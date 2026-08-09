import { spawn } from 'node:child_process';
import type { JsonObject } from './experiment.js';
import type { NormalizedUsage } from './result.js';
import type { SubjectAdapter, SubjectExecutionResult } from './runner.js';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const EMPTY_USAGE: NormalizedUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
});

export function createExternalSubjectAdapter(options?: {
  readonly now?: () => number;
}): SubjectAdapter {
  const now = options?.now ?? Date.now;
  return {
    kind: 'external',
    validate(cell) {
      decodeExternalSubjectConfig(cell.subject.config);
    },
    async execute({ cell, context }): Promise<SubjectExecutionResult> {
      const config = decodeExternalSubjectConfig(cell.subject.config);
      const args = config.args.map((argument) =>
        expandArgument(argument, {
          taskId: cell.task.id,
          taskInput: cell.task.input,
          subjectId: cell.subject.id,
          repetition: String(cell.repetition),
        }),
      );
      const startedAt = now();
      try {
        if (!context.executeExternal) {
          throw new Error('executor did not provide an external process capability');
        }
        const processResult = await context.executeExternal({
          command: config.command,
          args,
          cwd: context.cwd,
          environment: config.environment,
          signal: context.signal,
        });
        const durationMs = now() - startedAt;
        if (processResult.exitCode !== 0) {
          return {
            usage: EMPTY_USAGE,
            costUsd: null,
            durationMs,
            status: 'failed',
            artifacts: [{ kind: 'external_process', exitCode: processResult.exitCode }],
          };
        }
        const external = decodeExternalSubjectResult(processResult.stdout);
        return {
          ...(external.output === undefined ? {} : { output: external.output }),
          usage: external.usage,
          costUsd: external.costUsd,
          durationMs,
          status: 'completed',
          artifacts: [
            {
              kind: 'external_process',
              exitCode: processResult.exitCode,
            },
            ...external.artifacts,
          ],
        };
      } catch (error) {
        return {
          usage: EMPTY_USAGE,
          costUsd: null,
          durationMs: now() - startedAt,
          status: context.signal?.aborted ? 'indeterminate' : 'infra_failed',
          artifacts: [
            {
              kind: 'external_process_failure',
              reason: context.signal?.aborted ? 'cancelled' : classifyProcessFailure(error),
            },
          ],
        };
      }
    },
  };
}

interface ExternalSubjectConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: readonly string[];
}

interface ExternalSubjectProtocolResult {
  readonly output?: string;
  readonly usage: NormalizedUsage;
  readonly costUsd: number | null;
  readonly artifacts: readonly JsonObject[];
}

function decodeExternalSubjectResult(stdout: string): ExternalSubjectProtocolResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error('external subject returned invalid JSON');
  }
  const record = exactRecord(
    value,
    'external subject result',
    ['schemaVersion', 'usage', 'costUsd', 'artifacts'],
    ['output'],
  );
  if (record.schemaVersion !== 'maka.external_subject_result.v1') {
    throw new Error('external subject result.schemaVersion is invalid');
  }
  if (record.output !== undefined && typeof record.output !== 'string') {
    throw new Error('external subject result.output must be a string');
  }
  const usage = exactRecord(record.usage, 'external subject result.usage', [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
    'totalTokens',
  ]);
  const decodedUsage = {
    inputTokens: nonnegativeNumber(usage.inputTokens, 'usage.inputTokens'),
    outputTokens: nonnegativeNumber(usage.outputTokens, 'usage.outputTokens'),
    cacheReadTokens: nonnegativeNumber(usage.cacheReadTokens, 'usage.cacheReadTokens'),
    cacheWriteTokens: nonnegativeNumber(usage.cacheWriteTokens, 'usage.cacheWriteTokens'),
    reasoningTokens: nonnegativeNumber(usage.reasoningTokens, 'usage.reasoningTokens'),
    totalTokens: nonnegativeNumber(usage.totalTokens, 'usage.totalTokens'),
  };
  const costUsd =
    record.costUsd === null ? null : nonnegativeNumber(record.costUsd, 'result.costUsd');
  if (!Array.isArray(record.artifacts) || !record.artifacts.every(isJsonObject)) {
    throw new Error('external subject result.artifacts must contain JSON objects');
  }
  return {
    ...(record.output === undefined ? {} : { output: record.output }),
    usage: decodedUsage,
    costUsd,
    artifacts: record.artifacts,
  };
}

function decodeExternalSubjectConfig(config: JsonObject): ExternalSubjectConfig {
  const expected = ['command', 'args', 'environment'];
  for (const key of Object.keys(config)) {
    if (!expected.includes(key)) throw new Error(`external subject config.${key} is not supported`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(config, key)) throw new Error(`external subject config.${key} is required`);
  }
  if (typeof config.command !== 'string' || config.command.length === 0) {
    throw new Error('external subject config.command is required');
  }
  if (!Array.isArray(config.args) || !config.args.every((value) => typeof value === 'string')) {
    throw new Error('external subject config.args must be an array of strings');
  }
  if (
    !Array.isArray(config.environment) ||
    !config.environment.every((value) => typeof value === 'string' && value.length > 0)
  ) {
    throw new Error('external subject config.environment must be an array of names');
  }
  return config as unknown as ExternalSubjectConfig;
}

function expandArgument(
  value: string,
  replacements: {
    taskId: string;
    taskInput: string;
    subjectId: string;
    repetition: string;
  },
): string {
  return value
    .replaceAll('{{task.id}}', replacements.taskId)
    .replaceAll('{{task.input}}', replacements.taskInput)
    .replaceAll('{{subject.id}}', replacements.subjectId)
    .replaceAll('{{repetition}}', replacements.repetition);
}

export function createLocalExternalExecution(sourceEnvironment: NodeJS.ProcessEnv = process.env) {
  return (input: {
    command: string;
    args: readonly string[];
    cwd: string;
    environment: readonly string[];
    signal?: AbortSignal;
  }): Promise<{ exitCode: number; stdout: string }> => {
    const environment: NodeJS.ProcessEnv = {};
    for (const name of input.environment) {
      const value = sourceEnvironment[name];
      if (value !== undefined) environment[name] = value;
    }
    return runProcess({ ...input, env: environment });
  };
}

function runProcess(input: {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<{ exitCode: number; stdout: string }> {
  if (input.signal?.aborted) return Promise.reject(new Error('external subject was cancelled'));
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      killProcessTree(child.pid);
      reject(error);
    };
    const capture = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        fail(new Error(`external subject output exceeded ${MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    const abort = () => fail(new Error('external subject was cancelled'));
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    child.once('error', fail);
    child.once('close', (code, signal) => {
      input.signal?.removeEventListener('abort', abort);
      if (settled) return;
      settled = true;
      if (code === null) {
        reject(new Error(`external subject terminated by ${signal ?? 'unknown signal'}`));
        return;
      }
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdout).toString('utf8'),
      });
    });
  });
}

function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
  } catch {
    // The process may have exited between the failing read and the signal.
  }
}

function exactRecord(
  value: unknown,
  where: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`${where}.${key} is not supported`);
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) throw new Error(`${where}.${key} is required`);
  }
  return record;
}

function nonnegativeNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${where} must be a non-negative finite number`);
  }
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function classifyProcessFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'external subject returned invalid JSON') return 'invalid_result';
  if (message.includes('output exceeded')) return 'output_limit';
  if (message.includes('result.')) return 'invalid_result';
  return 'launch_failed';
}
