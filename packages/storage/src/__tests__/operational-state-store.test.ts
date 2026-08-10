import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
const MAIN_WORKFLOW_SCHEMA_VERSION = 4;
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
        WHEN 'workflow' THEN 4
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

function rewindRuntimeSchema(database: DatabaseSync): void {
  database.exec('DROP TRIGGER runtime_events_assign_session_ordinal');
  database.exec('DROP TABLE runtime_session_event_ordinals');
  database.exec(`PRAGMA user_version = ${LEGACY_RUNTIME_SCHEMA_VERSION}`);
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
