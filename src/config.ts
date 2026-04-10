import { config as loadEnv } from "dotenv";
import { z } from "zod";
import { existsSync, readFileSync, writeFileSync } from "fs";
import {
  ACTIVE_SESSION_RUN_ID_PATH,
  ENV_PATH,
  ensureMaxHome,
  ensureSessionLogsDir,
} from "./paths.js";

// Load from ~/.max/.env, fall back to cwd .env for dev
loadEnv({ path: ENV_PATH, quiet: true });
loadEnv({ quiet: true }); // also check cwd for backwards compat

const configSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  AUTHORIZED_USER_ID: z.string().min(1).optional(),
  API_PORT: z.string().optional(),
  COPILOT_MODEL: z.string().optional(),
  WORKER_TIMEOUT: z.string().optional(),
  SCHEDULER_POLL_INTERVAL: z.string().optional(),
  SCHEDULER_MODEL_OVERRIDE: z.string().optional(),
});

const raw = configSchema.parse(process.env);

const parsedUserId = raw.AUTHORIZED_USER_ID
  ? parseInt(raw.AUTHORIZED_USER_ID, 10)
  : undefined;
const parsedPort = parseInt(raw.API_PORT || "7777", 10);

if (parsedUserId !== undefined && (Number.isNaN(parsedUserId) || parsedUserId <= 0)) {
  throw new Error(`AUTHORIZED_USER_ID must be a positive integer, got: "${raw.AUTHORIZED_USER_ID}"`);
}
if (Number.isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
  throw new Error(`API_PORT must be 1-65535, got: "${raw.API_PORT}"`);
}

const DEFAULT_WORKER_TIMEOUT_MS = 600_000; // 10 minutes
const parsedWorkerTimeout = raw.WORKER_TIMEOUT
  ? Number(raw.WORKER_TIMEOUT)
  : DEFAULT_WORKER_TIMEOUT_MS;
const DEFAULT_SCHEDULER_POLL_INTERVAL_MS = 30_000; // 30 seconds
const parsedSchedulerPollInterval = raw.SCHEDULER_POLL_INTERVAL
  ? Number(raw.SCHEDULER_POLL_INTERVAL)
  : DEFAULT_SCHEDULER_POLL_INTERVAL_MS;

if (!Number.isInteger(parsedWorkerTimeout) || parsedWorkerTimeout <= 0) {
  throw new Error(`WORKER_TIMEOUT must be a positive integer (ms), got: "${raw.WORKER_TIMEOUT}"`);
}
if (!Number.isInteger(parsedSchedulerPollInterval) || parsedSchedulerPollInterval <= 0) {
  throw new Error(`SCHEDULER_POLL_INTERVAL must be a positive integer (ms), got: "${raw.SCHEDULER_POLL_INTERVAL}"`);
}

export const DEFAULT_MODEL = "claude-sonnet-4.6";

let _copilotModel = raw.COPILOT_MODEL || DEFAULT_MODEL;
const schedulerModelOverride = raw.SCHEDULER_MODEL_OVERRIDE?.trim() || undefined;

export const config = {
  telegramBotToken: raw.TELEGRAM_BOT_TOKEN,
  authorizedUserId: parsedUserId,
  apiPort: parsedPort,
  workerTimeoutMs: parsedWorkerTimeout,
  schedulerPollIntervalMs: parsedSchedulerPollInterval,
  schedulerModelOverride,
  get copilotModel(): string {
    return _copilotModel;
  },
  set copilotModel(model: string) {
    _copilotModel = model;
  },
  get telegramEnabled(): boolean {
    return !!this.telegramBotToken && this.authorizedUserId !== undefined;
  },
  get selfEditEnabled(): boolean {
    return process.env.MAX_SELF_EDIT === "1";
  },
  get activeSessionRunId(): string | undefined {
    return readActiveSessionRunId();
  },
};

/** Update or append an env var in ~/.max/.env */
function persistEnvVar(key: string, value: string): void {
  ensureMaxHome();
  try {
    const content = readFileSync(ENV_PATH, "utf-8");
    const lines = content.split("\n");
    let found = false;
    const updated = lines.map((line) => {
      if (line.startsWith(`${key}=`)) {
        found = true;
        return `${key}=${value}`;
      }
      return line;
    });
    if (!found) updated.push(`${key}=${value}`);
    writeFileSync(ENV_PATH, updated.join("\n"));
  } catch {
    // File doesn't exist — create it
    writeFileSync(ENV_PATH, `${key}=${value}\n`);
  }
}

/** Persist the current model choice to ~/.max/.env */
export function persistModel(model: string): void {
  persistEnvVar("COPILOT_MODEL", model);
}

export function persistActiveSessionRunId(runId: string): void {
  ensureSessionLogsDir();
  process.env.MAX_ACTIVE_SESSION_RUN_ID = runId;
  writeFileSync(ACTIVE_SESSION_RUN_ID_PATH, `${runId}\n`);
}

export function readActiveSessionRunId(): string | undefined {
  const fromEnv = process.env.MAX_ACTIVE_SESSION_RUN_ID?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  if (!existsSync(ACTIVE_SESSION_RUN_ID_PATH)) {
    return undefined;
  }

  const fromFile = readFileSync(ACTIVE_SESSION_RUN_ID_PATH, "utf-8").trim();
  return fromFile || undefined;
}
