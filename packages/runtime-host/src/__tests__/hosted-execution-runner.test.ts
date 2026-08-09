import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HostedExecutionStartInput } from '../protocol/index.js';
import { HostHostedExecutionRunner } from '../server/hosted-execution-runner.js';

test('Hosted execution retires a Session whose create outcome is unknown', async () => {
  const sessions = new Set<string>();
  const runner = new HostHostedExecutionRunner({
    sessions: {
      handlers: {
        'session.create': async (input) => {
          sessions.add(input.sessionId);
          return {
            ok: false,
            error: {
              code: 'commit_outcome_unknown',
              message: 'Session may have committed',
            },
          };
        },
        'session.catalog.query': async (input) => ({
          ok: true,
          result: {
            kind: 'session',
            session:
              input.kind === 'get' && sessions.has(input.sessionId)
                ? ({ id: input.sessionId, revision: 1 } as never)
                : null,
          },
        }),
      },
    },
    root: {
      handlers: {
        'turn.start': async () => assert.fail('Turn must not start'),
        'turn.query': async () => assert.fail('Turn must not be queried'),
      },
    },
    retirement: {
      stopHostedExecution: async (sessionId: string) => [sessionId],
      readExecutionFamilySessionIds: async (sessionId: string) => [sessionId],
      handlers: {
        'session.remove': async (input) => {
          sessions.delete(input.sessionId);
          return { ok: true, result: { kind: 'removed', sessionId: input.sessionId } };
        },
      },
    },
    usage: {
      handlers: { 'usage.query': async () => assert.fail('Usage must not be queried') },
    },
    context: {
      hostEpoch: 'epoch',
      connectionId: 'connection',
      surface: 'run',
      principal: 'principal',
      acquireResidency: () => ({ release() {} }),
    },
  });

  const result = await runner.run(input(), new AbortController().signal);

  assert.equal(result.status, 'indeterminate');
  assert.equal(sessions.has('execution-1'), false);
});

function input(): HostedExecutionStartInput {
  return {
    executionId: 'execution-1',
    cwd: '/workspace',
    modelTarget: { kind: 'default' },
    content: { text: 'Solve the task' },
  };
}
