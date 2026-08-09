export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export interface BenchmarkSpec {
  readonly id: string;
  readonly version: string;
  readonly config: JsonObject;
}

export interface ExecutorSpec {
  readonly kind: string;
  readonly config: JsonObject;
}

export interface SubjectSpec {
  readonly id: string;
  readonly kind: 'maka' | 'external';
  readonly config: JsonObject;
}

export interface TaskSpec {
  readonly id: string;
  readonly input: string;
  readonly config: JsonObject;
}

export interface ExperimentSpec {
  readonly schemaVersion: 'maka.eval.v1';
  readonly id: string;
  readonly benchmark: BenchmarkSpec;
  readonly executor: ExecutorSpec;
  readonly subjects: readonly SubjectSpec[];
  readonly tasks: readonly TaskSpec[];
  readonly repetitions: number;
  readonly budget: JsonObject;
  readonly verifier: JsonObject;
}

export interface ExperimentCell {
  readonly id: string;
  readonly experimentId: string;
  readonly benchmark: BenchmarkSpec;
  readonly executor: ExecutorSpec;
  readonly budget: JsonObject;
  readonly verifier: JsonObject;
  readonly task: TaskSpec;
  readonly repetition: number;
  readonly subject: SubjectSpec;
}

export function expandExperiment(spec: ExperimentSpec): ExperimentCell[] {
  const cells: ExperimentCell[] = [];
  for (const task of spec.tasks) {
    for (let repetition = 1; repetition <= spec.repetitions; repetition += 1) {
      for (const subject of spec.subjects) {
        cells.push({
          id: `${task.id}::${repetition}::${subject.id}`,
          experimentId: spec.id,
          benchmark: spec.benchmark,
          executor: spec.executor,
          budget: spec.budget,
          verifier: spec.verifier,
          task,
          repetition,
          subject,
        });
      }
    }
  }
  return cells;
}
