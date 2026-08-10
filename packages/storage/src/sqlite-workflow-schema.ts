import type { DatabaseSync } from 'node:sqlite';
import {
  insertMigratedScheduledTasks,
  readLegacyPlanReminderTasks,
} from './sqlite-legacy-scheduling.js';

export const SQLITE_WORKFLOW_SCHEMA_VERSION = 9;
export const SQLITE_WORKFLOW_REQUIRED_TABLES = [
  ['workflow_task_ledger_events', 1],
  ['workflow_task_ledger_projections', 1],
  ['workflow_plan_events', 1],
  ['workflow_plan_projections', 1],
  ['workflow_plan_reminders', 1, 8],
  ['workflow_deep_research_events', 1],
  ['workflow_quote_companion_cleanup', 2],
  ['workflow_daily_review_state', 2],
  ['workflow_daily_review_authority_state', 3],
  ['workflow_daily_review_archives', 2],
  ['workflow_goal_authority', 5],
  ['workflow_scheduled_tasks', 8],
  ['workflow_scheduled_task_fires', 8],
] as const;

const WORKFLOW_QUOTE_CLEANUP_FILL_RECORD_TRIGGER = `
  CREATE TRIGGER IF NOT EXISTS workflow_quote_cleanup_fill_record
  AFTER INSERT ON workflow_quote_companion_cleanup
  WHEN NEW.record_json IS NULL
  BEGIN
    UPDATE workflow_quote_companion_cleanup
    SET record_json = json_object(
      'version', 1,
      'sessionId', NEW.session_id,
      'trackedAt', NEW.tracked_at,
      'phase', 'cleanup',
      'cancelRequested', json('true')
    )
    WHERE session_id = NEW.session_id;
  END
`;

export const SQLITE_WORKFLOW_REQUIRED_TRIGGERS = [
  {
    name: 'workflow_quote_cleanup_fill_record',
    introducedIn: 9,
    sql: WORKFLOW_QUOTE_CLEANUP_FILL_RECORD_TRIGGER,
  },
] as const;

export function migrateSqliteWorkflowDatabase(db: DatabaseSync): void {
  const legacyPlanReminders = readLegacyPlanReminderTasks(db);
  db.exec(`
    DROP INDEX IF EXISTS workflow_plan_reminders_order;
    DROP TABLE IF EXISTS workflow_plan_reminders;

    CREATE TABLE IF NOT EXISTS workflow_task_ledger_events (
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      event_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, sequence),
      UNIQUE (session_id, event_id)
    );

    CREATE TABLE IF NOT EXISTS workflow_task_ledger_projections (
      session_id TEXT PRIMARY KEY,
      record_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_plan_events (
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      event_id TEXT NOT NULL,
      store_version INTEGER NOT NULL CHECK (store_version > 0),
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, sequence),
      UNIQUE (session_id, event_id),
      UNIQUE (session_id, store_version)
    );

    CREATE TABLE IF NOT EXISTS workflow_plan_projections (
      session_id TEXT PRIMARY KEY,
      store_version INTEGER NOT NULL CHECK (store_version >= 0),
      record_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_deep_research_events (
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      event_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, sequence),
      UNIQUE (session_id, event_id)
    );

    CREATE TABLE IF NOT EXISTS workflow_scheduled_tasks (
      task_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS workflow_scheduled_tasks_order
      ON workflow_scheduled_tasks(created_at, task_id);

    CREATE TABLE IF NOT EXISTS workflow_scheduled_task_fires (
      claim_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL UNIQUE,
      claimed_at INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_quote_companion_cleanup (
      session_id TEXT PRIMARY KEY,
      tracked_at INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_daily_review_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      config_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_daily_review_authority_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0)
    );

    CREATE TABLE IF NOT EXISTS workflow_daily_review_archives (
      archive_id TEXT PRIMARY KEY,
      generated_at INTEGER NOT NULL,
      day_from_ms INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS workflow_daily_review_archives_order
      ON workflow_daily_review_archives(generated_at DESC, day_from_ms DESC, archive_id);

    CREATE TABLE IF NOT EXISTS workflow_goal_authority (
      session_id TEXT PRIMARY KEY,
      authority_revision INTEGER NOT NULL CHECK (authority_revision >= 0),
      goal_id TEXT NOT NULL,
      goal_revision INTEGER NOT NULL CHECK (goal_revision >= 0),
      status TEXT NOT NULL,
      record_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS workflow_goal_authority_status
      ON workflow_goal_authority(status, session_id);
  `);

  const cleanupColumns = new Set(
    (
      db.prepare('PRAGMA table_info(workflow_quote_companion_cleanup)').all() as Array<{
        name: string;
      }>
    ).map(({ name }) => name),
  );
  if (!cleanupColumns.has('record_json')) {
    db.exec('ALTER TABLE workflow_quote_companion_cleanup ADD COLUMN record_json TEXT');
  }
  db.prepare(`
    UPDATE workflow_quote_companion_cleanup
    SET record_json = json_object(
      'version', 1,
      'sessionId', session_id,
      'trackedAt', tracked_at,
      'phase', 'cleanup',
      'cancelRequested', json('true')
    )
    WHERE record_json IS NULL
  `).run();
  db.exec(`
    ${WORKFLOW_QUOTE_CLEANUP_FILL_RECORD_TRIGGER};
  `);
  insertMigratedScheduledTasks(db, legacyPlanReminders);
}
