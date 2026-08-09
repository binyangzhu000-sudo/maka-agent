import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createHarborExecutorAdapter,
  createPierExecutorAdapter,
  type ExperimentCell,
  type SubjectExecutionContext,
} from '../index.js';

for (const [kind, create] of [
  ['harbor', createHarborExecutorAdapter],
  ['pier', createPierExecutorAdapter],
] as const) {
  test(`${kind} is an executor adapter over the common result kernel`, async () => {
    const contexts: SubjectExecutionContext[] = [];
    const executor = create({
      async prepare(cell) {
        assert.equal(cell.benchmark.id, 'bench');
        assert.deepEqual(cell.budget, { timeoutMs: 1000 });
        assert.deepEqual(cell.verifier, { kind: 'official' });
        return { cwd: '/task', metadata: { trial: 'trial-1' } };
      },
      async verify({ subject }) {
        assert.equal(subject.status, 'completed');
        return { status: 'completed', score: 0.75, artifacts: [{ kind: 'verifier' }] };
      },
    });

    const result = await executor.execute({
      cell: cell(kind),
      async runSubject(context) {
        contexts.push(context);
        return {
          output: 'done',
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 2,
            cacheWriteTokens: 1,
            reasoningTokens: 3,
            totalTokens: 18,
          },
          costUsd: 0.02,
          durationMs: 12,
          status: 'completed',
          artifacts: [{ kind: 'subject' }],
        };
      },
    });

    assert.equal(executor.kind, kind);
    assert.deepEqual(contexts, [{ cwd: '/task', metadata: { trial: 'trial-1' } }]);
    assert.deepEqual(result, {
      score: 0.75,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        reasoningTokens: 3,
        totalTokens: 18,
      },
      costUsd: 0.02,
      durationMs: 12,
      status: 'completed',
      artifacts: [{ kind: 'subject' }, { kind: 'verifier' }],
    });
  });
}

function cell(kind: string): ExperimentCell {
  return {
    id: 'task::1::subject',
    experimentId: 'experiment',
    benchmark: { id: 'bench', version: '1', config: {} },
    executor: { kind, config: {} },
    budget: { timeoutMs: 1000 },
    verifier: { kind: 'official' },
    task: { id: 'task', input: 'Solve it', config: {} },
    repetition: 1,
    subject: { id: 'subject', kind: 'external', config: {} },
  };
}
