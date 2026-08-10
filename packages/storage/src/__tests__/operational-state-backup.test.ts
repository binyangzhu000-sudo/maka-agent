import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createSqliteArtifactStore } from '../artifact-store.js';
import { resolveStorageRoot, type StorageRootKind } from '../root-authority.js';
import { createSqliteRuntimeStore } from '../sqlite-runtime-store.js';
import { createSqliteScheduledTaskStore } from '../scheduled-task-store.js';
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

const V016_BACKUP_FIXTURE = resolve(
  import.meta.dirname,
  '../../test-fixtures/v0.1.6-operational-backup/backup',
);
const V016_SESSION_ID = '8774e02b-1cff-4d50-90b8-97f78cceaa2a';

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

test('rejects backup roots that overlap through a path alias', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-operational-backup-alias-'));
  const stateRoot = join(base, 'state');
  const aliasRoot = join(base, 'state-alias');
  try {
    const runtime = createSqliteRuntimeStore(join(stateRoot, 'runtime.sqlite'));
    runtime.close();
    await symlink(stateRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');

    await assert.rejects(
      createOperationalStateBackup({
        stateRoot,
        destinationRoot: join(aliasRoot, 'backup'),
      }),
      (error: unknown) =>
        error instanceof OperationalBackupError && error.code === 'overlapping_roots',
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('rejects restore roots that overlap through a path alias', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-operational-restore-alias-'));
  const backupRoot = join(base, 'backup');
  const aliasRoot = join(base, 'backup-alias');
  try {
    await cp(V016_BACKUP_FIXTURE, backupRoot, { recursive: true });
    await symlink(backupRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');

    await assert.rejects(
      restoreOperationalStateBackup({
        backupRoot,
        destinationRoot: join(aliasRoot, 'restore'),
        kind: 'interactive',
      }),
      (error: unknown) =>
        error instanceof OperationalBackupError && error.code === 'overlapping_roots',
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('restores a v0.1.6 backup as current operational state', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-operational-backup-upgrade-'));
  const backupRoot = join(base, 'backup');
  const restoreRoot = join(base, 'restore');
  try {
    await cp(V016_BACKUP_FIXTURE, backupRoot, { recursive: true });

    await restoreOperationalStateBackup({
      backupRoot,
      destinationRoot: restoreRoot,
      kind: 'interactive',
    });
    await assertRestoredRootBinding(restoreRoot, 'interactive');

    const restored = createSessionStore(restoreRoot);
    try {
      assert.equal((await restored.readMessages(V016_SESSION_ID))[0]?.id, 'message-v016');
      const header = await restored.readHeaderSnapshot(V016_SESSION_ID);
      assert.equal(header.connectionLocked, true);
      assert.equal(header.workspaceRoot, restoreRoot);
    } finally {
      await restored.close?.();
    }
    const scheduledTasks = createSqliteScheduledTaskStore(restoreRoot);
    try {
      assert.deepEqual((await scheduledTasks.list()).map(({ id }) => id).sort(), [
        '60999192-d3b2-45b6-affb-e76355d4cf85',
        'cron-v016',
      ]);
    } finally {
      scheduledTasks.close();
    }
    assert.equal(
      await readFile(
        join(restoreRoot, 'artifacts', V016_SESSION_ID, 'artifact-v016-sentinel.txt'),
        'utf8',
      ),
      'v0.1.6 artifact',
    );
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

test('rejects a backup with an uncheckpointed SQLite sidecar', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-operational-backup-wal-'));
  const backupRoot = join(base, 'backup');
  try {
    await cp(V016_BACKUP_FIXTURE, backupRoot, { recursive: true });
    await writeFile(join(backupRoot, 'runtime.sqlite-wal'), 'uncheckpointed');

    await assert.rejects(
      validateOperationalStateBackup(backupRoot),
      /Backup cannot contain SQLite sidecars/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('rejects a v0.1.6 backup missing a table required by that release', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-operational-backup-legacy-table-'));
  const backupRoot = join(base, 'backup');
  try {
    await cp(V016_BACKUP_FIXTURE, backupRoot, { recursive: true });
    const database = new DatabaseSync(join(backupRoot, 'runtime.sqlite'));
    try {
      database.exec('DROP TABLE core_agent_runs');
    } finally {
      database.close();
    }
    await resignDatabaseInventory(backupRoot);

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

async function resignDatabaseInventory(backupRoot: string): Promise<void> {
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
