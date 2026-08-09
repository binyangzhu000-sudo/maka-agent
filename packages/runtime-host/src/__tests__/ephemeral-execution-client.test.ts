import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RuntimeHostConnection } from '../client/connection.js';
import { executeEphemeralRuntimeHostSession } from '../client/ephemeral-execution.js';

test('ephemeral execution waits for Host quiescence and attributes every Session turn', async () => {
  const operations: string[] = [];
  let removalAttempts = 0;
  const connection = {
    async request(operation: string) {
      operations.push(operation);
      if (operation === 'session.create') return {};
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
        return {
          kind: 'logs',
          source: 'llm',
          rows: [
            usageRow('execution-1', 'root-turn', 10, 5, 0.1),
            usageRow('execution-1', 'continuation-turn', 4, 2, 0.04),
            usageRow('another-session', 'other-turn', 100, 100, 10),
          ],
          nextOffset: null,
        };
      }
      throw new Error(`unexpected operation ${operation}`);
    },
    async startTurn() {
      return {
        kind: 'started',
        turn: {
          sessionId: 'execution-1',
          turnId: 'root-turn',
          runId: 'root-run',
          status: 'running',
        },
      };
    },
    async queryTurn() {
      return {
        sessionId: 'execution-1',
        turnId: 'root-turn',
        runId: 'root-run',
        status: 'completed',
        terminalEventId: 'terminal',
      };
    },
    async stopTurn() {
      throw new Error('unexpected stop');
    },
  } as unknown as RuntimeHostConnection;

  const result = await executeEphemeralRuntimeHostSession(
    connection,
    {
      executionId: 'execution-1',
      turnId: 'root-turn',
      cwd: '/workspace',
      name: 'subject',
      content: { text: 'Solve it' },
      modelTarget: { kind: 'explicit', connectionSlug: 'connection', model: 'model' },
      permissionMode: 'bypass',
      collaborationMode: 'agent',
      orchestrationMode: 'default',
      maxSteps: 100,
    },
    { pollIntervalMs: 0, requestTimeoutMs: 100 },
  );

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
  const connection = {
    async request(operation: string) {
      operations.push(operation);
      if (operation === 'session.create') return {};
      if (operation === 'session.catalog.query') {
        return { kind: 'session', session: { revision: 1 } };
      }
      if (operation === 'session.remove') {
        return { kind: 'removed', sessionId: 'execution-1' };
      }
      throw new Error(`unexpected operation ${operation}`);
    },
    async startTurn() {
      throw failure;
    },
    async queryTurn() {
      throw new Error('turn was not admitted');
    },
  } as unknown as RuntimeHostConnection;

  await assert.rejects(
    executeEphemeralRuntimeHostSession(
      connection,
      {
        executionId: 'execution-1',
        turnId: 'root-turn',
        cwd: '/workspace',
        name: 'subject',
        content: { text: 'Solve it' },
        modelTarget: { kind: 'explicit', connectionSlug: 'connection', model: 'model' },
        permissionMode: 'bypass',
        collaborationMode: 'agent',
        orchestrationMode: 'default',
      },
      { pollIntervalMs: 0, requestTimeoutMs: 100 },
    ),
    failure,
  );
  assert.deepEqual(operations, ['session.create', 'session.catalog.query', 'session.remove']);
});

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
