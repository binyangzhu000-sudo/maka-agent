import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  HostedExecutionProjection,
  HostedExecutionStartInput,
  OperationInput,
  OperationKey,
  OperationOutput,
} from '../protocol/index.js';
import type { RuntimeHostConnection } from '../client/connection.js';
import { executeHostedRuntimeHostSubject } from '../client/hosted-execution.js';

type HostedExecutionTerminal = Exclude<HostedExecutionProjection, { readonly status: 'running' }>;

test('Hosted execution client observes the Host-owned terminal result', async () => {
  const operations: string[] = [];
  let queries = 0;
  const result = await executeHostedRuntimeHostSubject(
    connection((operation) => {
      operations.push(operation);
      if (operation === 'hosted.execution.start') return running();
      queries += 1;
      return queries === 1 ? running() : completed();
    }),
    input(),
    { pollIntervalMs: 0 },
  );

  assert.deepEqual(result, completed());
  assert.deepEqual(operations, [
    'hosted.execution.start',
    'hosted.execution.query',
    'hosted.execution.query',
  ]);
});

test('Hosted execution client delegates cancellation to the same Host authority', async () => {
  const operations: string[] = [];
  const abort = new AbortController();
  const result = await executeHostedRuntimeHostSubject(
    connection((operation) => {
      operations.push(operation);
      if (operation === 'hosted.execution.start') {
        abort.abort();
        return running();
      }
      return { ...completed(), status: 'cancelled' };
    }),
    input(),
    { signal: abort.signal, pollIntervalMs: 0 },
  );

  assert.equal(result.status, 'cancelled');
  assert.deepEqual(operations, ['hosted.execution.start', 'hosted.execution.cancel']);
});

function input(): HostedExecutionStartInput {
  return {
    executionId: 'execution-1',
    cwd: '/workspace',
    modelTarget: { kind: 'default' },
    content: { text: 'Solve the task' },
  };
}

function running(): HostedExecutionProjection {
  return { executionId: 'execution-1', status: 'running' };
}

function completed(): HostedExecutionTerminal {
  return {
    executionId: 'execution-1',
    status: 'completed',
    usage: {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 3,
    },
    costUsd: 0.01,
    usageComplete: true,
  };
}

function connection(
  respond: (operation: OperationKey) => HostedExecutionProjection,
): Pick<RuntimeHostConnection, 'request'> {
  return {
    request: async <K extends OperationKey>(
      operation: K,
      _input: OperationInput<K>,
    ): Promise<OperationOutput<K>> => respond(operation) as OperationOutput<K>,
  };
}
