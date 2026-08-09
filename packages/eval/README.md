# @maka/eval

`@maka/eval` owns experiment semantics. It does not execute Maka or construct Runtime objects.

```text
Experiment → Cells → Attempts → Results
                    ↓
       Runtime Host executes Maka subjects
```

An Experiment combines one benchmark, one executor, all subjects, all tasks, a repetition count, one shared budget, and one verifier. Cells are the Cartesian product `task × repetition × subject`. A repetition is a new experimental sample; an infrastructure retry appends a replacement attempt to the same cell; continuation remains internal to Runtime Host. Each subject declares only the credential environment names its cells receive.

Run a fully expanded spec through the public CLI:

```sh
maka eval run experiment.json --out .maka-eval/run-001
```

Use `--cell <cell-id>` to replace one failed or indeterminate cell. The attempt log is append-only and result selection always uses the earliest valid attempt.

Executor modules implement the `ExperimentExecutor` contract and are loaded from `executor.module` plus `executor.export`. The built-in `@maka/eval/harbor` and `@maka/eval/pier` adapters use one relay Agent: Harbor/Pier prepares the task environment, the relay invokes exactly one Eval subject from `Agent.run()`, and the harness then runs its native verifier. `executeMaka` starts a Runtime Host inside that environment; `executeExternal` runs a generic external subject there. Eval never assumes that an executor environment is the CLI process working directory.

Every executor implements the single prepare → verify → cleanup contract. The kernel invokes exactly one subject between prepare and verify. Framework-specific provisioning, Runtime Host connection details, credentials, and machine paths remain in the executor adapter; they are not Eval semantics.

The result kernel contains only score, normalized usage, attributable cost, duration, status, and artifacts. Specs carry every semantic setting; environment variables are reserved for credentials and machine-local paths.

The checked-in Terminal-Bench 2.1 four-arm cohort is `experiments/terminal-bench-2.1-deepseek-v4-flash-four-arm.json`. Before running it, set `MAKA_EVAL_MOUNTS_JSON` to executor volume mounts that place the built repository at `/opt/maka-agent`, the three declared competitor toolchains at their declared `/opt` paths, and the Runtime Host connection configuration at `/root/.config/maka`. `MAKA_EVAL_HARBOR_PYTHON`, `MAKA_EVAL_PIER_PYTHON`, `MAKA_EVAL_TRIALS_DIR`, and `MAKA_EVAL_CONTAINER_REPO` may override machine-local executable and path locations; they do not alter experiment semantics.
