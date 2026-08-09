import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createExternalSubjectAdapter } from './external-subject.js';
import { loadExperimentExecutor } from './executor-loader.js';
import { openExperimentDirectory } from './experiment-directory.js';
import { expandExperiment, type ExperimentSpec } from './experiment.js';
import { createMakaSubjectAdapter } from './runtime-host-subject.js';
import { runExperiment, type ExperimentExecutor, type SubjectAdapter } from './runner.js';
import { parseExperimentSpec } from './spec.js';

const USAGE = 'usage: maka eval run <spec.json> --out <dir> [--cell <cell-id>]';

export interface RunMakaEvalCliDeps {
  readonly loadExecutor: (spec: ExperimentSpec, specPath: string) => Promise<ExperimentExecutor>;
  readonly createExternalSubject: () => SubjectAdapter;
  readonly writeOut: (text: string) => void;
  readonly writeError: (text: string) => void;
}

export async function runMakaEvalCli(
  argv: readonly string[],
  overrides: Partial<RunMakaEvalCliDeps> = {},
): Promise<number> {
  const deps: RunMakaEvalCliDeps = {
    loadExecutor: loadExperimentExecutor,
    createExternalSubject: createExternalSubjectAdapter,
    writeOut: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text),
    ...overrides,
  };
  try {
    const command = parseArgs(argv);
    if (command.kind === 'help') {
      deps.writeOut(`${USAGE}\n`);
      return 0;
    }
    const specPath = resolve(command.specPath);
    const spec = parseExperimentSpec(JSON.parse(await readFile(specPath, 'utf8')) as unknown);
    const directory = await openExperimentDirectory(resolve(command.outDir), spec);
    const executor = await deps.loadExecutor(spec, specPath);
    const subjects: SubjectAdapter[] = [deps.createExternalSubject(), createMakaSubjectAdapter()];
    {
      const run = await runExperiment({
        spec,
        store: directory.attempts,
        executors: [executor],
        subjects,
        ...(command.cellIds.length > 0 ? { cellIds: command.cellIds } : {}),
      });
      const cells = await Promise.all(
        expandExperiment(spec).map(async (cell) => {
          const selected = run.results.get(cell.id);
          if (selected) return { cellId: cell.id, attempt: selected };
          const attempts = await directory.attempts.list(cell.id);
          return {
            cellId: cell.id,
            status: attempts.length > 0 ? ('replaceable' as const) : ('missing' as const),
          };
        }),
      );
      const document = {
        schemaVersion: 'maka.eval.results.v1',
        experimentId: spec.id,
        cells,
      };
      const temporaryResultsPath = `${directory.resultsPath}.${process.pid}.tmp`;
      await writeFile(temporaryResultsPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      await rename(temporaryResultsPath, directory.resultsPath);
      const incomplete = cells.filter((cell) => !('attempt' in cell)).length;
      deps.writeOut(
        `${JSON.stringify({ experimentId: spec.id, cells: cells.length, incomplete })}\n`,
      );
      return incomplete === 0 ? 0 : 1;
    }
  } catch (error) {
    deps.writeError(`maka eval: ${errorMessage(error)}\n${USAGE}\n`);
    return 2;
  }
}

function parseArgs(argv: readonly string[]):
  | { kind: 'help' }
  | {
      kind: 'run';
      specPath: string;
      outDir: string;
      cellIds: string[];
    } {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { kind: 'help' };
  if (argv[0] !== 'run' || !argv[1] || argv[1].startsWith('-')) throw new Error(USAGE);
  const specPath = argv[1];
  let outDir: string | undefined;
  const cellIds: string[] = [];
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`);
    if (flag === '--out') outDir = value;
    else if (flag === '--cell') cellIds.push(value);
    else throw new Error(`unexpected argument: ${flag}`);
    index += 1;
  }
  if (!outDir) throw new Error('--out is required');
  return {
    kind: 'run',
    specPath,
    outDir,
    cellIds,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
