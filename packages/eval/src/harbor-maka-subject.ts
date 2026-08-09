import {
  connectOrSpawnRuntimeHost,
  executeHostedRuntimeHostSubject,
  type HostedExecutionStartInput,
} from '@maka/runtime-host/client';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '@maka/runtime-host/protocol';

const input = JSON.parse(
  Buffer.from(process.argv[2] ?? '', 'base64url').toString('utf8'),
) as HostedExecutionStartInput;
const connected = await connectOrSpawnRuntimeHost({
  rootPath: input.cwd,
  surface: 'run',
  protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
  candidateEntrypoint: new URL(import.meta.resolve('@maka/runtime-host/execution-candidate-main')),
  ...(process.env.MAKA_CONFIG_DIR ? { legacyConfigurationRoot: process.env.MAKA_CONFIG_DIR } : {}),
});
if (connected.kind !== 'connected') throw new Error(`Runtime Host unavailable: ${connected.kind}`);
try {
  process.stdout.write(
    JSON.stringify(await executeHostedRuntimeHostSubject(connected.connection, input)),
  );
} finally {
  await connected.connection.close();
}
