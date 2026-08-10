import {
  isBotDeliveryProvider,
  isCollaborationMode,
  isOrchestrationMode,
  isThinkingLevel,
} from '@maka/core';
import type { AutomationDefinition, AutomationPendingFire } from '@maka/core/automation';
import type { ScheduledTask, ScheduledTaskRun } from '@maka/core/scheduled-task';
import type { DatabaseSync } from 'node:sqlite';
import {
  assertAutomationSnapshotRelationships,
  normalizeAutomationDefinitionRecord,
  normalizeAutomationPendingFireRecord,
} from './automation-record-codec.js';
import { canonicalizeLegacyCronExpression } from './legacy-cron-expression.js';

export interface LegacyAutomationMigration {
  readonly revision: number;
  readonly definitions: readonly AutomationDefinition[];
  readonly pendingFires: readonly AutomationPendingFire[];
  readonly scheduledTasks: readonly ScheduledTask[];
}

type LegacyAutomationTarget =
  | { readonly kind: 'automation'; readonly definition: AutomationDefinition }
  | { readonly kind: 'scheduled_task'; readonly task: ScheduledTask };

export function readLegacyAutomationMigration(
  database: DatabaseSync,
): LegacyAutomationMigration | undefined {
  if (!hasColumn(database, 'automation_definitions', 'durable')) return undefined;
  const revisionRow = database
    .prepare('SELECT revision FROM automation_authority_state WHERE singleton = 1')
    .get() as { revision?: unknown } | undefined;
  const revision = requireNonnegativeInteger(
    revisionRow?.revision,
    'legacy Automation authority revision',
  );
  const targets = database
    .prepare(`
      SELECT automation_id, session_id, created_at, status, durable, record_json
      FROM automation_definitions
      ORDER BY created_at, automation_id
    `)
    .all()
    .map((row) => decodeLegacyAutomationDefinition(database, row));
  const byId = new Map(
    targets.map((target) => [
      target.kind === 'automation' ? target.definition.id : target.task.id,
      target,
    ]),
  );
  const pendingFires = database
    .prepare(`
      SELECT fire_id, automation_id, target_session_id, admitted_at, record_json
      FROM automation_pending_fires
      ORDER BY admitted_at, fire_id
    `)
    .all()
    .map((row) => decodeLegacyAutomationPendingFire(row, byId));
  return {
    revision,
    definitions: targets.flatMap((target) =>
      target.kind === 'automation' ? [target.definition] : [],
    ),
    pendingFires,
    scheduledTasks: targets.flatMap((target) =>
      target.kind === 'scheduled_task' ? [target.task] : [],
    ),
  };
}

export function insertMigratedAutomationState(
  database: DatabaseSync,
  migration: LegacyAutomationMigration | undefined,
): void {
  if (!migration) return;
  const insertDefinition = database.prepare(`
    INSERT INTO automation_definitions(
      automation_id, session_id, created_at, status, record_json
    ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const definition of migration.definitions) {
    insertDefinition.run(
      definition.id,
      definition.sessionId,
      definition.createdAt,
      definition.status,
      JSON.stringify(definition),
    );
  }
  const insertFire = database.prepare(`
    INSERT INTO automation_pending_fires(
      fire_id, automation_id, target_session_id, admitted_at, record_json
    ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const fire of migration.pendingFires) {
    insertFire.run(
      fire.id,
      fire.automationId,
      fire.targetSessionId,
      fire.admittedAt,
      JSON.stringify(fire),
    );
  }
  database
    .prepare('UPDATE automation_authority_state SET revision = ? WHERE singleton = 1')
    .run(migration.revision);
  insertMigratedScheduledTasks(database, migration.scheduledTasks);
}

export function readLegacyPlanReminderTasks(database: DatabaseSync): ScheduledTask[] {
  if (!hasTable(database, 'workflow_plan_reminders')) return [];
  const rows = database
    .prepare(`
      SELECT reminder_id, created_at, updated_at, record_json
      FROM workflow_plan_reminders
      ORDER BY created_at, reminder_id
    `)
    .all() as Array<{
    reminder_id?: unknown;
    created_at?: unknown;
    updated_at?: unknown;
    record_json?: unknown;
  }>;
  return rows.map((row, index) => decodeLegacyPlanReminder(row, index));
}

export function insertMigratedScheduledTasks(
  database: DatabaseSync,
  tasks: readonly ScheduledTask[],
): void {
  if (tasks.length === 0) return;
  const insert = database.prepare(`
    INSERT INTO workflow_scheduled_tasks(task_id, created_at, updated_at, record_json)
    VALUES (?, ?, ?, ?)
  `);
  for (const task of tasks) {
    insert.run(task.id, task.createdAt, task.updatedAt, JSON.stringify(task));
  }
}

function decodeLegacyAutomationDefinition(
  database: DatabaseSync,
  value: unknown,
): LegacyAutomationTarget {
  const row = requireRecord(value, 'legacy Automation definition row');
  const record = parseRecord(row.record_json, 'legacy Automation definition');
  const { kind, durable, execution, ...currentRecord } = record;
  const definition = normalizeAutomationDefinitionRecord({
    ...currentRecord,
    schedule: canonicalizeLegacyAutomationSchedule(currentRecord.schedule),
  });
  if (
    row.automation_id !== definition.id ||
    row.session_id !== definition.sessionId ||
    row.created_at !== definition.createdAt ||
    row.status !== definition.status ||
    row.durable !== (durable === true ? 1 : 0)
  ) {
    throw new Error(`Legacy Automation indexes contradict record JSON: ${definition.id}`);
  }
  if (kind === 'heartbeat' && durable !== true && execution === undefined) {
    return { kind: 'automation', definition };
  }
  if (kind !== 'cron') {
    throw new Error(`Invalid legacy Automation kind: ${definition.id}`);
  }
  return {
    kind: 'scheduled_task',
    task: convertLegacyCronAutomation(
      execution ?? readLegacyAutomationExecution(database, definition.sessionId),
      definition,
    ),
  };
}

function readLegacyAutomationExecution(database: DatabaseSync, sessionId: string): unknown {
  if (!hasTable(database, 'session_metadata')) {
    throw new Error(`Legacy cron Automation has no creator Session: ${sessionId}`);
  }
  const row = database
    .prepare('SELECT payload_json FROM session_metadata WHERE session_id = ?')
    .get(sessionId) as { payload_json?: unknown } | undefined;
  if (!row) throw new Error(`Legacy cron Automation has no creator Session: ${sessionId}`);
  const header = parseRecord(row.payload_json, 'legacy cron creator Session');
  return {
    cwd: header.cwd,
    ...(header.projectId === undefined ? {} : { projectId: header.projectId }),
    backend: header.backend,
    llmConnectionSlug: header.llmConnectionSlug,
    model: header.model,
    ...(header.thinkingLevel === undefined ? {} : { thinkingLevel: header.thinkingLevel }),
    collaborationMode: header.collaborationMode ?? 'agent',
    orchestrationMode: header.orchestrationMode ?? 'default',
  };
}

function canonicalizeLegacyAutomationSchedule(value: unknown): unknown {
  const schedule = requireRecord(value, 'legacy Automation schedule');
  if (schedule.type !== 'cron') return schedule;
  return {
    ...schedule,
    expression: canonicalizeLegacyCronExpression(
      requireString(schedule.expression, 'legacy Automation cron expression'),
      'automation-v1',
    ),
  };
}

function decodeLegacyAutomationPendingFire(
  value: unknown,
  definitions: ReadonlyMap<string, LegacyAutomationTarget>,
): AutomationPendingFire {
  const row = requireRecord(value, 'legacy pending Automation fire row');
  const record = parseRecord(row.record_json, 'legacy pending Automation fire');
  const { automationKind, execution: _execution, ...currentRecord } = record;
  const fire = normalizeAutomationPendingFireRecord(currentRecord);
  if (
    row.fire_id !== fire.id ||
    row.automation_id !== fire.automationId ||
    row.target_session_id !== fire.targetSessionId ||
    row.admitted_at !== fire.admittedAt
  ) {
    throw new Error(`Legacy pending Automation indexes contradict record JSON: ${fire.id}`);
  }
  const target = definitions.get(fire.automationId);
  if (!target) throw new Error(`Legacy pending Automation has no definition: ${fire.id}`);
  if (target.kind === 'scheduled_task') {
    throw new Error(
      `Legacy cron Automation has an in-flight fire and cannot migrate safely: ${fire.id}`,
    );
  }
  if (automationKind !== 'heartbeat') throw new Error(`Invalid legacy Automation kind: ${fire.id}`);
  assertAutomationSnapshotRelationships([target.definition], [fire]);
  return fire;
}

function convertLegacyCronAutomation(
  execution: unknown,
  definition: AutomationDefinition,
): ScheduledTask {
  const lastRun =
    definition.lastRunId === null || definition.lastFireAt === null
      ? []
      : [
          {
            id: definition.lastRunId,
            at: definition.lastFireAt,
            outcome: definition.lastError === null ? ('ok' as const) : ('failed' as const),
            message: definition.lastError ?? 'Migrated legacy Automation run',
          },
        ];
  return {
    id: definition.id,
    title: definition.name,
    intent: { kind: 'text', body: definition.prompt },
    schedule: convertLegacyCronSchedule(definition),
    effect: {
      kind: 'agent_run',
      execution: decodeLegacyAutomationExecution(execution),
    },
    status: definition.status,
    nextFireAt: definition.nextFireAt,
    lastFireAt: definition.lastFireAt,
    fireCount: definition.fireCount,
    maxFires: definition.maxFires,
    expiresAt: definition.expiresAt,
    createdBy: { kind: 'agent', sessionId: definition.sessionId },
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
    runs: lastRun,
    lastError: definition.lastError,
  };
}

function convertLegacyCronSchedule(definition: AutomationDefinition): ScheduledTask['schedule'] {
  if (definition.schedule.type === 'cron') {
    return {
      kind: 'cron',
      expression: canonicalizeLegacyCronExpression(definition.schedule.expression, 'automation-v1'),
      startAt: definition.createdAt,
    };
  }
  if (definition.schedule.type === 'interval') {
    return {
      kind: 'interval',
      everySeconds: definition.schedule.seconds,
      startAt: definition.nextFireAt ?? definition.createdAt,
    };
  }
  return {
    kind: 'once',
    runAt: definition.nextFireAt ?? definition.createdAt + definition.schedule.delaySeconds * 1_000,
  };
}

function decodeLegacyAutomationExecution(
  value: unknown,
): Extract<ScheduledTask['effect'], { kind: 'agent_run' }>['execution'] {
  const execution = requireRecord(value, 'legacy Automation execution');
  const backend = requireOneOf(execution.backend, ['ai-sdk', 'fake', 'pi-agent'] as const);
  const collaborationMode = execution.collaborationMode;
  if (!isCollaborationMode(collaborationMode)) {
    throw new Error('Invalid legacy Automation collaboration mode');
  }
  const orchestrationMode = execution.orchestrationMode;
  if (!isOrchestrationMode(orchestrationMode)) {
    throw new Error('Invalid legacy Automation orchestration mode');
  }
  const thinkingLevel = execution.thinkingLevel;
  if (thinkingLevel !== undefined && !isThinkingLevel(thinkingLevel)) {
    throw new Error('Invalid legacy Automation thinking level');
  }
  const projectId = execution.projectId;
  if (!(projectId === undefined || projectId === null || typeof projectId === 'string')) {
    throw new Error('Invalid legacy Automation project id');
  }
  return {
    cwd: requireString(execution.cwd, 'legacy Automation cwd'),
    ...(projectId === undefined ? {} : { projectId }),
    backend,
    llmConnectionSlug: requireString(execution.llmConnectionSlug, 'legacy Automation connection'),
    model: requireString(execution.model, 'legacy Automation model'),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    permissionMode: 'explore',
    collaborationMode,
    orchestrationMode,
  };
}

function decodeLegacyPlanReminder(
  row: {
    reminder_id?: unknown;
    created_at?: unknown;
    updated_at?: unknown;
    record_json?: unknown;
  },
  index: number,
): ScheduledTask {
  const value = parseRecord(row.record_json, `legacy plan reminder ${index + 1}`);
  const id = requireString(value.id, 'legacy plan reminder id');
  const createdAt = requireNonnegativeInteger(value.createdAt, 'legacy plan reminder createdAt');
  const updatedAt = requireNonnegativeInteger(value.updatedAt, 'legacy plan reminder updatedAt');
  if (row.reminder_id !== id || row.created_at !== createdAt || row.updated_at !== updatedAt) {
    throw new Error(`Legacy plan reminder indexes contradict record JSON: ${id}`);
  }
  const status = requireOneOf(value.status, ['scheduled', 'paused', 'completed'] as const);
  const enabled = requireBoolean(value.enabled, 'legacy plan reminder enabled');
  const nextRunAt = optionalNonnegativeInteger(value.nextRunAt, 'legacy plan reminder nextRunAt');
  const runs = requireArray(value.runs, 'legacy plan reminder runs').map(decodeLegacyRun);
  const lastRun = value.lastRun === undefined ? undefined : decodeLegacyRun(value.lastRun);
  return {
    id,
    title: requireString(value.title, 'legacy plan reminder title'),
    intent: {
      kind: 'text',
      body: requireString(value.note, 'legacy plan reminder note'),
    },
    schedule: decodeLegacyReminderSchedule(value.schedule),
    effect: decodeLegacyReminderDelivery(value.delivery),
    status:
      status === 'scheduled' && enabled
        ? 'active'
        : status === 'completed'
          ? 'completed'
          : 'paused',
    nextFireAt: status === 'scheduled' && enabled ? (nextRunAt ?? null) : null,
    lastFireAt: lastRun?.at ?? null,
    fireCount: requireNonnegativeInteger(value.runCount, 'legacy plan reminder runCount'),
    maxFires: null,
    expiresAt: null,
    createdBy: { kind: 'user' },
    createdAt,
    updatedAt,
    runs,
    lastError: lastRun && lastRun.outcome !== 'ok' ? lastRun.message : null,
  };
}

function decodeLegacyReminderSchedule(value: unknown): ScheduledTask['schedule'] {
  const schedule = requireRecord(value, 'legacy plan reminder schedule');
  if (schedule.kind === 'once') {
    return {
      kind: 'once',
      runAt: requireNonnegativeInteger(schedule.runAt, 'legacy plan reminder runAt'),
    };
  }
  if (schedule.kind === 'recurring') {
    return {
      kind: 'calendar',
      recurrence: requireOneOf(schedule.recurrence, ['daily', 'weekly', 'monthly'] as const),
      anchorAt: requireNonnegativeInteger(schedule.startAt, 'legacy plan reminder startAt'),
    };
  }
  if (schedule.kind === 'cron') {
    return {
      kind: 'cron',
      expression: canonicalizeLegacyCronExpression(
        requireString(schedule.expression, 'legacy plan reminder cron expression'),
        'plan-reminder-v1',
      ),
      startAt: requireNonnegativeInteger(schedule.startAt, 'legacy plan reminder startAt'),
    };
  }
  throw new Error('Invalid legacy plan reminder schedule');
}

function decodeLegacyReminderDelivery(value: unknown): ScheduledTask['effect'] {
  const delivery = requireRecord(value, 'legacy plan reminder delivery');
  if (delivery.channel === 'local') return { kind: 'notify', channel: 'local' };
  if (delivery.channel === 'bot') {
    if (!isBotDeliveryProvider(delivery.platform)) {
      throw new Error('Invalid legacy plan reminder bot platform');
    }
    return {
      kind: 'notify',
      channel: 'bot',
      platform: delivery.platform,
      chatId: requireString(delivery.chatId, 'legacy plan reminder chatId'),
    };
  }
  throw new Error('Invalid legacy plan reminder delivery');
}

function decodeLegacyRun(value: unknown, index?: number): ScheduledTaskRun {
  const run = requireRecord(
    value,
    `legacy plan reminder run${index === undefined ? '' : ` ${index + 1}`}`,
  );
  return {
    id: requireString(run.id, 'legacy plan reminder run id'),
    at: requireNonnegativeInteger(run.at, 'legacy plan reminder run at'),
    outcome:
      run.status === 'triggered' ? 'ok' : requireOneOf(run.status, ['blocked', 'failed'] as const),
    message: requireString(run.message, 'legacy plan reminder run message'),
  };
}

function hasTable(database: DatabaseSync, name: string): boolean {
  return (
    database
      .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

function parseRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'string') throw new Error(`Invalid ${label} record JSON`);
  try {
    return requireRecord(JSON.parse(value), label);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid ${label} record JSON`);
    throw error;
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid ${label}`);
  return value;
}

function requireNonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function optionalNonnegativeInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : requireNonnegativeInteger(value, label);
}

function hasColumn(database: DatabaseSync, table: string, column: string): boolean {
  return (
    database
      .prepare(`SELECT 1 AS present FROM pragma_table_info(?) WHERE name = ?`)
      .get(table, column) !== undefined
  );
}

function requireOneOf<const T extends readonly string[]>(value: unknown, choices: T): T[number] {
  if (typeof value !== 'string' || !choices.includes(value)) throw new Error('Invalid enum value');
  return value as T[number];
}
