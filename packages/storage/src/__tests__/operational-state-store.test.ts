import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants, DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { SessionHeader } from '@maka/core';
import {
  acquireOperationalStateDatabase,
  inspectOperationalStateSchema,
  migrateOperationalStateDatabaseInternal,
} from '../operational-state-store.js';
import { SQLITE_RUNTIME_SCHEMA_VERSION } from '../sqlite-runtime-schema.js';
import { SQLITE_SESSION_METADATA_SCHEMA_VERSION } from '../sqlite-session-metadata-schema.js';
import { SQLITE_USAGE_SCHEMA_VERSION } from '../sqlite-usage-schema.js';
import { createSqliteSessionMetadataStore } from '../sqlite-session-metadata-store.js';

const LEGACY_RUNTIME_SCHEMA_VERSION = 10;
const LEGACY_SESSION_METADATA_SCHEMA_VERSION = 21;
const MAIN_WORKFLOW_SCHEMA_VERSION = 8;
const WORKFLOW_SCHEDULE_REQUIRED_TABLE_NAMES = [
  'workflow_scheduled_tasks',
  'workflow_scheduled_task_fires',
] as const;
const SESSION_CATALOG_REQUIRED_TRIGGER_NAMES = [
  'session_catalog_after_insert',
  'session_catalog_after_update',
  'session_catalog_after_delete',
  'session_catalog_label_after_insert',
  'session_catalog_label_after_delete',
] as const;

test('shares one operational database and produces an online backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-state-'));
  const backupPath = join(root, 'backup.sqlite');
  try {
    const lease = acquireOperationalStateDatabase(root);
    const secondLease = acquireOperationalStateDatabase(root);
    assert.equal(secondLease.database, lease.database);
    secondLease.close();

    const metadata = createSqliteSessionMetadataStore(join(root, 'runtime.sqlite'), {
      databaseLease: lease,
    });
    await metadata.create(sessionHeader());
    const backup = lease.backup(backupPath);
    metadata.close();
    assert.ok((await backup) > 0);

    const reopened = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(
        (
          reopened.prepare('SELECT COUNT(*) AS count FROM session_metadata').get() as {
            count: number;
          }
        ).count,
        1,
      );
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves operational state when every schema is current', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-compatible-'));
  try {
    const lease = acquireOperationalStateDatabase(root);
    lease.database.exec('CREATE TABLE compatibility_sentinel (value TEXT NOT NULL)');
    lease.database.exec("INSERT INTO compatibility_sentinel(value) VALUES ('preserved')");
    lease.close();

    const reopened = acquireOperationalStateDatabase(root);
    assert.equal(
      (
        reopened.database.prepare('SELECT value FROM compatibility_sentinel').get() as {
          value: string;
        }
      ).value,
      'preserved',
    );
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('inspects one schema snapshot while another connection initializes the database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-inspection-snapshot-'));
  const databasePath = join(root, 'runtime.sqlite');
  const reader = new DatabaseSync(databasePath);
  const writer = new DatabaseSync(databasePath);
  try {
    reader.exec('PRAGMA journal_mode = WAL');
    writer.exec('PRAGMA journal_mode = WAL');
    let initialized = false;
    reader.setAuthorizer((actionCode, tableName) => {
      if (!initialized && actionCode === constants.SQLITE_READ && tableName === 'sqlite_master') {
        initialized = true;
        writer.exec('CREATE TABLE concurrent_initialization_sentinel (value TEXT)');
      }
      return constants.SQLITE_OK;
    });

    assert.equal(inspectOperationalStateSchema(reader).status, 'needs_migration');
    assert.equal(initialized, true);
  } finally {
    reader.setAuthorizer(null);
    writer.close();
    reader.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('migrates older operational state without losing sessions or messages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-upgrade-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    const lease = acquireOperationalStateDatabase(root);
    const metadata = createSqliteSessionMetadataStore(databasePath, { databaseLease: lease });
    await metadata.importSession(
      sessionHeader(),
      [{ type: 'user', id: 'message-1', turnId: 'turn-1', ts: 3, text: 'keep me' }],
      { lastMessageAt: 3, lastMessagePreview: 'keep me' },
    );
    metadata.close();

    const database = new DatabaseSync(databasePath);
    rewindRuntimeSchema(database);
    database
      .prepare(`UPDATE operational_schema_migrations SET version = ? WHERE scope = 'runtime'`)
      .run(LEGACY_RUNTIME_SCHEMA_VERSION);
    database.close();

    const reopenedLease = acquireOperationalStateDatabase(root);
    assert.equal(
      (reopenedLease.database.prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version,
      SQLITE_RUNTIME_SCHEMA_VERSION,
    );
    const reopened = createSqliteSessionMetadataStore(databasePath, {
      databaseLease: reopenedLease,
    });
    try {
      assert.equal((await reopened.read('session-1')).header.name, 'Session');
      assert.deepEqual(await reopened.readMessages('session-1'), [
        { type: 'user', id: 'message-1', turnId: 'turn-1', ts: 3, text: 'keep me' },
      ]);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('migrates released scheduling state through the operational transaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-scheduling-upgrade-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    acquireOperationalStateDatabase(root).close();
    const legacy = new DatabaseSync(databasePath);
    seedLegacyScheduling(legacy);
    legacy.close();

    const upgraded = acquireOperationalStateDatabase(root);
    try {
      assert.deepEqual(
        upgraded.database
          .prepare('SELECT task_id FROM workflow_scheduled_tasks ORDER BY task_id')
          .all()
          .map((row) => (row as { task_id: string }).task_id),
        ['cron-1', 'reminder-1'],
      );
      assert.equal(
        upgraded.database.prepare('SELECT COUNT(*) AS count FROM automation_definitions').get()
          ?.count,
        0,
      );
      assert.equal(inspectOperationalStateSchema(upgraded.database).status, 'current');
    } finally {
      upgraded.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('retains a legacy cron when its execution authority is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-scheduling-unavailable-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    acquireOperationalStateDatabase(root).close();
    const legacy = new DatabaseSync(databasePath);
    seedLegacyScheduling(legacy);
    const row = legacy
      .prepare('SELECT record_json FROM automation_definitions WHERE automation_id = ?')
      .get('cron-1') as { record_json: string };
    const { execution: _execution, ...record } = JSON.parse(row.record_json);
    legacy
      .prepare(
        'UPDATE automation_definitions SET session_id = ?, record_json = ? WHERE automation_id = ?',
      )
      .run(
        'missing-session',
        JSON.stringify({ ...record, sessionId: 'missing-session' }),
        'cron-1',
      );
    legacy.close();

    acquireOperationalStateDatabase(root).close();

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const migrated = preserved
        .prepare('SELECT record_json FROM workflow_scheduled_tasks WHERE task_id = ?')
        .get('cron-1') as { record_json: string };
      const task = JSON.parse(migrated.record_json);
      assert.equal(task.status, 'paused');
      assert.equal(task.nextFireAt, null);
      assert.equal(task.effect.kind, 'agent_run_unavailable');
      assert.equal(inspectOperationalStateSchema(preserved).status, 'current');
    } finally {
      preserved.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installs new invariants when upgrading the current main schema', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-current-main-upgrade-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    acquireOperationalStateDatabase(root).close();

    const main = new DatabaseSync(databasePath);
    main.exec(`
      DROP TRIGGER IF EXISTS runtime_event_ordinal_retry;
      DROP TRIGGER IF EXISTS runtime_events_assign_session_ordinal;
      DROP TRIGGER IF EXISTS session_messages_lock_connection;
      DROP TRIGGER IF EXISTS workflow_quote_cleanup_fill_record;
      PRAGMA user_version = 11;
      UPDATE session_metadata_schema
      SET version = 22
      WHERE scope = 'session_metadata';
      UPDATE operational_schema_migrations
      SET version = CASE scope
        WHEN 'runtime' THEN 11
        WHEN 'session_metadata' THEN 22
        WHEN 'workflow' THEN ${MAIN_WORKFLOW_SCHEMA_VERSION}
        ELSE version
      END;
    `);
    main.close();

    const upgraded = acquireOperationalStateDatabase(root);
    try {
      assert.equal(inspectOperationalStateSchema(upgraded.database).status, 'current');
    } finally {
      upgraded.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rechecks a stale schema classification inside the migration transaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-stale-classification-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    acquireOperationalStateDatabase(root).close();

    const stale = new DatabaseSync(databasePath);
    try {
      stale.exec(`
        DROP TRIGGER runtime_events_assign_session_ordinal;
        DROP TRIGGER runtime_event_ordinal_retry;
        PRAGMA user_version = 11;
        UPDATE operational_schema_migrations SET version = 11 WHERE scope = 'runtime';
      `);
      assert.equal(inspectOperationalStateSchema(stale).status, 'needs_migration');

      acquireOperationalStateDatabase(root).close();
      stale.exec(`
        CREATE TRIGGER reject_redundant_registry_update
        BEFORE UPDATE ON operational_schema_migrations
        BEGIN
          SELECT RAISE(ABORT, 'stale opener repeated a completed migration');
        END;
      `);

      migrateOperationalStateDatabaseInternal(stale, () => 2);
      assert.equal(inspectOperationalStateSchema(stale).status, 'current');
    } finally {
      stale.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rolls back migration when an older schema occupies a reserved trigger name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-reserved-trigger-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    acquireOperationalStateDatabase(root).close();
    const database = new DatabaseSync(databasePath);
    database.exec(`
      DROP TRIGGER workflow_quote_cleanup_fill_record;
      CREATE TRIGGER workflow_quote_cleanup_fill_record
      AFTER INSERT ON workflow_quote_companion_cleanup
      BEGIN
        SELECT 1;
      END;
      UPDATE operational_schema_migrations
      SET version = ${MAIN_WORKFLOW_SCHEMA_VERSION}
      WHERE scope = 'workflow';
    `);
    database.close();

    assert.throws(
      () => acquireOperationalStateDatabase(root),
      /required trigger definition changed: workflow_quote_cleanup_fill_record/i,
    );

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        (
          preserved
            .prepare(`SELECT version FROM operational_schema_migrations WHERE scope = 'workflow'`)
            .get() as { version: number }
        ).version,
        MAIN_WORKFLOW_SCHEMA_VERSION,
      );
    } finally {
      preserved.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rolls back every migrated scope when schema publication fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-atomic-migration-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    const lease = acquireOperationalStateDatabase(root);
    const metadata = createSqliteSessionMetadataStore(databasePath, { databaseLease: lease });
    await metadata.importSession(
      { ...sessionHeader(), connectionLocked: false },
      [{ type: 'user', id: 'message-1', turnId: 'turn-1', ts: 3, text: 'keep me' }],
      { lastMessageAt: 3, lastMessagePreview: 'keep me' },
    );
    metadata.close();

    const database = new DatabaseSync(databasePath);
    rewindRuntimeSchema(database);
    database.exec(`
      DROP TRIGGER session_messages_lock_connection;
      DROP TRIGGER workflow_quote_cleanup_fill_record;
      UPDATE session_metadata
      SET payload_json = json_set(payload_json, '$.connectionLocked', json('false'));
      UPDATE session_metadata_schema
      SET version = ${LEGACY_SESSION_METADATA_SCHEMA_VERSION}
      WHERE scope = 'session_metadata';
      UPDATE operational_schema_migrations
      SET version = CASE scope
        WHEN 'runtime' THEN ${LEGACY_RUNTIME_SCHEMA_VERSION}
        WHEN 'session_metadata' THEN ${LEGACY_SESSION_METADATA_SCHEMA_VERSION}
        WHEN 'workflow' THEN ${MAIN_WORKFLOW_SCHEMA_VERSION}
        ELSE version
      END;
      CREATE TRIGGER reject_runtime_registry_upgrade
      BEFORE UPDATE OF version ON operational_schema_migrations
      WHEN OLD.scope = 'runtime' AND NEW.version > OLD.version
      BEGIN
        SELECT RAISE(ABORT, 'registry publication failed');
      END;
    `);
    const before = captureOperationalSchemaState(database);
    database.close();

    assert.throws(() => acquireOperationalStateDatabase(root), /registry publication failed/);

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.deepEqual(captureOperationalSchemaState(preserved), before);
    } finally {
      preserved.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const incompatibleSchemaCases: ReadonlyArray<{
  name: string;
  error: RegExp;
  prepare(database: DatabaseSync): void;
  assertPreserved(database: DatabaseSync): void;
}> = [
  {
    name: 'rejects a newer scope before migrating an older scope',
    error: /Operational schema usage is newer than supported/,
    prepare(database) {
      rewindRuntimeSchema(database);
      database
        .prepare(`UPDATE operational_schema_migrations SET version = ? WHERE scope = 'usage'`)
        .run(SQLITE_USAGE_SCHEMA_VERSION + 1);
    },
    assertPreserved: assertLegacyRuntimeVersion,
  },
  {
    name: 'rejects a newer runtime schema without changing the database',
    error: /Operational schema runtime is newer than supported/,
    prepare(database) {
      database.exec(`
        PRAGMA user_version = ${SQLITE_RUNTIME_SCHEMA_VERSION + 1};
        CREATE TABLE runtime_future_sentinel (value TEXT NOT NULL);
        INSERT INTO runtime_future_sentinel(value) VALUES ('preserved');
      `);
    },
    assertPreserved(database) {
      assert.equal(readRuntimeVersion(database), SQLITE_RUNTIME_SCHEMA_VERSION + 1);
      assert.equal(
        (database.prepare('SELECT value FROM runtime_future_sentinel').get() as { value: string })
          .value,
        'preserved',
      );
    },
  },
  {
    name: 'rejects newer session metadata before migrating older runtime state',
    error: /Operational schema session_metadata is newer than supported/,
    prepare(database) {
      rewindRuntimeSchema(database);
      database
        .prepare(`UPDATE session_metadata_schema SET version = ? WHERE scope = 'session_metadata'`)
        .run(SQLITE_SESSION_METADATA_SCHEMA_VERSION + 1);
    },
    assertPreserved: assertLegacyRuntimeVersion,
  },
  {
    name: 'rejects an unknown operational schema without changing the database',
    error: /Operational schema future_scope is unknown to this Maka build/,
    prepare(database) {
      database
        .prepare(
          `INSERT INTO operational_schema_migrations(scope, version, applied_at) VALUES (?, ?, ?)`,
        )
        .run('future_scope', 1, 1);
    },
    assertPreserved(database) {
      assert.deepEqual(
        {
          ...(database
            .prepare(
              `SELECT scope, version, applied_at FROM operational_schema_migrations WHERE scope = ?`,
            )
            .get('future_scope') as Record<string, unknown>),
        },
        { scope: 'future_scope', version: 1, applied_at: 1 },
      );
    },
  },
  {
    name: 'rejects an operational registry with a missing scope',
    error: /Operational schema registry is missing scope workflow/,
    prepare(database) {
      database.exec(`
        DELETE FROM operational_schema_migrations WHERE scope = 'workflow';
        DROP TABLE workflow_task_ledger_events;
      `);
    },
    assertPreserved(database) {
      assert.equal(
        database
          .prepare('SELECT version FROM operational_schema_migrations WHERE scope = ?')
          .get('workflow'),
        undefined,
      );
      assert.equal(
        database
          .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get('workflow_task_ledger_events'),
        undefined,
      );
    },
  },
  {
    name: 'rejects an invalid registered schema version before migrating',
    error: /Operational schema usage has invalid version 1.5/,
    prepare(database) {
      rewindRuntimeSchema(database);
      database
        .prepare(`UPDATE operational_schema_migrations SET version = ? WHERE scope = 'usage'`)
        .run(1.5);
    },
    assertPreserved: assertLegacyRuntimeVersion,
  },
  {
    name: 'rejects a registry without its scope primary key',
    error: /Operational schema registry has an invalid definition/,
    prepare(database) {
      database.exec(`
        ALTER TABLE operational_schema_migrations
        RENAME TO original_operational_schema_migrations;
        CREATE TABLE operational_schema_migrations (
          scope TEXT NOT NULL,
          version INTEGER NOT NULL,
          applied_at INTEGER NOT NULL
        );
        INSERT INTO operational_schema_migrations(scope, version, applied_at)
        SELECT scope, version, applied_at
        FROM original_operational_schema_migrations;
        INSERT INTO operational_schema_migrations(scope, version, applied_at)
        SELECT scope, version, applied_at
        FROM original_operational_schema_migrations
        WHERE scope = 'runtime';
        DROP TABLE original_operational_schema_migrations;
      `);
    },
    assertPreserved(database) {
      assert.equal(
        (
          database
            .prepare(
              `SELECT COUNT(*) AS count FROM operational_schema_migrations WHERE scope = 'runtime'`,
            )
            .get() as { count: number }
        ).count,
        2,
      );
    },
  },
  {
    name: 'rejects a nonempty database without its operational registry',
    error: /Operational schema registry is missing/,
    prepare(database) {
      database.exec(`
        DROP TABLE operational_schema_migrations;
        DROP TABLE workflow_task_ledger_events;
      `);
    },
    assertPreserved(database) {
      const tableExists = database.prepare(
        "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?",
      );
      assert.equal(tableExists.get('operational_schema_migrations'), undefined);
      assert.equal(tableExists.get('workflow_task_ledger_events'), undefined);
    },
  },
  {
    name: 'rejects a current schema with a missing required table',
    error: /required table is missing: workflow_task_ledger_events/,
    prepare(database) {
      database.exec('DROP TABLE workflow_task_ledger_events');
    },
    assertPreserved(database) {
      assert.equal(
        database
          .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get('workflow_task_ledger_events'),
        undefined,
      );
    },
  },
  {
    name: 'rejects a current schema without workflow goal authority',
    error: /required table is missing: workflow_goal_authority/,
    prepare(database) {
      database.exec('DROP TABLE workflow_goal_authority');
    },
    assertPreserved(database) {
      assert.equal(
        database
          .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get('workflow_goal_authority'),
        undefined,
      );
    },
  },
  ...WORKFLOW_SCHEDULE_REQUIRED_TABLE_NAMES.map((table) => ({
    name: `rejects a current schema without ${table}`,
    error: new RegExp(`required table is missing: ${table}`),
    prepare(database: DatabaseSync) {
      database.exec(`DROP TABLE ${table}`);
    },
    assertPreserved(database: DatabaseSync) {
      assert.equal(
        database
          .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get(table),
        undefined,
      );
    },
  })),
  ...SESSION_CATALOG_REQUIRED_TRIGGER_NAMES.map((trigger) => ({
    name: `rejects a current schema without ${trigger}`,
    error: new RegExp(`required trigger is missing: ${trigger}`),
    prepare(database: DatabaseSync) {
      database.exec(`DROP TRIGGER ${trigger}`);
    },
    assertPreserved(database: DatabaseSync) {
      assert.equal(
        database
          .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'trigger' AND name = ?")
          .get(trigger),
        undefined,
      );
    },
  })),
];

for (const contract of incompatibleSchemaCases) {
  test(contract.name, async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-operational-incompatible-'));
    const databasePath = join(root, 'runtime.sqlite');
    try {
      acquireOperationalStateDatabase(root).close();
      const database = new DatabaseSync(databasePath);
      contract.prepare(database);
      database.close();

      assert.throws(() => acquireOperationalStateDatabase(root), contract.error);

      const preserved = new DatabaseSync(databasePath, { readOnly: true });
      try {
        contract.assertPreserved(preserved);
      } finally {
        preserved.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('rejects a released workflow schema without its reminder catalog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-missing-reminders-'));
  try {
    const lease = acquireOperationalStateDatabase(root);
    seedLegacyScheduling(lease.database);
    lease.database.exec('DROP TABLE workflow_plan_reminders');
    lease.close();

    assert.throws(
      () => acquireOperationalStateDatabase(root),
      /required table is missing: workflow_plan_reminders/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('accepts a released runtime schema before later tables were introduced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-early-runtime-'));
  try {
    const lease = acquireOperationalStateDatabase(root);
    lease.database.exec(`
      DROP TRIGGER runtime_events_assign_session_ordinal;
      DROP TRIGGER runtime_event_ordinal_retry;
      DROP TABLE runtime_partial_segments;
      DROP TABLE runtime_capabilities;
      DROP TABLE runtime_storage_root_binding;
      DROP TABLE runtime_continuation_claims;
      DROP TABLE runtime_workspace_epochs;
      DROP TABLE runtime_workspace_versions;
      DROP TABLE runtime_workspace_heads;
      DROP TABLE headless_task_run_events;
      DROP TABLE runtime_session_event_ordinals;
      PRAGMA user_version = 4;
      UPDATE operational_schema_migrations SET version = 4 WHERE scope = 'runtime';
    `);
    assert.equal(inspectOperationalStateSchema(lease.database).status, 'needs_migration');
    lease.close();

    const upgraded = acquireOperationalStateDatabase(root);
    assert.equal(inspectOperationalStateSchema(upgraded.database).status, 'current');
    upgraded.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a released Automation schema without its durable discriminator', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-malformed-automation-'));
  try {
    const lease = acquireOperationalStateDatabase(root);
    seedLegacyScheduling(lease.database);
    lease.database.exec('ALTER TABLE automation_definitions DROP COLUMN durable');
    lease.close();

    assert.throws(
      () => acquireOperationalStateDatabase(root),
      /released Automation schema is missing durable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function rewindRuntimeSchema(database: DatabaseSync): void {
  database.exec('DROP TRIGGER runtime_events_assign_session_ordinal');
  database.exec('DROP TABLE runtime_session_event_ordinals');
  database.exec(`PRAGMA user_version = ${LEGACY_RUNTIME_SCHEMA_VERSION}`);
}

function seedLegacyScheduling(database: DatabaseSync): void {
  database.exec(`
    DROP TABLE workflow_scheduled_task_fires;
    DROP TABLE workflow_scheduled_tasks;
    CREATE TABLE workflow_plan_reminders (
      reminder_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );
    DROP TABLE automation_pending_fires;
    DROP TABLE automation_definitions;
    DROP TABLE automation_authority_state;
    CREATE TABLE automation_authority_state (
      singleton INTEGER PRIMARY KEY,
      revision INTEGER NOT NULL
    );
    INSERT INTO automation_authority_state VALUES (1, 1);
    CREATE TABLE automation_definitions (
      automation_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      durable INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE TABLE automation_pending_fires (
      fire_id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL UNIQUE,
      target_session_id TEXT NOT NULL,
      admitted_at INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );
    UPDATE operational_schema_migrations
    SET version = CASE scope
      WHEN 'workflow' THEN 3
      WHEN 'automation' THEN 1
      ELSE version
    END;
  `);
  database.prepare('INSERT INTO workflow_plan_reminders VALUES (?, ?, ?, ?)').run(
    'reminder-1',
    1,
    2,
    JSON.stringify({
      id: 'reminder-1',
      title: 'Follow up',
      note: 'Review the result',
      schedule: { kind: 'once', runAt: 10 },
      delivery: { channel: 'local' },
      enabled: true,
      status: 'scheduled',
      createdAt: 1,
      updatedAt: 2,
      nextRunAt: 10,
      runCount: 0,
      runs: [],
    }),
  );
  database.prepare('INSERT INTO automation_definitions VALUES (?, ?, ?, ?, ?, ?)').run(
    'cron-1',
    'session-1',
    1,
    'active',
    1,
    JSON.stringify({
      id: 'cron-1',
      kind: 'cron',
      name: 'Daily report',
      status: 'active',
      prompt: 'Prepare the report',
      sessionId: 'session-1',
      schedule: { type: 'cron', expression: '0 9 * * *' },
      createdAt: 1,
      updatedAt: 2,
      nextFireAt: 10,
      lastFireAt: null,
      lastRunId: null,
      fireCount: 0,
      maxFires: null,
      expiresAt: null,
      lastError: null,
      consecutiveFailures: 0,
      durable: true,
      execution: {
        cwd: '/workspace',
        backend: 'fake',
        llmConnectionSlug: 'test',
        model: 'test-model',
        collaborationMode: 'agent',
        orchestrationMode: 'default',
      },
    }),
  );
}

function assertLegacyRuntimeVersion(database: DatabaseSync): void {
  assert.equal(readRuntimeVersion(database), LEGACY_RUNTIME_SCHEMA_VERSION);
}

function readRuntimeVersion(database: DatabaseSync): number {
  return (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

function captureOperationalSchemaState(database: DatabaseSync) {
  return {
    userVersion: (database.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version,
    sessionMetadataVersion: (
      database
        .prepare(`SELECT version FROM session_metadata_schema WHERE scope = 'session_metadata'`)
        .get() as { version: number }
    ).version,
    registry: database
      .prepare(
        `SELECT scope, version, applied_at FROM operational_schema_migrations ORDER BY scope`,
      )
      .all(),
    sessions: database
      .prepare(
        `SELECT session_id, payload_json, metadata_version, committed_at FROM session_metadata ORDER BY session_id`,
      )
      .all(),
    schema: database
      .prepare(`
        SELECT type, name, tbl_name, sql
        FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name
      `)
      .all(),
  };
}

function sessionHeader(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/workspace',
    cwd: '/workspace',
    createdAt: 1,
    lastUsedAt: 2,
    name: 'Session',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    hasUnread: false,
    backend: 'fake',
    llmConnectionSlug: 'test',
    connectionLocked: true,
    model: 'test-model',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    schemaVersion: 1,
  };
}
