import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  expandExperiment,
  parseExperimentSpec,
  runExperiment,
  selectCellResult,
  type CellAttempt,
  type SubjectExecutionResult,
  type ExperimentExecutor,
  type ExperimentSpec,
  type AttemptStore,
} from '../index.js';

describe('experiment cells', () => {
  test('expands tasks, repetitions, and subjects into a stable cell order', () => {
    const spec: ExperimentSpec = {
      schemaVersion: 'maka.eval.v1',
      id: 'cohort',
      benchmark: { id: 'bench', version: '1', config: {} },
      executor: { kind: 'harbor', config: {} },
      subjects: [
        { id: 'maka-default', kind: 'maka', credentials: [], config: {} },
        { id: 'competitor', kind: 'external', credentials: [], config: {} },
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
          subjects: [{ id: 'maka', kind: 'maka', credentials: [], config: {} }],
          tasks: [{ id: 'task', input: 'task', config: {} }],
          budget: {},
          verifier: {},
        }),
      /repetitions/,
    );
  });

  test('preserves every JSON key in the frozen semantic authority', () => {
    const parsed = parseExperimentSpec(
      JSON.parse(
        '{"schemaVersion":"maka.eval.v1","id":"prototype","benchmark":{"id":"bench","version":"1","config":{"__proto__":{"mode":"strict"}}},"executor":{"kind":"harbor","config":{}},"subjects":[{"id":"external","kind":"external","credentials":[],"config":{}}],"tasks":[{"id":"task","input":"task","config":{}}],"repetitions":1,"budget":{},"verifier":{}}',
      ),
    );

    assert.equal(Object.hasOwn(parsed.benchmark.config, '__proto__'), true);
    assert.equal((parsed.benchmark.config.__proto__ as { mode: string }).mode, 'strict');
    assert.equal(Object.getPrototypeOf(parsed.benchmark.config), null);
    assert.equal(Object.isFrozen(parsed.benchmark.config), true);
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
      subjects: [{ id: 'maka', kind: 'maka', credentials: [], config: {} }],
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
      async prepare() {
        return { cwd: '/task', metadata: {} };
      },
      async verify() {
        return { status: 'completed', score: 1, artifacts: [] };
      },
    };

    const run = await runExperiment({
      spec,
      store,
      executors: [executor],
      subjects: [
        {
          kind: 'maka',
          async execute({ cell }) {
            executed.push(cell.id);
            return completedSubjectResult();
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

  test('rejects invalid subject configuration before executing a cell', async () => {
    let executions = 0;
    await assert.rejects(
      runExperiment({
        spec: oneCellSpec(),
        store: new InMemoryAttemptStore(),
        executors: [
          {
            kind: 'harbor',
            async prepare() {
              executions += 1;
              return { cwd: '/task', metadata: {} };
            },
            async verify() {
              return { status: 'completed', score: 1, artifacts: [] };
            },
          },
        ],
        subjects: [
          {
            kind: 'external',
            validate() {
              throw new Error('invalid external config');
            },
            async execute() {
              throw new Error('unreachable');
            },
          },
        ],
      }),
      /invalid external config/,
    );
    assert.equal(executions, 0);
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
      artifacts: [],
    },
  };
}

class InMemoryAttemptStore implements AttemptStore {
  readonly #attempts: CellAttempt[];

  constructor(attempts: readonly CellAttempt[] = []) {
    this.#attempts = [...attempts];
  }

  async list(cellId: string): Promise<readonly CellAttempt[]> {
    return this.#attempts
      .filter((candidate) => candidate.cellId === cellId)
      .sort((left, right) => left.sequence - right.sequence);
  }

  async append(value: CellAttempt): Promise<void> {
    this.#attempts.push(value);
  }

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}

function oneCellSpec(): ExperimentSpec {
  return {
    schemaVersion: 'maka.eval.v1',
    id: 'validation',
    benchmark: { id: 'bench', version: '1', config: {} },
    executor: { kind: 'harbor', config: {} },
    subjects: [{ id: 'external', kind: 'external', credentials: [], config: {} }],
    tasks: [{ id: 'task', input: 'task', config: {} }],
    repetitions: 1,
    budget: {},
    verifier: {},
  };
}

function completedSubjectResult(): SubjectExecutionResult {
  const result = attempt(1, 'completed').result;
  return {
    usage: result.usage,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    status: 'completed',
    artifacts: result.artifacts,
  };
}
