import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createSqliteArtifactStore } from '../artifact-store.js';
import { resolveStorageRoot, type StorageRootKind } from '../root-authority.js';
import { createSqliteRuntimeStore } from '../sqlite-runtime-store.js';
import { createSessionStore } from '../session-store.js';
import { bindWorkspaceBaselineAuthorityStoreRootInternal } from '../workspace-version-authority-internal.js';
import {
  createOperationalStateBackup,
  OPERATIONAL_BACKUP_MANIFEST_FILE,
  type OperationalBackupManifest,
  OperationalBackupError,
  restoreOperationalStateBackup,
  validateOperationalStateBackup,
} from '../operational-state-backup.js';

test('backs up and restores runtime.sqlite plus artifact bytes', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-operational-backup-'));
  const stateRoot = join(base, 'state');
  const backupRoot = join(base, 'backup');
  const restoreRoot = join(base, 'restore');
  const sourceCapability = await resolveStorageRoot({ path: stateRoot, kind: 'headless' });
  const sourceRuntime = createSqliteRuntimeStore(join(stateRoot, 'runtime.sqlite'));
  bindWorkspaceBaselineAuthorityStoreRootInternal(sourceRuntime, sourceCapability.rootId);
  sourceRuntime.close();
  const sessions = createSessionStore(stateRoot);
  try {
    const session = await sessions.create({
      projectId: 'project-1',
      cwd: '/tmp/cwd',
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
      name: 'Backup',
      labels: [],
    });
    await sessions.appendMessage(session.id, {
      type: 'user',
      id: 'message-1',
      turnId: 'turn-1',
      ts: 1,
      text: 'durable',
    });
    await sessions.close?.();
    const artifacts = createSqliteArtifactStore(stateRoot);
    const artifact = await artifacts.create({
      id: 'artifact-1',
      sessionId: session.id,
      turnId: 'turn-1',
      name: 'note.txt',
      kind: 'file',
      content: 'artifact',
      source: 'fixture',
      now: 2,
    });
    artifacts.close?.();

    const manifest = await createOperationalStateBackup({
      stateRoot,
      destinationRoot: backupRoot,
      now: () => 10,
    });
    assert.equal(manifest.createdAt, 10);
    await restoreOperationalStateBackup({
      backupRoot,
      destinationRoot: restoreRoot,
      kind: 'headless',
    });

    const restoredCapability = await assertRestoredRootBinding(restoreRoot, 'headless');
    assert.notEqual(restoredCapability.rootId, sourceCapability.rootId);

    const restored = createSessionStore(restoreRoot);
    try {
      assert.equal((await restored.readHeaderSnapshot(session.id)).workspaceRoot, restoreRoot);
      assert.equal((await restored.readMessages(session.id))[0]?.id, 'message-1');
      assert.equal(
        await readFile(join(restoreRoot, 'artifacts', artifact.relativePath), 'utf8'),
        'artifact',
      );
    } finally {
      await restored.close?.();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('restores a v0.1.6 backup as current operational state', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-operational-backup-upgrade-'));
  const stateRoot = join(base, 'state');
  const backupRoot = join(base, 'backup');
  const restoreRoot = join(base, 'restore');
  try {
    const sessions = createSessionStore(stateRoot);
    const session = await sessions.create({
      projectId: 'project-1',
      cwd: '/tmp/cwd',
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
      name: 'Legacy backup',
      labels: [],
    });
    await sessions.appendMessage(session.id, {
      type: 'user',
      id: 'message-1',
      turnId: 'turn-1',
      ts: 1,
      text: 'survives migration',
    });
    await sessions.close?.();
    await createOperationalStateBackup({ stateRoot, destinationRoot: backupRoot });
    await rewriteAsV016OperationalBackup(backupRoot);

    await restoreOperationalStateBackup({
      backupRoot,
      destinationRoot: restoreRoot,
      kind: 'interactive',
    });
    await assertRestoredRootBinding(restoreRoot, 'interactive');

    const restored = createSessionStore(restoreRoot);
    try {
      assert.equal((await restored.readMessages(session.id))[0]?.id, 'message-1');
      assert.equal((await restored.readHeaderSnapshot(session.id)).connectionLocked, true);
    } finally {
      await restored.close?.();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('rejects a backup whose SQLite Artifact metadata has no matching payload', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-operational-backup-artifact-'));
  const stateRoot = join(base, 'state');
  try {
    const artifacts = createSqliteArtifactStore(stateRoot);
    const artifact = await artifacts.create({
      id: 'artifact-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      name: 'note.txt',
      kind: 'file',
      content: 'artifact',
      source: 'fixture',
      now: 2,
    });
    artifacts.close?.();
    await rm(join(stateRoot, 'artifacts', artifact.relativePath));

    await assert.rejects(
      createOperationalStateBackup({
        stateRoot,
        destinationRoot: join(base, 'backup'),
        now: () => 10,
      }),
      (error: unknown) =>
        error instanceof OperationalBackupError &&
        error.code === 'corrupt_backup' &&
        /artifact payload/i.test(error.message),
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('rejects a v0.1.6 backup missing a table required by that release', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-operational-backup-legacy-table-'));
  const stateRoot = join(base, 'state');
  const backupRoot = join(base, 'backup');
  try {
    const sessions = createSessionStore(stateRoot);
    await sessions.close?.();
    await createOperationalStateBackup({ stateRoot, destinationRoot: backupRoot });
    await rewriteAsV016OperationalBackup(backupRoot);
    const database = new DatabaseSync(join(backupRoot, 'runtime.sqlite'));
    try {
      database.exec('DROP TABLE core_agent_runs');
    } finally {
      database.close();
    }
    await refreshDatabaseInventory(backupRoot);

    await assert.rejects(
      validateOperationalStateBackup(backupRoot),
      (error: unknown) =>
        error instanceof OperationalBackupError &&
        error.code === 'corrupt_backup' &&
        error.message.includes('required table is missing: core_agent_runs'),
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

async function rewriteAsV016OperationalBackup(backupRoot: string): Promise<void> {
  const databasePath = join(backupRoot, 'runtime.sqlite');
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      UPDATE operational_schema_migrations
      SET version = CASE scope
        WHEN 'runtime' THEN 10
        WHEN 'session_metadata' THEN 21
        WHEN 'core_execution' THEN 1
        WHEN 'workflow' THEN 3
        WHEN 'operational' THEN 1
        ELSE version
      END;
      DROP TRIGGER runtime_events_assign_session_ordinal;
      DROP TRIGGER session_messages_lock_connection;
      DROP TRIGGER workflow_quote_cleanup_fill_record;
      DROP TABLE runtime_session_event_ordinals;
      DROP TABLE core_root_turn_start_rejections;
      ALTER TABLE workflow_quote_companion_cleanup DROP COLUMN record_json;
      PRAGMA user_version = 10;
      UPDATE session_metadata_schema SET version = 21 WHERE scope = 'session_metadata';
      UPDATE session_metadata
      SET payload_json = json_set(payload_json, '$.connectionLocked', json('false'));
      PRAGMA journal_mode = DELETE;
    `);
  } finally {
    database.close();
  }

  await refreshDatabaseInventory(backupRoot);
}

async function refreshDatabaseInventory(backupRoot: string): Promise<void> {
  const databasePath = join(backupRoot, 'runtime.sqlite');
  const manifestPath = join(backupRoot, OPERATIONAL_BACKUP_MANIFEST_FILE);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as OperationalBackupManifest;
  const bytes = await readFile(databasePath);
  const files = manifest.files.map((file) =>
    file.path === 'runtime.sqlite'
      ? {
          ...file,
          size: bytes.byteLength,
          sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const,
        }
      : file,
  );
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, files }, null, 2)}\n`);
}

async function assertRestoredRootBinding(root: string, kind: StorageRootKind) {
  const capability = await resolveStorageRoot({ path: root, kind });
  const runtime = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
  try {
    assert.doesNotThrow(() =>
      bindWorkspaceBaselineAuthorityStoreRootInternal(runtime, capability.rootId),
    );
  } finally {
    runtime.close();
  }
  return capability;
}
