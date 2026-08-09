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
maka eval run experiment.json --out .maka-eval/run-001 --runtime-host-root /path/to/runtime-host
```

Use `--cell <cell-id>` to replace one failed or indeterminate cell. The attempt log is append-only and result selection always uses the earliest valid attempt.

Executor modules implement the `ExperimentExecutor` contract and are loaded from `executor.module` plus `executor.export`. Harbor and Pier integrations belong in such adapters; they are not separate workflows. A Maka subject uses the Runtime Host client/protocol. An external subject uses the generic command adapter.

The result kernel contains only score, normalized usage, attributable cost, duration, status or failure reason, and artifacts. Specs carry every semantic setting; environment variables are reserved for credentials and machine-local paths.
