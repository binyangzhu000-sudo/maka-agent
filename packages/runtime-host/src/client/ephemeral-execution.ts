import type { SessionCreateInput, TurnSnapshot, TurnStartInput } from '../protocol/index.js';
import { RuntimeHostOperationError, type RuntimeHostConnection } from './connection.js';

export interface EphemeralRuntimeHostUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
}

const EMPTY_USAGE: EphemeralRuntimeHostUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
});

export interface EphemeralRuntimeHostExecutionInput extends Omit<SessionCreateInput, 'sessionId'> {
  readonly executionId: string;
  readonly turnId: string;
  readonly content: TurnStartInput['content'];
  readonly maxSteps?: number;
}

export interface EphemeralRuntimeHostExecutionResult {
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly executionId: string;
  readonly rootTurnId: string;
  readonly rootRunId: string;
  readonly failureReason?: string;
  readonly usage: EphemeralRuntimeHostUsage;
  readonly costUsd: number | null;
}

export interface EphemeralRuntimeHostExecutionOptions {
  readonly signal?: AbortSignal;
  readonly pollIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly now?: () => number;
}

/**
 * Runtime Host client-owned lifecycle for one disposable execution.
 *
 * Callers submit subject input and observe one result. Session, Turn,
 * continuation settlement, usage reconciliation, and retirement stay behind
 * the Runtime Host client boundary.
 */
export async function executeEphemeralRuntimeHostSession(
  connection: RuntimeHostConnection,
  input: EphemeralRuntimeHostExecutionInput,
  options: EphemeralRuntimeHostExecutionOptions = {},
): Promise<EphemeralRuntimeHostExecutionResult> {
  const timeout = options.requestTimeoutMs ?? 5_000;
  const pollInterval = options.pollIntervalMs ?? 25;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const { executionId: sessionId, turnId, content, maxSteps, ...session } = input;

  await createOrReconcile(connection, { ...session, sessionId }, timeout);
  const started = await startOrReconcile(
    connection,
    { sessionId, turnId, content, ...(maxSteps === undefined ? {} : { maxSteps }) },
    timeout,
  );
  if (started.kind === 'blocked') {
    await retireWhenQuiescent(connection, sessionId, timeout, pollInterval, options.signal);
    return {
      status: 'failed',
      executionId: sessionId,
      rootTurnId: turnId,
      rootRunId: '',
      failureReason: 'Runtime Host blocked the root Turn',
      usage: EMPTY_USAGE,
      costUsd: null,
    };
  }

  const terminal = await waitForRootTurn(
    connection,
    { sessionId, turnId, runId: started.turn.runId },
    timeout,
    pollInterval,
    options.signal,
  );
  await retireWhenQuiescent(connection, sessionId, timeout, pollInterval, options.signal);
  const usage = await readSessionUsage(connection, sessionId, startedAt, now(), timeout);
  return {
    status: terminal.status,
    executionId: sessionId,
    rootTurnId: turnId,
    rootRunId: terminal.runId,
    ...(terminal.status === 'failed'
      ? { failureReason: terminal.failureClass }
      : terminal.status === 'cancelled'
        ? { failureReason: terminal.abortSource }
        : {}),
    ...usage,
  };
}

async function createOrReconcile(
  connection: RuntimeHostConnection,
  input: SessionCreateInput,
  timeout: number,
): Promise<void> {
  try {
    await connection.request('session.create', input, timeout);
  } catch (error) {
    const queried = await connection.request(
      'session.catalog.query',
      { kind: 'get', sessionId: input.sessionId },
      timeout,
    );
    if (queried.kind !== 'session' || !queried.session) throw error;
  }
}

async function startOrReconcile(
  connection: RuntimeHostConnection,
  input: Parameters<RuntimeHostConnection['startTurn']>[0],
  timeout: number,
) {
  try {
    return await connection.startTurn(input, timeout);
  } catch (error) {
    try {
      const turn = await connection.queryTurn(
        { sessionId: input.sessionId, turnId: input.turnId },
        timeout,
      );
      return { kind: 'started' as const, turn };
    } catch {
      throw error;
    }
  }
}

async function waitForRootTurn(
  connection: RuntimeHostConnection,
  identity: { sessionId: string; turnId: string; runId: string },
  timeout: number,
  pollInterval: number,
  signal?: AbortSignal,
): Promise<Extract<TurnSnapshot, { status: 'completed' | 'failed' | 'cancelled' }>> {
  for (;;) {
    if (signal?.aborted) await connection.stopTurn(identity, timeout);
    const turn = await connection.queryTurn(identity, timeout);
    if (turn.status === 'completed' || turn.status === 'failed' || turn.status === 'cancelled') {
      return turn;
    }
    await delay(pollInterval);
  }
}

async function retireWhenQuiescent(
  connection: RuntimeHostConnection,
  sessionId: string,
  timeout: number,
  pollInterval: number,
  signal?: AbortSignal,
): Promise<void> {
  for (;;) {
    const queried = await connection.request(
      'session.catalog.query',
      { kind: 'get', sessionId },
      timeout,
    );
    if (queried.kind !== 'session' || !queried.session) return;
    if ('kind' in queried.session) throw new Error('Runtime Host Session is not removable');
    try {
      await connection.request(
        'session.remove',
        { sessionId, expectedRevision: queried.session.revision },
        timeout,
      );
      return;
    } catch (error) {
      if (!isSessionBusy(error) || signal?.aborted) throw error;
      await delay(pollInterval);
    }
  }
}

async function readSessionUsage(
  connection: RuntimeHostConnection,
  sessionId: string,
  from: number,
  to: number,
  timeout: number,
): Promise<{ usage: EphemeralRuntimeHostUsage; costUsd: number | null }> {
  const rows = [];
  let offset = 0;
  for (;;) {
    const page = await connection.request(
      'usage.query',
      {
        kind: 'logs',
        source: 'llm',
        query: { range: { from, to }, status: 'all' },
        offset,
        limit: 100,
      },
      timeout,
    );
    if (page.kind !== 'logs' || page.source !== 'llm') {
      throw new Error('Runtime Host returned a non-LLM usage page');
    }
    rows.push(...page.rows.filter((row) => row.sessionId === sessionId));
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  return {
    usage: rows.reduce<EphemeralRuntimeHostUsage>(
      (total, row) => ({
        inputTokens: total.inputTokens + row.inputTokens,
        outputTokens: total.outputTokens + row.outputTokens,
        cacheReadTokens: total.cacheReadTokens + row.cacheReadTokens,
        cacheWriteTokens: total.cacheWriteTokens + row.cacheWriteTokens,
        reasoningTokens: total.reasoningTokens + row.reasoningTokens,
        totalTokens: total.totalTokens + row.totalTokens,
      }),
      EMPTY_USAGE,
    ),
    costUsd:
      rows.length === 0 || rows.some((row) => row.costUsd === undefined)
        ? null
        : rows.reduce((total, row) => total + (row.costUsd ?? 0), 0),
  };
}

function isSessionBusy(error: unknown): boolean {
  return (
    (error instanceof RuntimeHostOperationError && error.code === 'session_busy') ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'session_busy')
  );
}

function delay(ms: number): Promise<void> {
  return ms === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}
