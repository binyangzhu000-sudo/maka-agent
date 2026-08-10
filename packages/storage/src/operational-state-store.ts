import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import {
  configureSqliteRuntimeDatabase,
  configureSqliteRuntimeLockWait,
  migrateSqliteRuntimeDatabase,
  readUserVersion,
  SQLITE_RUNTIME_REQUIRED_TABLES,
  SQLITE_RUNTIME_REQUIRED_TRIGGERS,
  SQLITE_RUNTIME_SCHEMA_VERSION,
} from './sqlite-runtime-schema.js';
import {
  migrateSqliteSessionMetadataDatabase,
  readSqliteSessionMetadataSchemaVersion,
  SQLITE_SESSION_METADATA_REQUIRED_TABLES,
  SQLITE_SESSION_METADATA_REQUIRED_TRIGGERS,
  SQLITE_SESSION_METADATA_SCHEMA_VERSION,
} from './sqlite-session-metadata-schema.js';
import {
  migrateSqliteCoreExecutionDatabase,
  SQLITE_CORE_EXECUTION_REQUIRED_TABLES,
  SQLITE_CORE_EXECUTION_SCHEMA_VERSION,
} from './sqlite-core-execution-schema.js';
import {
  migrateSqliteWorkflowDatabase,
  SQLITE_WORKFLOW_REQUIRED_TABLES,
  SQLITE_WORKFLOW_REQUIRED_TRIGGERS,
  SQLITE_WORKFLOW_SCHEMA_VERSION,
} from './sqlite-workflow-schema.js';
import {
  migrateSqliteUsageDatabase,
  SQLITE_USAGE_REQUIRED_TABLES,
  SQLITE_USAGE_SCHEMA_VERSION,
} from './sqlite-usage-schema.js';
import {
  migrateSqliteArtifactDatabase,
  SQLITE_ARTIFACT_REQUIRED_TABLES,
  SQLITE_ARTIFACT_SCHEMA_VERSION,
} from './sqlite-artifact-schema.js';
import {
  migrateSqliteAutomationDatabase,
  SQLITE_AUTOMATION_REQUIRED_TABLES,
  SQLITE_AUTOMATION_SCHEMA_VERSION,
} from './sqlite-automation-schema.js';
import {
  assertStorageRootCapability,
  type StorageRootCapability,
  type StorageRootKind,
} from './root-authority.js';

export const OPERATIONAL_STATE_DATABASE_NAME = 'runtime.sqlite';
export const OPERATIONAL_STATE_SCHEMA_VERSION = 1;

/** Resolve the authoritative on-disk path of the operational-state database. */
export function resolveOperationalStateDatabasePath(workspaceRoot: string): string {
  return resolve(workspaceRoot, OPERATIONAL_STATE_DATABASE_NAME);
}

const OPERATIONAL_SCHEMA_VERSIONS: ReadonlyMap<string, number> = new Map([
  ['runtime', SQLITE_RUNTIME_SCHEMA_VERSION],
  ['session_metadata', SQLITE_SESSION_METADATA_SCHEMA_VERSION],
  ['core_execution', SQLITE_CORE_EXECUTION_SCHEMA_VERSION],
  ['workflow', SQLITE_WORKFLOW_SCHEMA_VERSION],
  ['usage', SQLITE_USAGE_SCHEMA_VERSION],
  ['artifact', SQLITE_ARTIFACT_SCHEMA_VERSION],
  ['automation', SQLITE_AUTOMATION_SCHEMA_VERSION],
  ['operational', OPERATIONAL_STATE_SCHEMA_VERSION],
] as const);

const REQUIRED_SCHEMA_TRIGGERS = [
  ...SQLITE_RUNTIME_REQUIRED_TRIGGERS.map((trigger) => ({ ...trigger, scope: 'runtime' })),
  ...SQLITE_SESSION_METADATA_REQUIRED_TRIGGERS.map((trigger) => ({
    ...trigger,
    scope: 'session_metadata',
  })),
  ...SQLITE_WORKFLOW_REQUIRED_TRIGGERS.map((trigger) => ({ ...trigger, scope: 'workflow' })),
] as const;

function requiredTables<const T extends readonly (readonly [string, number, number?])[]>(
  scope: string,
  tables: T,
) {
  return tables.map(([name, introducedIn, removedIn]) => ({
    scope,
    name,
    introducedIn,
    removedIn,
  }));
}

const RUNTIME_REQUIRED_SCHEMA_TABLES = requiredTables('runtime', SQLITE_RUNTIME_REQUIRED_TABLES);

const REQUIRED_SCHEMA_TABLES = [
  { scope: 'operational', name: 'operational_schema_migrations', introducedIn: 1 },
  ...RUNTIME_REQUIRED_SCHEMA_TABLES,
  ...requiredTables('session_metadata', SQLITE_SESSION_METADATA_REQUIRED_TABLES),
  ...requiredTables('core_execution', SQLITE_CORE_EXECUTION_REQUIRED_TABLES),
  ...requiredTables('workflow', SQLITE_WORKFLOW_REQUIRED_TABLES),
  ...requiredTables('usage', SQLITE_USAGE_REQUIRED_TABLES),
  ...requiredTables('artifact', SQLITE_ARTIFACT_REQUIRED_TABLES),
  ...requiredTables('automation', SQLITE_AUTOMATION_REQUIRED_TABLES),
] as const;

const RUNTIME_SCHEMA_TABLE_NAMES = new Set<string>(
  SQLITE_RUNTIME_REQUIRED_TABLES.map(([name]) => name),
);

const require = createRequire(import.meta.url);
const owners = new Map<string, OperationalStateDatabaseOwner>();

export interface OperationalStateDatabaseOptions {
  now?: () => number;
}

export interface OperationalStateDatabaseLease {
  readonly database: DatabaseSync;
  readonly databasePath: string;
  transaction<T>(mode: 'read' | 'write', operation: () => T): T;
  backup(destinationPath: string): Promise<number>;
  close(): void;
}

/**
 * Acquire the process-local owner for the operational SQLite authority.
 *
 * Repositories receive leases instead of opening independent connections.
 * The last lease closes the connection, while transaction boundaries remain
 * centralized on the owner for the lifetime of the workspace.
 */
export function acquireOperationalStateDatabase(
  workspaceRoot: string,
  options: OperationalStateDatabaseOptions = {},
): OperationalStateDatabaseLease {
  const databasePath = resolveOperationalStateDatabasePath(workspaceRoot);
  let owner = owners.get(databasePath);
  if (!owner) {
    owner = new OperationalStateDatabaseOwner(databasePath, options);
    owners.set(databasePath, owner);
  }
  return owner.acquire();
}

/** Adopt a restored database and its persisted sessions into one new storage root. */
export async function adoptRestoredOperationalStateRootInternal<K extends StorageRootKind>(
  lease: OperationalStateDatabaseLease,
  capability: StorageRootCapability<K>,
  destinationRoot: string,
): Promise<void> {
  await assertStorageRootCapability(capability, capability.kind);
  if (
    realpathSync(resolveOperationalStateDatabasePath(capability.canonicalPath)) !==
    realpathSync(lease.databasePath)
  ) {
    throw new Error('Operational state database is unavailable for this storage root');
  }
  const canonicalDestination = resolve(destinationRoot);
  const committedAt = Date.now();
  lease.transaction('write', () => {
    lease.database
      .prepare(`
        INSERT INTO runtime_storage_root_binding(singleton, root_id, protocol_version)
        VALUES (1, ?, 1)
        ON CONFLICT(singleton) DO UPDATE SET
          root_id = excluded.root_id,
          protocol_version = excluded.protocol_version
      `)
      .run(capability.rootId);
    lease.database
      .prepare(`
        UPDATE session_metadata
        SET
          payload_json = json_set(payload_json, '$.workspaceRoot', json(?)),
          metadata_version = metadata_version + 1,
          committed_at = MAX(committed_at, ?)
        WHERE json_extract(payload_json, '$.workspaceRoot') IS NOT ?
      `)
      .run(JSON.stringify(canonicalDestination), committedAt, canonicalDestination);
  });
}

class OperationalStateDatabaseOwner {
  readonly database: DatabaseSync;
  private references = 0;
  private closed = false;
  private transactionDepth = 0;

  constructor(
    readonly databasePath: string,
    options: OperationalStateDatabaseOptions,
  ) {
    mkdirSync(dirname(databasePath), { recursive: true });
    const Database = loadDatabaseSync();
    this.database = new Database(databasePath);
    try {
      configureSqliteRuntimeLockWait(this.database);
      this.database.exec('PRAGMA foreign_keys = ON');
      if (inspectOperationalStateSchema(this.database).status === 'needs_migration') {
        migrateOperationalStateDatabaseInternal(this.database, options.now ?? Date.now);
      }
      configureSqliteRuntimeDatabase(this.database);
    } catch (error) {
      this.database.close();
      this.closed = true;
      throw error;
    }
  }

  acquire(): OperationalStateDatabaseLease {
    if (this.closed) throw new Error('Operational state database is closed');
    this.references += 1;
    let released = false;
    return {
      database: this.database,
      databasePath: this.databasePath,
      transaction: (mode, operation) => this.transaction(mode, operation),
      backup: (destinationPath) => this.backup(destinationPath),
      close: () => {
        if (released) return;
        released = true;
        this.releaseReference();
      },
    };
  }

  private async backup(destinationPath: string): Promise<number> {
    if (this.closed) throw new Error('Operational state database is closed');
    if (!destinationPath) throw new Error('Operational state backup destination is required');
    const canonicalDestination = resolve(destinationPath);
    if (canonicalDestination === this.databasePath) {
      throw new Error('Operational state backup destination must differ from the source database');
    }
    if (existsSync(canonicalDestination)) {
      throw new Error(
        `Operational state backup destination already exists: ${canonicalDestination}`,
      );
    }
    mkdirSync(dirname(canonicalDestination), { recursive: true });
    this.references += 1;
    try {
      return await loadSqliteModule().backup(this.database, canonicalDestination);
    } finally {
      this.releaseReference();
    }
  }

  private releaseReference(): void {
    this.references -= 1;
    if (this.references !== 0) return;
    this.closed = true;
    owners.delete(this.databasePath);
    this.database.close();
  }

  private transaction<T>(mode: 'read' | 'write', operation: () => T): T {
    if (this.closed) throw new Error('Operational state database is closed');
    if (this.transactionDepth > 0) return operation();
    this.database.exec(mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN');
    this.transactionDepth += 1;
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      rollback(this.database);
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }
}

export interface OperationalStateSchemaInspection {
  readonly status: 'current' | 'needs_migration';
  readonly versions: ReadonlyMap<string, number>;
}

export function inspectOperationalStateSchema(
  database: DatabaseSync,
): OperationalStateSchemaInspection {
  if (database.isTransaction) return inspectOperationalStateSchemaInternal(database);
  database.exec('BEGIN');
  try {
    const inspection = inspectOperationalStateSchemaInternal(database);
    database.exec('COMMIT');
    return inspection;
  } catch (error) {
    rollback(database);
    throw error;
  }
}

function inspectOperationalStateSchemaInternal(
  database: DatabaseSync,
): OperationalStateSchemaInspection {
  let needsMigration = false;
  const runtimeVersion = readUserVersion(database);
  const versions = new Map<string, number>([['runtime', runtimeVersion]]);
  assertSupportedOperationalSchemaVersion('runtime', runtimeVersion, SQLITE_RUNTIME_SCHEMA_VERSION);
  needsMigration ||= runtimeVersion < SQLITE_RUNTIME_SCHEMA_VERSION;

  if (hasTable(database, 'session_metadata_schema')) {
    const sessionMetadataVersion = readSqliteSessionMetadataSchemaVersion(database);
    versions.set('session_metadata', sessionMetadataVersion);
    assertSupportedOperationalSchemaVersion(
      'session_metadata',
      sessionMetadataVersion,
      SQLITE_SESSION_METADATA_SCHEMA_VERSION,
    );
    needsMigration ||= sessionMetadataVersion < SQLITE_SESSION_METADATA_SCHEMA_VERSION;
  } else {
    needsMigration = true;
  }

  if (!hasTable(database, 'operational_schema_migrations')) {
    if (runtimeVersion === 0 && !hasApplicationSchemaObjects(database)) {
      return { status: 'needs_migration', versions };
    }
    if (runtimeVersion === SQLITE_RUNTIME_SCHEMA_VERSION && hasOnlyRuntimeSchemaTables(database)) {
      assertRequiredSchemaTables(database, versions, RUNTIME_REQUIRED_SCHEMA_TABLES);
      assertRequiredSchemaTriggers(database, versions);
      return { status: 'needs_migration', versions };
    }
    throw new Error(
      'Operational schema registry is missing from a nonempty database; ' +
        'Maka did not migrate or delete the database. Restore or repair this workspace before opening it.',
    );
  }
  assertOperationalSchemaRegistryDefinition(database);
  const rows = database
    .prepare('SELECT scope, version FROM operational_schema_migrations')
    .all() as Array<{ scope?: unknown; version?: unknown }>;
  const registered = new Map<string, number>();
  for (const { scope, version } of rows) {
    if (typeof scope !== 'string') {
      throw new Error(
        'Operational schema registry has an invalid scope; ' +
          'Maka did not migrate or delete the database. Restore or repair this workspace before opening it.',
      );
    }
    const supportedVersion = OPERATIONAL_SCHEMA_VERSIONS.get(scope);
    if (supportedVersion === undefined) {
      throw new Error(
        `Operational schema ${scope} is unknown to this Maka build; ` +
          'Maka did not migrate or delete the database. Upgrade Maka to open this workspace.',
      );
    }
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
      throw new Error(
        `Operational schema ${scope} has invalid version ${String(version)}; ` +
          'Maka did not migrate or delete the database. Restore or repair this workspace before opening it.',
      );
    }
    assertSupportedOperationalSchemaVersion(scope, version, supportedVersion);
    registered.set(scope, version);
    if (scope !== 'runtime' && scope !== 'session_metadata') versions.set(scope, version);
  }
  for (const [scope, version] of OPERATIONAL_SCHEMA_VERSIONS) {
    needsMigration ||= (registered.get(scope) ?? -1) < version;
  }
  assertRequiredSchemaTables(database, versions);
  assertRequiredSchemaTriggers(database, versions);
  return { status: needsMigration ? 'needs_migration' : 'current', versions };
}

function assertOperationalSchemaRegistryDefinition(database: DatabaseSync): void {
  const columns = database
    .prepare('PRAGMA table_info(operational_schema_migrations)')
    .all() as Array<{ name?: unknown; type?: unknown; notnull?: unknown; pk?: unknown }>;
  const byName = new Map(columns.map((column) => [column.name, column]));
  const scope = byName.get('scope');
  const version = byName.get('version');
  const appliedAt = byName.get('applied_at');
  if (
    columns.length !== 3 ||
    scope?.type !== 'TEXT' ||
    scope.pk !== 1 ||
    version?.type !== 'INTEGER' ||
    version.notnull !== 1 ||
    version.pk !== 0 ||
    appliedAt?.type !== 'INTEGER' ||
    appliedAt.notnull !== 1 ||
    appliedAt.pk !== 0
  ) {
    throw new Error(
      'Operational schema registry has an invalid definition; ' +
        'Maka did not migrate or delete the database. Restore or repair this workspace before opening it.',
    );
  }
}

function assertRequiredSchemaTables(
  database: DatabaseSync,
  versions: ReadonlyMap<string, number>,
  tables: readonly {
    scope: string;
    name: string;
    introducedIn: number;
    removedIn?: number;
  }[] = REQUIRED_SCHEMA_TABLES,
): void {
  const tableExists = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  );
  for (const table of tables) {
    const version = versions.get(table.scope) ?? -1;
    if (version < table.introducedIn || version >= (table.removedIn ?? Infinity)) continue;
    if (tableExists.get(table.name) === undefined) {
      throw new Error(`required table is missing: ${table.name}`);
    }
  }
}

function assertRequiredSchemaTriggers(
  database: DatabaseSync,
  versions: ReadonlyMap<string, number>,
): void {
  const readTrigger = database.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'trigger' AND name = ?
  `);
  for (const trigger of REQUIRED_SCHEMA_TRIGGERS) {
    const version = versions.get(trigger.scope);
    if (version === undefined || version < trigger.introducedIn) continue;
    const row = readTrigger.get(trigger.name) as { sql?: unknown } | undefined;
    if (!row) throw new Error(`required trigger is missing: ${trigger.name}`);
    if (
      typeof row.sql !== 'string' ||
      normalizeSchemaSql(row.sql) !== normalizeSchemaSql(trigger.sql)
    ) {
      throw new Error(`required trigger definition changed: ${trigger.name}`);
    }
  }
}

function normalizeSchemaSql(sql: string): string {
  return sql
    .replace(/\bIF NOT EXISTS\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;$/, '');
}

function assertSupportedOperationalSchemaVersion(
  scope: string,
  observedVersion: number,
  supportedVersion: number,
): void {
  if (observedVersion <= supportedVersion) return;
  throw new Error(
    `Operational schema ${scope} is newer than supported version ${supportedVersion}; ` +
      'Maka did not migrate or delete the database. Upgrade Maka to open this workspace.',
  );
}

function hasTable(database: DatabaseSync, name: string): boolean {
  const table = database
    .prepare(`
      SELECT 1 AS present
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `)
    .get(name) as { present?: unknown } | undefined;
  return table?.present === 1;
}

function hasApplicationSchemaObjects(database: DatabaseSync): boolean {
  const object = database
    .prepare("SELECT 1 AS present FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1")
    .get() as { present?: unknown } | undefined;
  return object?.present === 1;
}

function hasOnlyRuntimeSchemaTables(database: DatabaseSync): boolean {
  const tables = database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name?: unknown }>;
  return tables.every(
    ({ name }) => typeof name === 'string' && RUNTIME_SCHEMA_TABLE_NAMES.has(name),
  );
}

export function migrateOperationalStateDatabaseInternal(db: DatabaseSync, now: () => number): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = inspectOperationalStateSchema(db).status === 'current';
    if (current) {
      db.exec('COMMIT');
      return;
    }
    migrateSqliteRuntimeDatabase(db, { transaction: 'caller' });
    migrateSqliteSessionMetadataDatabase(db, { transaction: 'caller' });
    migrateSqliteCoreExecutionDatabase(db);
    migrateSqliteWorkflowDatabase(db);
    migrateSqliteUsageDatabase(db);
    migrateSqliteArtifactDatabase(db);
    migrateSqliteAutomationDatabase(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS operational_schema_migrations (
        scope TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version >= 0),
        applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
      );
    `);
    const appliedAt = now();
    for (const [scope, version] of OPERATIONAL_SCHEMA_VERSIONS) {
      registerSchema(db, scope, version, appliedAt);
    }
    assertRequiredSchemaTables(db, OPERATIONAL_SCHEMA_VERSIONS);
    assertRequiredSchemaTriggers(db, OPERATIONAL_SCHEMA_VERSIONS);
    db.exec('COMMIT');
  } catch (error) {
    rollback(db);
    throw error;
  }
}

function registerSchema(db: DatabaseSync, scope: string, version: number, appliedAt: number): void {
  const existing = db
    .prepare('SELECT version FROM operational_schema_migrations WHERE scope = ?')
    .get(scope) as { version?: unknown } | undefined;
  if (existing) {
    if (
      typeof existing.version !== 'number' ||
      !Number.isSafeInteger(existing.version) ||
      existing.version < 0
    ) {
      throw new Error(
        `Operational schema ${scope} has invalid version ${String(existing.version)}; ` +
          'Maka did not migrate or delete the database. Restore or repair this workspace before opening it.',
      );
    }
    assertSupportedOperationalSchemaVersion(scope, existing.version, version);
  }
  db.prepare(`
    INSERT INTO operational_schema_migrations(scope, version, applied_at)
    VALUES (?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET
      version = excluded.version,
      applied_at = CASE
        WHEN operational_schema_migrations.version = excluded.version
        THEN operational_schema_migrations.applied_at
        ELSE excluded.applied_at
      END
  `).run(scope, version, appliedAt);
}

function loadDatabaseSync(): typeof import('node:sqlite').DatabaseSync {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const warningType = typeof args[0] === 'string' ? args[0] : undefined;
    if (
      warningType === 'ExperimentalWarning' &&
      String(warning).startsWith('SQLite is an experimental feature')
    ) {
      return;
    }
    Reflect.apply(emitWarning, process, [warning, ...args]);
  }) as typeof process.emitWarning;
  try {
    return (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
  } finally {
    process.emitWarning = emitWarning;
  }
}

function loadSqliteModule(): typeof import('node:sqlite') {
  return require('node:sqlite') as typeof import('node:sqlite');
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // Preserve the failure that triggered rollback.
  }
}
