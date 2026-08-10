import {
  AUTOMATION_CRON_EXPRESSION_LIMIT,
  AUTOMATION_LAST_ERROR_LIMIT,
  AUTOMATION_MAX_CLIENT_CAPABILITY_REQUIREMENTS,
  AUTOMATION_NAME_LIMIT,
  AUTOMATION_PROMPT_LIMIT,
  isAutomationTextWithinLimit,
  type AutomationClientCapabilityRequirement,
  type AutomationDefinition,
  type AutomationPendingFire,
  type AutomationSchedule,
  type AutomationWaitingState,
} from '@maka/core/automation';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DEFINITION_KEYS = new Set([
  'id',
  'name',
  'status',
  'prompt',
  'sessionId',
  'schedule',
  'createdAt',
  'updatedAt',
  'nextFireAt',
  'lastFireAt',
  'lastRunId',
  'fireCount',
  'maxFires',
  'expiresAt',
  'lastError',
  'consecutiveFailures',
  'deferredFireCount',
  'capabilityRequirements',
  'waiting',
]);
const PENDING_FIRE_KEYS = new Set([
  'id',
  'automationId',
  'automationName',
  'prompt',
  'scheduledFor',
  'targetSessionId',
  'turnId',
  'runId',
  'userMessageId',
  'status',
  'admittedAt',
  'updatedAt',
  'transientDeferredSince',
  'startedAt',
  'capabilityRequirements',
]);

export function normalizeAutomationDefinitionRecord(value: unknown): AutomationDefinition {
  if (!isRecord(value) || !hasOnlyKeys(value, DEFINITION_KEYS)) {
    throw new Error('Invalid Automation definition');
  }
  const schedule = normalizeSchedule(value.schedule);
  const capabilityRequirements = normalizeCapabilityRequirements(value.capabilityRequirements);
  const waiting = value.waiting === undefined ? undefined : normalizeWaitingState(value.waiting);
  if (!isId(value.id) || !isId(value.sessionId)) throw new Error('Invalid Automation identity');
  if (
    (value.status !== 'active' &&
      value.status !== 'paused' &&
      value.status !== 'completed' &&
      value.status !== 'expired') ||
    !isAutomationTextWithinLimit(value.name, AUTOMATION_NAME_LIMIT, { nonblank: true }) ||
    !isAutomationTextWithinLimit(value.prompt, AUTOMATION_PROMPT_LIMIT, { nonblank: true })
  ) {
    throw new Error('Invalid Automation state');
  }
  const lastError = normalizeLastError(value.lastError);
  if (
    !isNonnegativeInteger(value.createdAt) ||
    !isNonnegativeInteger(value.updatedAt) ||
    !isNullableNonnegativeInteger(value.nextFireAt) ||
    !isNullableNonnegativeInteger(value.lastFireAt) ||
    !(value.lastRunId === null || isId(value.lastRunId)) ||
    !isNonnegativeInteger(value.fireCount) ||
    !(value.maxFires === null || (isNonnegativeInteger(value.maxFires) && value.maxFires > 0)) ||
    !isNullableNonnegativeInteger(value.expiresAt) ||
    lastError === undefined ||
    !isNonnegativeInteger(value.consecutiveFailures) ||
    !(value.deferredFireCount === undefined || isNonnegativeInteger(value.deferredFireCount))
  ) {
    throw new Error('Invalid Automation counters or timestamps');
  }
  return structuredClone({
    id: value.id,
    name: value.name,
    status: value.status,
    prompt: value.prompt,
    sessionId: value.sessionId,
    schedule,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    nextFireAt: value.nextFireAt,
    lastFireAt: value.lastFireAt,
    lastRunId: value.lastRunId,
    fireCount: value.fireCount,
    maxFires: value.maxFires,
    expiresAt: value.expiresAt,
    lastError,
    consecutiveFailures: value.consecutiveFailures,
    ...(value.deferredFireCount === undefined
      ? {}
      : { deferredFireCount: value.deferredFireCount }),
    ...(capabilityRequirements.length === 0 ? {} : { capabilityRequirements }),
    ...(waiting ? { waiting } : {}),
  } satisfies AutomationDefinition);
}

export function normalizeAutomationPendingFireRecord(value: unknown): AutomationPendingFire {
  if (!isRecord(value) || !hasOnlyKeys(value, PENDING_FIRE_KEYS)) {
    throw new Error('Invalid pending Automation fire');
  }
  if (
    !isId(value.id) ||
    !isId(value.automationId) ||
    !isId(value.targetSessionId) ||
    !isId(value.turnId) ||
    !isId(value.runId) ||
    !isId(value.userMessageId) ||
    !isAutomationTextWithinLimit(value.automationName, AUTOMATION_NAME_LIMIT, {
      nonblank: true,
    }) ||
    !isAutomationTextWithinLimit(value.prompt, AUTOMATION_PROMPT_LIMIT, { nonblank: true }) ||
    !isNonnegativeInteger(value.scheduledFor) ||
    !isNonnegativeInteger(value.admittedAt) ||
    !isNonnegativeInteger(value.updatedAt) ||
    (value.status !== 'admitted' && value.status !== 'running')
  ) {
    throw new Error('Invalid pending Automation fire state');
  }
  const startedAt =
    value.startedAt === undefined ? undefined : requireNonnegativeInteger(value.startedAt);
  const transientDeferredSince =
    value.transientDeferredSince === undefined
      ? undefined
      : requireNonnegativeInteger(value.transientDeferredSince);
  if ((value.status === 'running') !== (startedAt !== undefined)) {
    throw new Error('Pending Automation fire start state is inconsistent');
  }
  if (
    transientDeferredSince !== undefined &&
    (value.status === 'running' ||
      transientDeferredSince < value.admittedAt ||
      transientDeferredSince > value.updatedAt)
  ) {
    throw new Error('Pending Automation fire deferral state is inconsistent');
  }
  const capabilityRequirements = normalizeCapabilityRequirements(value.capabilityRequirements);
  return structuredClone({
    id: value.id,
    automationId: value.automationId,
    automationName: value.automationName,
    prompt: value.prompt,
    scheduledFor: value.scheduledFor,
    targetSessionId: value.targetSessionId,
    turnId: value.turnId,
    runId: value.runId,
    userMessageId: value.userMessageId,
    status: value.status,
    admittedAt: value.admittedAt,
    updatedAt: value.updatedAt,
    ...(transientDeferredSince === undefined ? {} : { transientDeferredSince }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(capabilityRequirements.length === 0 ? {} : { capabilityRequirements }),
  } satisfies AutomationPendingFire);
}

export function assertAutomationSnapshotRelationships(
  automations: readonly AutomationDefinition[],
  pendingFires: readonly AutomationPendingFire[],
): void {
  const definitions = new Map(automations.map((automation) => [automation.id, automation]));
  for (const fire of pendingFires) {
    const automation = definitions.get(fire.automationId);
    if (!automation) {
      throw new Error(`Pending Automation fire has no definition: ${fire.id}`);
    }
    if (
      automation.name !== fire.automationName ||
      automation.prompt !== fire.prompt ||
      automation.fireCount === 0 ||
      automation.lastFireAt === null ||
      automation.lastFireAt > fire.admittedAt ||
      automation.sessionId !== fire.targetSessionId ||
      JSON.stringify(automation.capabilityRequirements ?? []) !==
        JSON.stringify(fire.capabilityRequirements ?? [])
    ) {
      throw new Error(`Pending Automation fire contradicts its definition: ${fire.id}`);
    }
  }
}

function normalizeCapabilityRequirements(value: unknown): AutomationClientCapabilityRequirement[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > AUTOMATION_MAX_CLIENT_CAPABILITY_REQUIREMENTS) {
    throw new Error('Invalid Automation Client Capability requirements');
  }
  const requirements = value.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasOnlyKeys(entry, new Set(['principalId', 'clientInstanceId', 'contractId'])) ||
      typeof entry.principalId !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(entry.principalId) ||
      !isId(entry.clientInstanceId) ||
      !isId(entry.contractId)
    ) {
      throw new Error('Invalid Automation Client Capability requirement');
    }
    return {
      principalId: entry.principalId,
      clientInstanceId: entry.clientInstanceId,
      contractId: entry.contractId,
    };
  });
  const identities = requirements.map(
    ({ principalId, clientInstanceId, contractId }) =>
      `${principalId}\0${clientInstanceId}\0${contractId}`,
  );
  if (new Set(identities).size !== identities.length) {
    throw new Error('Duplicate Automation Client Capability requirement');
  }
  return requirements;
}

function normalizeWaitingState(value: unknown): AutomationWaitingState {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(['reason', 'since', 'message'])) ||
    value.reason !== 'client_capability_provider_unavailable' ||
    !isNonnegativeInteger(value.since) ||
    !isAutomationTextWithinLimit(value.message, AUTOMATION_LAST_ERROR_LIMIT)
  ) {
    throw new Error('Invalid Automation waiting state');
  }
  return { reason: value.reason, since: value.since, message: value.message };
}

function normalizeSchedule(value: unknown): AutomationSchedule {
  if (!isRecord(value)) throw new Error('Invalid Automation schedule');
  if (
    value.type === 'cron' &&
    hasOnlyKeys(value, new Set(['type', 'expression'])) &&
    isAutomationTextWithinLimit(value.expression, AUTOMATION_CRON_EXPRESSION_LIMIT)
  ) {
    return { type: 'cron', expression: value.expression };
  }
  if (
    value.type === 'interval' &&
    hasOnlyKeys(value, new Set(['type', 'seconds'])) &&
    isNonnegativeInteger(value.seconds) &&
    value.seconds >= 10 &&
    value.seconds <= 86_400
  ) {
    return { type: 'interval', seconds: value.seconds };
  }
  if (
    value.type === 'once' &&
    hasOnlyKeys(value, new Set(['type', 'delaySeconds'])) &&
    isNonnegativeInteger(value.delaySeconds) &&
    value.delaySeconds >= 5 &&
    value.delaySeconds <= 86_400
  ) {
    return { type: 'once', delaySeconds: value.delaySeconds };
  }
  throw new Error('Invalid Automation schedule');
}

function normalizeLastError(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return isAutomationTextWithinLimit(value, AUTOMATION_LAST_ERROR_LIMIT) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNullableNonnegativeInteger(value: unknown): value is number | null {
  return value === null || isNonnegativeInteger(value);
}

function requireNonnegativeInteger(value: unknown): number {
  if (!isNonnegativeInteger(value)) throw new Error('Expected a non-negative integer');
  return value;
}
