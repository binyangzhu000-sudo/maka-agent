import { spawn } from 'node:child_process';

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('external subject command is required');
const exitCode = await new Promise<number>((done, reject) => {
  const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'inherit'] });
  child.once('error', reject);
  child.once('exit', (code) => done(code ?? 1));
});
process.stdout.write(
  JSON.stringify({
    schemaVersion: 'maka.external_subject_result.v1',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
    costUsd: null,
    artifacts: [],
  }),
);
process.exitCode = exitCode;
