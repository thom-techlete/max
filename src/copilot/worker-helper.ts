import {
  approveAll,
  type CopilotClient,
  type CopilotSession,
  type CustomAgentConfig,
  type SessionConfig,
} from "@github/copilot-sdk";
import { readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, resolve, sep } from "path";
import { homedir } from "os";
import { config } from "../config.js";
import { attachSessionLog } from "../logging/session-log.js";
import { SESSIONS_DIR } from "../paths.js";
import { getDb } from "../store/db.js";

function isTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|timed?\s*out/i.test(msg);
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function formatWorkerError(workerName: string, startedAt: number, timeoutMs: number, err: unknown): string {
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  const limit = Math.round(timeoutMs / 1000);
  const msg = formatError(err);

  if (isTimeoutError(err)) {
    return `Worker '${workerName}' timed out after ${elapsed}s (limit: ${limit}s). The task was still running but had to be stopped. To allow more time, set WORKER_TIMEOUT=${timeoutMs * 2} in ~/.max/.env`;
  }
  return `Worker '${workerName}' failed after ${elapsed}s: ${msg}`;
}

export function logWorker(message: string): void {
  console.log(`[max][worker] ${message}`);
}

export interface WorkerInfo {
  name: string;
  session: CopilotSession;
  workingDir: string;
  status: "idle" | "running" | "error";
  model: string;
  agent: string;
  lastOutput?: string;
  currentTask?: string;
  createdAt: number;
  lastActivityAt: number;
  /** Timestamp (ms) when the worker started its current task. */
  startedAt?: number;
  /** Channel that created this worker — completions route back here. */
  originChannel?: "telegram" | "tui";
}

export interface CreateWorkerSessionInput {
  name: string;
  workingDir: string;
  initialPrompt?: string;
  model?: string;
  skillDirectories?: string[];
}

export interface CreateWorkerSessionDeps {
  client: CopilotClient;
  workers: Map<string, WorkerInfo>;
  onWorkerComplete: (name: string, result: string) => void;
  originChannel?: WorkerInfo["originChannel"];
  logWorker: (message: string) => void;
}

export type CreateWorkerSessionResult =
  | {
      created: false;
      message: string;
    }
  | {
      created: true;
      message: string;
      worker: WorkerInfo;
      sessionId: string;
      dispatchedInitialPrompt: boolean;
    };

type NamedAgent = Pick<CustomAgentConfig, "name" | "displayName">;

const BLOCKED_WORKER_DIRS = [
  ".ssh", ".gnupg", ".aws", ".azure", ".config/gcloud",
  ".kube", ".docker", ".npmrc", ".pypirc",
];

const MAX_CONCURRENT_WORKERS = 5;

function isNamedAgent(value: unknown): value is CustomAgentConfig {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { name?: unknown };
  return typeof candidate.name === "string" && candidate.name.length > 0;
}

function tryLoadCustomAgent(
  jsonPath: string,
  customAgents: CustomAgentConfig[],
  skillDirs: string[],
  workerLog: (message: string) => void,
): void {
  try {
    const raw = readFileSync(jsonPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isNamedAgent(parsed)) {
      workerLog(`skipping agent definition without a name: ${jsonPath}`);
      return;
    }

    customAgents.push(parsed);
    const dir = dirname(jsonPath);
    if (!skillDirs.includes(dir)) {
      skillDirs.push(dir);
    }
  } catch (err) {
    workerLog(`skipping unreadable agent definition '${jsonPath}': ${formatError(err)}`);
  }
}

function selectCustomAgent(agentName: string, customAgents: NamedAgent[]): NamedAgent | undefined {
  const wanted = agentName.trim().toLowerCase();
  return customAgents.find((agent) =>
    String(agent.name || "").toLowerCase() === wanted ||
    String(agent.displayName || "").toLowerCase() === wanted
  );
}

function discoverAgentsFolder(resolvedDir: string, workerLog: (message: string) => void): string | null {
  let current = resolvedDir;

  while (current !== sep) {
    const potentialPath = join(current, "agents");
    try {
      if (statSync(potentialPath).isDirectory()) {
        return potentialPath;
      }
    } catch (err) {
      workerLog(`agents folder check skipped for '${potentialPath}': ${formatError(err)}`);
    }

    current = dirname(current);
  }

  return null;
}

function discoverCustomAgents(
  resolvedDir: string,
  providedSkillDirectories: string[] | undefined,
  workerLog: (message: string) => void,
): {
  agentsFolderPath: string | null;
  customAgents: CustomAgentConfig[];
  skillDirs: string[];
} {
  const skillDirs = Array.isArray(providedSkillDirectories) ? [...providedSkillDirectories] : [];
  workerLog(`initial skillDirs count=${skillDirs.length}`);

  const agentsFolderPath = discoverAgentsFolder(resolvedDir, workerLog);
  const customAgents: CustomAgentConfig[] = [];
  const agentSearchPaths = new Set<string>();

  if (agentsFolderPath) {
    agentSearchPaths.add(agentsFolderPath);
  }

  for (const dir of skillDirs) {
    agentSearchPaths.add(dir);
  }

  for (const root of agentSearchPaths) {
    try {
      const stat = statSync(root);
      if (!stat.isDirectory()) {
        continue;
      }

      tryLoadCustomAgent(join(root, "agent.json"), customAgents, skillDirs, workerLog);

      const entries = readdirSync(root);
      for (const entry of entries) {
        const entryPath = join(root, entry);
        try {
          const entryStat = statSync(entryPath);
          if (entryStat.isDirectory()) {
            tryLoadCustomAgent(join(entryPath, "agent.json"), customAgents, skillDirs, workerLog);
          } else if (entry.endsWith(".agent.json")) {
            tryLoadCustomAgent(entryPath, customAgents, skillDirs, workerLog);
          }
        } catch (err) {
          workerLog(`skipping agent search entry '${entryPath}': ${formatError(err)}`);
        }
      }
    } catch (err) {
      workerLog(`skipping unreadable agent search root '${root}': ${formatError(err)}`);
    }
  }

  return { agentsFolderPath, customAgents, skillDirs };
}

export async function createWorkerSession(
  input: CreateWorkerSessionInput,
  deps: CreateWorkerSessionDeps,
): Promise<CreateWorkerSessionResult> {
  if (deps.workers.has(input.name)) {
    return {
      created: false,
      message: `Worker '${input.name}' already exists. Use send_to_worker to interact with it.`,
    };
  }

  const home = homedir();
  const resolvedDir = resolve(input.workingDir);
  for (const blocked of BLOCKED_WORKER_DIRS) {
    const blockedPath = join(home, blocked);
    if (resolvedDir === blockedPath || resolvedDir.startsWith(blockedPath + sep)) {
      return {
        created: false,
        message: `Refused: '${input.workingDir}' is a sensitive directory. Workers cannot operate in ${blocked}.`,
      };
    }
  }

  if (deps.workers.size >= MAX_CONCURRENT_WORKERS) {
    const names = Array.from(deps.workers.keys()).join(", ");
    return {
      created: false,
      message: `Worker limit reached (${MAX_CONCURRENT_WORKERS}). Active: ${names}. Kill a session first.`,
    };
  }

  const { agentsFolderPath, customAgents, skillDirs } = discoverCustomAgents(
    resolvedDir,
    input.skillDirectories,
    deps.logWorker,
  );

  if (agentsFolderPath) {
    deps.logWorker(`found agents folder at ${agentsFolderPath}`);
  }
  deps.logWorker(`discovered customAgents=${customAgents.length}`);

  const sessionModel = input.model || config.copilotModel;
  const orchestratorAgent = selectCustomAgent("orchestrator", customAgents);
  const workerAgent = orchestratorAgent ? "orchestrator" : customAgents.length > 0 ? "custom" : "default";
  const createdAt = Date.now();

  const sessionOptions: SessionConfig = {
    model: sessionModel,
    configDir: SESSIONS_DIR,
    workingDirectory: input.workingDir,
    skillDirectories: skillDirs.length > 0 ? skillDirs : undefined,
    customAgents: customAgents.length > 0 ? customAgents : undefined,
    onPermissionRequest: approveAll,
  };
  if (orchestratorAgent) {
    sessionOptions.agent = "orchestrator";
  }

  deps.logWorker(
    `creating session: model=${sessionModel}, workingDirectory=${input.workingDir}, skillDirectories=${skillDirs.length}, customAgents=${customAgents.length}, agent=${sessionOptions.agent ?? "(default)"}`,
  );

  let session: CopilotSession;
  try {
    session = await deps.client.createSession(sessionOptions);
    deps.logWorker(`create_session succeeded: ${session.sessionId}`);
    attachSessionLog(session, {
      agentName: input.name,
      agentType: workerAgent,
    });
  } catch (err) {
    deps.logWorker(`create_session failed: ${formatError(err)}`);
    throw err;
  }

  const worker: WorkerInfo = {
    name: input.name,
    session,
    workingDir: input.workingDir,
    status: "idle",
    model: sessionModel,
    agent: workerAgent,
    createdAt,
    lastActivityAt: createdAt,
    originChannel: deps.originChannel,
  };
  deps.workers.set(input.name, worker);

  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO worker_sessions (name, copilot_session_id, working_dir, status)
     VALUES (?, ?, ?, 'idle')`
  ).run(input.name, session.sessionId, input.workingDir);

  if (!input.initialPrompt) {
    return {
      created: true,
      message: `Worker '${input.name}' created in ${input.workingDir}. Use send_to_worker to send it prompts.`,
      worker,
      sessionId: session.sessionId,
      dispatchedInitialPrompt: false,
    };
  }

  worker.status = "running";
  worker.startedAt = Date.now();
  worker.lastActivityAt = worker.startedAt;
  worker.currentTask = input.initialPrompt;
  db.prepare(
    `UPDATE worker_sessions SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE name = ?`
  ).run(input.name);

  const timeoutMs = config.workerTimeoutMs;
  const promptPayload: { prompt: string; skillDirectories?: string[] } = {
    prompt: `Working directory: ${input.workingDir}\n\n${input.initialPrompt}`,
  };
  if (Array.isArray(input.skillDirectories)) {
    promptPayload.skillDirectories = input.skillDirectories;
  }

  deps.logWorker(`dispatching initial prompt to worker '${input.name}', timeoutMs=${timeoutMs}`);

  session.sendAndWait(promptPayload, timeoutMs).then((result) => {
    worker.lastOutput = result?.data?.content || "No response";
    deps.logWorker(`worker '${input.name}' completed initial prompt successfully`);
    deps.onWorkerComplete(input.name, worker.lastOutput);
  }).catch((err) => {
    const errMsg = formatWorkerError(input.name, worker.startedAt!, timeoutMs, err);
    worker.lastOutput = errMsg;
    deps.logWorker(`worker '${input.name}' failed initial prompt: ${errMsg}`);
    deps.onWorkerComplete(input.name, errMsg);
  }).finally(() => {
    void session.disconnect().catch((err) => {
      deps.logWorker(`worker '${input.name}' disconnect failed: ${formatError(err)}`);
    });
    deps.workers.delete(input.name);
    getDb().prepare(`DELETE FROM worker_sessions WHERE name = ?`).run(input.name);
  });

  return {
    created: true,
    message: `Worker '${input.name}' created in ${input.workingDir}. Task dispatched — I'll notify you when it's done.`,
    worker,
    sessionId: session.sessionId,
    dispatchedInitialPrompt: true,
  };
}
