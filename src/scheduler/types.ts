export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export type SchedulePayload = JsonValue;

export type ScheduleType = "one_time" | "recurring";
export type ScheduleStatus = "scheduled" | "cancelled" | "completed";
export type ScheduleOverlapPolicy = "forbid" | "queue" | "replace";
export type ScheduleRunStatus = "running" | "succeeded" | "failed" | "skipped";
export type ScheduleDispatchStatus = Exclude<ScheduleRunStatus, "running">;

export interface ScheduleRecord<TPayload extends SchedulePayload = SchedulePayload> {
  id: string;
  createdAtISO: string;
  updatedAtISO: string;
  scheduleType: ScheduleType;
  status: ScheduleStatus;
  runAtISO: string | null;
  cronExpr: string | null;
  timezone: string;
  overlapPolicy: ScheduleOverlapPolicy;
  nextRunAtISO: string | null;
  lastRunAtISO: string | null;
  lastSuccessAtISO: string | null;
  lastFailureAtISO: string | null;
  lastError: string | null;
  runCount: number;
  failureCount: number;
  payload: TPayload;
}

export interface ScheduleRunRecord {
  id: string;
  taskId: string;
  createdAtISO: string;
  scheduledForISO: string;
  startedAtISO: string | null;
  finishedAtISO: string | null;
  status: ScheduleRunStatus;
  error: string | null;
  externalRunId: string | null;
  runnerResult: JsonValue | null;
}

export interface ScheduleRunnerContext {
  runId: string;
  evaluatedAtISO: string;
  scheduledForISO: string;
}

export interface ScheduleDispatchResult {
  status: ScheduleDispatchStatus;
  finishedAtISO?: string;
  externalRunId?: string;
  error?: string;
  result?: JsonValue;
}

export type ScheduleRunner<TPayload extends SchedulePayload = SchedulePayload> = (
  schedule: ScheduleRecord<TPayload>,
  context: ScheduleRunnerContext,
) => ScheduleDispatchResult | Promise<ScheduleDispatchResult>;

export interface RunDueSchedulesOptions<TPayload extends SchedulePayload = SchedulePayload> {
  now?: Date;
  runner?: ScheduleRunner<TPayload>;
}

export interface RunDueSchedulesResult {
  evaluatedAtISO: string;
  dueCount: number;
  dispatchedCount: number;
  blockedCount: number;
  completedCount: number;
  failedCount: number;
  skippedCount: number;
  runs: ScheduleRunRecord[];
}
