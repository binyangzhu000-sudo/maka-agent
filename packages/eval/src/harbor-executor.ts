import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { HostedExecutionProjection } from '@maka/runtime-host/client';
import type { ExperimentCell, JsonObject } from './experiment.js';
import type { ExperimentExecutorFactoryInput } from './executor-loader.js';
import type { ExperimentExecutor, SubjectExecutionEnvironment } from './runner.js';

interface RelayState {
  readonly child: ChildProcess;
  readonly server: Server;
  readonly socket: Socket;
  readonly lines: AsyncIterator<string>;
  readonly token: string;
  readonly trialName: string;
  readonly trialPath: string;
  readonly taskInput: string;
  used: boolean;
}

export async function createHarborExecutor(
  input: ExperimentExecutorFactoryInput,
): Promise<ExperimentExecutor> {
  return createHarnessExecutor(input, 'harbor');
}

export async function createPierExecutor(
  input: ExperimentExecutorFactoryInput,
): Promise<ExperimentExecutor> {
  return createHarnessExecutor(input, 'pier');
}

async function createHarnessExecutor(
  input: ExperimentExecutorFactoryInput,
  kind: 'harbor' | 'pier',
): Promise<ExperimentExecutor> {
  const options = decodeOptions(input.options);
  const states = new Map<string, RelayState>();
  return {
    kind,
    async prepare({ cell, signal }) {
      const state = await startTrial(cell, input.specPath, options, kind, signal);
      states.set(cell.id, state);
      return environment(state, options.containerCwd);
    },
    async verify({ cell }) {
      const state = requireState(states, cell.id);
      if ((await waitForChild(state.child)) !== 0) throw new Error('Harbor Trial failed');
      state.server.close();
      const result = JSON.parse(await readFile(join(state.trialPath, 'result.json'), 'utf8')) as {
        exception_info?: unknown;
        verifier_result?: { rewards?: Record<string, number> | null } | null;
      };
      if (result.exception_info) throw new Error('Harbor Trial did not settle cleanly');
      const score = result.verifier_result?.rewards?.[rewardKey(cell)] ?? null;
      return {
        status: score === null ? 'infra_failed' : 'completed',
        score,
        artifacts: [{ kind: 'harbor_trial', trialName: state.trialName }],
      };
    },
    async cleanup({ cell }) {
      const state = states.get(cell.id);
      if (!state) return;
      states.delete(cell.id);
      state.socket.destroy();
      state.server.close();
      if (state.child.exitCode === null) state.child.kill('SIGKILL');
    },
  };
}

function environment(state: RelayState, cwd: string): SubjectExecutionEnvironment {
  return {
    cwd,
    taskInput: state.taskInput,
    metadata: { trialName: state.trialName },
    executeExternal: (input) => execute(state, input),
    executeMaka: async (input, options) => {
      const repo = process.env.MAKA_EVAL_CONTAINER_REPO ?? '/opt/maka-agent';
      const result = await execute(state, {
        command: 'node',
        args: [
          `${repo}/packages/eval/dist/harbor-maka-subject.js`,
          Buffer.from(JSON.stringify(input)).toString('base64url'),
        ],
        cwd,
        environment: [],
        signal: options?.signal,
      });
      if (result.exitCode !== 0) throw new Error('Maka Hosted execution failed');
      return JSON.parse(result.stdout) as Exclude<
        HostedExecutionProjection,
        { readonly status: 'running' }
      >;
    },
  };
}

async function startTrial(
  cell: ExperimentCell,
  specPath: string,
  options: HarborOptions,
  kind: 'harbor' | 'pier',
  signal?: AbortSignal,
): Promise<RelayState> {
  const token = randomBytes(24).toString('hex');
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Harbor relay did not bind TCP');
  const trialsRoot = resolve(
    process.env.MAKA_EVAL_HARBOR_TRIALS_DIR ?? join(dirname(specPath), '.maka-eval', 'harbor'),
  );
  await mkdir(trialsRoot, { recursive: true });
  const trialName = `${safeName(cell.id)}-${randomBytes(6).toString('hex')}`;
  const configPath = join(trialsRoot, `${trialName}.json`);
  await writeFile(
    configPath,
    `${JSON.stringify({
      task: decodeTask(cell),
      trial_name: trialName,
      trials_dir: trialsRoot,
      timeout_multiplier: positiveNumber(cell.budget.timeoutMultiplier, 'budget.timeoutMultiplier'),
      agent: {
        import_path: 'relay_agent:RelayAgent',
        kwargs: { relay_host: '127.0.0.1', relay_port: address.port, relay_token: token },
      },
      environment: {
        ...options.environment,
        env: {
          ...(isJsonObject(options.environment.env) ? options.environment.env : {}),
          ...Object.fromEntries(options.credentialEnvironment.map((name) => [name, `\${${name}}`])),
        },
        ...(process.env.MAKA_EVAL_HARBOR_MOUNTS_JSON
          ? { mounts: JSON.parse(process.env.MAKA_EVAL_HARBOR_MOUNTS_JSON) as unknown }
          : {}),
      },
    })}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );
  const connected = once(server, 'connection').then(([socket]) => socket as Socket);
  const relayPath = resolve(dirname(fileURLToPath(import.meta.url)), '../harbor');
  const child = spawn(
    process.env[kind === 'harbor' ? 'MAKA_EVAL_HARBOR_BIN' : 'MAKA_EVAL_PIER_BIN'] ?? kind,
    ['trial', 'start', '--config', configPath],
    {
      cwd: dirname(specPath),
      env: {
        ...process.env,
        PYTHONPATH: [relayPath, process.env.PYTHONPATH].filter(Boolean).join(':'),
      },
      stdio: 'ignore',
    },
  );
  const abort = () => child.kill('SIGKILL');
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const socket = await Promise.race([connected, childFailure(child)]);
    const lines = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY })[
      Symbol.asyncIterator
    ]();
    const ready = await readLine(lines);
    if (ready.token !== token || ready.kind !== 'ready' || typeof ready.instruction !== 'string') {
      throw new Error('Harbor relay returned an invalid ready message');
    }
    return {
      child,
      server,
      socket,
      lines,
      token,
      trialName,
      trialPath: join(trialsRoot, trialName),
      taskInput: ready.instruction,
      used: false,
    };
  } catch (error) {
    child.kill('SIGKILL');
    server.close();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

async function execute(
  state: RelayState,
  input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly environment: readonly string[];
    readonly signal?: AbortSignal;
  },
): Promise<{ exitCode: number; stdout: string }> {
  if (state.used) throw new Error('Harbor Trial already executed its subject');
  state.used = true;
  input.signal?.throwIfAborted();
  state.socket.write(
    `${JSON.stringify({
      token: state.token,
      kind: 'execute',
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      env: Object.fromEntries(
        input.environment.flatMap((name) => {
          const value = process.env[name];
          return value === undefined ? [] : [[name, value]];
        }),
      ),
    })}\n`,
  );
  const cancel = () =>
    state.socket.write(`${JSON.stringify({ token: state.token, kind: 'cancel' })}\n`);
  input.signal?.addEventListener('abort', cancel, { once: true });
  if (input.signal?.aborted) cancel();
  const executed = await readLine(state.lines);
  input.signal?.removeEventListener('abort', cancel);
  if (
    executed.token !== state.token ||
    executed.kind !== 'executed' ||
    typeof executed.exitCode !== 'number' ||
    typeof executed.stdout !== 'string'
  ) {
    throw new Error('Harbor relay returned an invalid execution result');
  }
  state.socket.end();
  return { exitCode: executed.exitCode, stdout: executed.stdout };
}

async function readLine(lines: AsyncIterator<string>): Promise<Record<string, unknown>> {
  const result = await lines.next();
  if (result.done) throw new Error('Harbor relay closed before settlement');
  return JSON.parse(result.value) as Record<string, unknown>;
}

interface HarborOptions {
  readonly containerCwd: string;
  readonly credentialEnvironment: readonly string[];
  readonly environment: JsonObject;
}

function decodeOptions(value: JsonObject): HarborOptions {
  const record = exact(value, ['containerCwd', 'credentialEnvironment', 'environment'], 'options');
  if (typeof record.containerCwd !== 'string' || !record.containerCwd.startsWith('/')) {
    throw new Error('Harbor options.containerCwd must be absolute');
  }
  if (
    !Array.isArray(record.credentialEnvironment) ||
    !record.credentialEnvironment.every((name) => typeof name === 'string' && name.length > 0)
  ) {
    throw new Error('Harbor options.credentialEnvironment must contain environment names');
  }
  return record as unknown as HarborOptions;
}

function decodeTask(cell: ExperimentCell): Record<string, unknown> {
  const task = exact(cell.task.config, ['harbor'], 'task config');
  if (!isJsonObject(task.harbor)) throw new Error('task config.harbor must be an object');
  const repository = cell.benchmark.config.repository;
  return typeof repository === 'string'
    ? { git_url: repository, git_commit_id: cell.benchmark.version, ...task.harbor }
    : task.harbor;
}

function rewardKey(cell: ExperimentCell): string {
  const verifier = exact(cell.verifier, ['reward'], 'verifier');
  if (typeof verifier.reward !== 'string' || verifier.reward.length === 0) {
    throw new Error('verifier.reward is required');
  }
  return verifier.reward;
}

function exact(value: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) {
    throw new Error(`${where} contains an unsupported field`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) throw new Error(`${where}.${key} is required`);
  }
  return record;
}

function positiveNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${where} must be positive`);
  }
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function safeName(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
}

function requireState(states: Map<string, RelayState>, cellId: string): RelayState {
  const state = states.get(cellId);
  if (!state) throw new Error(`Harbor Trial is missing for ${cellId}`);
  return state;
}

function childFailure(child: ChildProcess): Promise<never> {
  return once(child, 'exit').then(([code]) => {
    throw new Error(`Harbor exited before Agent.run (${code})`);
  });
}

function waitForChild(child: ChildProcess): Promise<number> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  if (child.signalCode !== null) return Promise.resolve(1);
  return once(child, 'exit').then(([code]) => (typeof code === 'number' ? code : 1));
}
