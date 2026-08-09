import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openExperimentDirectory, type ExperimentSpec } from '../index.js';

test('experiment directory refuses a different spec after its authority is frozen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-experiment-'));
  const first = spec('model-a');
  const opened = await openExperimentDirectory(root, first);

  assert.equal(opened.attempts.path, join(root, 'attempts'));
  await openExperimentDirectory(root, first);
  await assert.rejects(openExperimentDirectory(root, spec('model-b')), /different experiment spec/);
});

function spec(model: string): ExperimentSpec {
  return {
    schemaVersion: 'maka.eval.v1',
    id: 'experiment',
    benchmark: { id: 'bench', version: '1', config: {} },
    executor: { kind: 'harbor', config: {} },
    subjects: [
      {
        id: 'maka',
        kind: 'maka',
        credentials: [],
        config: {
          connectionSlug: 'connection',
          model,
          thinkingLevel: null,
          permissionMode: 'bypass',
          collaborationMode: 'agent',
          orchestrationMode: 'default',
          maxSteps: 100,
        },
      },
    ],
    tasks: [{ id: 'task', input: 'task', config: {} }],
    repetitions: 1,
    budget: {},
    verifier: {},
  };
}
