import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { JsonObject } from './experiment.js';
import type { CellAttempt, EvalResultStatus, NormalizedUsage } from './result.js';
import type { AttemptStore } from './runner.js';

export class FileAttemptStore implements AttemptStore {
  constructor(readonly path: string) {}

  async list(cellId: string): Promise<readonly CellAttempt[]> {
    const attempts = await this.#readAll();
    return attempts
      .filter((attempt) => attempt.cellId === cellId)
      .sort((left, right) => left.sequence - right.sequence);
  }

  async append(attempt: CellAttempt): Promise<void> {
    const canonical = decodeCellAttempt(attempt, 'attempt to append');
    const attempts = await this.list(canonical.cellId);
    const expected = (attempts.at(-1)?.sequence ?? 0) + 1;
    if (canonical.sequence !== expected) {
      throw new Error(
        `attempt ${canonical.cellId}#${canonical.sequence} is not the next immutable sequence ${expected}`,
      );
    }
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(canonical)}\n`, 'utf8');
  }

  async #readAll(): Promise<CellAttempt[]> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (text.length > 0 && !text.endsWith('\n')) {
      throw new Error(`${this.path}: attempts log has an incomplete final record`);
    }
    return text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line, index) => {
        let value: unknown;
        try {
          value = JSON.parse(line) as unknown;
        } catch (error) {
          throw new Error(`${this.path}:${index + 1}: invalid JSON: ${errorMessage(error)}`);
        }
        return decodeCellAttempt(value, `${this.path}:${index + 1}`);
      });
  }
}

function decodeCellAttempt(value: unknown, where: string): CellAttempt {
  const record = object(value, where);
  const result = object(record.result, `${where}.result`);
  const usage = object(result.usage, `${where}.result.usage`);
  const status = resultStatus(result.status, `${where}.result.status`);
  const artifacts = array(result.artifacts, `${where}.result.artifacts`).map((artifact, index) =>
    object(artifact, `${where}.result.artifacts[${index}]`),
  );
  const failureReason = optionalString(result.failureReason, `${where}.result.failureReason`);
  if (status !== 'completed' && !failureReason) {
    throw new Error(`${where}.result.failureReason is required for ${status}`);
  }
  return {
    cellId: nonemptyString(record.cellId, `${where}.cellId`),
    sequence: positiveInteger(record.sequence, `${where}.sequence`),
    startedAt: nonnegativeNumber(record.startedAt, `${where}.startedAt`),
    completedAt: nonnegativeNumber(record.completedAt, `${where}.completedAt`),
    result: {
      score: nullableFiniteNumber(result.score, `${where}.result.score`),
      usage: decodeUsage(usage, `${where}.result.usage`),
      costUsd: nullableNonnegativeNumber(result.costUsd, `${where}.result.costUsd`),
      durationMs: nonnegativeNumber(result.durationMs, `${where}.result.durationMs`),
      status,
      ...(failureReason ? { failureReason } : {}),
      artifacts: artifacts as JsonObject[],
    },
  };
}

function decodeUsage(value: Record<string, unknown>, where: string): NormalizedUsage {
  return {
    inputTokens: nonnegativeNumber(value.inputTokens, `${where}.inputTokens`),
    outputTokens: nonnegativeNumber(value.outputTokens, `${where}.outputTokens`),
    cacheReadTokens: nonnegativeNumber(value.cacheReadTokens, `${where}.cacheReadTokens`),
    cacheWriteTokens: nonnegativeNumber(value.cacheWriteTokens, `${where}.cacheWriteTokens`),
    reasoningTokens: nonnegativeNumber(value.reasoningTokens, `${where}.reasoningTokens`),
    totalTokens: nonnegativeNumber(value.totalTokens, `${where}.totalTokens`),
  };
}

function resultStatus(value: unknown, where: string): EvalResultStatus {
  if (
    value !== 'completed' &&
    value !== 'subject_failed' &&
    value !== 'infra_failed' &&
    value !== 'indeterminate'
  ) {
    throw new Error(`${where} is invalid`);
  }
  return value;
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`);
  return value;
}

function nonemptyString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${where} is required`);
  return value;
}

function optionalString(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${where} is invalid`);
  return value;
}

function positiveInteger(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${where} must be a positive integer`);
  }
  return value as number;
}

function nonnegativeNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${where} must be a non-negative finite number`);
  }
  return value;
}

function nullableFiniteNumber(value: unknown, where: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${where} must be a finite number or null`);
  }
  return value;
}

function nullableNonnegativeNumber(value: unknown, where: string): number | null {
  if (value === null) return null;
  return nonnegativeNumber(value, where);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
