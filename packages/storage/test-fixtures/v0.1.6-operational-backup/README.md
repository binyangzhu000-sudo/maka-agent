# v0.1.6 operational backup fixture

This directory is an operational backup created by the public storage APIs at Maka tag `v0.1.6`, commit `2e4c1aabf1f562e0aa0f817201e60ee22e84c3f8`. It is frozen release input for forward-migration tests; tests must not rewrite a current database to imitate this schema.

The source state contains one Session and user message, one Plan Reminder, one durable cron Automation, and one Artifact payload. The backup was produced with Node.js 24.18.1 on macOS by building `@maka/core` and `@maka/storage` at that tag, creating those records through `createSessionStore`, `createSqlitePlanReminderStore`, `createAutomationStore`, and `createSqliteArtifactStore`, then calling `createOperationalStateBackup` with `createdAt = 100`.

Fixture identities used by the integration test:

- Session: `8774e02b-1cff-4d50-90b8-97f78cceaa2a`
- Plan Reminder: `60999192-d3b2-45b6-affb-e76355d4cf85`
- Automation: `cron-v016`
- Artifact: `artifact-v016`

SHA-256:

- `runtime.sqlite`: `634d514c07df704b7f30794e5fd5aa53221b20e2833e036cdb166dfe663221e5`
- `operational-backup.json`: `55579f4ac8aa42d51967d81e4901057e1e3a306820ec44d96bc1fe4f6614d51f`
- Artifact payload: `c1550cc0278822d09ae1c981bf5b853599b7e85df2ad1b22fae7d8ad13a7025a`
