import type {
  BenchmarkSpec,
  ExecutorSpec,
  ExperimentSpec,
  JsonObject,
  JsonValue,
  SubjectSpec,
  TaskSpec,
} from './experiment.js';

const ROOT_FIELDS = [
  'schemaVersion',
  'id',
  'benchmark',
  'executor',
  'subjects',
  'tasks',
  'repetitions',
  'budget',
  'verifier',
] as const;

export function parseExperimentSpec(value: unknown): ExperimentSpec {
  const record = exactObject(value, 'experiment spec', ROOT_FIELDS);
  if (record.schemaVersion !== 'maka.eval.v1') {
    throw new Error('experiment spec.schemaVersion must be maka.eval.v1');
  }
  const subjects = nonemptyArray(record.subjects, 'experiment spec.subjects').map(decodeSubject);
  const tasks = nonemptyArray(record.tasks, 'experiment spec.tasks').map(decodeTask);
  assertUniqueIds(subjects, 'subject');
  assertUniqueIds(tasks, 'task');
  return deepFreeze({
    schemaVersion: 'maka.eval.v1',
    id: identifier(record.id, 'experiment spec.id'),
    benchmark: decodeBenchmark(record.benchmark),
    executor: decodeExecutor(record.executor),
    subjects,
    tasks,
    repetitions: positiveInteger(record.repetitions, 'experiment spec.repetitions'),
    budget: jsonObject(record.budget, 'experiment spec.budget'),
    verifier: jsonObject(record.verifier, 'experiment spec.verifier'),
  });
}

function decodeBenchmark(value: unknown): BenchmarkSpec {
  const record = exactObject(value, 'experiment spec.benchmark', ['id', 'version', 'config']);
  return {
    id: identifier(record.id, 'experiment spec.benchmark.id'),
    version: nonemptyString(record.version, 'experiment spec.benchmark.version'),
    config: jsonObject(record.config, 'experiment spec.benchmark.config'),
  };
}

function decodeExecutor(value: unknown): ExecutorSpec {
  const record = exactObject(value, 'experiment spec.executor', ['kind', 'config']);
  return {
    kind: identifier(record.kind, 'experiment spec.executor.kind'),
    config: jsonObject(record.config, 'experiment spec.executor.config'),
  };
}

function decodeSubject(value: unknown, index: number): SubjectSpec {
  const where = `experiment spec.subjects[${index}]`;
  const record = exactObject(value, where, ['id', 'kind', 'config']);
  if (record.kind !== 'maka' && record.kind !== 'external') {
    throw new Error(`${where}.kind must be maka or external`);
  }
  return {
    id: identifier(record.id, `${where}.id`),
    kind: record.kind,
    config: jsonObject(record.config, `${where}.config`),
  };
}

function decodeTask(value: unknown, index: number): TaskSpec {
  const where = `experiment spec.tasks[${index}]`;
  const record = exactObject(value, where, ['id', 'input', 'config']);
  return {
    id: identifier(record.id, `${where}.id`),
    input: nonemptyString(record.input, `${where}.input`),
    config: jsonObject(record.config, `${where}.config`),
  };
}

function exactObject(
  value: unknown,
  where: string,
  fields: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(fields);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`${where}.${key} is not supported`);
  }
  for (const field of fields) {
    if (!Object.hasOwn(record, field)) throw new Error(`${where}.${field} is required`);
  }
  return record;
}

function nonemptyArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${where} must contain at least one item`);
  }
  return value;
}

function identifier(value: unknown, where: string): string {
  const id = nonemptyString(value, where);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`${where} must contain only letters, numbers, dot, underscore, or hyphen`);
  }
  return id;
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

function jsonObject(value: unknown, where: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  const result: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value))
    result[key] = jsonValue(child, `${where}.${key}`);
  return result;
}

function jsonValue(value: unknown, where: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${where} must be finite JSON data`);
    return value;
  }
  if (Array.isArray(value))
    return value.map((child, index) => jsonValue(child, `${where}[${index}]`));
  if (value && typeof value === 'object') return jsonObject(value, where);
  throw new Error(`${where} must be JSON data`);
}

function assertUniqueIds(values: readonly { readonly id: string }[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) throw new Error(`duplicate ${label} id: ${value.id}`);
    seen.add(value.id);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
