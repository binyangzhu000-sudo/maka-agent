import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runMakaEvalCli, type EvalResult, type ExperimentExecutor } from '../index.js';

test('maka eval runs every arm from one declarative spec', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-cli-'));
  const specPath = join(root, 'cohort.json');
  const out = join(root, 'out');
  await writeFile(
    specPath,
    JSON.stringify({
      schemaVersion: 'maka.eval.v1',
      id: 'cohort',
      benchmark: { id: 'bench', version: '1', config: {} },
      executor: { kind: 'harbor', config: {} },
      subjects: [
        { id: 'maka-a', kind: 'external', config: {} },
        { id: 'competitor', kind: 'external', config: {} },
      ],
      tasks: [{ id: 'task', input: 'Solve it', config: {} }],
      repetitions: 1,
      budget: {},
      verifier: {},
    }),
  );
  const executed: string[] = [];
  const executor: ExperimentExecutor = {
    kind: 'harbor',
    async execute({ cell }): Promise<EvalResult> {
      executed.push(cell.subject.id);
      return {
        score: cell.subject.id === 'maka-a' ? 1 : 0,
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
        status: 'completed',
        artifacts: [],
      };
    },
  };

  const code = await runMakaEvalCli(['run', specPath, '--out', out], {
    writeOut: () => {},
    loadExecutor: async () => executor,
    createExternalSubject: () => ({
      kind: 'external',
      async execute() {
        throw new Error('test executor owns the result');
      },
    }),
  });

  assert.equal(code, 0);
  assert.deepEqual(executed, ['maka-a', 'competitor']);
  const results = JSON.parse(await readFile(join(out, 'results.json'), 'utf8'));
  assert.deepEqual(
    results.cells.map((cell: { cellId: string; attempt: { result: { score: number } } }) => [
      cell.cellId,
      cell.attempt.result.score,
    ]),
    [
      ['task::1::maka-a', 1],
      ['task::1::competitor', 0],
    ],
  );
});
