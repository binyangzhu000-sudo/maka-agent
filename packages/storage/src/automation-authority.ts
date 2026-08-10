import type {
  AutomationAuthoritySnapshot,
  AutomationDefinition,
  AutomationPendingFire,
} from '@maka/core/automation';
import {
  assertAutomationSnapshotRelationships,
  normalizeAutomationDefinitionRecord,
  normalizeAutomationPendingFireRecord,
} from './automation-record-codec.js';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';

const MAX_AUTOMATIONS = 10_000;
const MAX_PENDING_FIRES = 10_000;

const writerBrand: unique symbol = Symbol('InteractiveAutomationAuthorityWriter');
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, InteractiveAutomationAuthorityWriter>();
const writerOpeningByLease = new WeakMap<object, Promise<InteractiveAutomationAuthorityWriter>>();

export interface CommitAutomationAuthorityInput {
  readonly expectedRevision: number;
  readonly automations: readonly AutomationDefinition[];
  readonly pendingFires: readonly AutomationPendingFire[];
}

export type CommitAutomationAuthorityResult =
  | { readonly kind: 'committed'; readonly snapshot: AutomationAuthoritySnapshot }
  | { readonly kind: 'revision_conflict'; readonly actualRevision: number };

export interface InteractiveAutomationAuthorityWriter {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
  read(): Promise<AutomationAuthoritySnapshot>;
  commit(input: CommitAutomationAuthorityInput): Promise<CommitAutomationAuthorityResult>;
  close(): void;
}

export interface AutomationAuthorityRepository {
  ready(): Promise<void>;
  read(): AutomationAuthoritySnapshot;
  commit(input: CommitAutomationAuthorityInput): CommitAutomationAuthorityResult;
  close(): void;
}

export function createSqliteAutomationAuthority(
  workspaceRoot: string,
): AutomationAuthorityRepository {
  return new SqliteAutomationAuthority(workspaceRoot);
}

export function authenticateInteractiveAutomationAuthorityWriter(
  writer: InteractiveAutomationAuthorityWriter,
): InteractiveAutomationAuthorityWriter {
  if (!writers.has(writer)) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Expected an authentic interactive Automation authority writer',
    );
  }
  return writer;
}

export async function openInteractiveAutomationAuthorityForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveAutomationAuthorityWriter> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = writerByLease.get(lease);
  if (existing) return existing;
  const opening = writerOpeningByLease.get(lease);
  if (opening) return opening;

  const pending = Promise.resolve().then(async () => {
    let store: SqliteAutomationAuthority | undefined;
    try {
      store = await runWithStorageRootLease(lease, 'interactive', 'write', async (root) => {
        const opened = new SqliteAutomationAuthority(root);
        await opened.ready();
        return opened;
      });
      await assertStorageRootLease(lease, 'interactive', 'write');
      const recoveredExisting = writerByLease.get(lease);
      if (recoveredExisting) {
        store.close();
        return recoveredExisting;
      }
      const writer = createWriterFacade(lease, store);
      writers.add(writer);
      writerByLease.set(lease, writer);
      return writer;
    } catch (error) {
      store?.close();
      throw error;
    }
  });
  writerOpeningByLease.set(lease, pending);
  try {
    return await pending;
  } finally {
    if (writerOpeningByLease.get(lease) === pending) writerOpeningByLease.delete(lease);
  }
}

function createWriterFacade(
  lease: StorageRootLease<'interactive', 'write'>,
  store: SqliteAutomationAuthority,
): InteractiveAutomationAuthorityWriter {
  let closed = false;
  const run = <T>(operation: () => T | Promise<T>): Promise<T> => {
    if (closed) {
      return Promise.reject(
        new StorageRootAuthorityError('invalid_lease', 'Automation authority writer is closed'),
      );
    }
    return runWithStorageRootLease(lease, 'interactive', 'write', async () => operation());
  };
  const writer: InteractiveAutomationAuthorityWriter = {
    kind: 'interactive',
    access: 'write',
    [writerBrand]: true,
    read: () => run(() => store.read()),
    commit: (input) => {
      const accepted = normalizeCommitInput(input);
      return run(() => store.commit(accepted));
    },
    close: () => {
      if (closed) return;
      closed = true;
      if (writerByLease.get(lease) === writer) writerByLease.delete(lease);
      writers.delete(writer);
      store.close();
    },
  };
  return Object.freeze(writer);
}

class SqliteAutomationAuthority implements AutomationAuthorityRepository {
  readonly #lease: OperationalStateDatabaseLease;

  constructor(root: string) {
    this.#lease = acquireOperationalStateDatabase(root);
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  read(): AutomationAuthoritySnapshot {
    const revision = readRevision(this.#lease);
    const automations = this.#lease.database
      .prepare(`
        SELECT automation_id, session_id, created_at, status, record_json
        FROM automation_definitions
        ORDER BY created_at, automation_id
      `)
      .all()
      .map((row) => readDefinitionRow(row));
    const pendingFires = this.#lease.database
      .prepare(`
        SELECT fire_id, automation_id, target_session_id, admitted_at, record_json
        FROM automation_pending_fires
        ORDER BY admitted_at, fire_id
      `)
      .all()
      .map((row) => readPendingFireRow(row));
    assertAutomationSnapshotRelationships(automations, pendingFires);
    return cloneSnapshot({ revision, automations, pendingFires });
  }

  commit(input: CommitAutomationAuthorityInput): CommitAutomationAuthorityResult {
    return this.#lease.transaction('write', () => {
      const actualRevision = readRevision(this.#lease);
      if (actualRevision !== input.expectedRevision) {
        return { kind: 'revision_conflict', actualRevision };
      }
      const existingDefinitions = new Map(
        this.#lease.database
          .prepare('SELECT automation_id, record_json FROM automation_definitions')
          .all()
          .map((row) => readRecordJsonIndexRow(row, 'automation_id')),
      );
      const existingFires = new Map(
        this.#lease.database
          .prepare('SELECT fire_id, record_json FROM automation_pending_fires')
          .all()
          .map((row) => readRecordJsonIndexRow(row, 'fire_id')),
      );
      const desiredDefinitionIds = new Set(input.automations.map((automation) => automation.id));
      const desiredFireIds = new Set(input.pendingFires.map((fire) => fire.id));
      const deleteFire = this.#lease.database.prepare(
        'DELETE FROM automation_pending_fires WHERE fire_id = ?',
      );
      for (const fireId of existingFires.keys()) {
        if (!desiredFireIds.has(fireId)) deleteFire.run(fireId);
      }
      const deleteDefinition = this.#lease.database.prepare(
        'DELETE FROM automation_definitions WHERE automation_id = ?',
      );
      for (const automationId of existingDefinitions.keys()) {
        if (!desiredDefinitionIds.has(automationId)) deleteDefinition.run(automationId);
      }
      const upsertDefinition = this.#lease.database.prepare(`
        INSERT INTO automation_definitions(
          automation_id, session_id, created_at, status, record_json
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(automation_id) DO UPDATE SET
          session_id = excluded.session_id,
          created_at = excluded.created_at,
          status = excluded.status,
          record_json = excluded.record_json
      `);
      for (const automation of input.automations) {
        const encoded = JSON.stringify(automation);
        if (existingDefinitions.get(automation.id) === encoded) continue;
        upsertDefinition.run(
          automation.id,
          automation.sessionId,
          automation.createdAt,
          automation.status,
          encoded,
        );
      }
      const changedFires = input.pendingFires
        .map((fire) => ({ fire, encoded: JSON.stringify(fire) }))
        .filter(({ fire, encoded }) => existingFires.get(fire.id) !== encoded);
      for (const { fire } of changedFires) {
        if (existingFires.has(fire.id)) deleteFire.run(fire.id);
      }
      const insertFire = this.#lease.database.prepare(`
        INSERT INTO automation_pending_fires(
          fire_id, automation_id, target_session_id, admitted_at, record_json
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const { fire, encoded } of changedFires) {
        insertFire.run(fire.id, fire.automationId, fire.targetSessionId, fire.admittedAt, encoded);
      }
      const revision = actualRevision + 1;
      const updated = this.#lease.database
        .prepare('UPDATE automation_authority_state SET revision = ? WHERE singleton = 1')
        .run(revision);
      if (updated.changes !== 1) throw new Error('Unable to advance Automation revision');
      return {
        kind: 'committed',
        snapshot: cloneSnapshot({
          revision,
          automations: input.automations,
          pendingFires: input.pendingFires,
        }),
      };
    });
  }

  close(): void {
    this.#lease.close();
  }
}

function normalizeCommitInput(
  input: CommitAutomationAuthorityInput,
): CommitAutomationAuthorityInput {
  if (!isNonnegativeInteger(input.expectedRevision)) {
    throw new Error('Expected Automation revision must be a non-negative integer');
  }
  if (!Array.isArray(input.automations) || input.automations.length > MAX_AUTOMATIONS) {
    throw new Error('Automation definitions exceed the authority limit');
  }
  if (!Array.isArray(input.pendingFires) || input.pendingFires.length > MAX_PENDING_FIRES) {
    throw new Error('Pending Automation fires exceed the authority limit');
  }
  const automations = input.automations.map((automation) =>
    normalizeAutomationDefinitionRecord(automation),
  );
  const pendingFires = input.pendingFires.map(normalizeAutomationPendingFireRecord);
  assertUnique(
    automations.map((automation) => automation.id),
    'Automation id',
  );
  assertUnique(
    pendingFires.map((fire) => fire.id),
    'Automation fire id',
  );
  assertUnique(
    pendingFires.map((fire) => fire.automationId),
    'pending Automation id',
  );
  assertAutomationSnapshotRelationships(automations, pendingFires);
  return { expectedRevision: input.expectedRevision, automations, pendingFires };
}

function readDefinitionRow(value: unknown): AutomationDefinition {
  if (!isRecord(value) || typeof value.record_json !== 'string') {
    throw new Error('Invalid SQLite Automation definition row');
  }
  const definition = normalizeAutomationDefinitionRecord(JSON.parse(value.record_json));
  if (
    value.automation_id !== definition.id ||
    value.session_id !== definition.sessionId ||
    value.created_at !== definition.createdAt ||
    value.status !== definition.status
  ) {
    throw new Error(`SQLite Automation definition index mismatch: ${definition.id}`);
  }
  return definition;
}

function readPendingFireRow(value: unknown): AutomationPendingFire {
  if (!isRecord(value) || typeof value.record_json !== 'string') {
    throw new Error('Invalid SQLite pending Automation fire row');
  }
  const fire = normalizeAutomationPendingFireRecord(JSON.parse(value.record_json));
  if (
    value.fire_id !== fire.id ||
    value.automation_id !== fire.automationId ||
    value.target_session_id !== fire.targetSessionId ||
    value.admitted_at !== fire.admittedAt
  ) {
    throw new Error(`SQLite pending Automation fire index mismatch: ${fire.id}`);
  }
  return fire;
}

function readRevision(lease: OperationalStateDatabaseLease): number {
  const row = lease.database
    .prepare('SELECT revision FROM automation_authority_state WHERE singleton = 1')
    .get() as { revision?: unknown } | undefined;
  if (!row || !isNonnegativeInteger(row.revision)) {
    throw new Error('Invalid Automation authority revision');
  }
  return row.revision;
}

function cloneSnapshot(snapshot: AutomationAuthoritySnapshot): AutomationAuthoritySnapshot {
  return structuredClone(snapshot);
}

function readRecordJsonIndexRow(
  value: unknown,
  key: 'automation_id' | 'fire_id',
): readonly [string, string] {
  if (!isRecord(value) || typeof value[key] !== 'string' || typeof value.record_json !== 'string') {
    throw new Error('Invalid SQLite Automation index row');
  }
  return [value[key], value.record_json];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}
