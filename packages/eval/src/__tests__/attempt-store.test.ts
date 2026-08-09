import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileAttemptStore, type CellAttempt } from '../index.js';

test('file attempt store preserves append-only cell history across reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-attempts-'));
  const path = join(root, 'attempts');
  const first = attempt(1, 'infra_failed');
  const second = attempt(2, 'completed');

  await new FileAttemptStore(path).append(first);
  await new FileAttemptStore(path).append(second);

  assert.deepEqual(await new FileAttemptStore(path).list(first.cellId), [first, second]);
});

test('experiment attempt authority admits only one writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-attempt-lock-'));
  const first = new FileAttemptStore(join(root, 'attempts'));
  const second = new FileAttemptStore(join(root, 'attempts'));
  let release!: () => void;
  const held = first.runExclusive(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    second.runExclusive(async () => {}),
    /already has an active writer/,
  );
  release();
  await held;
  await second.runExclusive(async () => {});
});

test('unpublished temporary records cannot poison immutable attempt history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-attempt-recovery-'));
  const store = new FileAttemptStore(join(root, 'attempts'));
  const first = attempt(1, 'completed');
  await store.append(first);
  await writeFile(join(store.path, 'interrupted.tmp'), '{');

  assert.deepEqual(await store.list(first.cellId), [first]);
});

function attempt(sequence: number, status: CellAttempt['result']['status']): CellAttempt {
  return {
    cellId: 'task::1::subject',
    sequence,
    startedAt: sequence,
    completedAt: sequence + 1,
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
