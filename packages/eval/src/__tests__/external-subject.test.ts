import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createExternalSubjectAdapter, type ExperimentCell } from '../index.js';

test('external subject executes its declared command without kernel changes', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'maka-eval-external-'));
  const adapter = createExternalSubjectAdapter();
  const result = await adapter.execute({
    cell: externalCell(),
    context: { cwd, metadata: {} },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'task:task-1:2');
  assert.deepEqual(result.usage, {
    inputTokens: 3,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 5,
  });
  assert.equal(result.costUsd, 0.01);
});

test('external subject never persists stderr from a failed credential-bearing process', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'maka-eval-external-failure-'));
  const adapter = createExternalSubjectAdapter({ environment: { SECRET_TOKEN: 'do-not-store' } });
  const cell = externalCell();
  const result = await adapter.execute({
    cell: {
      ...cell,
      subject: {
        ...cell.subject,
        config: {
          command: process.execPath,
          args: ['-e', 'process.stderr.write(process.env.SECRET_TOKEN);process.exit(7)'],
          environment: ['SECRET_TOKEN'],
        },
      },
    },
    context: { cwd, metadata: {} },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failureReason, 'external subject exited with code 7');
  assert.doesNotMatch(JSON.stringify(result), /do-not-store/);
});

test('external subject output limit terminates the whole process group', {
  skip: process.platform === 'win32',
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'maka-eval-external-tree-'));
  const pidPath = join(cwd, 'grandchild.pid');
  const cell = externalCell();
  const adapter = createExternalSubjectAdapter();
  const result = await adapter.execute({
    cell: {
      ...cell,
      subject: {
        ...cell.subject,
        config: {
          command: process.execPath,
          args: [
            '-e',
            'const{spawn}=require("node:child_process");const{writeFileSync}=require("node:fs");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});writeFileSync(process.argv[1],String(child.pid));process.stdout.write("x".repeat(1024*1024+1));setInterval(()=>{},1000)',
            pidPath,
          ],
          environment: [],
        },
      },
    },
    context: { cwd, metadata: {} },
  });

  assert.equal(result.status, 'infra_failed');
  const grandchildPid = Number(await readFile(pidPath, 'utf8'));
  await assertProcessExited(grandchildPid);
});

function externalCell(): ExperimentCell {
  return {
    id: 'task-1::2::competitor',
    experimentId: 'experiment',
    benchmark: { id: 'bench', version: '1', config: {} },
    executor: { kind: 'pier', config: {} },
    budget: {},
    verifier: {},
    task: { id: 'task-1', input: 'Solve it', config: {} },
    repetition: 2,
    subject: {
      id: 'competitor',
      kind: 'external',
      config: {
        command: process.execPath,
        args: [
          '-e',
          'process.stdout.write(JSON.stringify({schemaVersion:"maka.external_subject_result.v1",output:process.argv[1],usage:{inputTokens:3,outputTokens:2,cacheReadTokens:0,cacheWriteTokens:0,reasoningTokens:0,totalTokens:5},costUsd:0.01,artifacts:[]}))',
          'task:{{task.id}}:{{repetition}}',
        ],
        environment: [],
      },
    },
  };
}

async function assertProcessExited(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`process ${pid} survived external subject termination`);
}
