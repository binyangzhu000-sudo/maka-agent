import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  EphemeralRuntimeHostExecutionInput,
  EphemeralRuntimeHostExecutionResult,
} from '@maka/runtime-host/client';
import { createMakaSubjectAdapter, type ExperimentCell } from '../index.js';

test('Maka subject executes one ephemeral Session through Runtime Host', async () => {
  const calls: unknown[] = [];
  const executeMaka = async (
    input: EphemeralRuntimeHostExecutionInput,
  ): Promise<EphemeralRuntimeHostExecutionResult> => {
    calls.push(input);
    return {
      status: 'completed',
      executionId: input.executionId,
      rootTurnId: input.turnId,
      rootRunId: 'run-1',
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
  };
  const ids = ['session-1', 'turn-1'];
  const adapter = createMakaSubjectAdapter({
    newId: () => ids.shift()!,
    now: (() => {
      let now = 100;
      return () => now++;
    })(),
    pollIntervalMs: 0,
  });

  const result = await adapter.execute({
    cell: makaCell(),
    context: { cwd: '/workspace', metadata: {}, executeMaka },
  });

  assert.deepEqual(calls, [
    {
      executionId: 'session-1',
      turnId: 'turn-1',
      cwd: '/workspace',
      name: 'maka',
      content: { text: 'Solve it' },
      modelTarget: { kind: 'explicit', connectionSlug: 'connection', model: 'model' },
      thinkingLevel: 'high',
      permissionMode: 'bypass',
      collaborationMode: 'agent',
      orchestrationMode: 'default',
      maxSteps: 100,
    },
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

test('Maka subject preserves Runtime Host failure attribution', async () => {
  const executeMaka = async (
    input: EphemeralRuntimeHostExecutionInput,
  ): Promise<EphemeralRuntimeHostExecutionResult> => {
    return {
      status: 'failed',
      failureReason: 'provider failed',
      executionId: input.executionId,
      rootTurnId: input.turnId,
      rootRunId: 'run-1',
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
  };
  const ids = ['session-1', 'turn-1'];
  const adapter = createMakaSubjectAdapter({
    newId: () => ids.shift()!,
    now: (() => {
      let now = 100;
      return () => now++;
    })(),
    pollIntervalMs: 0,
  });

  const result = await adapter.execute({
    cell: makaCell(),
    context: { cwd: '/workspace', metadata: {}, executeMaka },
  });

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
    status: 'failed',
    artifacts: [
      {
        kind: 'runtime_host_run',
        sessionId: 'session-1',
        turnId: 'turn-1',
        runId: 'run-1',
        reason: 'provider failed',
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
