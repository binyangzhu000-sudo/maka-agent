import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExternalSubjectAdapter, type ExperimentCell } from '../index.js';

test('external subject executes its declared command without kernel changes', async () => {
  const adapter = createExternalSubjectAdapter();
  let execution: unknown;
  const result = await adapter.execute({
    cell: externalCell(),
    context: {
      cwd: '/task',
      metadata: {},
      async executeExternal(input) {
        execution = input;
        return { exitCode: 0, stdout: externalResult('task:task-1:2') };
      },
    },
  });

  assert.deepEqual(execution, {
    command: 'competitor',
    args: ['task:task-1:2'],
    cwd: '/task',
    environment: ['SECRET_TOKEN'],
    signal: undefined,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'task:task-1:2');
  assert.deepEqual(result.usage, {
    inputTokens: 3,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 5,
  });
  assert.equal(result.costUsd, 0.01);
});

test('external subject does not persist output from a failed execution', async () => {
  const adapter = createExternalSubjectAdapter();
  const cell = externalCell();
  const result = await adapter.execute({
    cell: {
      ...cell,
      subject: {
        ...cell.subject,
        config: {
          command: 'competitor',
          args: [],
        },
      },
    },
    context: {
      cwd: '/task',
      metadata: {},
      executeExternal: async () => ({ exitCode: 7, stdout: 'do-not-store' }),
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.usage, null);
  assert.deepEqual(result.artifacts, [{ kind: 'external_process', exitCode: 7 }]);
  assert.doesNotMatch(JSON.stringify(result), /do-not-store/);
});

test('external subject does not start when its execution is already cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  const adapter = createExternalSubjectAdapter();

  const result = await adapter.execute({
    cell: externalCell(),
    context: {
      cwd: '/task',
      metadata: {},
      signal: controller.signal,
      executeExternal: async () => {
        throw new Error('cancelled');
      },
    },
  });

  assert.equal(result.status, 'indeterminate');
  assert.deepEqual(result.artifacts, [{ kind: 'external_process_failure', reason: 'cancelled' }]);
});

function externalCell(): ExperimentCell {
  return {
    id: 'task-1::2::competitor',
    experimentId: 'experiment',
    benchmark: { id: 'bench', version: '1', config: {} },
    executor: { kind: 'pier', config: {} },
    budget: {},
    verifier: {},
    task: { id: 'task-1', input: 'Solve it', config: {} },
    repetition: 2,
    subject: {
      id: 'competitor',
      kind: 'external',
      credentials: ['SECRET_TOKEN'],
      config: {
        command: 'competitor',
        args: ['task:{{task.id}}:{{repetition}}'],
      },
    },
  };
}

function externalResult(output: string): string {
  return JSON.stringify({
    schemaVersion: 'maka.external_subject_result.v1',
    output,
    usage: {
      inputTokens: 3,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 5,
    },
    costUsd: 0.01,
    artifacts: [],
  });
}
