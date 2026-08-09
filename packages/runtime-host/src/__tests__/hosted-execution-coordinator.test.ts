import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HostedExecutionStartInput } from '../protocol/index.js';
import { HostHostedExecutionCoordinator } from '../server/hosted-execution-coordinator.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';

test('Hosted execution cancellation settles the owned operation before returning', async () => {
  let released = false;
  const coordinator = new HostHostedExecutionCoordinator({
    run: async (input, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return terminal(input.executionId, 'cancelled');
    },
  });

  const started = await coordinator.handlers['hosted.execution.start'](
    input(),
    context(() => {
      released = true;
    }),
  );
  assert.deepEqual(started, {
    ok: true,
    result: { executionId: 'execution-1', status: 'running' },
  });
  assert.deepEqual(
    await coordinator.handlers['hosted.execution.query']({ executionId: 'execution-1' }, context()),
    started,
  );

  const cancelled = await coordinator.handlers['hosted.execution.cancel'](
    { executionId: 'execution-1' },
    context(),
  );
  assert.deepEqual(cancelled, { ok: true, result: terminal('execution-1', 'cancelled') });
  assert.equal(released, true);
  assert.deepEqual(
    await coordinator.handlers['hosted.execution.query']({ executionId: 'execution-1' }, context()),
    cancelled,
  );
});

test('Hosted execution identity is idempotent only for the same frozen input', async () => {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const coordinator = new HostHostedExecutionCoordinator({
    run: async (value) => {
      await settled;
      return terminal(value.executionId, 'completed');
    },
  });
  const first = await coordinator.handlers['hosted.execution.start'](input(), context());
  const same = await coordinator.handlers['hosted.execution.start'](input(), context());
  const conflict = await coordinator.handlers['hosted.execution.start'](
    { ...input(), content: { text: 'Different task' } },
    context(),
  );

  assert.equal(first.ok, true);
  assert.deepEqual(same, first);
  assert.deepEqual(conflict, {
    ok: false,
    error: { code: 'operation_conflict', message: 'Hosted execution identity is already in use' },
  });
  settle();
  await coordinator.close();
});

function input(): HostedExecutionStartInput {
  return {
    executionId: 'execution-1',
    cwd: '/workspace',
    modelTarget: { kind: 'default' },
    content: { text: 'Solve the task' },
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
  };
}

function terminal(executionId: string, status: 'completed' | 'cancelled') {
  return {
    executionId,
    status,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
    costUsd: null,
    usageComplete: true,
  } as const;
}

function context(onRelease: () => void = () => undefined): ConnectionContext {
  return {
    hostEpoch: 'epoch',
    connectionId: 'connection',
    surface: 'run',
    principal: 'principal',
    acquireResidency: () => ({ release: onRelease }),
  };
}
