import Database from "better-sqlite3";
import { SCHEDULER_DB_PATH, ensureMaxHome } from "../paths.js";

const SCHEDULER_SCHEMA_VERSION = 1;

let schedulerDb: Database.Database | undefined;

export function getSchedulerDb(): Database.Database {
  if (!schedulerDb) {
    ensureMaxHome();
    schedulerDb = new Database(SCHEDULER_DB_PATH);
    schedulerDb.pragma("journal_mode = WAL");
    schedulerDb.pragma("foreign_keys = ON");
    migrateSchedulerDb(schedulerDb);
  }

  return schedulerDb;
}

function migrateSchedulerDb(db: Database.Database): void {
  const currentVersion = db.pragma("user_version", { simple: true }) as number;

  if (currentVersion >= SCHEDULER_SCHEMA_VERSION) {
    return;
  }

  if (currentVersion < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        schedule_type TEXT NOT NULL CHECK (schedule_type IN ('one_time', 'recurring')),
        status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'completed')),
        run_at TEXT,
        cron_expr TEXT,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        payload_json TEXT NOT NULL,
        overlap_policy TEXT NOT NULL DEFAULT 'forbid' CHECK (overlap_policy IN ('forbid', 'queue', 'replace')),
        next_run_at TEXT,
        last_run_at TEXT,
        last_success_at TEXT,
        last_failure_at TEXT,
        last_error TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        active_run_id TEXT,
        CHECK (
          (schedule_type = 'one_time' AND run_at IS NOT NULL AND cron_expr IS NULL) OR
          (schedule_type = 'recurring' AND run_at IS NULL AND cron_expr IS NOT NULL)
        )
      );

      CREATE INDEX IF NOT EXISTS scheduled_tasks_due_idx
      ON scheduled_tasks (status, next_run_at);

      CREATE TABLE IF NOT EXISTS scheduled_task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
        error TEXT,
        external_run_id TEXT,
        runner_result_json TEXT
      );

      CREATE INDEX IF NOT EXISTS scheduled_task_runs_task_idx
      ON scheduled_task_runs (task_id, created_at DESC);
    `);
  }

  db.pragma(`user_version = ${SCHEDULER_SCHEMA_VERSION}`);
}

export function closeSchedulerDb(): void {
  if (schedulerDb) {
    schedulerDb.close();
    schedulerDb = undefined;
  }
}
