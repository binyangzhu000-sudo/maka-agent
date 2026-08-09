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
  readonly artifacts: readonly JsonObject[];
}

export interface ExperimentExecutorDriver {
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

export function createExperimentExecutorAdapter(
  kind: string,
  driver: ExperimentExecutorDriver,
): ExperimentExecutor {
  return {
    kind,
    async execute({ cell, runSubject }): Promise<EvalResult> {
      let context: SubjectExecutionContext;
      try {
        context = await driver.prepare(cell);
      } catch {
        return failedResult('infra_failed', 'prepare');
      }

      let subject: SubjectExecutionResult;
      try {
        subject = await runSubject(context);
      } catch {
        subject = {
          ...failedResult('infra_failed', 'subject'),
          status: 'infra_failed',
        };
      }

      let result: EvalResult;
      if (subject.status === 'infra_failed' || subject.status === 'indeterminate') {
        result = {
          score: null,
          usage: subject.usage,
          costUsd: subject.costUsd,
          durationMs: subject.durationMs,
          status: subject.status,
          artifacts: subject.artifacts,
        };
      } else {
        try {
          const verified = await driver.verify({ cell, context, subject });
          const status = subject.status === 'failed' ? 'subject_failed' : verified.status;
          result = {
            score: verified.score,
            usage: subject.usage,
            costUsd: subject.costUsd,
            durationMs: subject.durationMs,
            status,
            artifacts: [...subject.artifacts, ...verified.artifacts],
          };
        } catch {
          result = {
            score: null,
            usage: subject.usage,
            costUsd: subject.costUsd,
            durationMs: subject.durationMs,
            status: 'infra_failed',
            artifacts: [...subject.artifacts, executorFailureArtifact('verify')],
          };
        }
      }

      if (driver.cleanup) {
        try {
          await driver.cleanup({ cell, context });
        } catch {
          return {
            ...result,
            score: null,
            status: 'indeterminate',
            artifacts: [...result.artifacts, executorFailureArtifact('cleanup')],
          };
        }
      }
      return result;
    },
  };
}

function failedResult(
  status: 'infra_failed' | 'indeterminate',
  phase: 'prepare' | 'subject',
): EvalResult {
  return {
    score: null,
    usage: EMPTY_USAGE,
    costUsd: null,
    durationMs: 0,
    status,
    artifacts: [executorFailureArtifact(phase)],
  };
}

function executorFailureArtifact(phase: 'prepare' | 'subject' | 'verify' | 'cleanup'): JsonObject {
  return { kind: 'executor_failure', phase };
}
