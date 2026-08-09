import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RuntimeHostOperationError, type RuntimeHostConnection } from '../client/connection.js';
import { executeEphemeralRuntimeHostSession } from '../client/ephemeral-execution.js';

test('ephemeral execution waits for Host quiescence and attributes every Session turn', async () => {
  const operations: string[] = [];
  let removalAttempts = 0;
  const connection = connectionStub({
    operations,
    request(operation) {
      if (operation === 'session.catalog.query') {
        return { kind: 'session', session: { revision: 1 } };
      }
      if (operation === 'session.remove') {
        removalAttempts += 1;
        if (removalAttempts === 1) {
          throw Object.assign(new Error('Session has a live Goal'), { code: 'session_busy' });
        }
        return { kind: 'removed', sessionId: 'execution-1' };
      }
      if (operation === 'usage.query') {
        return usagePage([
          usageRow('execution-1', 'root-turn', 10, 5, 0.1),
          usageRow('execution-1', 'continuation-turn', 4, 2, 0.04),
          usageRow('another-session', 'other-turn', 100, 100, 10),
        ]);
      }
    },
  });

  const result = await execute(connection);

  assert.equal(removalAttempts, 2);
  assert.deepEqual(result, {
    status: 'completed',
    executionId: 'execution-1',
    rootTurnId: 'root-turn',
    rootRunId: 'root-run',
    usage: {
      inputTokens: 14,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 21,
    },
    costUsd: 0.14,
    usageComplete: true,
  });
  assert.deepEqual(operations, [
    'session.create',
    'session.catalog.query',
    'session.remove',
    'session.catalog.query',
    'session.remove',
    'usage.query',
  ]);
});

test('ephemeral execution retires its Session when Turn startup fails', async () => {
  const operations: string[] = [];
  const failure = new Error('transport lost during start');
  const connection = connectionStub({
    operations,
    request(operation) {
      if (operation === 'session.stop') return { kind: 'stopped', sessionId: 'execution-1' };
      if (operation === 'session.catalog.query') {
        return { kind: 'session', session: { revision: 1 } };
      }
      if (operation === 'session.remove') {
        return { kind: 'removed', sessionId: 'execution-1' };
      }
    },
    startTurn: async () => {
      throw failure;
    },
  });

  await assert.rejects(execute(connection), failure);
  assert.deepEqual(operations, [
    'session.create',
    'session.stop',
    'session.catalog.query',
    'session.remove',
  ]);
});

test('ephemeral execution never reconciles a deterministic Session identity conflict', async () => {
  const operations: string[] = [];
  const conflict = new RuntimeHostOperationError(
    'session.create',
    'operation_conflict',
    'identity belongs to another Session',
  );
  const connection = connectionStub({
    operations,
    request(operation) {
      if (operation === 'session.create') throw conflict;
    },
  });

  await assert.rejects(execute(connection), conflict);
  assert.deepEqual(operations, ['session.create']);
});

test('ephemeral execution reports incomplete usage provenance without discarding visible usage', async () => {
  const connection = connectionStub({
    operations: [],
    request(operation) {
      if (operation === 'usage.query') {
        return usagePage([usageRow('execution-1', 'root-turn', 10, 5, 0.1)], {
          unreadableRecords: 1,
          pendingRepairs: 0,
        });
      }
      if (operation === 'session.catalog.query') {
        return { kind: 'session', session: { revision: 1 } };
      }
      if (operation === 'session.remove') {
        return { kind: 'removed', sessionId: 'execution-1' };
      }
    },
  });

  const result = await execute(connection);
  assert.equal(result.usageComplete, false);
  assert.equal(result.usage.totalTokens, 15);
  assert.equal(result.costUsd, 0.1);
});

test('cancelled ephemeral execution asks Host to stop the whole Session before retirement', async () => {
  const operations: string[] = [];
  const controller = new AbortController();
  controller.abort();
  const connection = connectionStub({
    operations,
    request(operation) {
      if (operation === 'session.stop') return { kind: 'stopped', sessionId: 'execution-1' };
      if (operation === 'usage.query') return usagePage([]);
      if (operation === 'session.catalog.query') {
        return { kind: 'session', session: { revision: 1 } };
      }
      if (operation === 'session.remove') {
        return { kind: 'removed', sessionId: 'execution-1' };
      }
    },
    queryTurn: async () => ({
      sessionId: 'execution-1',
      turnId: 'root-turn',
      runId: 'root-run',
      status: 'cancelled',
      terminalEventId: 'terminal',
      abortSource: 'stop_button',
    }),
  });

  const result = await executeEphemeralRuntimeHostSession(connection, executionInput(), {
    signal: controller.signal,
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
  });

  assert.equal(result.status, 'cancelled');
  assert.deepEqual(operations, [
    'session.create',
    'session.stop',
    'session.catalog.query',
    'session.remove',
    'usage.query',
  ]);
});

function execute(connection: RuntimeHostConnection) {
  return executeEphemeralRuntimeHostSession(connection, executionInput(), {
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
  });
}

function executionInput() {
  return {
    executionId: 'execution-1',
    turnId: 'root-turn',
    cwd: '/workspace',
    name: 'subject',
    content: { text: 'Solve it' },
    modelTarget: { kind: 'explicit' as const, connectionSlug: 'connection', model: 'model' },
    permissionMode: 'bypass' as const,
    collaborationMode: 'agent' as const,
    orchestrationMode: 'default' as const,
  };
}

function connectionStub(overrides: {
  operations: string[];
  request?: (operation: string) => unknown;
  startTurn?: RuntimeHostConnection['startTurn'];
  queryTurn?: RuntimeHostConnection['queryTurn'];
}): RuntimeHostConnection {
  return {
    async request(operation: string) {
      overrides.operations.push(operation);
      const result = overrides.request?.(operation);
      if (result !== undefined) return result;
      if (operation === 'session.create') return {};
      throw new Error(`unexpected operation ${operation}`);
    },
    startTurn:
      overrides.startTurn ??
      (async () => ({
        kind: 'started',
        turn: {
          sessionId: 'execution-1',
          turnId: 'root-turn',
          runId: 'root-run',
          status: 'running',
        },
      })),
    queryTurn:
      overrides.queryTurn ??
      (async () => ({
        sessionId: 'execution-1',
        turnId: 'root-turn',
        runId: 'root-run',
        status: 'completed',
        terminalEventId: 'terminal',
      })),
  } as unknown as RuntimeHostConnection;
}

function usagePage(rows: unknown[], provenance = { unreadableRecords: 0, pendingRepairs: 0 }) {
  return {
    kind: 'logs',
    source: 'llm',
    rows,
    nextOffset: null,
    provenance,
  };
}

function usageRow(
  sessionId: string,
  turnId: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
) {
  return {
    id: `${sessionId}-${turnId}`,
    timestamp: 1,
    sessionId,
    turnId,
    runId: `${turnId}-run`,
    connectionSlug: 'connection',
    model: 'model',
    provider: 'provider',
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: inputTokens + outputTokens,
    costUsd,
    status: 'success',
  };
}
