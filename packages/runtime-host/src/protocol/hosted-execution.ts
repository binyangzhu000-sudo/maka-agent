import type { CollaborationMode } from '@maka/core/collaboration';
import type { SessionStartMode } from '@maka/core/explore-agent';
import type { MessageContent } from '@maka/core';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { OrchestrationMode } from '@maka/core/orchestration';
import type { PermissionMode } from '@maka/core/permission';
import {
  requireCount,
  requireEntityId,
  requireExactRecord,
  requireRecord,
  requireShapedRecord,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';
import {
  decodeSessionCreateInput,
  type SessionCreateInput,
  type SessionModelTarget,
} from './session-catalog.js';
import { decodeMessageContent } from './turn.js';

const COMMON_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'not_found',
  'operation_conflict',
  'internal_failure',
] as const;

export interface HostedExecutionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
}

export interface HostedExecutionStartInput {
  readonly executionId: string;
  readonly cwd: string;
  readonly mode?: SessionStartMode;
  readonly projectId?: string | null;
  readonly name?: string;
  readonly labels?: readonly string[];
  readonly modelTarget: SessionModelTarget;
  readonly thinkingLevel?: ThinkingLevel;
  readonly permissionMode?: PermissionMode;
  readonly collaborationMode?: CollaborationMode;
  readonly orchestrationMode?: OrchestrationMode;
  readonly content: MessageContent;
  readonly maxSteps?: number;
}

export interface HostedExecutionReferenceInput {
  readonly executionId: string;
}

export type HostedExecutionProjection =
  | { readonly executionId: string; readonly status: 'running' }
  | {
      readonly executionId: string;
      readonly status: 'completed' | 'failed' | 'cancelled' | 'indeterminate';
      readonly failureReason?: string;
      readonly usage: HostedExecutionUsage;
      readonly costUsd: number | null;
      readonly usageComplete: boolean;
    };

export const HOSTED_EXECUTION_OPERATION_SPECS = {
  'hosted.execution.start': defineOperation<
    HostedExecutionStartInput,
    HostedExecutionProjection,
    (typeof COMMON_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: COMMON_ERRORS,
    decodeInput: decodeHostedExecutionStartInput,
    decodeOutput: decodeHostedExecutionProjection,
  }),
  'hosted.execution.query': defineOperation<
    HostedExecutionReferenceInput,
    HostedExecutionProjection,
    (typeof COMMON_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: COMMON_ERRORS,
    decodeInput: decodeHostedExecutionReferenceInput,
    decodeOutput: decodeHostedExecutionProjection,
  }),
  'hosted.execution.cancel': defineOperation<
    HostedExecutionReferenceInput,
    HostedExecutionProjection,
    (typeof COMMON_ERRORS)[number]
  >({
    mode: 'control',
    availability: 'ready',
    errors: COMMON_ERRORS,
    decodeInput: decodeHostedExecutionReferenceInput,
    decodeOutput: decodeHostedExecutionProjection,
  }),
} as const;

export function decodeHostedExecutionStartInput(value: unknown): HostedExecutionStartInput {
  const input = requireShapedRecord(
    value,
    'Hosted execution start input',
    ['executionId', 'cwd', 'modelTarget', 'content'],
    [
      'mode',
      'projectId',
      'name',
      'labels',
      'thinkingLevel',
      'permissionMode',
      'collaborationMode',
      'orchestrationMode',
      'maxSteps',
    ],
  );
  const executionId = requireEntityId(input.executionId, 'executionId');
  const { sessionId: _sessionId, ...session } = decodeSessionCreateInput({
    sessionId: executionId,
    cwd: input.cwd,
    modelTarget: input.modelTarget,
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.labels === undefined ? {} : { labels: input.labels }),
    ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
    ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
    ...(input.collaborationMode === undefined
      ? {}
      : { collaborationMode: input.collaborationMode }),
    ...(input.orchestrationMode === undefined
      ? {}
      : { orchestrationMode: input.orchestrationMode }),
  });
  return {
    executionId,
    ...session,
    content: decodeMessageContent(input.content),
    ...(input.maxSteps === undefined
      ? {}
      : { maxSteps: requirePositiveCount(input.maxSteps, 'maxSteps') }),
  };
}

export function decodeHostedExecutionReferenceInput(value: unknown): HostedExecutionReferenceInput {
  const input = requireExactRecord(value, 'Hosted execution reference', ['executionId']);
  return { executionId: requireEntityId(input.executionId, 'executionId') };
}

export function decodeHostedExecutionProjection(value: unknown): HostedExecutionProjection {
  const result = requireRecord(value, 'Hosted execution projection');
  const executionId = requireEntityId(result.executionId, 'executionId');
  if (result.status === 'running') {
    requireExactRecord(result, 'Running Hosted execution projection', ['executionId', 'status']);
    return { executionId, status: 'running' };
  }
  if (
    result.status !== 'completed' &&
    result.status !== 'failed' &&
    result.status !== 'cancelled' &&
    result.status !== 'indeterminate'
  ) {
    throw invalidProtocolFrame('Invalid Hosted execution status');
  }
  const terminal = requireShapedRecord(
    result,
    'Terminal Hosted execution projection',
    ['executionId', 'status', 'usage', 'costUsd', 'usageComplete'],
    ['failureReason'],
  );
  return {
    executionId,
    status: result.status,
    ...(terminal.failureReason === undefined
      ? {}
      : { failureReason: requireFailureReason(terminal.failureReason) }),
    usage: decodeUsage(terminal.usage),
    costUsd: decodeCost(terminal.costUsd),
    usageComplete: requireBoolean(terminal.usageComplete, 'usageComplete'),
  };
}

function decodeUsage(value: unknown): HostedExecutionUsage {
  const usage = requireExactRecord(value, 'Hosted execution usage', [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
    'totalTokens',
  ]);
  return {
    inputTokens: requireCount(usage.inputTokens, 'inputTokens'),
    outputTokens: requireCount(usage.outputTokens, 'outputTokens'),
    cacheReadTokens: requireCount(usage.cacheReadTokens, 'cacheReadTokens'),
    cacheWriteTokens: requireCount(usage.cacheWriteTokens, 'cacheWriteTokens'),
    reasoningTokens: requireCount(usage.reasoningTokens, 'reasoningTokens'),
    totalTokens: requireCount(usage.totalTokens, 'totalTokens'),
  };
}

function requirePositiveCount(value: unknown, label: string): number {
  const count = requireCount(value, label);
  if (count === 0) throw invalidProtocolFrame(`Invalid ${label}`);
  return count;
}

function decodeCost(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalidProtocolFrame('Invalid Hosted execution cost');
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidProtocolFrame(`Invalid ${label}`);
  return value;
}

function requireFailureReason(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw invalidProtocolFrame('Invalid Hosted execution failure reason');
  }
  return value;
}
