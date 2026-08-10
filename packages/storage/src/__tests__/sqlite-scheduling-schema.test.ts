import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { migrateSqliteAutomationDatabase } from '../sqlite-automation-schema.js';
import { migrateSqliteWorkflowDatabase } from '../sqlite-workflow-schema.js';

describe('SQLite scheduling schema', () => {
  test('migrates a legacy heartbeat into the current Automation catalog', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(`
        CREATE TABLE automation_authority_state (
          singleton INTEGER PRIMARY KEY,
          revision INTEGER NOT NULL
        );
        INSERT INTO automation_authority_state VALUES (1, 9);
        CREATE TABLE automation_definitions (
          automation_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          status TEXT NOT NULL,
          durable INTEGER NOT NULL,
          record_json TEXT NOT NULL
        );
        CREATE TABLE automation_pending_fires (
          fire_id TEXT PRIMARY KEY,
          automation_id TEXT NOT NULL,
          target_session_id TEXT NOT NULL,
          admitted_at INTEGER NOT NULL,
          record_json TEXT NOT NULL
        );
      `);
      database.prepare('INSERT INTO automation_definitions VALUES (?, ?, ?, ?, ?, ?)').run(
        'legacy-heartbeat',
        'session-1',
        1,
        'active',
        0,
        JSON.stringify({
          id: 'legacy-heartbeat',
          kind: 'heartbeat',
          name: 'Keep context fresh',
          status: 'active',
          prompt: 'Check for new work',
          sessionId: 'session-1',
          schedule: { type: 'interval', seconds: 60 },
          createdAt: 1,
          updatedAt: 2,
          nextFireAt: 121_000,
          lastFireAt: 61_000,
          lastRunId: 'run-1',
          fireCount: 1,
          maxFires: null,
          expiresAt: null,
          lastError: null,
          consecutiveFailures: 0,
          durable: false,
        }),
      );
      database.prepare('INSERT INTO automation_pending_fires VALUES (?, ?, ?, ?, ?)').run(
        'fire-1',
        'legacy-heartbeat',
        'session-1',
        61_000,
        JSON.stringify({
          id: 'fire-1',
          automationId: 'legacy-heartbeat',
          automationKind: 'heartbeat',
          automationName: 'Keep context fresh',
          prompt: 'Check for new work',
          scheduledFor: 61_000,
          targetSessionId: 'session-1',
          turnId: 'turn-1',
          runId: 'run-1',
          userMessageId: 'message-1',
          status: 'admitted',
          admittedAt: 61_000,
          updatedAt: 61_000,
        }),
      );

      migrateSqliteAutomationDatabase(database);

      assert.deepEqual(
        database
          .prepare('PRAGMA table_info(automation_definitions)')
          .all()
          .map((row) => row.name),
        ['automation_id', 'session_id', 'created_at', 'status', 'record_json'],
      );
      const row = database
        .prepare('SELECT record_json FROM automation_definitions WHERE automation_id = ?')
        .get('legacy-heartbeat') as { record_json: string };
      assert.deepEqual(JSON.parse(row.record_json), {
        id: 'legacy-heartbeat',
        name: 'Keep context fresh',
        status: 'active',
        prompt: 'Check for new work',
        sessionId: 'session-1',
        schedule: { type: 'interval', seconds: 60 },
        createdAt: 1,
        updatedAt: 2,
        nextFireAt: 121_000,
        lastFireAt: 61_000,
        lastRunId: 'run-1',
        fireCount: 1,
        maxFires: null,
        expiresAt: null,
        lastError: null,
        consecutiveFailures: 0,
      });
      const fire = database
        .prepare('SELECT record_json FROM automation_pending_fires WHERE fire_id = ?')
        .get('fire-1') as { record_json: string };
      assert.deepEqual(JSON.parse(fire.record_json), {
        id: 'fire-1',
        automationId: 'legacy-heartbeat',
        automationName: 'Keep context fresh',
        prompt: 'Check for new work',
        scheduledFor: 61_000,
        targetSessionId: 'session-1',
        turnId: 'turn-1',
        runId: 'run-1',
        userMessageId: 'message-1',
        status: 'admitted',
        admittedAt: 61_000,
        updatedAt: 61_000,
      });
      assert.equal(
        (
          database.prepare('SELECT revision FROM automation_authority_state').get() as {
            revision: number;
          }
        ).revision,
        9,
      );
    } finally {
      database.close();
    }
  });

  test('preserves a legacy heartbeat cron schedule', () => {
    const database = new DatabaseSync(':memory:');
    try {
      createLegacyAutomationSchema(database);
      database.prepare('INSERT INTO automation_definitions VALUES (?, ?, ?, ?, ?, ?)').run(
        'legacy-heartbeat',
        'session-1',
        1,
        'active',
        0,
        JSON.stringify({
          id: 'legacy-heartbeat',
          kind: 'heartbeat',
          name: 'Keep context fresh',
          status: 'active',
          prompt: 'Check for new work',
          sessionId: 'session-1',
          schedule: { type: 'cron', expression: '0 9 * JAN MON' },
          createdAt: 1,
          updatedAt: 2,
          nextFireAt: 61_000,
          lastFireAt: null,
          lastRunId: null,
          fireCount: 0,
          maxFires: null,
          expiresAt: null,
          lastError: null,
          consecutiveFailures: 0,
          durable: false,
        }),
      );

      migrateSqliteAutomationDatabase(database);

      const row = database
        .prepare('SELECT record_json FROM automation_definitions WHERE automation_id = ?')
        .get('legacy-heartbeat') as { record_json: string };
      assert.deepEqual(JSON.parse(row.record_json).schedule, {
        type: 'cron',
        expression: '0 9 * 1 1',
      });
    } finally {
      database.close();
    }
  });

  test('migrates a legacy durable cron into the scheduled-task catalog', () => {
    const database = new DatabaseSync(':memory:');
    try {
      createLegacyAutomationSchema(database);
      insertLegacyCron(database);

      migrateSqliteWorkflowDatabase(database);
      migrateSqliteAutomationDatabase(database);

      assert.equal(
        database.prepare('SELECT COUNT(*) AS count FROM automation_definitions').get()?.count,
        0,
      );
      const row = database
        .prepare('SELECT record_json FROM workflow_scheduled_tasks WHERE task_id = ?')
        .get('legacy-cron') as { record_json: string };
      assert.deepEqual(JSON.parse(row.record_json), {
        id: 'legacy-cron',
        title: 'Daily report',
        intent: { kind: 'text', body: 'Prepare the report' },
        schedule: { kind: 'cron', expression: '0 9 * * *', startAt: 1 },
        effect: {
          kind: 'agent_run',
          execution: {
            cwd: '/workspace',
            projectId: 'project-1',
            backend: 'ai-sdk',
            llmConnectionSlug: 'openai',
            model: 'gpt-test',
            thinkingLevel: 'medium',
            permissionMode: 'explore',
            collaborationMode: 'agent',
            orchestrationMode: 'default',
          },
        },
        status: 'active',
        nextFireAt: 61_000,
        lastFireAt: null,
        fireCount: 0,
        maxFires: null,
        expiresAt: null,
        createdBy: { kind: 'agent', sessionId: 'session-1' },
        createdAt: 1,
        updatedAt: 2,
        runs: [],
        lastError: null,
      });
    } finally {
      database.close();
    }
  });

  test('preserves legacy Automation cron semantics', () => {
    const database = new DatabaseSync(':memory:');
    try {
      createLegacyAutomationSchema(database);
      insertLegacyCron(database);
      const row = database
        .prepare('SELECT record_json FROM automation_definitions WHERE automation_id = ?')
        .get('legacy-cron') as { record_json: string };
      database
        .prepare('UPDATE automation_definitions SET record_json = ? WHERE automation_id = ?')
        .run(
          JSON.stringify({
            ...JSON.parse(row.record_json),
            schedule: { type: 'cron', expression: '*,15 9 * JAN MON' },
          }),
          'legacy-cron',
        );

      migrateSqliteWorkflowDatabase(database);
      migrateSqliteAutomationDatabase(database);

      const migrated = database
        .prepare('SELECT record_json FROM workflow_scheduled_tasks WHERE task_id = ?')
        .get('legacy-cron') as { record_json: string };
      assert.deepEqual(JSON.parse(migrated.record_json).schedule, {
        kind: 'cron',
        expression: '15 9 * 1 1',
        startAt: 1,
      });
    } finally {
      database.close();
    }
  });

  test('preserves a released fractional Automation range', () => {
    const database = new DatabaseSync(':memory:');
    try {
      createLegacyAutomationSchema(database);
      insertLegacyCron(database);
      const row = database
        .prepare('SELECT record_json FROM automation_definitions WHERE automation_id = ?')
        .get('legacy-cron') as { record_json: string };
      database
        .prepare('UPDATE automation_definitions SET record_json = ? WHERE automation_id = ?')
        .run(
          JSON.stringify({
            ...JSON.parse(row.record_json),
            schedule: { type: 'cron', expression: '1.5-5.5 * * * *' },
          }),
          'legacy-cron',
        );

      migrateSqliteWorkflowDatabase(database);
      migrateSqliteAutomationDatabase(database);

      const migrated = database
        .prepare('SELECT record_json FROM workflow_scheduled_tasks WHERE task_id = ?')
        .get('legacy-cron') as { record_json: string };
      assert.deepEqual(JSON.parse(migrated.record_json).schedule, {
        kind: 'cron',
        expression: '2,3,4,5 * * * *',
        startAt: 1,
      });
    } finally {
      database.close();
    }
  });

  test('preserves a released Automation with an empty Vixie day arm', () => {
    const database = new DatabaseSync(':memory:');
    try {
      createLegacyAutomationSchema(database);
      insertLegacyCron(database);
      const row = database
        .prepare('SELECT record_json FROM automation_definitions WHERE automation_id = ?')
        .get('legacy-cron') as { record_json: string };
      database
        .prepare('UPDATE automation_definitions SET record_json = ? WHERE automation_id = ?')
        .run(
          JSON.stringify({
            ...JSON.parse(row.record_json),
            schedule: { type: 'cron', expression: '0 0 1x-5y * 5' },
          }),
          'legacy-cron',
        );

      migrateSqliteWorkflowDatabase(database);
      migrateSqliteAutomationDatabase(database);

      const migrated = database
        .prepare('SELECT record_json FROM workflow_scheduled_tasks WHERE task_id = ?')
        .get('legacy-cron') as { record_json: string };
      assert.deepEqual(JSON.parse(migrated.record_json).schedule, {
        kind: 'cron',
        expression: '0 0 * * 5',
        startAt: 1,
      });
    } finally {
      database.close();
    }
  });

  test('migrates a released non-durable cron', () => {
    const database = new DatabaseSync(':memory:');
    try {
      createLegacyAutomationSchema(database);
      insertLegacyCron(database);
      const row = database
        .prepare('SELECT record_json FROM automation_definitions WHERE automation_id = ?')
        .get('legacy-cron') as { record_json: string };
      database
        .prepare(
          'UPDATE automation_definitions SET durable = 0, record_json = ? WHERE automation_id = ?',
        )
        .run(JSON.stringify({ ...JSON.parse(row.record_json), durable: false }), 'legacy-cron');

      migrateSqliteWorkflowDatabase(database);
      migrateSqliteAutomationDatabase(database);

      assert.equal(
        database
          .prepare('SELECT COUNT(*) AS count FROM workflow_scheduled_tasks WHERE task_id = ?')
          .get('legacy-cron')?.count,
        1,
      );
    } finally {
      database.close();
    }
  });

  test('reconstructs a released cron execution from its creator Session', () => {
    const database = new DatabaseSync(':memory:');
    try {
      createLegacyAutomationSchema(database);
      insertLegacyCron(database);
      const row = database
        .prepare('SELECT record_json FROM automation_definitions WHERE automation_id = ?')
        .get('legacy-cron') as { record_json: string };
      const { execution: _execution, ...withoutExecution } = JSON.parse(row.record_json);
      database
        .prepare('UPDATE automation_definitions SET record_json = ? WHERE automation_id = ?')
        .run(JSON.stringify(withoutExecution), 'legacy-cron');
      database.exec(`
        CREATE TABLE session_metadata (
          session_id TEXT PRIMARY KEY,
          payload_json TEXT NOT NULL
        );
      `);
      database.prepare('INSERT INTO session_metadata VALUES (?, ?)').run(
        'session-1',
        JSON.stringify({
          cwd: '/session-workspace',
          projectId: 'project-from-session',
          backend: 'pi-agent',
          llmConnectionSlug: 'session-connection',
          model: 'session-model',
          thinkingLevel: 'high',
          collaborationMode: 'agent',
          orchestrationMode: 'default',
        }),
      );

      migrateSqliteWorkflowDatabase(database);
      migrateSqliteAutomationDatabase(database);

      const migrated = database
        .prepare('SELECT record_json FROM workflow_scheduled_tasks WHERE task_id = ?')
        .get('legacy-cron') as { record_json: string };
      assert.deepEqual(JSON.parse(migrated.record_json).effect.execution, {
        cwd: '/session-workspace',
        projectId: 'project-from-session',
        backend: 'pi-agent',
        llmConnectionSlug: 'session-connection',
        model: 'session-model',
        thinkingLevel: 'high',
        permissionMode: 'explore',
        collaborationMode: 'agent',
        orchestrationMode: 'default',
      });
    } finally {
      database.close();
    }
  });

  test('safely pauses a released cron whose execution authority is unavailable', () => {
    const database = new DatabaseSync(':memory:');
    try {
      createLegacyAutomationSchema(database);
      insertLegacyCron(database);
      const row = database
        .prepare('SELECT record_json FROM automation_definitions WHERE automation_id = ?')
        .get('legacy-cron') as { record_json: string };
      const { execution: _execution, ...withoutExecution } = JSON.parse(row.record_json);
      database
        .prepare('UPDATE automation_definitions SET record_json = ? WHERE automation_id = ?')
        .run(JSON.stringify(withoutExecution), 'legacy-cron');

      migrateSqliteWorkflowDatabase(database);
      migrateSqliteAutomationDatabase(database);

      const migrated = database
        .prepare('SELECT record_json FROM workflow_scheduled_tasks WHERE task_id = ?')
        .get('legacy-cron') as { record_json: string };
      const task = JSON.parse(migrated.record_json);
      assert.equal(task.status, 'paused');
      assert.equal(task.nextFireAt, null);
      assert.deepEqual(task.effect, {
        kind: 'agent_run_unavailable',
        reason: 'Creator Session unavailable; execution settings are unknown.',
      });
    } finally {
      database.close();
    }
  });

  test('preserves a released cron AgentRun identity', () => {
    const database = new DatabaseSync(':memory:');
    try {
      createLegacyAutomationSchema(database);
      insertLegacyCron(database);
      const row = database
        .prepare('SELECT record_json FROM automation_definitions WHERE automation_id = ?')
        .get('legacy-cron') as { record_json: string };
      database
        .prepare('UPDATE automation_definitions SET record_json = ? WHERE automation_id = ?')
        .run(
          JSON.stringify({
            ...JSON.parse(row.record_json),
            lastRunId: 'agent-run-1',
            lastFireAt: 60_000,
          }),
          'legacy-cron',
        );

      migrateSqliteWorkflowDatabase(database);
      migrateSqliteAutomationDatabase(database);

      const migrated = database
        .prepare('SELECT record_json FROM workflow_scheduled_tasks WHERE task_id = ?')
        .get('legacy-cron') as { record_json: string };
      assert.deepEqual(JSON.parse(migrated.record_json).runs, [
        {
          id: 'agent-run-1',
          runId: 'agent-run-1',
          at: 60_000,
          outcome: 'ok',
          message: 'Migrated legacy Automation run',
        },
      ]);
    } finally {
      database.close();
    }
  });

  test('completes a released one-shot that already fired', () => {
    const database = new DatabaseSync(':memory:');
    try {
      createLegacyAutomationSchema(database);
      insertLegacyCron(database);
      const row = database
        .prepare('SELECT record_json FROM automation_definitions WHERE automation_id = ?')
        .get('legacy-cron') as { record_json: string };
      database
        .prepare('UPDATE automation_definitions SET record_json = ? WHERE automation_id = ?')
        .run(
          JSON.stringify({
            ...JSON.parse(row.record_json),
            schedule: { type: 'once', delaySeconds: 60 },
            fireCount: 1,
            nextFireAt: null,
          }),
          'legacy-cron',
        );

      migrateSqliteWorkflowDatabase(database);
      migrateSqliteAutomationDatabase(database);

      const migrated = database
        .prepare('SELECT record_json FROM workflow_scheduled_tasks WHERE task_id = ?')
        .get('legacy-cron') as { record_json: string };
      const task = JSON.parse(migrated.record_json);
      assert.equal(task.status, 'completed');
      assert.match(task.lastError, /outcome was recorded/);
    } finally {
      database.close();
    }
  });

  test('completes an interrupted released schedule whose fire budget is spent', () => {
    const database = new DatabaseSync(':memory:');
    try {
      createLegacyAutomationSchema(database);
      insertLegacyCron(database);
      const row = database
        .prepare('SELECT record_json FROM automation_definitions WHERE automation_id = ?')
        .get('legacy-cron') as { record_json: string };
      database
        .prepare('UPDATE automation_definitions SET record_json = ? WHERE automation_id = ?')
        .run(
          JSON.stringify({
            ...JSON.parse(row.record_json),
            schedule: { type: 'interval', seconds: 60 },
            fireCount: 1,
            maxFires: 1,
            nextFireAt: null,
          }),
          'legacy-cron',
        );

      migrateSqliteWorkflowDatabase(database);
      migrateSqliteAutomationDatabase(database);

      const migrated = database
        .prepare('SELECT record_json FROM workflow_scheduled_tasks WHERE task_id = ?')
        .get('legacy-cron') as { record_json: string };
      const task = JSON.parse(migrated.record_json);
      assert.equal(task.status, 'completed');
      assert.equal(task.nextFireAt, null);
      assert.match(task.lastError, /not re-run/);
    } finally {
      database.close();
    }
  });

  test('settles a released in-flight cron without replaying it', () => {
    const database = new DatabaseSync(':memory:');
    try {
      createLegacyAutomationSchema(database);
      insertLegacyCron(database);
      const definition = database
        .prepare('SELECT record_json FROM automation_definitions WHERE automation_id = ?')
        .get('legacy-cron') as { record_json: string };
      const parsedDefinition = JSON.parse(definition.record_json);
      const { execution, ...definitionWithoutExecution } = parsedDefinition;
      database
        .prepare('UPDATE automation_definitions SET record_json = ? WHERE automation_id = ?')
        .run(
          JSON.stringify({
            ...definitionWithoutExecution,
            nextFireAt: 120_000,
            lastFireAt: 61_000,
            fireCount: 1,
          }),
          'legacy-cron',
        );
      database.prepare('INSERT INTO automation_pending_fires VALUES (?, ?, ?, ?, ?)').run(
        'fire-1',
        'legacy-cron',
        'session-1',
        61_000,
        JSON.stringify({
          id: 'fire-1',
          automationId: 'legacy-cron',
          automationKind: 'cron',
          automationName: 'Daily report',
          prompt: 'Prepare the report',
          scheduledFor: 61_000,
          targetSessionId: 'session-1',
          turnId: 'turn-1',
          runId: 'run-1',
          userMessageId: 'message-1',
          status: 'admitted',
          admittedAt: 61_000,
          updatedAt: 61_000,
          execution,
        }),
      );
      migrateSqliteWorkflowDatabase(database);

      migrateSqliteAutomationDatabase(database);

      assert.equal(
        database.prepare('SELECT COUNT(*) AS count FROM automation_definitions').get()?.count,
        0,
      );
      assert.equal(
        database.prepare('SELECT COUNT(*) AS count FROM workflow_scheduled_task_fires').get()
          ?.count,
        0,
      );
      const closure = database
        .prepare('SELECT record_json FROM automation_recovery_closures WHERE fire_id = ?')
        .get('fire-1') as { record_json: string };
      assert.deepEqual(JSON.parse(closure.record_json).fire, {
        id: 'fire-1',
        automationId: 'legacy-cron',
        automationName: 'Daily report',
        prompt: 'Prepare the report',
        scheduledFor: 61_000,
        targetSessionId: 'session-1',
        turnId: 'turn-1',
        runId: 'run-1',
        userMessageId: 'message-1',
        status: 'admitted',
        admittedAt: 61_000,
        updatedAt: 61_000,
      });
      const migrated = database
        .prepare('SELECT record_json FROM workflow_scheduled_tasks WHERE task_id = ?')
        .get('legacy-cron') as { record_json: string };
      const task = JSON.parse(migrated.record_json);
      assert.equal(task.effect.kind, 'agent_run');
      assert.equal(task.fireCount, 1);
      assert.equal(task.nextFireAt, 120_000);
      assert.deepEqual(task.runs[0], {
        id: 'run-1',
        runId: 'run-1',
        sessionId: 'session-1',
        at: 61_000,
        outcome: 'failed',
        message: 'Interrupted during upgrade before the fire outcome was recorded; not re-run.',
      });
    } finally {
      database.close();
    }
  });

  test('migrates a legacy plan reminder into the scheduled-task catalog', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(`
        CREATE TABLE workflow_plan_reminders (
          reminder_id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          record_json TEXT NOT NULL
        );
        CREATE INDEX workflow_plan_reminders_order
          ON workflow_plan_reminders(created_at, reminder_id);
      `);
      database.prepare('INSERT INTO workflow_plan_reminders VALUES (?, ?, ?, ?)').run(
        'legacy-reminder',
        10,
        20,
        JSON.stringify({
          id: 'legacy-reminder',
          title: 'Ship safely',
          note: 'Preserve this reminder',
          schedule: { kind: 'once', runAt: 30 },
          delivery: { channel: 'local' },
          status: 'scheduled',
          enabled: true,
          createdAt: 10,
          updatedAt: 20,
          nextRunAt: 30,
          runs: [],
          runCount: 0,
        }),
      );
      migrateSqliteWorkflowDatabase(database);

      const row = database
        .prepare('SELECT record_json FROM workflow_scheduled_tasks WHERE task_id = ?')
        .get('legacy-reminder') as { record_json: string };
      assert.deepEqual(JSON.parse(row.record_json), {
        id: 'legacy-reminder',
        title: 'Ship safely',
        intent: { kind: 'text', body: 'Preserve this reminder' },
        schedule: { kind: 'once', runAt: 30 },
        effect: { kind: 'notify', channel: 'local' },
        status: 'active',
        nextFireAt: 30,
        lastFireAt: null,
        fireCount: 0,
        maxFires: null,
        expiresAt: null,
        createdBy: { kind: 'user' },
        createdAt: 10,
        updatedAt: 20,
        runs: [],
        lastError: null,
      });
    } finally {
      database.close();
    }
  });

  test('preserves legacy plan-reminder cron semantics', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(`
        CREATE TABLE workflow_plan_reminders (
          reminder_id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          record_json TEXT NOT NULL
        );
      `);
      database.prepare('INSERT INTO workflow_plan_reminders VALUES (?, ?, ?, ?)').run(
        'legacy-reminder',
        10,
        20,
        JSON.stringify({
          id: 'legacy-reminder',
          title: 'Ship safely',
          note: 'Preserve this reminder',
          schedule: { kind: 'cron', expression: '5/10 * * * *', startAt: 10 },
          delivery: { channel: 'local' },
          status: 'scheduled',
          enabled: true,
          createdAt: 10,
          updatedAt: 20,
          nextRunAt: 65_000,
          runs: [],
          runCount: 0,
        }),
      );
      database.prepare('INSERT INTO workflow_plan_reminders VALUES (?, ?, ?, ?)').run(
        'wildcard-reminder',
        11,
        21,
        JSON.stringify({
          id: 'wildcard-reminder',
          title: 'Ship on cadence',
          note: 'Preserve this reminder too',
          schedule: { kind: 'cron', expression: '*/5 * * * *', startAt: 11 },
          delivery: { channel: 'local' },
          status: 'scheduled',
          enabled: true,
          createdAt: 11,
          updatedAt: 21,
          nextRunAt: 300_000,
          runs: [],
          runCount: 0,
        }),
      );

      migrateSqliteWorkflowDatabase(database);

      const row = database
        .prepare('SELECT record_json FROM workflow_scheduled_tasks WHERE task_id = ?')
        .get('legacy-reminder') as { record_json: string };
      assert.deepEqual(JSON.parse(row.record_json).schedule, {
        kind: 'cron',
        expression: '5 * * * *',
        startAt: 10,
      });
      const wildcard = database
        .prepare('SELECT record_json FROM workflow_scheduled_tasks WHERE task_id = ?')
        .get('wildcard-reminder') as { record_json: string };
      assert.deepEqual(JSON.parse(wildcard.record_json).schedule, {
        kind: 'cron',
        expression: '*/5 * * * *',
        startAt: 11,
      });
    } finally {
      database.close();
    }
  });

  test('preserves fixed-duration legacy reminder recurrence', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(`
        CREATE TABLE workflow_plan_reminders (
          reminder_id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          record_json TEXT NOT NULL
        );
      `);
      database.prepare('INSERT INTO workflow_plan_reminders VALUES (?, ?, ?, ?)').run(
        'legacy-reminder',
        10,
        20,
        JSON.stringify({
          id: 'legacy-reminder',
          title: 'Daily',
          note: '',
          schedule: { kind: 'recurring', recurrence: 'daily', startAt: 30 },
          delivery: { channel: 'local' },
          status: 'paused',
          enabled: false,
          createdAt: 10,
          updatedAt: 20,
          nextRunAt: 30,
          runs: [],
          runCount: 0,
        }),
      );

      migrateSqliteWorkflowDatabase(database);

      const row = database
        .prepare('SELECT record_json FROM workflow_scheduled_tasks WHERE task_id = ?')
        .get('legacy-reminder') as { record_json: string };
      assert.deepEqual(JSON.parse(row.record_json).schedule, {
        kind: 'interval',
        everySeconds: 86_400,
        startAt: 30,
      });
    } finally {
      database.close();
    }
  });
});

function createLegacyAutomationSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE automation_authority_state (
      singleton INTEGER PRIMARY KEY,
      revision INTEGER NOT NULL
    );
    INSERT INTO automation_authority_state VALUES (1, 9);
    CREATE TABLE automation_definitions (
      automation_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      durable INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE TABLE automation_pending_fires (
      fire_id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      target_session_id TEXT NOT NULL,
      admitted_at INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );
  `);
}

function insertLegacyCron(database: DatabaseSync): void {
  database.prepare('INSERT INTO automation_definitions VALUES (?, ?, ?, ?, ?, ?)').run(
    'legacy-cron',
    'session-1',
    1,
    'active',
    1,
    JSON.stringify({
      id: 'legacy-cron',
      kind: 'cron',
      name: 'Daily report',
      status: 'active',
      prompt: 'Prepare the report',
      sessionId: 'session-1',
      schedule: { type: 'cron', expression: '0 9 * * *' },
      createdAt: 1,
      updatedAt: 2,
      nextFireAt: 61_000,
      lastFireAt: null,
      lastRunId: null,
      fireCount: 0,
      maxFires: null,
      expiresAt: null,
      lastError: null,
      consecutiveFailures: 0,
      durable: true,
      execution: {
        cwd: '/workspace',
        projectId: 'project-1',
        backend: 'ai-sdk',
        llmConnectionSlug: 'openai',
        model: 'gpt-test',
        thinkingLevel: 'medium',
        collaborationMode: 'agent',
        orchestrationMode: 'default',
      },
    }),
  );
}
