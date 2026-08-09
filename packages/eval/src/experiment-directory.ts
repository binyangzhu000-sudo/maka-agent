import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { FileAttemptStore } from './attempt-store.js';
import type { ExperimentSpec, JsonValue } from './experiment.js';
import { parseExperimentSpec } from './spec.js';

export interface ExperimentDirectory {
  readonly root: string;
  readonly specPath: string;
  readonly resultsPath: string;
  readonly attempts: FileAttemptStore;
}

export async function openExperimentDirectory(
  root: string,
  spec: ExperimentSpec,
): Promise<ExperimentDirectory> {
  const canonical = `${canonicalJson(spec)}\n`;
  const specPath = join(root, 'experiment.json');
  await mkdir(root, { recursive: true });
  const temporaryPath = join(root, `.experiment-${randomUUID()}.tmp`);
  try {
    const temporary = await open(temporaryPath, 'wx');
    try {
      await temporary.writeFile(canonical, 'utf8');
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    await link(temporaryPath, specPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = parseExperimentSpec(JSON.parse(await readFile(specPath, 'utf8')) as unknown);
    if (canonicalJson(existing) !== canonicalJson(spec)) {
      throw new Error(`${root} belongs to a different experiment spec`);
    }
  } finally {
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return {
    root,
    specPath,
    resultsPath: join(root, 'results.json'),
    attempts: new FileAttemptStore(join(root, 'attempts')),
  };
}

function canonicalJson(value: JsonValue | ExperimentSpec): string {
  return JSON.stringify(sortJson(value as JsonValue));
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    const record = value as { readonly [key: string]: JsonValue };
    const sorted = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(record).sort()) sorted[key] = sortJson(record[key] as JsonValue);
    return sorted;
  }
  return value;
}
