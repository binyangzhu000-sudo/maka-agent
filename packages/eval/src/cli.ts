import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RuntimeHostConnection } from '@maka/runtime-host/client';
import { createExternalSubjectAdapter } from './external-subject.js';
import { loadExperimentExecutor } from './executor-loader.js';
import { openExperimentDirectory } from './experiment-directory.js';
import { expandExperiment, type ExperimentSpec } from './experiment.js';
import {
  createMakaRuntimeHostClient,
  createMakaSubjectAdapter,
  type MakaRuntimeHostClient,
} from './runtime-host-subject.js';
import { runExperiment, type ExperimentExecutor, type SubjectAdapter } from './runner.js';
import { parseExperimentSpec } from './spec.js';

const USAGE =
  'usage: maka eval run <spec.json> --out <dir> [--cell <cell-id>] [--runtime-host-root <dir>]';

interface MakaClientLease {
  readonly client: MakaRuntimeHostClient;
  close(): Promise<void>;
}

export interface RunMakaEvalCliDeps {
  readonly loadExecutor: (spec: ExperimentSpec, specPath: string) => Promise<ExperimentExecutor>;
  readonly createExternalSubject: () => SubjectAdapter;
  readonly connectMakaClient: (rootPath: string) => Promise<MakaClientLease>;
  readonly environment: NodeJS.ProcessEnv;
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
    connectMakaClient: connectLocalMakaClient,
    environment: process.env,
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
    const subjects: SubjectAdapter[] = [deps.createExternalSubject()];
    let maka: MakaClientLease | undefined;
    try {
      if (spec.subjects.some((subject) => subject.kind === 'maka')) {
        const rootPath = command.runtimeHostRoot ?? deps.environment.MAKA_EVAL_RUNTIME_HOST_ROOT;
        if (!rootPath) {
          throw new Error(
            'a Maka subject requires --runtime-host-root or MAKA_EVAL_RUNTIME_HOST_ROOT',
          );
        }
        maka = await deps.connectMakaClient(resolve(rootPath));
        subjects.push(createMakaSubjectAdapter({ client: maka.client }));
      }
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
    } finally {
      await maka?.close().catch(() => undefined);
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
      runtimeHostRoot?: string;
    } {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { kind: 'help' };
  if (argv[0] !== 'run' || !argv[1] || argv[1].startsWith('-')) throw new Error(USAGE);
  const specPath = argv[1];
  let outDir: string | undefined;
  let runtimeHostRoot: string | undefined;
  const cellIds: string[] = [];
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`);
    if (flag === '--out') outDir = value;
    else if (flag === '--cell') cellIds.push(value);
    else if (flag === '--runtime-host-root') runtimeHostRoot = value;
    else throw new Error(`unexpected argument: ${flag}`);
    index += 1;
  }
  if (!outDir) throw new Error('--out is required');
  return {
    kind: 'run',
    specPath,
    outDir,
    cellIds,
    ...(runtimeHostRoot ? { runtimeHostRoot } : {}),
  };
}

async function connectLocalMakaClient(rootPath: string): Promise<MakaClientLease> {
  const [{ connectRuntimeHost }, { RUNTIME_HOST_PROTOCOL_VERSION }] = await Promise.all([
    import('@maka/runtime-host/client'),
    import('@maka/runtime-host/protocol'),
  ]);
  const connected = await connectRuntimeHost({
    rootPath,
    surface: 'run',
    protocol: {
      min: RUNTIME_HOST_PROTOCOL_VERSION,
      max: RUNTIME_HOST_PROTOCOL_VERSION,
    },
  });
  if (connected.kind !== 'connected') {
    throw new Error(`Runtime Host is unavailable: ${connected.kind}`);
  }
  await waitForReady(connected.connection);
  return {
    client: createMakaRuntimeHostClient(connected.connection),
    close: () => connected.connection.close(),
  };
}

async function waitForReady(connection: RuntimeHostConnection): Promise<void> {
  const deadline = Date.now() + 45_000;
  for (;;) {
    const status = await connection.status(Math.max(1, deadline - Date.now()));
    if (status.state === 'ready') return;
    if (status.state === 'draining') throw new Error('Runtime Host is draining');
    if (Date.now() >= deadline) throw new Error('Runtime Host did not become ready');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
