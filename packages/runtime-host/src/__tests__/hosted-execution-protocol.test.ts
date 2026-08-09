import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeClientFrame, decodeHostFrame, RuntimeHostProtocolError } from '../protocol/index.js';

test('Hosted execution protocol exposes one subject lifecycle without Session identity', () => {
  assert.deepEqual(
    decodeClientFrame({
      requestId: 'request',
      operation: 'hosted.execution.start',
      input: {
        executionId: 'execution-1',
        cwd: '/workspace',
        modelTarget: { kind: 'default' },
        content: { text: 'Solve the task' },
        permissionMode: 'ask',
        collaborationMode: 'agent',
        orchestrationMode: 'default',
      },
    }),
    {
      requestId: 'request',
      operation: 'hosted.execution.start',
      input: {
        executionId: 'execution-1',
        cwd: '/workspace',
        modelTarget: { kind: 'default' },
        content: { text: 'Solve the task' },
        permissionMode: 'ask',
        collaborationMode: 'agent',
        orchestrationMode: 'default',
      },
    },
  );

  assert.deepEqual(
    decodeHostFrame({
      requestId: 'request',
      operation: 'hosted.execution.query',
      ok: true,
      result: {
        executionId: 'execution-1',
        status: 'completed',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          totalTokens: 15,
        },
        costUsd: 0.1,
        usageComplete: true,
      },
    }),
    {
      requestId: 'request',
      operation: 'hosted.execution.query',
      ok: true,
      result: {
        executionId: 'execution-1',
        status: 'completed',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          totalTokens: 15,
        },
        costUsd: 0.1,
        usageComplete: true,
      },
    },
  );
});

test('Hosted execution terminal projections reject contradictory settlement fields', () => {
  assert.throws(
    () =>
      decodeHostFrame({
        requestId: 'request',
        operation: 'hosted.execution.cancel',
        ok: true,
        result: {
          executionId: 'execution-1',
          status: 'running',
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
          },
          costUsd: null,
          usageComplete: true,
        },
      }),
    (error: unknown) => error instanceof RuntimeHostProtocolError,
  );
});
