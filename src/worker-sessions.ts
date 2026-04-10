export interface WorkerSessionSummary {
  name: string;
  status: string;
  workingDir: string;
  model: string;
  agent: string;
  startedAt: string;
  lastActivityAt: string;
  currentTask: string;
}

export interface WorkerSessionLike {
  name: string;
  status: string;
  workingDir: string;
  model?: string;
  agent?: string;
  createdAt?: string | number | Date;
  lastActivityAt?: string | number | Date;
  currentTask?: string;
}

export type WorkerSessionOutputFormat = "cli" | "plain" | "telegram";

function normalizeDate(value: string | number | Date | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatTimestamp(value: string | number | Date | undefined): string {
  const date = normalizeDate(value);
  if (!date) {
    return "Unknown";
  }

  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`;
}

function summarizeTask(task: string | undefined): string {
  const normalized = task?.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "Waiting for prompt";
  }

  if (normalized.length <= 160) {
    return normalized;
  }

  return `${normalized.slice(0, 157)}...`;
}

export function toWorkerSessionSummary(worker: WorkerSessionLike): WorkerSessionSummary {
  return {
    name: worker.name,
    status: worker.status,
    workingDir: worker.workingDir,
    model: worker.model || "default",
    agent: worker.agent || "default",
    startedAt: formatTimestamp(worker.createdAt),
    lastActivityAt: formatTimestamp(worker.lastActivityAt ?? worker.createdAt),
    currentTask: summarizeTask(worker.currentTask),
  };
}

function formatSessionBlock(session: WorkerSessionSummary, format: WorkerSessionOutputFormat): string {
  const title = format === "telegram" ? `**${session.name}**` : session.name;
  const workingDir = format === "telegram" ? `\`${session.workingDir}\`` : session.workingDir;

  return [
    title,
    `  Status: ${session.status}`,
    `  Working directory: ${workingDir}`,
    `  Model: ${session.model}`,
    `  Agent/role: ${session.agent}`,
    `  Started: ${session.startedAt}`,
    `  Last activity: ${session.lastActivityAt}`,
    `  Current task: ${session.currentTask}`,
  ].join("\n");
}

export function formatSessionsOutput(
  sessions: WorkerSessionSummary[],
  format: WorkerSessionOutputFormat = "cli"
): string {
  if (sessions.length === 0) {
    return "No active worker sessions.\n";
  }

  const blocks = sessions.map((session) => formatSessionBlock(session, format));
  const output = `Active worker sessions (${sessions.length}):\n\n${blocks.join("\n\n")}`;

  return format === "telegram" ? output : `${output}\n`;
}
