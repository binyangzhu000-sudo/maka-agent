import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonObject } from './experiment.js';
import type { CellAttempt, EvalResultStatus, NormalizedUsage } from './result.js';
import type { AttemptStore } from './runner.js';

export class FileAttemptStore implements AttemptStore {
  constructor(readonly path: string) {}

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.path, { recursive: true });
    const lockPath = join(this.path, '.writer.lock');
    await acquireLock(lockPath);
    try {
      return await operation();
    } finally {
      await unlink(lockPath);
    }
  }

  async list(cellId: string): Promise<readonly CellAttempt[]> {
    const directory = this.#cellDirectory(cellId);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const attempts = [];
    for (const name of names.sort()) {
      const match = /^(\d{6})\.json$/.exec(name);
      if (!match) continue;
      const sequence = Number(match[1]);
      const attempt = decodeCellAttempt(
        JSON.parse(await readFile(join(directory, name), 'utf8')) as unknown,
        join(directory, name),
      );
      if (attempt.cellId !== cellId || attempt.sequence !== sequence) {
        throw new Error(`${join(directory, name)} does not match its immutable identity`);
      }
      attempts.push(attempt);
    }
    return attempts;
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
    const directory = this.#cellDirectory(canonical.cellId);
    await mkdir(directory, { recursive: true });
    const recordPath = join(directory, `${String(canonical.sequence).padStart(6, '0')}.json`);
    try {
      await writeFile(recordPath, `${JSON.stringify(canonical)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(
          `attempt ${canonical.cellId}#${canonical.sequence} already exists and is immutable`,
        );
      }
      throw error;
    }
  }

  #cellDirectory(cellId: string): string {
    return join(this.path, createHash('sha256').update(cellId).digest('hex'));
  }
}

async function acquireLock(path: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(path, `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt === 0 && (await removeStaleLock(path))) continue;
      throw new Error(`${path}: experiment already has an active writer`);
    }
  }
}

async function removeStaleLock(path: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown };
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) < 1) return false;
    try {
      process.kill(value.pid as number, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
      await unlink(path);
      return true;
    }
  } catch {
    return false;
  }
}

function decodeCellAttempt(value: unknown, where: string): CellAttempt {
  const record = exactObject(value, where, [
    'cellId',
    'sequence',
    'startedAt',
    'completedAt',
    'result',
  ]);
  const result = exactObject(record.result, `${where}.result`, [
    'score',
    'usage',
    'costUsd',
    'durationMs',
    'status',
    'artifacts',
  ]);
  const usage = exactObject(result.usage, `${where}.result.usage`, [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
    'totalTokens',
  ]);
  const status = resultStatus(result.status, `${where}.result.status`);
  const artifacts = array(result.artifacts, `${where}.result.artifacts`).map((artifact, index) =>
    object(artifact, `${where}.result.artifacts[${index}]`),
  );
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

function exactObject(
  value: unknown,
  where: string,
  fields: readonly string[],
): Record<string, unknown> {
  const record = object(value, where);
  const allowed = new Set(fields);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`${where}.${key} is not supported`);
  }
  for (const field of fields) {
    if (!Object.hasOwn(record, field)) throw new Error(`${where}.${field} is required`);
  }
  return record;
}

function array(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`);
  return value;
}

function nonemptyString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${where} is required`);
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
