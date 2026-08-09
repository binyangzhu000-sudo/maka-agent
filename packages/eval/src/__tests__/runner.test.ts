import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  runExperiment,
  type AttemptStore,
  type CellAttempt,
  type ExperimentExecutor,
  type ExperimentSpec,
  type SubjectExecutionContext,
  type SubjectExecutionResult,
} from '../index.js';

test('the kernel executes one subject in one executor environment', async () => {
  const contexts: SubjectExecutionContext[] = [];
  let executions = 0;
  const result = await runOne(executor(), async (context) => {
    executions += 1;
    contexts.push(context);
    return completedSubject();
  });

  assert.equal(executions, 1);
  assert.deepEqual(contexts, [{ cwd: '/task', metadata: { trial: 'trial-1' } }]);
  assert.deepEqual(result, {
    score: 0.75,
    usage: usage(),
    costUsd: 0.02,
    durationMs: 12,
    status: 'completed',
    artifacts: [{ kind: 'subject' }, { kind: 'verifier' }],
  });
});

test('subject failure cannot be promoted to completed by a verifier', async () => {
  const result = await runOne(executor(), async () => ({
    ...completedSubject(),
    status: 'failed',
  }));

  assert.equal(result.status, 'subject_failed');
  assert.equal(result.score, 0.75);
});

test('verifier infrastructure failure preserves attributable subject data', async () => {
  const failing: ExperimentExecutor = {
    ...executor(),
    async verify() {
      throw new Error('verifier unavailable');
    },
  };

  const result = await runOne(failing, async () => completedSubject());

  assert.deepEqual(result, {
    score: null,
    usage: usage(),
    costUsd: 0.02,
    durationMs: 12,
    status: 'infra_failed',
    artifacts: [{ kind: 'subject' }, { kind: 'executor_failure', phase: 'verify' }],
  });
});

async function runOne(
  executor: ExperimentExecutor,
  execute: (context: SubjectExecutionContext) => Promise<SubjectExecutionResult>,
) {
  const store = new MemoryAttemptStore();
  const run = await runExperiment({
    spec: spec(),
    store,
    executors: [executor],
    subjects: [{ kind: 'external', execute: ({ context }) => execute(context) }],
  });
  const result =
    run.results.get('task::1::subject')?.result ??
    (await store.list('task::1::subject')).at(0)?.result;
  assert.ok(result);
  return result;
}

function executor(): ExperimentExecutor {
  return {
    kind: 'harbor',
    async prepare() {
      return { cwd: '/task', metadata: { trial: 'trial-1' } };
    },
    async verify() {
      return { status: 'completed', score: 0.75, artifacts: [{ kind: 'verifier' }] };
    },
  };
}

function completedSubject(): SubjectExecutionResult {
  return {
    output: 'done',
    usage: usage(),
    costUsd: 0.02,
    durationMs: 12,
    status: 'completed',
    artifacts: [{ kind: 'subject' }],
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

function spec(): ExperimentSpec {
  return {
    schemaVersion: 'maka.eval.v1',
    id: 'experiment',
    benchmark: { id: 'bench', version: '1', config: {} },
    executor: { kind: 'harbor', config: {} },
    subjects: [{ id: 'subject', kind: 'external', config: {} }],
    tasks: [{ id: 'task', input: 'Solve it', config: {} }],
    repetitions: 1,
    budget: {},
    verifier: {},
  };
}

class MemoryAttemptStore implements AttemptStore {
  readonly attempts: CellAttempt[] = [];

  async list(cellId: string): Promise<readonly CellAttempt[]> {
    return this.attempts.filter((attempt) => attempt.cellId === cellId);
  }

  async append(attempt: CellAttempt): Promise<void> {
    this.attempts.push(attempt);
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}
