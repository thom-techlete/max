import { readFileSync } from "fs";
import { resolve } from "path";
import type { JsonValue, RunDueSchedulesResult, ScheduleRecord } from "../scheduler/types.js";

class SchedulerUsageError extends Error {}

type FetchLike = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}>;

export interface SchedulerCommandOptions {
  apiPort: number;
  tokenPath: string;
  fetchImpl?: FetchLike;
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
}

type ParsedSchedulerCommand =
  | { kind: "add-one"; runAt: string; payloadFile: string }
  | { kind: "add-cron"; cron: string; payloadFile: string }
  | { kind: "list" }
  | { kind: "cancel"; id: string }
  | { kind: "run-now" };

function buildUsageText(): string {
  return [
    "Usage:",
    "  max scheduler add-one --run-at <iso> --payload-file <path>",
    "  max scheduler add-cron --cron <expr> --payload-file <path>",
    "  max scheduler list",
    "  max scheduler cancel <id>",
    "  max scheduler run-now",
  ].join("\n");
}

function readApiToken(tokenPath: string): string {
  try {
    const token = readFileSync(tokenPath, "utf-8").trim();
    if (token) {
      return token;
    }
  } catch {
    // handled below
  }

  throw new Error(`Local API token not found at ${tokenPath}. Start Max with 'max start'.`);
}

function parseStringFlag(args: string[], flagName: string): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === flagName) {
      const value = args[index + 1];
      if (!value) {
        throw new SchedulerUsageError(`Missing value for ${flagName}.`);
      }
      return value;
    }

    if (arg.startsWith(`${flagName}=`)) {
      const value = arg.slice(flagName.length + 1);
      if (!value) {
        throw new SchedulerUsageError(`Missing value for ${flagName}.`);
      }
      return value;
    }
  }

  throw new SchedulerUsageError(`Missing required flag: ${flagName}.`);
}

function parseNoExtraArgs(args: string[]): void {
  if (args.length === 0) {
    return;
  }

  const firstArg = args[0];
  if (firstArg?.startsWith("-")) {
    throw new SchedulerUsageError(`Unknown flag: ${firstArg}`);
  }

  throw new SchedulerUsageError(`Unexpected argument: ${firstArg}`);
}

function parseAddOneArgs(args: string[]): ParsedSchedulerCommand {
  let runAt: string | undefined;
  let payloadFile: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--run-at") {
      runAt = parseStringFlag([arg, args[index + 1] || ""], "--run-at");
      index += 1;
      continue;
    }

    if (arg.startsWith("--run-at=")) {
      runAt = parseStringFlag([arg], "--run-at");
      continue;
    }

    if (arg === "--payload-file") {
      payloadFile = parseStringFlag([arg, args[index + 1] || ""], "--payload-file");
      index += 1;
      continue;
    }

    if (arg.startsWith("--payload-file=")) {
      payloadFile = parseStringFlag([arg], "--payload-file");
      continue;
    }

    if (arg.startsWith("-")) {
      throw new SchedulerUsageError(`Unknown flag: ${arg}`);
    }

    throw new SchedulerUsageError(`Unexpected argument: ${arg}`);
  }

  if (!runAt) {
    throw new SchedulerUsageError("Missing required flag: --run-at.");
  }

  if (!payloadFile) {
    throw new SchedulerUsageError("Missing required flag: --payload-file.");
  }

  return { kind: "add-one", runAt, payloadFile };
}

function parseAddCronArgs(args: string[]): ParsedSchedulerCommand {
  let cron: string | undefined;
  let payloadFile: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--cron") {
      cron = parseStringFlag([arg, args[index + 1] || ""], "--cron");
      index += 1;
      continue;
    }

    if (arg.startsWith("--cron=")) {
      cron = parseStringFlag([arg], "--cron");
      continue;
    }

    if (arg === "--payload-file") {
      payloadFile = parseStringFlag([arg, args[index + 1] || ""], "--payload-file");
      index += 1;
      continue;
    }

    if (arg.startsWith("--payload-file=")) {
      payloadFile = parseStringFlag([arg], "--payload-file");
      continue;
    }

    if (arg.startsWith("-")) {
      throw new SchedulerUsageError(`Unknown flag: ${arg}`);
    }

    throw new SchedulerUsageError(`Unexpected argument: ${arg}`);
  }

  if (!cron) {
    throw new SchedulerUsageError("Missing required flag: --cron.");
  }

  if (!payloadFile) {
    throw new SchedulerUsageError("Missing required flag: --payload-file.");
  }

  return { kind: "add-cron", cron, payloadFile };
}

function parseCancelArgs(args: string[]): ParsedSchedulerCommand {
  let id: string | undefined;

  for (const arg of args) {
    if (arg.startsWith("-")) {
      throw new SchedulerUsageError(`Unknown flag: ${arg}`);
    }

    if (id) {
      throw new SchedulerUsageError(`Unexpected argument: ${arg}`);
    }

    id = arg;
  }

  if (!id) {
    throw new SchedulerUsageError("Missing required schedule id.");
  }

  return { kind: "cancel", id };
}

function parseArgs(args: string[]): ParsedSchedulerCommand {
  const subcommand = args[0];
  const rest = args.slice(1);

  if (!subcommand) {
    throw new SchedulerUsageError("Missing scheduler subcommand.");
  }

  switch (subcommand) {
    case "add-one":
      return parseAddOneArgs(rest);
    case "add-cron":
      return parseAddCronArgs(rest);
    case "list":
      parseNoExtraArgs(rest);
      return { kind: "list" };
    case "cancel":
      return parseCancelArgs(rest);
    case "run-now":
      parseNoExtraArgs(rest);
      return { kind: "run-now" };
    default:
      throw new SchedulerUsageError(`Unknown scheduler command: ${subcommand}`);
  }
}

function loadPayloadFile(payloadFile: string): JsonValue {
  const resolvedPath = resolve(payloadFile);

  let raw: string;
  try {
    raw = readFileSync(resolvedPath, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read payload file "${payloadFile}": ${message}`);
  }

  try {
    return JSON.parse(raw) as JsonValue;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Payload file "${payloadFile}" must contain valid JSON: ${message}`);
  }
}

async function requestLocalApi(
  apiPort: number,
  tokenPath: string,
  path: string,
  init: {
    method: "GET" | "POST";
    body?: Record<string, unknown>;
  },
  fetchImpl: FetchLike = fetch,
): Promise<unknown> {
  const token = readApiToken(tokenPath);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  let body: string | undefined;
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(`http://127.0.0.1:${apiPort}${path}`, {
      method: init.method,
      headers,
      body,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach the Max daemon on port ${apiPort}: ${message}. Start it with 'max start'.`);
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("The Max daemon rejected the request. Restart Max if the local API token changed.");
    }

    const details = (await response.text()).trim();
    const suffix = details ? `: ${details}` : "";
    throw new Error(`The Max daemon returned ${response.status} ${response.statusText}${suffix}`);
  }

  const rawBody = (await response.text()).trim();
  if (!rawBody) {
    return undefined;
  }

  try {
    return JSON.parse(rawBody) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`The Max daemon returned invalid JSON: ${message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isScheduleType(value: unknown): value is ScheduleRecord["scheduleType"] {
  return value === "one_time" || value === "recurring";
}

function isScheduleStatus(value: unknown): value is ScheduleRecord["status"] {
  return value === "scheduled" || value === "cancelled" || value === "completed";
}

function isScheduleRecord(value: unknown): value is ScheduleRecord {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.id === "string"
    && typeof value.createdAtISO === "string"
    && typeof value.updatedAtISO === "string"
    && isScheduleType(value.scheduleType)
    && isScheduleStatus(value.status)
    && isOptionalString(value.runAtISO)
    && isOptionalString(value.cronExpr)
    && typeof value.timezone === "string"
    && typeof value.overlapPolicy === "string"
    && isOptionalString(value.nextRunAtISO)
    && isOptionalString(value.lastRunAtISO)
    && isOptionalString(value.lastSuccessAtISO)
    && isOptionalString(value.lastFailureAtISO)
    && isOptionalString(value.lastError)
    && typeof value.runCount === "number"
    && typeof value.failureCount === "number"
    && "payload" in value;
}

function isScheduleRecordList(value: unknown): value is ScheduleRecord[] {
  return Array.isArray(value) && value.every(isScheduleRecord);
}

function isRunDueSchedulesResult(value: unknown): value is RunDueSchedulesResult {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.evaluatedAtISO === "string"
    && typeof value.dueCount === "number"
    && typeof value.dispatchedCount === "number"
    && typeof value.blockedCount === "number"
    && typeof value.completedCount === "number"
    && typeof value.failedCount === "number"
    && typeof value.skippedCount === "number"
    && Array.isArray(value.runs);
}

function formatScheduleSummary(schedule: ScheduleRecord): string {
  const lines = [
    `  ID: ${schedule.id}`,
    `  Type: ${schedule.scheduleType}`,
    `  Status: ${schedule.status}`,
  ];

  if (schedule.runAtISO) {
    lines.push(`  Run at: ${schedule.runAtISO}`);
  }

  if (schedule.cronExpr) {
    lines.push(`  Cron: ${schedule.cronExpr}`);
  }

  lines.push(`  Next run: ${schedule.nextRunAtISO ?? "n/a"}`);
  lines.push(`  Runs: ${schedule.runCount} (failures: ${schedule.failureCount})`);

  if (schedule.lastError) {
    lines.push(`  Last error: ${schedule.lastError}`);
  }

  return lines.join("\n");
}

export function formatScheduleList(schedules: ScheduleRecord[]): string {
  if (schedules.length === 0) {
    return "No schedules found.\n";
  }

  const blocks = schedules.map((schedule) => [
    `- ${schedule.id} [${schedule.scheduleType}] ${schedule.status}`,
    schedule.runAtISO ? `  Run at: ${schedule.runAtISO}` : undefined,
    schedule.cronExpr ? `  Cron: ${schedule.cronExpr}` : undefined,
    `  Next run: ${schedule.nextRunAtISO ?? "n/a"}`,
    `  Runs: ${schedule.runCount} (failures: ${schedule.failureCount})`,
    schedule.lastError ? `  Last error: ${schedule.lastError}` : undefined,
  ].filter((line): line is string => typeof line === "string").join("\n"));

  return `Schedules (${schedules.length}):\n${blocks.join("\n")}\n`;
}

function formatRunNowResult(result: RunDueSchedulesResult): string {
  return [
    "Scheduler run complete.",
    `Evaluated at: ${result.evaluatedAtISO}`,
    `Due schedules: ${result.dueCount}`,
    `Dispatched: ${result.dispatchedCount}`,
    `Blocked: ${result.blockedCount}`,
    `Completed: ${result.completedCount}`,
    `Failed: ${result.failedCount}`,
    `Skipped: ${result.skippedCount}`,
  ].join("\n");
}

export async function runSchedulerCommand(
  args: string[],
  options: SchedulerCommandOptions,
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  if (args.includes("--help") || args.includes("-h")) {
    stdout.write(`${buildUsageText()}\n`);
    return 0;
  }

  try {
    const command = parseArgs(args);

    switch (command.kind) {
      case "add-one": {
        const payload = loadPayloadFile(command.payloadFile);
        const response = await requestLocalApi(
          options.apiPort,
          options.tokenPath,
          "/schedules/one-time",
          {
            method: "POST",
            body: { runAt: command.runAt, payload },
          },
          options.fetchImpl,
        );

        if (response !== undefined && !isScheduleRecord(response)) {
          throw new Error("The Max daemon returned an invalid schedule payload.");
        }

        if (response) {
          stdout.write(`Added one-time schedule.\n${formatScheduleSummary(response)}\n`);
        } else {
          stdout.write("Added one-time schedule.\n");
        }
        return 0;
      }
      case "add-cron": {
        const payload = loadPayloadFile(command.payloadFile);
        const response = await requestLocalApi(
          options.apiPort,
          options.tokenPath,
          "/schedules/recurring",
          {
            method: "POST",
            body: { cron: command.cron, payload },
          },
          options.fetchImpl,
        );

        if (response !== undefined && !isScheduleRecord(response)) {
          throw new Error("The Max daemon returned an invalid schedule payload.");
        }

        if (response) {
          stdout.write(`Added recurring schedule.\n${formatScheduleSummary(response)}\n`);
        } else {
          stdout.write("Added recurring schedule.\n");
        }
        return 0;
      }
      case "list": {
        const response = await requestLocalApi(
          options.apiPort,
          options.tokenPath,
          "/schedules",
          { method: "GET" },
          options.fetchImpl,
        );

        if (!isScheduleRecordList(response)) {
          throw new Error("The Max daemon returned an invalid schedules payload.");
        }

        stdout.write(formatScheduleList(response));
        return 0;
      }
      case "cancel": {
        const response = await requestLocalApi(
          options.apiPort,
          options.tokenPath,
          `/schedules/${encodeURIComponent(command.id)}/cancel`,
          { method: "POST" },
          options.fetchImpl,
        );

        if (response !== undefined && !isScheduleRecord(response)) {
          throw new Error("The Max daemon returned an invalid schedule payload.");
        }

        if (response) {
          stdout.write(`Cancelled schedule.\n${formatScheduleSummary(response)}\n`);
        } else {
          stdout.write(`Cancelled schedule ${command.id}.\n`);
        }
        return 0;
      }
      case "run-now": {
        const response = await requestLocalApi(
          options.apiPort,
          options.tokenPath,
          "/scheduler/run-now",
          { method: "POST" },
          options.fetchImpl,
        );

        if (response === undefined) {
          stdout.write("Scheduler run triggered.\n");
          return 0;
        }

        if (!isRunDueSchedulesResult(response)) {
          throw new Error("The Max daemon returned an invalid scheduler run payload.");
        }

        stdout.write(`${formatRunNowResult(response)}\n`);
        return 0;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    if (error instanceof SchedulerUsageError) {
      stderr.write(`${buildUsageText()}\n`);
    }
    return 1;
  }
}
