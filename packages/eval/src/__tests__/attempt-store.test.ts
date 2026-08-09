import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileAttemptStore, type CellAttempt } from '../index.js';

test('file attempt store preserves append-only cell history across reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-attempts-'));
  const path = join(root, 'attempts.jsonl');
  const first = attempt(1, 'infra_failed');
  const second = attempt(2, 'completed');

  await new FileAttemptStore(path).append(first);
  await new FileAttemptStore(path).append(second);

  assert.deepEqual(await new FileAttemptStore(path).list(first.cellId), [first, second]);
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
