import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  expandExperiment,
  InMemoryAttemptStore,
  parseExperimentSpec,
  runExperiment,
  selectCellResult,
  type CellAttempt,
  type EvalResult,
  type ExperimentExecutor,
  type ExperimentSpec,
} from '../index.js';

describe('experiment cells', () => {
  test('expands tasks, repetitions, and subjects into a stable cell order', () => {
    const spec: ExperimentSpec = {
      schemaVersion: 'maka.eval.v1',
      id: 'cohort',
      benchmark: { id: 'bench', version: '1', config: {} },
      executor: { kind: 'harbor', config: {} },
      subjects: [
        { id: 'maka-default', kind: 'maka', config: {} },
        { id: 'competitor', kind: 'external', config: {} },
      ],
      tasks: [
        { id: 'task-a', input: 'A', config: {} },
        { id: 'task-b', input: 'B', config: {} },
      ],
      repetitions: 2,
      budget: {},
      verifier: {},
    };

    assert.deepEqual(
      expandExperiment(spec).map((cell) => ({
        id: cell.id,
        taskId: cell.task.id,
        repetition: cell.repetition,
        subjectId: cell.subject.id,
      })),
      [
        {
          id: 'task-a::1::maka-default',
          taskId: 'task-a',
          repetition: 1,
          subjectId: 'maka-default',
        },
        {
          id: 'task-a::1::competitor',
          taskId: 'task-a',
          repetition: 1,
          subjectId: 'competitor',
        },
        {
          id: 'task-a::2::maka-default',
          taskId: 'task-a',
          repetition: 2,
          subjectId: 'maka-default',
        },
        {
          id: 'task-a::2::competitor',
          taskId: 'task-a',
          repetition: 2,
          subjectId: 'competitor',
        },
        {
          id: 'task-b::1::maka-default',
          taskId: 'task-b',
          repetition: 1,
          subjectId: 'maka-default',
        },
        {
          id: 'task-b::1::competitor',
          taskId: 'task-b',
          repetition: 1,
          subjectId: 'competitor',
        },
        {
          id: 'task-b::2::maka-default',
          taskId: 'task-b',
          repetition: 2,
          subjectId: 'maka-default',
        },
        {
          id: 'task-b::2::competitor',
          taskId: 'task-b',
          repetition: 2,
          subjectId: 'competitor',
        },
      ],
    );
  });

  test('rejects a spec that relies on an implicit semantic default', () => {
    assert.throws(
      () =>
        parseExperimentSpec({
          schemaVersion: 'maka.eval.v1',
          id: 'implicit',
          benchmark: { id: 'bench', version: '1', config: {} },
          executor: { kind: 'harbor', config: {} },
          subjects: [{ id: 'maka', kind: 'maka', config: {} }],
          tasks: [{ id: 'task', input: 'task', config: {} }],
          budget: {},
          verifier: {},
        }),
      /repetitions/,
    );
  });
});

describe('cell attempts', () => {
  test('selects the earliest valid attempt after replaceable failures', () => {
    const attempts: CellAttempt[] = [
      attempt(1, 'infra_failed'),
      attempt(2, 'indeterminate'),
      attempt(3, 'completed'),
      attempt(4, 'completed'),
    ];

    assert.equal(selectCellResult(attempts), attempts[2]);
  });

  test('replaces one failed cell without rerunning valid cohort cells', async () => {
    const spec: ExperimentSpec = {
      schemaVersion: 'maka.eval.v1',
      id: 'replacement',
      benchmark: { id: 'bench', version: '1', config: {} },
      executor: { kind: 'test', config: {} },
      subjects: [{ id: 'maka', kind: 'maka', config: {} }],
      tasks: [
        { id: 'valid', input: 'valid', config: {} },
        { id: 'replace', input: 'replace', config: {} },
      ],
      repetitions: 1,
      budget: {},
      verifier: {},
    };
    const valid = { ...attempt(1, 'completed'), cellId: 'valid::1::maka' };
    const failed = { ...attempt(1, 'infra_failed'), cellId: 'replace::1::maka' };
    const store = new InMemoryAttemptStore([valid, failed]);
    const executed: string[] = [];
    const executor: ExperimentExecutor = {
      kind: 'test',
      async execute({ cell }): Promise<EvalResult> {
        executed.push(cell.id);
        return attempt(2, 'completed').result;
      },
    };

    const run = await runExperiment({
      spec,
      store,
      executors: [executor],
      subjects: [
        {
          kind: 'maka',
          async execute() {
            throw new Error('the test executor owns this result');
          },
        },
      ],
      cellIds: ['replace::1::maka'],
    });

    assert.deepEqual(executed, ['replace::1::maka']);
    assert.equal((await store.list('valid::1::maka')).length, 1);
    assert.deepEqual(
      (await store.list('replace::1::maka')).map(({ sequence, result }) => [
        sequence,
        result.status,
      ]),
      [
        [1, 'infra_failed'],
        [2, 'completed'],
      ],
    );
    assert.equal(run.results.get('valid::1::maka')?.sequence, 1);
    assert.equal(run.results.get('replace::1::maka')?.sequence, 2);
  });
});

function attempt(sequence: number, status: CellAttempt['result']['status']): CellAttempt {
  return {
    cellId: 'task-a::1::maka-default',
    sequence,
    startedAt: sequence * 10,
    completedAt: sequence * 10 + 1,
    result: {
      score: status === 'completed' ? 1 : null,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 2,
      },
      costUsd: 0.01,
      durationMs: 1,
      status,
      ...(status === 'completed' ? {} : { failureReason: status }),
      artifacts: [],
    },
  };
}
