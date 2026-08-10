import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteWorkflowDatabase } from '../sqlite-workflow-schema.js';

test('repairs cleanup records missed by a schema 3 writer after a schema 4 upgrade', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workflow-legacy-writer-'));
  const path = join(root, 'state.sqlite');
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec(`
      CREATE TABLE workflow_quote_companion_cleanup (
        session_id TEXT PRIMARY KEY,
        tracked_at INTEGER NOT NULL
      )
    `);

    const current = new DatabaseSync(path);
    try {
      current.exec('ALTER TABLE workflow_quote_companion_cleanup ADD COLUMN record_json TEXT');
    } finally {
      current.close();
    }

    legacy
      .prepare(`
        INSERT OR IGNORE INTO workflow_quote_companion_cleanup(session_id, tracked_at)
        VALUES (?, ?)
      `)
      .run('session-1', 10);

    migrateSqliteWorkflowDatabase(legacy);

    const row = legacy
      .prepare(`
        SELECT record_json
        FROM workflow_quote_companion_cleanup
        WHERE session_id = ?
      `)
      .get('session-1') as { record_json?: unknown };
    assert.equal(typeof row.record_json, 'string');
    assert.deepEqual(JSON.parse(row.record_json as string), {
      version: 1,
      sessionId: 'session-1',
      trackedAt: 10,
      phase: 'cleanup',
      cancelRequested: true,
    });
  } finally {
    legacy.close();
    await rm(root, { recursive: true, force: true });
  }
});
