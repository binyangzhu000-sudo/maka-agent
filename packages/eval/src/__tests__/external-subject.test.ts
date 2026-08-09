import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createExternalSubjectAdapter, type ExperimentCell } from '../index.js';

test('external subject executes its declared command without kernel changes', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'maka-eval-external-'));
  const adapter = createExternalSubjectAdapter();
  const result = await adapter.execute({
    cell: externalCell(),
    context: { cwd, metadata: {} },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'task:task-1:2\n');
  assert.deepEqual(result.usage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  });
  assert.equal(result.costUsd, null);
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
      config: {
        command: process.execPath,
        args: ['-e', 'process.stdout.write(process.argv[1])', 'task:{{task.id}}:{{repetition}}\n'],
        environment: [],
      },
    },
  };
}
