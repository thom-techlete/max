import { randomUUID } from "crypto";
import { CronExpressionParser } from "cron-parser";
import { getClient } from "../copilot/client.js";
import { createWorkerSession, logWorker } from "../copilot/worker-helper.js";
import { getWorkers } from "../copilot/orchestrator.js";
import { config } from "../config.js";
import { getSchedulerDb } from "../store/scheduler-db.js";
import type {
  JsonValue,
  RunDueSchedulesOptions,
  RunDueSchedulesResult,
  ScheduleDispatchResult,
  SchedulePayload,
  ScheduleRecord,
  ScheduleRunRecord,
  ScheduleRunner,
  ScheduleStatus,
  ScheduleType,
} from "./types.js";

const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_OVERLAP_POLICY = "forbid";
const DEFAULT_SCHEDULED_TASK_TYPE = "worker-task";
const RESEARCH_TASK_DEFAULT_MODEL = "gpt-5-mini";

interface ScheduledTaskRow {
  id: string;
  created_at: string;
  updated_at: string;
  schedule_type: ScheduleType;
  status: ScheduleStatus;
  run_at: string | null;
  cron_expr: string | null;
  timezone: string;
  payload_json: string;
  overlap_policy: "forbid" | "queue" | "replace";
  next_run_at: string | null;
  last_run_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error: string | null;
  run_count: number;
  failure_count: number;
}

interface ScheduledTaskRunRow {
  id: string;
  task_id: string;
  created_at: string;
  scheduled_for: string;
  started_at: string | null;
  finished_at: string | null;
  status: "running" | "succeeded" | "failed" | "skipped";
  error: string | null;
  external_run_id: string | null;
  runner_result_json: string | null;
}

interface ScheduledWorkerPayload {
  taskType?: JsonValue;
  task_type?: JsonValue;
  name?: JsonValue;
  workingDir?: JsonValue;
  working_dir?: JsonValue;
  cwd?: JsonValue;
  prompt?: JsonValue;
  initialPrompt?: JsonValue;
  initial_prompt?: JsonValue;
  model?: JsonValue;
  skillDirectories?: JsonValue;
  skill_directories?: JsonValue;
}

interface NormalizedScheduledWorkerPayload {
  taskType: string;
  name: string;
  workingDir: string;
  initialPrompt: string;
  model?: string;
  skillDirectories?: string[];
}

export function scheduleOneTime<TPayload extends SchedulePayload>(
  runAtISO: string,
  payload: TPayload,
): ScheduleRecord<TPayload> {
  const db = getSchedulerDb();
  const nowISO = new Date().toISOString();
  const normalizedRunAtISO = normalizeISODate(runAtISO, "runAtISO");
  const payloadJson = serializePayload(payload);
  const id = randomUUID();

  db.prepare(`
    INSERT INTO scheduled_tasks (
      id,
      created_at,
      updated_at,
      schedule_type,
      status,
      run_at,
      cron_expr,
      timezone,
      payload_json,
      overlap_policy,
      next_run_at
    ) VALUES (?, ?, ?, 'one_time', 'scheduled', ?, NULL, ?, ?, ?, ?)
  `).run(
    id,
    nowISO,
    nowISO,
    normalizedRunAtISO,
    DEFAULT_TIMEZONE,
    payloadJson,
    DEFAULT_OVERLAP_POLICY,
    normalizedRunAtISO,
  );

  return getScheduleById<TPayload>(id);
}

export function scheduleRecurring<TPayload extends SchedulePayload>(
  cronExpr: string,
  payload: TPayload,
): ScheduleRecord<TPayload> {
  const db = getSchedulerDb();
  const nowISO = new Date().toISOString();
  const normalizedCronExpr = normalizeCronExpression(cronExpr);
  const nextRunAtISO = computeNextRecurringRunAtISO(normalizedCronExpr, nowISO, DEFAULT_TIMEZONE);
  const payloadJson = serializePayload(payload);
  const id = randomUUID();

  db.prepare(`
    INSERT INTO scheduled_tasks (
      id,
      created_at,
      updated_at,
      schedule_type,
      status,
      run_at,
      cron_expr,
      timezone,
      payload_json,
      overlap_policy,
      next_run_at
    ) VALUES (?, ?, ?, 'recurring', 'scheduled', NULL, ?, ?, ?, ?, ?)
  `).run(
    id,
    nowISO,
    nowISO,
    normalizedCronExpr,
    DEFAULT_TIMEZONE,
    payloadJson,
    DEFAULT_OVERLAP_POLICY,
    nextRunAtISO,
  );

  return getScheduleById<TPayload>(id);
}

export function listSchedules<TPayload extends SchedulePayload>(): ScheduleRecord<TPayload>[] {
  const db = getSchedulerDb();
  const rows = db.prepare(`
    SELECT
      id,
      created_at,
      updated_at,
      schedule_type,
      status,
      run_at,
      cron_expr,
      timezone,
      payload_json,
      overlap_policy,
      next_run_at,
      last_run_at,
      last_success_at,
      last_failure_at,
      last_error,
      run_count,
      failure_count
    FROM scheduled_tasks
    ORDER BY
      CASE WHEN next_run_at IS NULL THEN 1 ELSE 0 END,
      next_run_at ASC,
      created_at ASC
  `).all() as ScheduledTaskRow[];

  return rows.map((row) => mapScheduleRow<TPayload>(row));
}

export function cancelSchedule<TPayload extends SchedulePayload>(id: string): ScheduleRecord<TPayload> {
  const db = getSchedulerDb();
  const nowISO = new Date().toISOString();
  const result = db.prepare(`
    UPDATE scheduled_tasks
    SET status = 'cancelled',
        updated_at = ?,
        next_run_at = NULL
    WHERE id = ?
  `).run(nowISO, id);

  if (result.changes === 0) {
    throw new Error(`Schedule not found: ${id}`);
  }

  return getScheduleById<TPayload>(id);
}

export async function runDueSchedulesNow<TPayload extends SchedulePayload>(
  options: RunDueSchedulesOptions<TPayload> = {},
): Promise<RunDueSchedulesResult> {
  const db = getSchedulerDb();
  const evaluatedAt = options.now ?? new Date();
  if (Number.isNaN(evaluatedAt.getTime())) {
    throw new TypeError("options.now must be a valid Date.");
  }

  const evaluatedAtISO = evaluatedAt.toISOString();
  const runner = options.runner ?? createWorkerScheduleRunner<TPayload>();

  const dueRows = db.prepare(`
    SELECT
      id,
      created_at,
      updated_at,
      schedule_type,
      status,
      run_at,
      cron_expr,
      timezone,
      payload_json,
      overlap_policy,
      next_run_at,
      last_run_at,
      last_success_at,
      last_failure_at,
      last_error,
      run_count,
      failure_count
    FROM scheduled_tasks
    WHERE status = 'scheduled'
      AND next_run_at IS NOT NULL
      AND next_run_at <= ?
    ORDER BY next_run_at ASC, created_at ASC
  `).all(evaluatedAtISO) as ScheduledTaskRow[];

  const runs: ScheduleRunRecord[] = [];
  let dispatchedCount = 0;
  let blockedCount = 0;
  let completedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const row of dueRows) {
    const scheduledForISO = row.next_run_at;
    if (!scheduledForISO) {
      continue;
    }

    const runId = randomUUID();
    const claimed = claimScheduleRun(row.id, runId, scheduledForISO, evaluatedAtISO);
    if (!claimed) {
      blockedCount += 1;
      continue;
    }

    dispatchedCount += 1;
    const schedule = getScheduleById<TPayload>(row.id);

    let dispatchResult: ScheduleDispatchResult;
    try {
      dispatchResult = await runner(schedule, {
        runId,
        evaluatedAtISO,
        scheduledForISO,
      });
    } catch (error) {
      dispatchResult = {
        status: "failed",
        error: formatError(error),
      };
    }

    const normalizedResult = normalizeDispatchResult(dispatchResult);
    finalizeScheduleRun(row, runId, scheduledForISO, normalizedResult);

    const runRecord = getScheduleRunById(runId);
    runs.push(runRecord);

    if (runRecord.status === "succeeded") {
      completedCount += 1;
    } else if (runRecord.status === "failed") {
      failedCount += 1;
    } else if (runRecord.status === "skipped") {
      skippedCount += 1;
    }
  }

  return {
    evaluatedAtISO,
    dueCount: dueRows.length,
    dispatchedCount,
    blockedCount,
    completedCount,
    failedCount,
    skippedCount,
    runs,
  };
}

function claimScheduleRun(
  scheduleId: string,
  runId: string,
  scheduledForISO: string,
  claimedAtISO: string,
): boolean {
  const db = getSchedulerDb();
  const claim = db.transaction(() => {
    const updateResult = db.prepare(`
      UPDATE scheduled_tasks
      SET active_run_id = ?,
          updated_at = ?
      WHERE id = ?
        AND status = 'scheduled'
        AND next_run_at = ?
        AND active_run_id IS NULL
    `).run(runId, claimedAtISO, scheduleId, scheduledForISO);

    if (updateResult.changes === 0) {
      return false;
    }

    db.prepare(`
      INSERT INTO scheduled_task_runs (
        id,
        task_id,
        created_at,
        scheduled_for,
        started_at,
        finished_at,
        status,
        error,
        external_run_id,
        runner_result_json
      ) VALUES (?, ?, ?, ?, ?, NULL, 'running', NULL, NULL, NULL)
    `).run(
      runId,
      scheduleId,
      claimedAtISO,
      scheduledForISO,
      claimedAtISO,
    );

    return true;
  });

  return claim();
}

function finalizeScheduleRun(
  row: ScheduledTaskRow,
  runId: string,
  scheduledForISO: string,
  result: Required<Pick<ScheduleDispatchResult, "status" | "error" | "finishedAtISO">> & Pick<ScheduleDispatchResult, "externalRunId" | "result">,
): void {
  const db = getSchedulerDb();
  const finishedAtISO = result.finishedAtISO;
  const serializedRunnerResult = result.result === undefined ? null : JSON.stringify(result.result);
  const taskAfterRun = db.prepare(`
    SELECT status
    FROM scheduled_tasks
    WHERE id = ?
  `).get(row.id) as { status: ScheduleStatus } | undefined;

  if (!taskAfterRun) {
    throw new Error(`Schedule not found during run finalization: ${row.id}`);
  }

  const nextRunAtISO = result.status === "succeeded" && row.schedule_type === "recurring" && row.cron_expr
    ? computeNextRecurringRunAtISO(row.cron_expr, finishedAtISO, row.timezone)
    : null;

  const finalize = db.transaction(() => {
    db.prepare(`
      UPDATE scheduled_task_runs
      SET finished_at = ?,
          status = ?,
          error = ?,
          external_run_id = ?,
          runner_result_json = ?
      WHERE id = ?
    `).run(
      finishedAtISO,
      result.status,
      result.error,
      result.externalRunId ?? null,
      serializedRunnerResult,
      runId,
    );

    if (result.status === "succeeded") {
      const nextStatus = taskAfterRun.status === "cancelled"
        ? "cancelled"
        : row.schedule_type === "one_time"
        ? "completed"
        : "scheduled";
      const storedNextRunAtISO = nextStatus === "scheduled" ? nextRunAtISO : null;

      db.prepare(`
        UPDATE scheduled_tasks
        SET active_run_id = NULL,
            updated_at = ?,
            status = ?,
            next_run_at = ?,
            last_run_at = ?,
            last_success_at = ?,
            last_error = NULL,
            run_count = run_count + 1
        WHERE id = ?
      `).run(
        finishedAtISO,
        nextStatus,
        storedNextRunAtISO,
        scheduledForISO,
        finishedAtISO,
        row.id,
      );
      return;
    }

    if (result.status === "failed") {
      db.prepare(`
        UPDATE scheduled_tasks
        SET active_run_id = NULL,
            updated_at = ?,
            last_failure_at = ?,
            last_error = ?,
            failure_count = failure_count + 1
        WHERE id = ?
      `).run(
        finishedAtISO,
        finishedAtISO,
        result.error,
        row.id,
      );
      return;
    }

    db.prepare(`
      UPDATE scheduled_tasks
      SET active_run_id = NULL,
          updated_at = ?,
          last_error = ?
      WHERE id = ?
    `).run(
      finishedAtISO,
      result.error,
      row.id,
    );
  });

  finalize();
}

function getScheduleById<TPayload extends SchedulePayload>(id: string): ScheduleRecord<TPayload> {
  const db = getSchedulerDb();
  const row = db.prepare(`
    SELECT
      id,
      created_at,
      updated_at,
      schedule_type,
      status,
      run_at,
      cron_expr,
      timezone,
      payload_json,
      overlap_policy,
      next_run_at,
      last_run_at,
      last_success_at,
      last_failure_at,
      last_error,
      run_count,
      failure_count
    FROM scheduled_tasks
    WHERE id = ?
  `).get(id) as ScheduledTaskRow | undefined;

  if (!row) {
    throw new Error(`Schedule not found: ${id}`);
  }

  return mapScheduleRow<TPayload>(row);
}

function getScheduleRunById(id: string): ScheduleRunRecord {
  const db = getSchedulerDb();
  const row = db.prepare(`
    SELECT
      id,
      task_id,
      created_at,
      scheduled_for,
      started_at,
      finished_at,
      status,
      error,
      external_run_id,
      runner_result_json
    FROM scheduled_task_runs
    WHERE id = ?
  `).get(id) as ScheduledTaskRunRow | undefined;

  if (!row) {
    throw new Error(`Schedule run not found: ${id}`);
  }

  return mapScheduleRunRow(row);
}

function mapScheduleRow<TPayload extends SchedulePayload>(row: ScheduledTaskRow): ScheduleRecord<TPayload> {
  return {
    id: row.id,
    createdAtISO: row.created_at,
    updatedAtISO: row.updated_at,
    scheduleType: row.schedule_type,
    status: row.status,
    runAtISO: row.run_at,
    cronExpr: row.cron_expr,
    timezone: row.timezone,
    overlapPolicy: row.overlap_policy,
    nextRunAtISO: row.next_run_at,
    lastRunAtISO: row.last_run_at,
    lastSuccessAtISO: row.last_success_at,
    lastFailureAtISO: row.last_failure_at,
    lastError: row.last_error,
    runCount: row.run_count,
    failureCount: row.failure_count,
    payload: parsePayload<TPayload>(row.payload_json),
  };
}

function mapScheduleRunRow(row: ScheduledTaskRunRow): ScheduleRunRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    createdAtISO: row.created_at,
    scheduledForISO: row.scheduled_for,
    startedAtISO: row.started_at,
    finishedAtISO: row.finished_at,
    status: row.status,
    error: row.error,
    externalRunId: row.external_run_id,
    runnerResult: row.runner_result_json ? JSON.parse(row.runner_result_json) as JsonValue : null,
  };
}

function serializePayload(payload: SchedulePayload): string {
  if (!isJsonValue(payload)) {
    throw new TypeError("Schedule payload must be JSON-serializable.");
  }

  return JSON.stringify(payload);
}

function parsePayload<TPayload extends SchedulePayload>(payloadJson: string): TPayload {
  return JSON.parse(payloadJson) as TPayload;
}

function normalizeISODate(value: string, fieldName: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${fieldName} must be a valid ISO timestamp.`);
  }

  return date.toISOString();
}

function normalizeCronExpression(cronExpr: string): string {
  if (typeof cronExpr !== "string" || cronExpr.trim().length === 0) {
    throw new TypeError("cronExpr must be a non-empty cron expression.");
  }

  const normalizedCronExpr = cronExpr.trim();
  computeNextRecurringRunAtISO(normalizedCronExpr, new Date().toISOString(), DEFAULT_TIMEZONE);
  return normalizedCronExpr;
}

function computeNextRecurringRunAtISO(cronExpr: string, referenceISO: string, timezone: string): string {
  const referenceDate = new Date(referenceISO);
  if (Number.isNaN(referenceDate.getTime())) {
    throw new TypeError("referenceISO must be a valid ISO timestamp.");
  }

  try {
    const interval = CronExpressionParser.parse(cronExpr, {
      currentDate: new Date(referenceDate.getTime() + 1),
      tz: timezone,
    });
    return interval.next().toDate().toISOString();
  } catch (error) {
    throw new TypeError(`Invalid cron expression: ${formatError(error)}`);
  }
}

function normalizeDispatchResult(result: ScheduleDispatchResult): Required<Pick<ScheduleDispatchResult, "status" | "error" | "finishedAtISO">> & Pick<ScheduleDispatchResult, "externalRunId" | "result"> {
  const finishedAtISO = result.finishedAtISO
    ? normalizeISODate(result.finishedAtISO, "finishedAtISO")
    : new Date().toISOString();

  if (result.error && typeof result.error !== "string") {
    throw new TypeError("Schedule runner error must be a string.");
  }

  if (result.result !== undefined && !isJsonValue(result.result)) {
    throw new TypeError("Schedule runner result must be JSON-serializable.");
  }

  return {
    status: result.status,
    error: result.error ?? defaultErrorForStatus(result.status),
    finishedAtISO,
    externalRunId: result.externalRunId,
    result: result.result,
  };
}

function defaultErrorForStatus(status: "succeeded" | "failed" | "skipped"): string {
  if (status === "failed") {
    return "Schedule runner failed without an explicit error message.";
  }
  if (status === "skipped") {
    return "Schedule runner skipped execution.";
  }
  return "";
}

function createWorkerScheduleRunner<TPayload extends SchedulePayload>(): ScheduleRunner<TPayload> {
  return async (schedule, context) => {
    const payload = normalizeScheduledWorkerPayload(schedule, context.runId);
    const model = resolveScheduledModel(payload);

    logWorker(
      `scheduler dispatching schedule='${schedule.id}' run='${context.runId}' worker='${payload.name}' model='${model}' dir='${payload.workingDir}'`,
    );

    const result = await createWorkerSession(
      {
        name: payload.name,
        workingDir: payload.workingDir,
        initialPrompt: payload.initialPrompt,
        model,
        skillDirectories: payload.skillDirectories,
      },
      {
        client: await getClient(),
        workers: getWorkers(),
        onWorkerComplete: (workerName, output) => {
          logWorker(
            `scheduler worker '${workerName}' finished for schedule '${schedule.id}': ${truncateForLog(output)}`,
          );
        },
        logWorker,
      },
    );

    if (!result.created) {
      const runnerResult: Record<string, JsonValue> = {
        workerName: payload.name,
        model,
        taskType: payload.taskType,
      };
      return {
        status: "failed",
        error: result.message,
        result: runnerResult,
      };
    }

    const runnerResult: Record<string, JsonValue> = {
      workerName: result.worker.name,
      sessionId: result.sessionId,
      dispatchedInitialPrompt: result.dispatchedInitialPrompt,
      model,
      taskType: payload.taskType,
      workingDir: payload.workingDir,
    };

    return {
      status: "succeeded",
      externalRunId: result.sessionId,
      result: runnerResult,
    };
  };
}

function normalizeScheduledWorkerPayload<TPayload extends SchedulePayload>(
  schedule: ScheduleRecord<TPayload>,
  runId: string,
): NormalizedScheduledWorkerPayload {
  if (!isJsonObject(schedule.payload)) {
    throw new TypeError(`Schedule ${schedule.id} payload must be a JSON object.`);
  }

  const payload = schedule.payload as ScheduledWorkerPayload;
  const taskType = readRequiredOrDefaultString(
    payload.taskType ?? payload.task_type,
    DEFAULT_SCHEDULED_TASK_TYPE,
  );
  const workingDir = readRequiredString(
    payload.workingDir ?? payload.working_dir ?? payload.cwd,
    `Schedule ${schedule.id} payload must include 'workingDir' (or 'working_dir'/'cwd').`,
  );
  const initialPrompt = readRequiredString(
    payload.initialPrompt ?? payload.initial_prompt ?? payload.prompt,
    `Schedule ${schedule.id} payload must include 'initialPrompt' (or 'initial_prompt'/'prompt').`,
  );
  const explicitName = readOptionalString(payload.name);
  const model = readOptionalString(payload.model);
  const skillDirectories = readOptionalStringArray(
    payload.skillDirectories ?? payload.skill_directories,
    "skillDirectories",
  );

  return {
    taskType,
    name: explicitName ?? buildScheduledWorkerName(taskType, schedule.id, runId),
    workingDir,
    initialPrompt,
    model,
    skillDirectories,
  };
}

function resolveScheduledModel(payload: NormalizedScheduledWorkerPayload): string {
  if (payload.model) {
    return payload.model;
  }
  if (config.schedulerModelOverride) {
    return config.schedulerModelOverride;
  }
  if (payload.taskType === "research-task") {
    return RESEARCH_TASK_DEFAULT_MODEL;
  }
  return config.copilotModel;
}

function buildScheduledWorkerName(taskType: string, scheduleId: string, runId: string): string {
  const taskPrefix = taskType
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "scheduled-task";
  return `${taskPrefix}-${scheduleId.slice(0, 8)}-${runId.slice(0, 8)}`;
}

function readRequiredOrDefaultString(value: JsonValue | undefined, fallback: string): string {
  const parsed = readOptionalString(value);
  return parsed ?? fallback;
}

function readRequiredString(value: JsonValue | undefined, errorMessage: string): string {
  const parsed = readOptionalString(value);
  if (!parsed) {
    throw new TypeError(errorMessage);
  }
  return parsed;
}

function readOptionalString(value: JsonValue | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalStringArray(
  value: JsonValue | undefined,
  fieldName: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an array of strings.`);
  }

  const normalized = value.map((item) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new TypeError(`${fieldName} must be an array of non-empty strings.`);
    }
    return item.trim();
  });

  return normalized.length > 0 ? normalized : undefined;
}

function truncateForLog(text: string, max = 200): string {
  const oneLine = text.replace(/\n/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }

  if (typeof value !== "object") {
    return false;
  }

  return Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item));
}

function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
