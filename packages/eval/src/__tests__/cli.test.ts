import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runMakaEvalCli, type ExperimentExecutor, type SubjectExecutionResult } from '../index.js';

const USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 2,
} as const;

test('maka eval runs Maka variants and a competitor through one declarative cohort', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-cli-'));
  const specPath = join(root, 'cohort.json');
  const out = join(root, 'out');
  await writeFile(
    specPath,
    JSON.stringify({
      schemaVersion: 'maka.eval.v1',
      id: 'cohort',
      benchmark: { id: 'bench', version: '1', config: {} },
      executor: {
        kind: 'harbor',
        config: { module: './harbor-adapter.mjs', export: 'createExecutor', options: {} },
      },
      subjects: [
        {
          id: 'maka-default',
          kind: 'maka',
          config: makaConfig('default'),
        },
        {
          id: 'maka-graph',
          kind: 'maka',
          config: makaConfig('graph'),
        },
        {
          id: 'competitor',
          kind: 'external',
          config: { command: 'competitor', args: [], environment: [] },
        },
      ],
      tasks: [{ id: 'task', input: 'Solve it', config: {} }],
      repetitions: 1,
      budget: {},
      verifier: {},
    }),
  );

  const prepared: string[] = [];
  const verified: string[] = [];
  const external: string[] = [];
  const sessions: Array<{ name?: string; orchestrationMode?: string }> = [];
  const executor = {
    kind: 'harbor',
    async prepare({ cell }) {
      prepared.push(cell.subject.id);
      return {
        cwd: root,
        metadata: {},
        async executeMaka(input) {
          sessions.push({ name: input.name, orchestrationMode: input.orchestrationMode });
          return {
            status: 'completed',
            executionId: input.executionId,
            usage: USAGE,
            costUsd: 0.01,
            usageComplete: true,
          };
        },
      };
    },
    async verify({ cell, subject }) {
      verified.push(cell.subject.id);
      return {
        status: subject.status === 'completed' ? 'completed' : 'subject_failed',
        score: subject.status === 'completed' ? 1 : null,
        artifacts: [],
      };
    },
  } satisfies ExperimentExecutor;
  const code = await runMakaEvalCli(['run', specPath, '--out', out], {
    writeOut: () => {},
    loadExecutor: async () => executor,
    createExternalSubject: () => ({
      kind: 'external',
      async execute({ cell }): Promise<SubjectExecutionResult> {
        external.push(cell.subject.id);
        return completedSubject();
      },
    }),
  });

  assert.equal(code, 0);
  assert.deepEqual(prepared, ['maka-default', 'maka-graph', 'competitor']);
  assert.deepEqual(verified, prepared);
  assert.deepEqual(external, ['competitor']);
  assert.deepEqual(sessions, [
    { name: 'maka-default', orchestrationMode: 'default' },
    { name: 'maka-graph', orchestrationMode: 'graph' },
  ]);
  const results = JSON.parse(await readFile(join(out, 'results.json'), 'utf8'));
  assert.deepEqual(
    results.cells.map((cell: { cellId: string; attempt: { result: { score: number } } }) => [
      cell.cellId,
      cell.attempt.result.score,
    ]),
    [
      ['task::1::maka-default', 1],
      ['task::1::maka-graph', 1],
      ['task::1::competitor', 1],
    ],
  );
});

test('maka eval public path loads a declared executor and runs a real external subject', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-public-cli-'));
  const specPath = join(root, 'experiment.json');
  const modulePath = join(root, 'executor.mjs');
  const out = join(root, 'out');
  const evalModuleUrl = new URL('../index.js', import.meta.url).href;
  await writeFile(
    modulePath,
    `import {createLocalExternalExecution} from ${JSON.stringify(evalModuleUrl)};const executeExternal=createLocalExternalExecution();export function createExecutor(){return{kind:"harbor",async prepare(){return{cwd:process.cwd(),metadata:{},executeExternal}},async verify({subject}){return{score:subject.status==="completed"?1:null,status:subject.status==="completed"?"completed":"subject_failed",artifacts:[]}}}}`,
  );
  await writeFile(
    specPath,
    JSON.stringify({
      schemaVersion: 'maka.eval.v1',
      id: 'public-path',
      benchmark: { id: 'bench', version: '1', config: {} },
      executor: {
        kind: 'harbor',
        config: { module: './executor.mjs', export: 'createExecutor', options: {} },
      },
      subjects: [
        {
          id: 'external',
          kind: 'external',
          config: {
            command: process.execPath,
            args: [
              '-e',
              'process.stdout.write(JSON.stringify({schemaVersion:"maka.external_subject_result.v1",output:"done",usage:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,reasoningTokens:0,totalTokens:2},costUsd:0.01,artifacts:[]}))',
            ],
            environment: [],
          },
        },
      ],
      tasks: [{ id: 'task', input: 'Solve it', config: {} }],
      repetitions: 1,
      budget: {},
      verifier: {},
    }),
  );

  const code = await runMakaEvalCli(['run', specPath, '--out', out], {
    writeOut: () => {},
    writeError: () => {},
  });

  assert.equal(code, 0);
  const results = JSON.parse(await readFile(join(out, 'results.json'), 'utf8'));
  assert.equal(results.cells[0].attempt.result.score, 1);
  assert.equal(results.cells[0].attempt.result.usage.totalTokens, 2);
});

test('maka eval settles an interrupted cell before returning the signal exit code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-signal-'));
  const specPath = join(root, 'experiment.json');
  await writeFile(
    specPath,
    JSON.stringify({
      schemaVersion: 'maka.eval.v1',
      id: 'signal',
      benchmark: { id: 'bench', version: '1', config: {} },
      executor: {
        kind: 'harbor',
        config: { module: './executor.mjs', export: 'createExecutor', options: {} },
      },
      subjects: [{ id: 'external', kind: 'external', config: {} }],
      tasks: [{ id: 'task', input: 'Solve it', config: {} }],
      repetitions: 1,
      budget: {},
      verifier: {},
    }),
  );
  let settled = false;
  let announceStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    announceStarted = resolve;
  });
  const run = runMakaEvalCli(['run', specPath, '--out', join(root, 'out')], {
    writeOut: () => {},
    writeError: () => {},
    loadExecutor: async () => executor(),
    createExternalSubject: () => ({
      kind: 'external',
      async execute({ context }) {
        announceStarted();
        await new Promise<void>((resolve) => {
          if (context.signal?.aborted) resolve();
          else context.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        settled = true;
        return { ...completedSubject(), status: 'indeterminate' };
      },
    }),
  });
  await started;
  process.emit('SIGINT', 'SIGINT');

  assert.equal(await run, 130);
  assert.equal(settled, true);
});

function makaConfig(orchestrationMode: 'default' | 'graph') {
  return {
    connectionSlug: 'deepseek',
    model: 'deepseek-v4-flash',
    thinkingLevel: 'max',
    permissionMode: 'bypass',
    collaborationMode: 'agent',
    orchestrationMode,
    maxSteps: 100,
  };
}

function completedSubject(): SubjectExecutionResult {
  return {
    usage: USAGE,
    costUsd: 0.01,
    durationMs: 1,
    status: 'completed',
    artifacts: [],
  };
}

function executor(): ExperimentExecutor {
  return {
    kind: 'harbor',
    async prepare() {
      return { cwd: '/task', metadata: {} };
    },
    async verify() {
      return { status: 'completed', score: 1, artifacts: [] };
    },
  };
}
