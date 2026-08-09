import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createMakaSubjectAdapter,
  type ExperimentCell,
  type MakaRuntimeHostClient,
} from '../index.js';

test('Maka subject executes one ephemeral Session through Runtime Host', async () => {
  const calls: string[] = [];
  const client: MakaRuntimeHostClient = {
    async createSession(input) {
      calls.push(`create:${input.sessionId}:${input.cwd}`);
    },
    async startTurn(input) {
      calls.push(`start:${input.sessionId}:${input.turnId}:${input.content.text}`);
      return { kind: 'started', runId: 'run-1' };
    },
    async queryTurn(input) {
      calls.push(`query:${input.sessionId}:${input.turnId}`);
      return { status: 'completed', runId: 'run-1' };
    },
    async readUsage(input) {
      calls.push(`usage:${input.sessionId}:${input.turnId}`);
      return {
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          reasoningTokens: 3,
          totalTokens: 18,
        },
        costUsd: 0.02,
      };
    },
    async removeSession(sessionId) {
      calls.push(`remove:${sessionId}`);
    },
    async stopTurn() {
      throw new Error('unexpected stop');
    },
  };
  const ids = ['session-1', 'turn-1'];
  const adapter = createMakaSubjectAdapter({
    client,
    newId: () => ids.shift()!,
    now: (() => {
      let now = 100;
      return () => now++;
    })(),
    pollIntervalMs: 0,
  });

  const result = await adapter.execute({
    cell: makaCell(),
    context: { cwd: '/workspace', metadata: {} },
  });

  assert.deepEqual(calls, [
    'create:session-1:/workspace',
    'start:session-1:turn-1:Solve it',
    'query:session-1:turn-1',
    'usage:session-1:turn-1',
    'remove:session-1',
  ]);
  assert.deepEqual(result, {
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      reasoningTokens: 3,
      totalTokens: 18,
    },
    costUsd: 0.02,
    durationMs: 1,
    status: 'completed',
    artifacts: [
      {
        kind: 'runtime_host_run',
        sessionId: 'session-1',
        turnId: 'turn-1',
        runId: 'run-1',
      },
    ],
  });
});

function makaCell(): ExperimentCell {
  return {
    id: 'task::1::maka',
    experimentId: 'experiment',
    benchmark: { id: 'bench', version: '1', config: {} },
    executor: { kind: 'harbor', config: {} },
    budget: {},
    verifier: {},
    task: { id: 'task', input: 'Solve it', config: {} },
    repetition: 1,
    subject: {
      id: 'maka',
      kind: 'maka',
      config: {
        connectionSlug: 'connection',
        model: 'model',
        thinkingLevel: 'high',
        permissionMode: 'bypass',
        collaborationMode: 'agent',
        orchestrationMode: 'default',
        maxSteps: 100,
      },
    },
  };
}
