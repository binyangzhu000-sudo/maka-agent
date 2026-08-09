import { isDeepStrictEqual } from 'node:util';
import type {
  HostedExecutionProjection,
  HostedExecutionStartInput,
  OperationOutcome,
} from '../protocol/index.js';
import type {
  ConnectionContext,
  HostedExecutionOperationHandlerMap,
  OperationResidency,
} from './operation-dispatcher.js';

type HostedExecutionTerminal = Exclude<HostedExecutionProjection, { readonly status: 'running' }>;
const MAX_RETAINED_TERMINAL_EXECUTIONS = 256;

export interface HostHostedExecutionCoordinatorInput {
  readonly run: (
    input: HostedExecutionStartInput,
    signal: AbortSignal,
  ) => Promise<HostedExecutionTerminal>;
}

interface ActiveHostedExecution {
  readonly input: HostedExecutionStartInput;
  readonly abort: AbortController;
  readonly residency: OperationResidency;
  projection: HostedExecutionProjection;
  task: Promise<void>;
}

export class HostHostedExecutionCoordinator {
  readonly handlers: HostedExecutionOperationHandlerMap = {
    'hosted.execution.start': (input, context) => this.#start(input, context),
    'hosted.execution.query': (input) => this.#query(input.executionId),
    'hosted.execution.cancel': (input) => this.#cancel(input.executionId),
  };

  readonly #input: HostHostedExecutionCoordinatorInput;
  readonly #executions = new Map<string, ActiveHostedExecution>();
  #accepting = true;

  constructor(input: HostHostedExecutionCoordinatorInput) {
    this.#input = input;
  }

  beginDrain(): void {
    if (!this.#accepting) return;
    this.#accepting = false;
    for (const execution of this.#executions.values()) execution.abort.abort();
  }

  async close(): Promise<void> {
    this.beginDrain();
    await Promise.all([...this.#executions.values()].map((execution) => execution.task));
  }

  async #start(
    input: HostedExecutionStartInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'hosted.execution.start'>> {
    const existing = this.#executions.get(input.executionId);
    if (existing) {
      if (!isDeepStrictEqual(existing.input, input)) {
        return {
          ok: false,
          error: {
            code: 'operation_conflict',
            message: 'Hosted execution identity is already in use',
          },
        };
      }
      return { ok: true, result: structuredClone(existing.projection) };
    }
    if (!this.#accepting) {
      return {
        ok: false,
        error: { code: 'host_draining', message: 'Runtime Host is draining' },
      };
    }
    const abort = new AbortController();
    const execution: ActiveHostedExecution = {
      input: structuredClone(input),
      abort,
      residency: context.acquireResidency(),
      projection: { executionId: input.executionId, status: 'running' },
      task: Promise.resolve(),
    };
    this.#executions.set(input.executionId, execution);
    execution.task = this.#run(execution);
    return { ok: true, result: structuredClone(execution.projection) };
  }

  #query(executionId: string): Promise<OperationOutcome<'hosted.execution.query'>> {
    const execution = this.#executions.get(executionId);
    return Promise.resolve(
      execution
        ? { ok: true, result: structuredClone(execution.projection) }
        : {
            ok: false,
            error: { code: 'not_found', message: 'Hosted execution does not exist' },
          },
    );
  }

  async #cancel(executionId: string): Promise<OperationOutcome<'hosted.execution.cancel'>> {
    const execution = this.#executions.get(executionId);
    if (!execution) {
      return {
        ok: false,
        error: { code: 'not_found', message: 'Hosted execution does not exist' },
      };
    }
    execution.abort.abort();
    await execution.task;
    return { ok: true, result: structuredClone(execution.projection) };
  }

  async #run(execution: ActiveHostedExecution): Promise<void> {
    try {
      execution.projection = await this.#input.run(execution.input, execution.abort.signal);
    } catch {
      execution.projection = {
        executionId: execution.input.executionId,
        status: 'indeterminate',
        failureReason: 'Hosted execution failed to settle',
        usage: emptyUsage(),
        costUsd: null,
        usageComplete: false,
      };
    } finally {
      execution.residency.release();
      this.#evictTerminalExecutions();
    }
  }

  #evictTerminalExecutions(): void {
    let terminalCount = [...this.#executions.values()].filter(
      (execution) => execution.projection.status !== 'running',
    ).length;
    if (terminalCount <= MAX_RETAINED_TERMINAL_EXECUTIONS) return;
    for (const [executionId, execution] of this.#executions) {
      if (execution.projection.status === 'running') continue;
      this.#executions.delete(executionId);
      terminalCount -= 1;
      if (terminalCount <= MAX_RETAINED_TERMINAL_EXECUTIONS) return;
    }
  }
}

function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  } as const;
}
