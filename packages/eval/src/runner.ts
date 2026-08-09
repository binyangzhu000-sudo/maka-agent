import {
  expandExperiment,
  type ExperimentCell,
  type ExperimentSpec,
  type JsonObject,
} from './experiment.js';
import {
  selectCellResult,
  type CellAttempt,
  type EvalResult,
  type NormalizedUsage,
} from './result.js';
import type {
  HostedExecutionClientOptions,
  HostedExecutionProjection,
  HostedExecutionStartInput,
} from '@maka/runtime-host/client';

export interface SubjectExecutionResult {
  readonly output?: string;
  readonly usage: NormalizedUsage | null;
  readonly costUsd: number | null;
  readonly durationMs: number;
  readonly status: Exclude<EvalResult['status'], 'subject_failed'> | 'failed';
  readonly artifacts: readonly JsonObject[];
}

export interface SubjectExecutionEnvironment {
  readonly cwd: string;
  readonly taskInput?: string;
  readonly metadata: JsonObject;
  readonly executeMaka?: (
    input: HostedExecutionStartInput,
    options?: HostedExecutionClientOptions,
  ) => Promise<Exclude<HostedExecutionProjection, { readonly status: 'running' }>>;
  readonly executeExternal?: (input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly environment: readonly string[];
    readonly signal?: AbortSignal;
  }) => Promise<{ readonly exitCode: number; readonly stdout: string }>;
}

export interface SubjectExecutionContext extends SubjectExecutionEnvironment {
  readonly signal?: AbortSignal;
}

export interface SubjectAdapter {
  readonly kind: string;
  validate?(cell: ExperimentCell): void;
  execute(input: {
    readonly cell: ExperimentCell;
    readonly context: SubjectExecutionContext;
  }): Promise<SubjectExecutionResult>;
}

export interface ExperimentExecutor {
  readonly kind: string;
  prepare(input: {
    readonly cell: ExperimentCell;
    readonly signal?: AbortSignal;
  }): Promise<SubjectExecutionEnvironment>;
  verify(input: {
    readonly cell: ExperimentCell;
    readonly environment: SubjectExecutionEnvironment;
    readonly subject: SubjectExecutionResult;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly status: EvalResult['status'];
    readonly score: number | null;
    readonly artifacts: readonly JsonObject[];
  }>;
  cleanup?(input: {
    readonly cell: ExperimentCell;
    readonly environment: SubjectExecutionEnvironment;
  }): Promise<void>;
}

export interface AttemptStore {
  list(cellId: string): Promise<readonly CellAttempt[]>;
  append(attempt: CellAttempt): Promise<void>;
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

export interface RunExperimentInput {
  readonly spec: ExperimentSpec;
  readonly store: AttemptStore;
  readonly executors: readonly ExperimentExecutor[];
  readonly subjects: readonly SubjectAdapter[];
  readonly cellIds?: readonly string[];
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

export interface ExperimentRunResult {
  readonly results: ReadonlyMap<string, CellAttempt>;
  readonly replaceableCellIds: readonly string[];
}

export async function runExperiment(input: RunExperimentInput): Promise<ExperimentRunResult> {
  return input.store.runExclusive(() => runExperimentExclusive(input));
}

async function runExperimentExclusive(input: RunExperimentInput): Promise<ExperimentRunResult> {
  const cells = expandExperiment(input.spec);
  const selected = input.cellIds ? new Set(input.cellIds) : new Set(cells.map((cell) => cell.id));
  const knownCellIds = new Set(cells.map((cell) => cell.id));
  for (const cellId of selected) {
    if (!knownCellIds.has(cellId)) throw new Error(`unknown experiment cell: ${cellId}`);
  }

  const executor = uniqueAdapter(input.executors, input.spec.executor.kind, 'executor');
  const subjects = uniqueAdapters(input.subjects, 'subject');
  const now = input.now ?? Date.now;

  for (const cell of cells) {
    if (!selected.has(cell.id)) continue;
    const subject = subjects.get(cell.subject.kind);
    if (!subject) throw new Error(`no subject adapter registered for ${cell.subject.kind}`);
    subject.validate?.(cell);
  }

  for (const cell of cells) {
    if (!selected.has(cell.id)) continue;
    if (input.signal?.aborted) break;
    const attempts = await input.store.list(cell.id);
    if (input.signal?.aborted) break;
    if (selectCellResult(attempts)) continue;
    const subject = subjects.get(cell.subject.kind)!;
    const sequence = (attempts.at(-1)?.sequence ?? 0) + 1;
    const startedAt = now();
    const result = await executeCell(executor, subject, cell, input.signal);
    await input.store.append({
      cellId: cell.id,
      sequence,
      startedAt,
      completedAt: now(),
      result,
    });
  }

  const results = new Map<string, CellAttempt>();
  const replaceableCellIds: string[] = [];
  for (const cell of cells) {
    const attempts = await input.store.list(cell.id);
    const result = selectCellResult(attempts);
    if (result) results.set(cell.id, result);
    else if (attempts.length > 0) replaceableCellIds.push(cell.id);
  }
  return { results, replaceableCellIds };
}

async function executeCell(
  executor: ExperimentExecutor,
  subjectAdapter: SubjectAdapter,
  cell: ExperimentCell,
  signal?: AbortSignal,
): Promise<EvalResult> {
  let environment: SubjectExecutionEnvironment;
  try {
    environment = await executor.prepare({ cell, signal });
  } catch {
    return failedResult('infra_failed', 'prepare');
  }

  let subject: SubjectExecutionResult;
  try {
    subject = await subjectAdapter.execute({
      cell,
      context: { ...environment, ...(signal ? { signal } : {}) },
    });
  } catch {
    subject = { ...failedResult('infra_failed', 'subject'), status: 'infra_failed' };
  }

  let result: EvalResult;
  try {
    const verified = await executor.verify({
      cell,
      environment,
      subject,
    });
    const cancelledByCaller = signal?.aborted === true;
    const subjectInfrastructureFailed = subject.status === 'infra_failed';
    const uncertain =
      cancelledByCaller || subjectInfrastructureFailed || subject.status === 'indeterminate';
    result = {
      score: uncertain ? null : verified.score,
      usage: subject.usage,
      costUsd: subject.costUsd,
      durationMs: subject.durationMs,
      status: cancelledByCaller
        ? 'indeterminate'
        : subjectInfrastructureFailed
          ? 'infra_failed'
          : subject.status === 'indeterminate'
            ? 'indeterminate'
            : subject.status === 'failed'
              ? 'subject_failed'
              : verified.status,
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

  if (executor.cleanup) {
    try {
      await executor.cleanup({ cell, environment });
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
}

function failedResult(
  status: 'infra_failed' | 'indeterminate',
  phase: 'prepare' | 'subject',
): EvalResult {
  return {
    score: null,
    usage: null,
    costUsd: null,
    durationMs: 0,
    status,
    artifacts: [executorFailureArtifact(phase)],
  };
}

function executorFailureArtifact(phase: 'prepare' | 'subject' | 'verify' | 'cleanup'): JsonObject {
  return { kind: 'executor_failure', phase };
}

function uniqueAdapter<T extends { readonly kind: string }>(
  adapters: readonly T[],
  kind: string,
  label: string,
): T {
  const matches = adapters.filter((adapter) => adapter.kind === kind);
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `no ${label} adapter registered for ${kind}`
        : `multiple ${label} adapters registered for ${kind}`,
    );
  }
  return matches[0] as T;
}

function uniqueAdapters<T extends { readonly kind: string }>(
  adapters: readonly T[],
  label: string,
): ReadonlyMap<string, T> {
  const byKind = new Map<string, T>();
  for (const adapter of adapters) {
    if (byKind.has(adapter.kind))
      throw new Error(`multiple ${label} adapters registered for ${adapter.kind}`);
    byKind.set(adapter.kind, adapter);
  }
  return byKind;
}
