import {
  connectOrSpawnRuntimeHost,
  executeHostedRuntimeHostSubject,
  type HostedExecutionStartInput,
} from '@maka/runtime-host/client';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '@maka/runtime-host/protocol';

const mode = process.argv[2];
const input = JSON.parse(
  Buffer.from(process.argv[3] ?? '', 'base64url').toString('utf8'),
) as HostedExecutionStartInput;
if (mode !== 'run' && mode !== 'cancel') throw new Error('Hosted execution mode is required');
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => abort.abort());
}
const connected = await connectOrSpawnRuntimeHost({
  rootPath: input.cwd,
  surface: 'run',
  protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
  candidateEntrypoint: new URL(import.meta.resolve('@maka/runtime-host/execution-candidate-main')),
  ...(process.env.MAKA_CONFIG_DIR ? { legacyConfigurationRoot: process.env.MAKA_CONFIG_DIR } : {}),
});
if (connected.kind !== 'connected') throw new Error(`Runtime Host unavailable: ${connected.kind}`);
try {
  const result =
    mode === 'cancel'
      ? await connected.connection.request(
          'hosted.execution.cancel',
          { executionId: input.executionId },
          5_000,
        )
      : await executeHostedRuntimeHostSubject(connected.connection, input, {
          signal: abort.signal,
        });
  process.stdout.write(JSON.stringify(result));
} finally {
  await connected.connection.close();
}
