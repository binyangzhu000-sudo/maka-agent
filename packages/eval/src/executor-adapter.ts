import type { ExperimentCell, JsonObject } from './experiment.js';
import type { EvalResult, EvalResultStatus } from './result.js';
import type {
  ExperimentExecutor,
  SubjectExecutionContext,
  SubjectExecutionResult,
} from './runner.js';

const EMPTY_USAGE = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
});

export interface ExecutorVerificationResult {
  readonly status: EvalResultStatus;
  readonly score: number | null;
  readonly failureReason?: string;
  readonly artifacts: readonly JsonObject[];
}

export interface BenchmarkExecutorDriver {
  prepare(cell: ExperimentCell): Promise<SubjectExecutionContext>;
  verify(input: {
    readonly cell: ExperimentCell;
    readonly context: SubjectExecutionContext;
    readonly subject: SubjectExecutionResult;
  }): Promise<ExecutorVerificationResult>;
  cleanup?(input: {
    readonly cell: ExperimentCell;
    readonly context: SubjectExecutionContext;
  }): Promise<void>;
}

export function createHarborExecutorAdapter(driver: BenchmarkExecutorDriver): ExperimentExecutor {
  return createExecutorAdapter('harbor', driver);
}

export function createPierExecutorAdapter(driver: BenchmarkExecutorDriver): ExperimentExecutor {
  return createExecutorAdapter('pier', driver);
}

function createExecutorAdapter(
  kind: 'harbor' | 'pier',
  driver: BenchmarkExecutorDriver,
): ExperimentExecutor {
  return {
    kind,
    async execute({ cell, runSubject }): Promise<EvalResult> {
      let context: SubjectExecutionContext;
      try {
        context = await driver.prepare(cell);
      } catch (error) {
        return failedResult('infra_failed', `executor prepare failed: ${errorMessage(error)}`);
      }

      let result: EvalResult;
      try {
        const subject = await runSubject(context);
        if (subject.status === 'infra_failed' || subject.status === 'indeterminate') {
          result = {
            score: null,
            usage: subject.usage,
            costUsd: subject.costUsd,
            durationMs: subject.durationMs,
            status: subject.status,
            failureReason: subject.failureReason ?? `subject ${subject.status}`,
            artifacts: subject.artifacts,
          };
        } else {
          const verified = await driver.verify({ cell, context, subject });
          result = {
            score: verified.score,
            usage: subject.usage,
            costUsd: subject.costUsd,
            durationMs: subject.durationMs,
            status: verified.status,
            ...(verified.status === 'completed'
              ? {}
              : {
                  failureReason:
                    verified.failureReason ?? subject.failureReason ?? `cell ${verified.status}`,
                }),
            artifacts: [...subject.artifacts, ...verified.artifacts],
          };
        }
      } catch (error) {
        result = failedResult(
          'infra_failed',
          `executor verification failed: ${errorMessage(error)}`,
        );
      }

      if (driver.cleanup) {
        try {
          await driver.cleanup({ cell, context });
        } catch (error) {
          return {
            ...result,
            score: null,
            status: 'indeterminate',
            failureReason: `executor cleanup failed: ${errorMessage(error)}`,
          };
        }
      }
      return result;
    },
  };
}

function failedResult(status: 'infra_failed' | 'indeterminate', failureReason: string): EvalResult {
  return {
    score: null,
    usage: EMPTY_USAGE,
    costUsd: null,
    durationMs: 0,
    status,
    failureReason,
    artifacts: [],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
