import type { DatabaseSync } from 'node:sqlite';
import {
  insertMigratedAutomationState,
  readLegacyAutomationMigration,
} from './sqlite-legacy-scheduling.js';

export const SQLITE_AUTOMATION_SCHEMA_VERSION = 3;
export const SQLITE_AUTOMATION_REQUIRED_TABLES = [
  ['automation_authority_state', 1],
  ['automation_definitions', 1],
  ['automation_pending_fires', 1],
  ['automation_recovery_closures', 3],
] as const;

export function migrateSqliteAutomationDatabase(
  db: DatabaseSync,
  options?: { readonly sourceVersion?: number; readonly now?: () => number },
): void {
  const legacy = readLegacyAutomationMigration(
    db,
    options?.sourceVersion === 1,
    options?.now?.() ?? Date.now(),
  );
  const legacyDefinition = db
    .prepare(
      "SELECT 1 AS present FROM pragma_table_info('automation_definitions') WHERE name = 'durable'",
    )
    .get() as { present?: number } | undefined;
  if (legacyDefinition?.present === 1) {
    db.exec(`
      DROP TABLE IF EXISTS automation_pending_fires;
      DROP TABLE IF EXISTS automation_definitions;
      DROP TABLE IF EXISTS automation_authority_state;
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_authority_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0)
    );

    INSERT OR IGNORE INTO automation_authority_state(singleton, revision)
    VALUES (1, 0);

    CREATE TABLE IF NOT EXISTS automation_definitions (
      automation_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      status TEXT NOT NULL,
      record_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS automation_definitions_session_order
      ON automation_definitions(session_id, created_at, automation_id);

    CREATE INDEX IF NOT EXISTS automation_definitions_active_schedule
      ON automation_definitions(status, created_at, automation_id);

    CREATE TABLE IF NOT EXISTS automation_pending_fires (
      fire_id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL UNIQUE,
      target_session_id TEXT NOT NULL,
      admitted_at INTEGER NOT NULL CHECK (admitted_at >= 0),
      record_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS automation_pending_fires_order
      ON automation_pending_fires(admitted_at, fire_id);

    CREATE TABLE IF NOT EXISTS automation_recovery_closures (
      fire_id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      target_session_id TEXT NOT NULL,
      admitted_at INTEGER NOT NULL CHECK (admitted_at >= 0),
      record_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS automation_recovery_closures_order
      ON automation_recovery_closures(admitted_at, fire_id);
  `);
  insertMigratedAutomationState(db, legacy);
}
