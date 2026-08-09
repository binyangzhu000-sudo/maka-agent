import { spawn } from 'node:child_process';
import type { JsonObject } from './experiment.js';
import type { SubjectAdapter, SubjectExecutionResult } from './runner.js';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const EMPTY_USAGE = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
});

export function createExternalSubjectAdapter(options?: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}): SubjectAdapter {
  const sourceEnvironment = options?.environment ?? process.env;
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
      const environment: NodeJS.ProcessEnv = {};
      for (const name of config.environment) {
        const value = sourceEnvironment[name];
        if (value !== undefined) environment[name] = value;
      }
      const startedAt = now();
      try {
        const processResult = await runProcess({
          command: config.command,
          args,
          cwd: context.cwd,
          env: environment,
          signal: context.signal,
        });
        const durationMs = now() - startedAt;
        return {
          output: processResult.stdout,
          usage: EMPTY_USAGE,
          costUsd: null,
          durationMs,
          status: processResult.exitCode === 0 ? 'completed' : 'failed',
          ...(processResult.exitCode === 0
            ? {}
            : {
                failureReason:
                  processResult.stderr.trim() ||
                  `external subject exited with code ${processResult.exitCode}`,
              }),
          artifacts: [
            {
              kind: 'external_process',
              command: config.command,
              exitCode: processResult.exitCode,
            },
          ],
        };
      } catch (error) {
        return {
          usage: EMPTY_USAGE,
          costUsd: null,
          durationMs: now() - startedAt,
          status: context.signal?.aborted ? 'failed' : 'infra_failed',
          failureReason: errorMessage(error),
          artifacts: [],
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

function runProcess(input: {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      signal: input.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
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
    child.once('error', fail);
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === null) {
        reject(new Error(`external subject terminated by ${signal ?? 'unknown signal'}`));
        return;
      }
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
