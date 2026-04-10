import { readFileSync } from "fs";

export interface WorkerSessionSummary {
  name: string;
  status: string;
  workingDir: string;
}

type FetchLike = (
  input: string | URL,
  init?: {
    headers?: Record<string, string>;
  }
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface SessionsCommandOptions {
  apiPort: number;
  tokenPath: string;
  fetchImpl?: FetchLike;
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
}

function readApiToken(tokenPath: string): string | undefined {
  try {
    const token = readFileSync(tokenPath, "utf-8").trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

function isWorkerSessionSummary(value: unknown): value is WorkerSessionSummary {
  if (!value || typeof value !== "object") return false;
  const session = value as Record<string, unknown>;
  return typeof session.name === "string"
    && typeof session.status === "string"
    && typeof session.workingDir === "string";
}

function isWorkerSessionSummaryList(value: unknown): value is WorkerSessionSummary[] {
  return Array.isArray(value) && value.every(isWorkerSessionSummary);
}

export function formatSessionsOutput(sessions: WorkerSessionSummary[]): string {
  if (sessions.length === 0) {
    return "No active worker sessions.\n";
  }

  const nameWidth = Math.max("NAME".length, ...sessions.map((session) => session.name.length));
  const statusWidth = Math.max("STATUS".length, ...sessions.map((session) => session.status.length));
  const header = `${"NAME".padEnd(nameWidth)}  ${"STATUS".padEnd(statusWidth)}  WORKING DIRECTORY`;
  const divider = `${"-".repeat(nameWidth)}  ${"-".repeat(statusWidth)}  -----------------`;
  const rows = sessions.map((session) =>
    `${session.name.padEnd(nameWidth)}  ${session.status.padEnd(statusWidth)}  ${session.workingDir}`
  );

  return `${[header, divider, ...rows].join("\n")}\n`;
}

export async function fetchActiveSessions(
  apiPort: number,
  tokenPath: string,
  fetchImpl: FetchLike = fetch
): Promise<WorkerSessionSummary[]> {
  const headers: Record<string, string> = {};
  const token = readApiToken(tokenPath);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(`http://127.0.0.1:${apiPort}/sessions`, { headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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

  const payload = await response.json();
  if (!isWorkerSessionSummaryList(payload)) {
    throw new Error("The Max daemon returned an invalid worker session payload.");
  }

  return payload;
}

export async function runSessionsCommand(options: SessionsCommandOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  try {
    const sessions = await fetchActiveSessions(
      options.apiPort,
      options.tokenPath,
      options.fetchImpl
    );
    stdout.write(formatSessionsOutput(sessions));
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`${message}\n`);
    return 1;
  }
}
