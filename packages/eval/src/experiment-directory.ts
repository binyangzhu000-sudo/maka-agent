import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  try {
    await writeFile(specPath, canonical, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = parseExperimentSpec(JSON.parse(await readFile(specPath, 'utf8')) as unknown);
    if (canonicalJson(existing) !== canonicalJson(spec)) {
      throw new Error(`${root} belongs to a different experiment spec`);
    }
  }
  return {
    root,
    specPath,
    resultsPath: join(root, 'results.json'),
    attempts: new FileAttemptStore(join(root, 'attempts.jsonl')),
  };
}

function canonicalJson(value: JsonValue | ExperimentSpec): string {
  return JSON.stringify(sortJson(value as JsonValue));
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    const record = value as { readonly [key: string]: JsonValue };
    const sorted: Record<string, JsonValue> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = sortJson(record[key] as JsonValue);
    return sorted;
  }
  return value;
}
