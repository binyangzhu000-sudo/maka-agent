import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createExternalSubjectAdapter } from '../external-subject.js';
import { expandExperiment } from '../experiment.js';
import { createHarborExecutor, createPierExecutor } from '../harbor-executor.js';
import type { ExperimentCell, ExperimentSpec } from '../experiment.js';
import { parseExperimentSpec } from '../spec.js';

test('Harbor and Pier own Trial setup and verification around exactly one Eval subject', async () => {
  for (const [kind, createExecutor] of [
    ['harbor', createHarborExecutor],
    ['pier', createPierExecutor],
  ] as const) {
    const root = await mkdtemp(join(tmpdir(), 'maka-eval-harbor-'));
    const python = join(root, 'fake-python.mjs');
    await writeFile(
      python,
      `#!/usr/bin/env node
import { connect } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
if(process.argv.at(-2)!==${JSON.stringify(kind)}) process.exit(64);
const config = JSON.parse(await readFile(process.argv.at(-1), 'utf8'));
const socket = connect(config.agent.kwargs.relay_port, config.agent.kwargs.relay_host);
socket.setEncoding('utf8');
await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
socket.write(JSON.stringify({token:config.agent.kwargs.relay_token,kind:'ready',instruction:'Solve inside Harbor'})+'\\n');
const request=JSON.parse(await new Promise(resolve => socket.once('data', resolve)));
socket.write(JSON.stringify({token:config.agent.kwargs.relay_token,kind:'executed',exitCode:0,stdout:JSON.stringify({schemaVersion:'maka.external_subject_result.v1',output:request.args.at(-1),usage:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,reasoningTokens:0,totalTokens:2},costUsd:0.01,artifacts:[]})})+'\\n');
socket.end();
const dir=config.trials_dir+'/'+config.trial_name;
await mkdir(dir,{recursive:true});
await writeFile(dir+'/result.json',JSON.stringify({verifier_result:{rewards:{reward:1}},exception_info:null}));
`,
    );
    await chmod(python, 0o755);
    const environmentName = `MAKA_EVAL_${kind.toUpperCase()}_PYTHON`;
    const previous = process.env[environmentName];
    process.env[environmentName] = python;
    try {
      const spec = experiment(kind);
      const executor = await createExecutor({
        spec,
        specPath: join(root, 'spec.json'),
        options: {
          containerCwd: '/app',
          credentialEnvironment: [],
          environment: { type: 'docker', delete: true },
        },
      });
      const cell = experimentCell(spec);
      const environment = await executor.prepare({ cell });
      const subject = await createExternalSubjectAdapter().execute({ cell, context: environment });
      assert.equal(subject.output, 'Solve inside Harbor');
      const verified = await executor.verify({ cell, environment, subject });
      assert.deepEqual(
        { status: verified.status, score: verified.score },
        {
          status: 'completed',
          score: 1,
        },
      );
      assert.match(String(verified.artifacts[0]?.trialName), /^task-1--1--external-/);
      await executor.cleanup?.({ cell, environment });
    } finally {
      if (previous === undefined) delete process.env[environmentName];
      else process.env[environmentName] = previous;
    }
  }
});

test('the current cohort is one fully expanded four-arm Experiment', async () => {
  const path = new URL(
    '../../experiments/terminal-bench-2.1-deepseek-v4-flash-four-arm.json',
    import.meta.url,
  );
  const spec = parseExperimentSpec(JSON.parse(await readFile(path, 'utf8')) as unknown);
  assert.equal(spec.tasks.length, 89);
  assert.deepEqual(
    spec.subjects.map((subject) => subject.id),
    ['maka', 'codex', 'claude-code', 'reasonix'],
  );
  assert.equal(expandExperiment(spec).length, 356);
});

function experiment(kind: 'harbor' | 'pier'): ExperimentSpec {
  return {
    schemaVersion: 'maka.eval.v1',
    id: 'harbor-test',
    benchmark: { id: 'bench', version: '1', config: { repository: 'https://example.test/bench' } },
    executor: {
      kind,
      config: {
        module: `@maka/eval/${kind}`,
        export: kind === 'harbor' ? 'createHarborExecutor' : 'createPierExecutor',
        options: {},
      },
    },
    subjects: [
      {
        id: 'external',
        kind: 'external',
        config: { command: 'agent', args: ['{{task.input}}'], environment: [] },
      },
    ],
    tasks: [
      {
        id: 'task-1',
        input: 'spec-owned identity',
        config: { harbor: { path: 'tasks/task-1' } },
      },
    ],
    repetitions: 1,
    budget: { timeoutMultiplier: 1 },
    verifier: { reward: 'reward' },
  };
}

function experimentCell(spec: ExperimentSpec): ExperimentCell {
  return {
    id: 'task-1::1::external',
    experimentId: spec.id,
    benchmark: spec.benchmark,
    executor: spec.executor,
    budget: spec.budget,
    verifier: spec.verifier,
    task: spec.tasks[0]!,
    repetition: 1,
    subject: spec.subjects[0]!,
  };
}
