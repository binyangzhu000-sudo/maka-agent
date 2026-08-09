# @maka/eval

`@maka/eval` owns experiment semantics. It does not execute Maka or construct Runtime objects.

```text
Experiment → Cells → Attempts → Results
                    ↓
       Runtime Host executes Maka subjects
```

An Experiment combines one benchmark, one executor, all subjects, all tasks, a repetition count, one shared budget, and one verifier. Cells are the Cartesian product `task × repetition × subject`. A repetition is a new experimental sample; an infrastructure retry appends a replacement attempt to the same cell; continuation remains internal to Runtime Host.

Run a fully expanded spec through the public CLI:

```sh
maka eval run experiment.json --out .maka-eval/run-001
```

Use `--cell <cell-id>` to replace one failed or indeterminate cell. The attempt log is append-only and result selection always uses the earliest valid attempt.

Executor modules implement the `ExperimentExecutor` contract and are loaded from `executor.module` plus `executor.export`. Harbor and Pier integrations belong in such adapters; they are not separate workflows. The executor prepares the task environment and supplies its execution capabilities to `runSubject`: `executeMaka` delegates one disposable execution to a Runtime Host client, while `executeExternal` runs a generic external subject in that same environment. Eval never assumes that an executor environment is the CLI process working directory.

Every executor implements the single prepare → verify → cleanup contract. The kernel invokes exactly one subject between prepare and verify. Framework-specific provisioning, Runtime Host connection details, credentials, and machine paths remain in the executor adapter; they are not Eval semantics.

The result kernel contains only score, normalized usage, attributable cost, duration, status, and artifacts. Specs carry every semantic setting; environment variables are reserved for credentials and machine-local paths.
