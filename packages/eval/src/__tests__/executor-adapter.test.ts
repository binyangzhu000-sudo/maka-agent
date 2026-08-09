import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createExperimentExecutorAdapter,
  type ExperimentCell,
  type SubjectExecutionContext,
} from '../index.js';

test('executor adapters bind one environment to the common result lifecycle', async () => {
  const contexts: SubjectExecutionContext[] = [];
  const executor = createExperimentExecutorAdapter('harbor', {
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
    cell: cell('harbor'),
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

  assert.equal(executor.kind, 'harbor');
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

test('subject failure cannot be promoted to completed by a verifier', async () => {
  const executor = createExperimentExecutorAdapter('harbor', {
    async prepare() {
      return { cwd: '/task', metadata: {} };
    },
    async verify() {
      return { status: 'completed', score: 0.25, artifacts: [] };
    },
  });

  const result = await executor.execute({
    cell: cell('harbor'),
    async runSubject() {
      return {
        usage: usage(),
        costUsd: 0.02,
        durationMs: 12,
        status: 'failed',
        artifacts: [{ kind: 'subject' }],
      };
    },
  });

  assert.equal(result.status, 'subject_failed');
  assert.equal(result.score, 0.25);
});

test('verifier infrastructure failure preserves attributable subject data', async () => {
  const executor = createExperimentExecutorAdapter('harbor', {
    async prepare() {
      return { cwd: '/task', metadata: {} };
    },
    async verify() {
      throw new Error('verifier unavailable');
    },
  });

  const result = await executor.execute({
    cell: cell('harbor'),
    async runSubject() {
      return {
        usage: usage(),
        costUsd: 0.02,
        durationMs: 12,
        status: 'completed',
        artifacts: [{ kind: 'subject' }],
      };
    },
  });

  assert.deepEqual(result, {
    score: null,
    usage: usage(),
    costUsd: 0.02,
    durationMs: 12,
    status: 'infra_failed',
    artifacts: [{ kind: 'subject' }, { kind: 'executor_failure', phase: 'verify' }],
  });
});

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

function usage() {
  return {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    reasoningTokens: 3,
    totalTokens: 18,
  };
}
