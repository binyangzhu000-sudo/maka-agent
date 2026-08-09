import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExperimentSpec, JsonObject } from './experiment.js';
import type { ExperimentExecutor } from './runner.js';

export interface ExperimentExecutorFactoryInput {
  readonly spec: ExperimentSpec;
  readonly specPath: string;
  readonly options: JsonObject;
}

export type ExperimentExecutorFactory = (
  input: ExperimentExecutorFactoryInput,
) => ExperimentExecutor | Promise<ExperimentExecutor>;

export async function loadExperimentExecutor(
  spec: ExperimentSpec,
  specPath: string,
): Promise<ExperimentExecutor> {
  const config = decodeLoaderConfig(spec.executor.config);
  const moduleUrl = isRelativeOrAbsolutePath(config.module)
    ? pathToFileURL(resolve(dirname(specPath), config.module)).href
    : config.module;
  const loaded = (await import(moduleUrl)) as Record<string, unknown>;
  const factory = loaded[config.export];
  if (typeof factory !== 'function') {
    throw new Error(`executor adapter ${config.module} does not export ${config.export}`);
  }
  const executor = await (factory as ExperimentExecutorFactory)({
    spec,
    specPath,
    options: config.options,
  });
  if (
    !executor ||
    executor.kind !== spec.executor.kind ||
    typeof executor.prepare !== 'function' ||
    typeof executor.verify !== 'function' ||
    (executor.cleanup !== undefined && typeof executor.cleanup !== 'function')
  ) {
    throw new Error(`executor adapter must return the ${spec.executor.kind} executor`);
  }
  return executor;
}

function decodeLoaderConfig(config: JsonObject): {
  module: string;
  export: string;
  options: JsonObject;
} {
  const expected = ['module', 'export', 'options'];
  for (const key of Object.keys(config)) {
    if (!expected.includes(key)) throw new Error(`executor config.${key} is not supported`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(config, key)) throw new Error(`executor config.${key} is required`);
  }
  if (typeof config.module !== 'string' || config.module.length === 0) {
    throw new Error('executor config.module is required');
  }
  if (typeof config.export !== 'string' || config.export.length === 0) {
    throw new Error('executor config.export is required');
  }
  if (!config.options || typeof config.options !== 'object' || Array.isArray(config.options)) {
    throw new Error('executor config.options must be an object');
  }
  return config as { module: string; export: string; options: JsonObject };
}

function isRelativeOrAbsolutePath(value: string): boolean {
  return value.startsWith('.') || isAbsolute(value);
}
