import { randomUUID } from 'node:crypto';
import type {
  HostedExecutionProjection,
  HostedExecutionStartInput,
  HostedExecutionUsage,
  OperationKey,
  OperationOutcome,
  OperationOutput,
  SessionCreateInput,
  TurnSnapshot,
} from '../protocol/index.js';
import type { HostSessionCatalogCoordinator } from './session-catalog-coordinator.js';
import type { HostSessionRetirementCoordinator } from './session-retirement-coordinator.js';
import type { RootTurnCoordinator } from './root-turn-coordinator.js';
import type { HostUsagePricingCoordinator } from './usage-pricing-coordinator.js';
import type { ConnectionContext } from './operation-dispatcher.js';

const EMPTY_USAGE: HostedExecutionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
};

export interface HostHostedExecutionRunnerInput {
  readonly sessions: HostSessionCatalogCoordinator;
  readonly root: RootTurnCoordinator;
  readonly retirement: HostSessionRetirementCoordinator;
  readonly usage: HostUsagePricingCoordinator;
  readonly context: ConnectionContext;
  readonly now?: () => number;
  readonly newId?: () => string;
}

export class HostHostedExecutionRunner {
  readonly #input: HostHostedExecutionRunnerInput;

  constructor(input: HostHostedExecutionRunnerInput) {
    this.#input = input;
  }

  async run(
    input: HostedExecutionStartInput,
    signal: AbortSignal,
  ): Promise<Exclude<HostedExecutionProjection, { readonly status: 'running' }>> {
    const startedAt = (this.#input.now ?? Date.now)();
    const sessionId = input.executionId;
    const turnId = (this.#input.newId ?? randomUUID)();
    await requireSuccess(
      this.#input.sessions.handlers['session.create'](sessionInput(input), this.#input.context),
    );
    let terminal: TurnSnapshot | undefined;
    try {
      if (!signal.aborted) {
        const started = await requireSuccess(
          this.#input.root.handlers['turn.start'](
            {
              sessionId,
              turnId,
              content: input.content,
              ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
            },
            this.#input.context,
          ),
        );
        if (started.kind === 'started') {
          terminal = await this.#waitForTerminal(sessionId, turnId, signal);
        }
      }
      const ownedSessionIds = await this.#stop(sessionId);
      const sessionIds = await this.#retire(ownedSessionIds, signal);
      const usage = await this.#readUsage(sessionIds, startedAt, (this.#input.now ?? Date.now)());
      return {
        executionId: input.executionId,
        status: signal.aborted
          ? 'cancelled'
          : terminal?.status === 'completed'
            ? 'completed'
            : 'failed',
        ...(terminal?.status === 'failed' ? { failureReason: terminal.failureClass } : {}),
        ...usage,
      };
    } catch {
      await this.#bestEffortStopAndRetire(sessionId);
      return {
        executionId: input.executionId,
        status: 'indeterminate',
        failureReason: 'Runtime Host could not settle the Hosted execution',
        usage: EMPTY_USAGE,
        costUsd: null,
        usageComplete: false,
      };
    }
  }

  async #waitForTerminal(
    sessionId: string,
    turnId: string,
    signal: AbortSignal,
  ): Promise<TurnSnapshot | undefined> {
    for (;;) {
      if (signal.aborted) return undefined;
      const turn = await requireSuccess(
        this.#input.root.handlers['turn.query']({ sessionId, turnId }, this.#input.context),
      );
      if (turn.status === 'completed' || turn.status === 'failed' || turn.status === 'cancelled') {
        return turn;
      }
      await delay();
    }
  }

  #stop(sessionId: string): Promise<string[]> {
    return this.#input.retirement.stopHostedExecution(sessionId);
  }

  async #retire(rootSessionIds: readonly string[], signal: AbortSignal): Promise<string[]> {
    const retired = new Set<string>();
    for (const rootSessionId of rootSessionIds) {
      for (const sessionId of await this.#retireRoot(rootSessionId, signal)) {
        retired.add(sessionId);
      }
    }
    return [...retired];
  }

  async #retireRoot(sessionId: string, signal: AbortSignal): Promise<readonly string[]> {
    for (;;) {
      const catalog = await requireSuccess(
        this.#input.sessions.handlers['session.catalog.query'](
          { kind: 'get', sessionId },
          this.#input.context,
        ),
      );
      if (catalog.kind !== 'session' || !catalog.session) return [sessionId];
      if ('kind' in catalog.session) throw new Error('Hosted Session is not removable');
      const sessionIds = await this.#input.retirement.readExecutionFamilySessionIds(sessionId);
      const removed = await this.#input.retirement.handlers['session.remove'](
        { sessionId, expectedRevision: catalog.session.revision },
        this.#input.context,
      );
      if (removed.ok) {
        if (removed.result.kind === 'removed') return sessionIds;
        continue;
      }
      if (removed.error.code !== 'session_busy') throw new Error(removed.error.message);
      if (signal.aborted) await this.#stop(sessionId);
      await delay();
    }
  }

  async #readUsage(sessionIds: readonly string[], from: number, to: number) {
    const owned = new Set(sessionIds);
    const rows = [];
    let usageComplete = true;
    let offset = 0;
    for (;;) {
      const page = await requireSuccess(
        this.#input.usage.handlers['usage.query'](
          {
            kind: 'logs',
            source: 'llm',
            query: { range: { from, to }, status: 'all' },
            offset,
            limit: 100,
          },
          this.#input.context,
        ),
      );
      if (page.kind !== 'logs' || page.source !== 'llm') throw new Error('Invalid usage page');
      if (page.provenance.unreadableRecords > 0 || page.provenance.pendingRepairs > 0) {
        usageComplete = false;
      }
      rows.push(...page.rows.filter((row) => row.sessionId && owned.has(row.sessionId)));
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    return {
      usage: rows.reduce<HostedExecutionUsage>(
        (total, row) => ({
          inputTokens: total.inputTokens + row.inputTokens,
          outputTokens: total.outputTokens + row.outputTokens,
          cacheReadTokens: total.cacheReadTokens + row.cacheReadTokens,
          cacheWriteTokens: total.cacheWriteTokens + row.cacheWriteTokens,
          reasoningTokens: total.reasoningTokens + row.reasoningTokens,
          totalTokens: total.totalTokens + row.totalTokens,
        }),
        EMPTY_USAGE,
      ),
      costUsd:
        rows.length === 0 || rows.some((row) => row.costUsd === undefined)
          ? null
          : rows.reduce((total, row) => total + (row.costUsd ?? 0), 0),
      usageComplete,
    };
  }

  async #bestEffortStopAndRetire(sessionId: string): Promise<void> {
    try {
      await this.#stop(sessionId);
      await this.#retire([sessionId], new AbortController().signal);
    } catch {
      // The terminal projection remains indeterminate.
    }
  }
}

function sessionInput(input: HostedExecutionStartInput): SessionCreateInput {
  const { executionId, content: _content, maxSteps: _maxSteps, ...session } = input;
  return { sessionId: executionId, ...session };
}

async function requireSuccess<K extends OperationKey>(
  outcome: Promise<OperationOutcome<K>>,
): Promise<OperationOutput<K>> {
  const settled = await outcome;
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.result;
}

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}
