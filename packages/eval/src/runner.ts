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
  EphemeralRuntimeHostExecutionInput,
  EphemeralRuntimeHostExecutionOptions,
  EphemeralRuntimeHostExecutionResult,
} from '@maka/runtime-host/client';

export interface SubjectExecutionResult {
  readonly output?: string;
  readonly usage: NormalizedUsage;
  readonly costUsd: number | null;
  readonly durationMs: number;
  readonly status: Exclude<EvalResult['status'], 'subject_failed'> | 'failed';
  readonly failureReason?: string;
  readonly artifacts: readonly JsonObject[];
}

export interface SubjectExecutionContext {
  readonly cwd: string;
  readonly metadata: JsonObject;
  readonly signal?: AbortSignal;
  readonly executeMaka?: (
    input: EphemeralRuntimeHostExecutionInput,
    options?: EphemeralRuntimeHostExecutionOptions,
  ) => Promise<EphemeralRuntimeHostExecutionResult>;
  readonly executeExternal?: (input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly environment: readonly string[];
    readonly signal?: AbortSignal;
  }) => Promise<{ readonly exitCode: number; readonly stdout: string }>;
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
  execute(input: {
    readonly cell: ExperimentCell;
    readonly runSubject: (context: SubjectExecutionContext) => Promise<SubjectExecutionResult>;
  }): Promise<EvalResult>;
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
    const attempts = await input.store.list(cell.id);
    if (selectCellResult(attempts)) continue;
    const subject = subjects.get(cell.subject.kind)!;
    const sequence = (attempts.at(-1)?.sequence ?? 0) + 1;
    const startedAt = now();
    const result = await executor.execute({
      cell,
      runSubject: (context) => subject.execute({ cell, context }),
    });
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
