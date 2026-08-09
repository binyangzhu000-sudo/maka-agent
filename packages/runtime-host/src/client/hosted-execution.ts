import type { HostedExecutionProjection, HostedExecutionStartInput } from '../protocol/index.js';
import type { RuntimeHostConnection } from './connection.js';

export interface HostedExecutionClientOptions {
  readonly signal?: AbortSignal;
  readonly pollIntervalMs?: number;
  readonly requestTimeoutMs?: number;
}

type HostedExecutionConnection = Pick<RuntimeHostConnection, 'request'>;
type HostedExecutionTerminal = Exclude<HostedExecutionProjection, { readonly status: 'running' }>;

export async function executeHostedRuntimeHostSubject(
  connection: HostedExecutionConnection,
  input: HostedExecutionStartInput,
  options: HostedExecutionClientOptions = {},
): Promise<HostedExecutionTerminal> {
  options.signal?.throwIfAborted();
  const timeout = options.requestTimeoutMs ?? 5_000;
  const pollInterval = options.pollIntervalMs ?? 25;
  let projection = await connection.request('hosted.execution.start', input, timeout);
  for (;;) {
    if (projection.status !== 'running') return projection;
    if (options.signal?.aborted) {
      projection = await connection.request(
        'hosted.execution.cancel',
        { executionId: input.executionId },
        timeout,
      );
      continue;
    }
    await delay(pollInterval);
    projection = await connection.request(
      'hosted.execution.query',
      { executionId: input.executionId },
      timeout,
    );
  }
}

function delay(ms: number): Promise<void> {
  return ms === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}
