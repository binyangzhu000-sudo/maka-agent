import { randomUUID } from 'node:crypto';
import type { JsonObject } from './experiment.js';
import type { NormalizedUsage } from './result.js';
import type { SubjectAdapter, SubjectExecutionResult } from './runner.js';

const EMPTY_USAGE: NormalizedUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
});

export interface CreateMakaSubjectAdapterInput {
  readonly newId?: () => string;
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
}

export function createMakaSubjectAdapter(
  input: CreateMakaSubjectAdapterInput = {},
): SubjectAdapter {
  const newId = input.newId ?? randomUUID;
  const now = input.now ?? Date.now;
  const pollIntervalMs = input.pollIntervalMs ?? 25;
  return {
    kind: 'maka',
    validate(cell) {
      decodeMakaSubjectConfig(cell.subject.config);
    },
    async execute({ cell, context }): Promise<SubjectExecutionResult> {
      const config = decodeMakaSubjectConfig(cell.subject.config);
      const sessionId = newId();
      const turnId = newId();
      const startedAt = now();
      try {
        if (!context.executeMaka) {
          throw new Error('executor did not provide a Runtime Host execution capability');
        }
        const result = await context.executeMaka(
          {
            executionId: sessionId,
            turnId,
            cwd: context.cwd,
            name: cell.subject.id,
            modelTarget: {
              kind: 'explicit',
              connectionSlug: config.connectionSlug,
              model: config.model,
            },
            permissionMode: config.permissionMode,
            collaborationMode: config.collaborationMode,
            orchestrationMode: config.orchestrationMode,
            ...(config.thinkingLevel === null ? {} : { thinkingLevel: config.thinkingLevel }),
            content: { text: cell.task.input },
            maxSteps: config.maxSteps,
          },
          {
            signal: context.signal,
            pollIntervalMs,
          },
        );
        return {
          usage: result.usage,
          costUsd: result.costUsd,
          durationMs: now() - startedAt,
          status: result.status === 'completed' ? 'completed' : 'failed',
          ...(result.failureReason ? { failureReason: result.failureReason } : {}),
          artifacts: [
            runtimeHostRunArtifact(result.executionId, result.rootTurnId, result.rootRunId),
          ],
        };
      } catch (error) {
        return failureResult('indeterminate', errorMessage(error), now() - startedAt, [
          { kind: 'runtime_host_execution', executionId: sessionId },
        ]);
      }
    },
  };
}

interface MakaSubjectConfig {
  readonly connectionSlug: string;
  readonly model: string;
  readonly thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  readonly permissionMode: 'explore' | 'ask' | 'execute' | 'bypass';
  readonly collaborationMode: 'agent' | 'plan';
  readonly orchestrationMode: 'default' | 'swarm' | 'graph';
  readonly maxSteps: number;
}

function decodeMakaSubjectConfig(config: JsonObject): MakaSubjectConfig {
  const expected = [
    'connectionSlug',
    'model',
    'thinkingLevel',
    'permissionMode',
    'collaborationMode',
    'orchestrationMode',
    'maxSteps',
  ];
  for (const key of Object.keys(config)) {
    if (!expected.includes(key)) throw new Error(`Maka subject config.${key} is not supported`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(config, key)) throw new Error(`Maka subject config.${key} is required`);
  }
  const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const permissionModes = ['explore', 'ask', 'execute', 'bypass'];
  const collaborationModes = ['agent', 'plan'];
  const orchestrationModes = ['default', 'swarm', 'graph'];
  if (typeof config.connectionSlug !== 'string' || config.connectionSlug.length === 0) {
    throw new Error('Maka subject config.connectionSlug is required');
  }
  if (typeof config.model !== 'string' || config.model.length === 0) {
    throw new Error('Maka subject config.model is required');
  }
  if (config.thinkingLevel !== null && !thinkingLevels.includes(config.thinkingLevel as string)) {
    throw new Error('Maka subject config.thinkingLevel is invalid');
  }
  if (!permissionModes.includes(config.permissionMode as string)) {
    throw new Error('Maka subject config.permissionMode is invalid');
  }
  if (!collaborationModes.includes(config.collaborationMode as string)) {
    throw new Error('Maka subject config.collaborationMode is invalid');
  }
  if (!orchestrationModes.includes(config.orchestrationMode as string)) {
    throw new Error('Maka subject config.orchestrationMode is invalid');
  }
  if (!Number.isSafeInteger(config.maxSteps) || (config.maxSteps as number) < 1) {
    throw new Error('Maka subject config.maxSteps must be a positive integer');
  }
  return config as unknown as MakaSubjectConfig;
}

function failureResult(
  status: 'failed' | 'infra_failed' | 'indeterminate',
  failureReason: string,
  durationMs: number,
  artifacts: readonly JsonObject[] = [],
): SubjectExecutionResult {
  return {
    usage: EMPTY_USAGE,
    costUsd: null,
    durationMs,
    status,
    failureReason,
    artifacts,
  };
}

function runtimeHostRunArtifact(sessionId: string, turnId: string, runId: string): JsonObject {
  return { kind: 'runtime_host_run', sessionId, turnId, runId };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
