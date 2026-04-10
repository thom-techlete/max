# Scheduling Recommendations for Max

> The request referenced both a repo-root recommendations file and `docs/scheduling-recommendations.md`; this document uses `docs/scheduling-recommendations.md` as the authoritative location.

## 1. Recommended approach for Max

- **Primary recommendation: a Max-owned, SQLite-backed scheduler inside the daemon.**
  - The **scheduler of record lives in Max**, not in the OS scheduler.
  - Max stores schedule definitions in **`~/.max/max.db`**, computes due work, and enqueues fresh runs into Max’s existing orchestrator/worker system.
  - This best matches the product requirement for a first-class data model, persistence, schedule CRUD, cancellation, listing, inspection, run history, overlap policy, and worker/session linkage.
- **Deployment recommendation on Linux:** run the Max daemon under a **systemd user service** for restart supervision and normal daemon lifecycle management.
- **Operational fallback before the internal scheduler exists, or when an external trigger is temporarily required:** prefer **systemd user timers**, then **cron** for non-systemd environments. These should only call Max’s local API/CLI to enqueue work.

### Why not rely on OS schedulers as the primary design?

OS schedulers are good at “run this command later,” but they are not Max’s control plane. Max needs first-class schedule create/update/delete, pause/resume, inspection, run history, overlap policy, and direct linkage to Max workers and orchestrator sessions. Those capabilities belong in Max’s own SQLite-backed model and scheduler loop.

### Alternatives considered

- **systemd timers:** strong Linux-native option for external triggering, but not the primary design because timer state and Max run state would be split across layers.
- **cron:** acceptable fallback external trigger, but limited for inspection, pause/resume, overlap handling, and product-level schedule management.
- **atd:** useful only for rare one-shot deferred tasks.
- **node-cron:** in-process only; schedules disappear while Max is down unless persistence is rebuilt elsewhere.
- **Agenda / Redis-backed schedulers:** add infrastructure Max does not otherwise need.
- **GitHub Actions:** wrong execution boundary for a local daemon.
- **External webhook schedulers:** add exposure, tunneling, and attack surface.

## 2. Data model for scheduled tasks

Store schedule definitions separately from execution records in Max’s SQLite database.

- **`scheduled_tasks`**
  - `id`
  - `created_at`, `updated_at`
  - `owner` / `source`
  - `task_type`
  - `payload` or `prompt`
  - `cwd`
  - `schedule_type` (`one_shot`, `recurring`)
  - `schedule_expression`
  - `timezone`
  - `next_run_at`
  - `last_run_at`
  - `last_success_at`
  - `last_failure_at`
  - `status` (`scheduled`, `paused`, `cancelled`, `completed`)
  - `retry_policy` / `backoff_policy`
  - `overlap_policy` (`forbid`, `queue`, `replace`)
  - `run_count`, `failure_count`
  - `last_error`
  - `metadata` / `tags`
- **`scheduled_task_runs`**
  - `id`
  - `task_id`
  - `enqueued_at`, `started_at`, `finished_at`
  - `outcome`, `error`
  - linked `worker_name`, `worker_id`, `orchestrator_session_id`, or equivalent run identifiers

This keeps durable schedule state in SQLite while each execution remains a fresh Max run.

## 3. Persistence/storage location

- Store scheduling state in Max’s existing SQLite database at **`~/.max/max.db`**.
- Reuse the existing persistence path; do **not** introduce a second scheduler database.
- Recommended tables:
  - `scheduled_tasks`
  - `scheduled_task_runs`
- On daemon startup, load enabled schedules from SQLite, recompute due work, and enqueue fresh runs.
- Do **not** attempt to resume destroyed workers from before restart; recover schedule state, not in-flight process state.

## 4. API for scheduling, cancelling, and listing tasks

Expose scheduling through Max’s local bearer-token API and mirror it in CLI commands.

- **Create**
  - `POST /schedules`
  - Body: task type, prompt/payload, cwd, schedule type, expression, timezone, retry policy, overlap policy, tags, enabled
- **List**
  - `GET /schedules`
  - Filters: status, enabled, tag, task type, due-before, owner/source
- **Inspect**
  - `GET /schedules/:id`
  - Return schedule definition, next run, recent run history, and linked worker/session/run records
- **Pause / resume**
  - `POST /schedules/:id/pause`
  - `POST /schedules/:id/resume`
- **Cancel**
  - `POST /schedules/:id/cancel`
  - Cancels future scheduling; does not imply killing an already running worker unless explicitly requested
- **Trigger now**
  - `POST /schedules/:id/trigger`
  - Enqueues immediate work without replacing the recurring definition

Suggested CLI mirrors:

- `max schedule create ...`
- `max schedule list`
- `max schedule inspect <id>`
- `max schedule pause <id>`
- `max schedule resume <id>`
- `max schedule cancel <id>`
- `max schedule trigger <id>`

## 5. Security considerations

- Keep scheduling behind Max’s existing **local bearer-token API** on `127.0.0.1`.
- Model ownership as **single-user today**; keep `owner/source` for provenance and future authorization work.
- Validate all schedule input:
  - schedule expression format
  - timezone
  - cwd path handling
  - payload/prompt size and shape
  - overlap and retry policy enums
- Keep an audit trail in SQLite: created/updated timestamps, source, trigger results, linked runs, and error history.
- Prefer **user-level** service management and external triggers:
  - use a **systemd user service** to supervise the Max daemon on Linux
  - if external scheduling is needed, prefer **user-level systemd timers**, then **user cron**
  - avoid root or system-wide schedulers unless there is a real admin requirement
- If webhook-based triggering is ever added, require signature validation, replay protection, and narrow allowed sources.

## 6. Migration path and tests

- **Safe rollout**
  - Phase 1: add SQLite tables for `scheduled_tasks` and `scheduled_task_runs`
  - Phase 2: add scheduler loop inside the Max daemon to load schedules, compute due work, and enqueue runs
  - Phase 3: add schedule API + CLI for CRUD, pause/resume, cancel, inspect, and trigger-now
  - Phase 4: optionally publish example **systemd user service**, **systemd timer**, and **cron** integration notes for external triggering or transitional deployments
- **Behavioral rules**
  - On restart, recover schedule definitions from SQLite and recompute due runs
  - Never resume prior worker state; always enqueue a fresh run
  - Enforce overlap policy and duplicate-dispatch protection inside Max
- **Tests**
  - schedule CRUD and persistence tests
  - daemon restart/recovery tests
  - DST and timezone boundary tests
  - duplicate-run prevention / idempotent dispatch tests
  - overlap policy tests (`forbid`, `queue`, `replace`)
  - cancellation and pause/resume semantics
  - retry/backoff behavior
  - integration tests that scheduled runs enqueue work into Max’s queue and link to workers/sessions correctly
