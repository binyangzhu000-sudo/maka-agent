import { randomUUID } from 'node:crypto';
import type { RuntimeHostConnection } from '@maka/runtime-host/client';
import type {
  SessionCreateInput,
  TurnQueryInput,
  TurnStartInput,
  TurnStopInput,
} from '@maka/runtime-host/protocol';
import type { JsonObject } from './experiment.js';
import type { NormalizedUsage } from './result.js';
import type { SubjectAdapter, SubjectExecutionResult } from './runner.js';

const EMPTY_USAGE: NormalizedUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
});

export interface MakaRuntimeHostClient {
  createSession(input: SessionCreateInput): Promise<void>;
  startTurn(
    input: TurnStartInput,
  ): Promise<{ readonly kind: 'started'; readonly runId: string } | { readonly kind: 'blocked' }>;
  queryTurn(input: TurnQueryInput): Promise<{
    readonly status:
      | 'admitted'
      | 'created'
      | 'running'
      | 'waiting_for_user'
      | 'completed'
      | 'failed'
      | 'cancelled';
    readonly runId: string;
    readonly failureReason?: string;
  }>;
  stopTurn(input: TurnStopInput): Promise<void>;
  readUsage(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly from: number;
    readonly to: number;
  }): Promise<{ readonly usage: NormalizedUsage; readonly costUsd: number | null }>;
  removeSession(sessionId: string): Promise<void>;
}

export interface CreateMakaSubjectAdapterInput {
  readonly client: MakaRuntimeHostClient;
  readonly newId?: () => string;
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
}

export function createMakaSubjectAdapter(input: CreateMakaSubjectAdapterInput): SubjectAdapter {
  const newId = input.newId ?? randomUUID;
  const now = input.now ?? Date.now;
  const pollIntervalMs = input.pollIntervalMs ?? 25;
  return {
    kind: 'maka',
    async execute({ cell, context }): Promise<SubjectExecutionResult> {
      const config = decodeMakaSubjectConfig(cell.subject.config);
      const sessionId = newId();
      const turnId = newId();
      const startedAt = now();
      let sessionCreated = false;
      let runId: string | undefined;
      let result: SubjectExecutionResult;
      try {
        await input.client.createSession({
          sessionId,
          cwd: context.cwd,
          name: cell.subject.id,
          modelTarget: {
            kind: 'explicit',
            connectionSlug: config.connectionSlug,
            model: config.model,
          },
          permissionMode: config.permissionMode,
          collaborationMode: config.collaborationMode,
          orchestrationMode: config.orchestrationMode,
          ...(config.thinkingLevel === null ? {} : { thinkingLevel: config.thinkingLevel }),
        });
        sessionCreated = true;
        const started = await input.client.startTurn({
          sessionId,
          turnId,
          content: { text: cell.task.input },
          maxSteps: config.maxSteps,
        });
        if (started.kind === 'blocked') {
          result = failureResult('failed', 'Runtime Host blocked the Turn', now() - startedAt);
        } else {
          runId = started.runId;
          const terminal = await waitForTerminalTurn({
            client: input.client,
            sessionId,
            turnId,
            runId,
            signal: context.signal,
            pollIntervalMs,
          });
          const completedAt = now();
          const usage = await input.client.readUsage({
            sessionId,
            turnId,
            from: startedAt,
            to: completedAt,
          });
          result = {
            usage: usage.usage,
            costUsd: usage.costUsd,
            durationMs: completedAt - startedAt,
            status: terminal.status === 'completed' ? 'completed' : 'failed',
            ...(terminal.status === 'completed'
              ? {}
              : {
                  failureReason: terminal.failureReason ?? `Runtime Host Turn ${terminal.status}`,
                }),
            artifacts: [runtimeHostRunArtifact(sessionId, turnId, terminal.runId)],
          };
        }
      } catch (error) {
        result = failureResult(
          runId ? 'indeterminate' : 'infra_failed',
          errorMessage(error),
          now() - startedAt,
          runId ? [runtimeHostRunArtifact(sessionId, turnId, runId)] : [],
        );
      }

      if (sessionCreated) {
        try {
          await input.client.removeSession(sessionId);
        } catch (error) {
          return {
            ...result,
            status: 'indeterminate',
            failureReason: `Runtime Host Session cleanup failed: ${errorMessage(error)}`,
          };
        }
      }
      return result;
    },
  };
}

export function createMakaRuntimeHostClient(
  connection: RuntimeHostConnection,
): MakaRuntimeHostClient {
  return {
    async createSession(input) {
      await connection.request('session.create', input);
    },
    async startTurn(input) {
      const result = await connection.startTurn(input);
      return result.kind === 'blocked'
        ? { kind: 'blocked' }
        : { kind: 'started', runId: result.turn.runId };
    },
    async queryTurn(input) {
      const turn = await connection.queryTurn(input);
      return {
        status: turn.status,
        runId: turn.runId,
        ...(turn.status === 'failed'
          ? { failureReason: turn.failureClass }
          : turn.status === 'cancelled'
            ? { failureReason: turn.abortSource }
            : {}),
      };
    },
    async stopTurn(input) {
      await connection.stopTurn(input);
    },
    readUsage: (input) => readTurnUsage(connection, input),
    removeSession: (sessionId) => removeRuntimeHostSession(connection, sessionId),
  };
}

interface MakaSubjectConfig {
  readonly connectionSlug: string;
  readonly model: string;
  readonly thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  readonly permissionMode: 'explore' | 'ask' | 'execute' | 'bypass';
  readonly collaborationMode: 'agent' | 'plan';
  readonly orchestrationMode: 'default' | 'swarm' | 'graph';
  readonly maxSteps: number;
}

function decodeMakaSubjectConfig(config: JsonObject): MakaSubjectConfig {
  const expected = [
    'connectionSlug',
    'model',
    'thinkingLevel',
    'permissionMode',
    'collaborationMode',
    'orchestrationMode',
    'maxSteps',
  ];
  for (const key of Object.keys(config)) {
    if (!expected.includes(key)) throw new Error(`Maka subject config.${key} is not supported`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(config, key)) throw new Error(`Maka subject config.${key} is required`);
  }
  const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const permissionModes = ['explore', 'ask', 'execute', 'bypass'];
  const collaborationModes = ['agent', 'plan'];
  const orchestrationModes = ['default', 'swarm', 'graph'];
  if (typeof config.connectionSlug !== 'string' || config.connectionSlug.length === 0) {
    throw new Error('Maka subject config.connectionSlug is required');
  }
  if (typeof config.model !== 'string' || config.model.length === 0) {
    throw new Error('Maka subject config.model is required');
  }
  if (config.thinkingLevel !== null && !thinkingLevels.includes(config.thinkingLevel as string)) {
    throw new Error('Maka subject config.thinkingLevel is invalid');
  }
  if (!permissionModes.includes(config.permissionMode as string)) {
    throw new Error('Maka subject config.permissionMode is invalid');
  }
  if (!collaborationModes.includes(config.collaborationMode as string)) {
    throw new Error('Maka subject config.collaborationMode is invalid');
  }
  if (!orchestrationModes.includes(config.orchestrationMode as string)) {
    throw new Error('Maka subject config.orchestrationMode is invalid');
  }
  if (!Number.isSafeInteger(config.maxSteps) || (config.maxSteps as number) < 1) {
    throw new Error('Maka subject config.maxSteps must be a positive integer');
  }
  return config as unknown as MakaSubjectConfig;
}

async function waitForTerminalTurn(input: {
  readonly client: MakaRuntimeHostClient;
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly signal?: AbortSignal;
  readonly pollIntervalMs: number;
}): Promise<Awaited<ReturnType<MakaRuntimeHostClient['queryTurn']>>> {
  for (;;) {
    if (input.signal?.aborted) {
      await input.client.stopTurn({
        sessionId: input.sessionId,
        turnId: input.turnId,
        runId: input.runId,
      });
    }
    const turn = await input.client.queryTurn({
      sessionId: input.sessionId,
      turnId: input.turnId,
    });
    if (turn.status === 'completed' || turn.status === 'failed' || turn.status === 'cancelled') {
      return turn;
    }
    await delay(input.pollIntervalMs);
  }
}

async function readTurnUsage(
  connection: RuntimeHostConnection,
  input: { sessionId: string; turnId: string; from: number; to: number },
): Promise<{ usage: NormalizedUsage; costUsd: number | null }> {
  const rows = [];
  let offset = 0;
  for (;;) {
    const page = await connection.request('usage.query', {
      kind: 'logs',
      source: 'llm',
      query: { range: { from: input.from, to: input.to }, status: 'all' },
      offset,
      limit: 100,
    });
    if (page.kind !== 'logs' || page.source !== 'llm') {
      throw new Error('Runtime Host returned a non-LLM usage page');
    }
    rows.push(
      ...page.rows.filter(
        (row) => row.sessionId === input.sessionId && row.turnId === input.turnId,
      ),
    );
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  const usage = rows.reduce<NormalizedUsage>(
    (total, row) => ({
      inputTokens: total.inputTokens + row.inputTokens,
      outputTokens: total.outputTokens + row.outputTokens,
      cacheReadTokens: total.cacheReadTokens + row.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + row.cacheWriteTokens,
      reasoningTokens: total.reasoningTokens + row.reasoningTokens,
      totalTokens: total.totalTokens + row.totalTokens,
    }),
    EMPTY_USAGE,
  );
  const costUsd =
    rows.length === 0 || rows.some((row) => row.costUsd === undefined)
      ? null
      : rows.reduce((total, row) => total + (row.costUsd ?? 0), 0);
  return { usage, costUsd };
}

async function removeRuntimeHostSession(
  connection: RuntimeHostConnection,
  sessionId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const queried = await connection.request('session.catalog.query', { kind: 'get', sessionId });
    if (queried.kind !== 'session') throw new Error('Runtime Host Session lookup changed revision');
    if (!queried.session) return;
    const removed = await connection.request('session.remove', {
      sessionId,
      expectedRevision: queried.session.revision,
    });
    if (removed.kind === 'removed') return;
  }
  throw new Error(`Runtime Host Session kept changing during removal: ${sessionId}`);
}

function failureResult(
  status: 'failed' | 'infra_failed' | 'indeterminate',
  failureReason: string,
  durationMs: number,
  artifacts: readonly JsonObject[] = [],
): SubjectExecutionResult {
  return {
    usage: EMPTY_USAGE,
    costUsd: null,
    durationMs,
    status,
    failureReason,
    artifacts,
  };
}

function runtimeHostRunArtifact(sessionId: string, turnId: string, runId: string): JsonObject {
  return { kind: 'runtime_host_run', sessionId, turnId, runId };
}

function delay(ms: number): Promise<void> {
  return ms === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
