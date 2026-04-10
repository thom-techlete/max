import { randomUUID } from "crypto";
import { CronExpressionParser } from "cron-parser";
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
  const runner = options.runner ?? createPlaceholderRunner<TPayload>();

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

function createPlaceholderRunner<TPayload extends SchedulePayload>(): ScheduleRunner<TPayload> {
  return () => ({
    status: "skipped",
    error: "No scheduler runner has been configured yet.",
  });
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
