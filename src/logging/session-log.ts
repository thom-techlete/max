import type { CopilotSession, SessionEvent } from "@github/copilot-sdk";
import { appendFileSync } from "fs";
import { join } from "path";
import { persistActiveSessionRunId } from "../config.js";
import { SESSION_LOGS_DIR, ensureSessionLogsDir } from "../paths.js";

export interface SessionLogMetadata {
  runId: string;
  sessionId: string;
  agentName: string;
  agentType: string;
}

export interface AttachedSessionLog extends SessionLogMetadata {
  filePath: string;
}

function sanitizeRunId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function getSessionLogPath(runId: string): string {
  return join(SESSION_LOGS_DIR, `${sanitizeRunId(runId)}.jsonl`);
}

function appendSessionEvent(metadata: SessionLogMetadata, event: SessionEvent): void {
  ensureSessionLogsDir();
  const record = {
    timestamp: new Date().toISOString(),
    runId: metadata.runId,
    sessionId: metadata.sessionId,
    agentName: metadata.agentName,
    agentType: metadata.agentType,
    event,
  };
  appendFileSync(getSessionLogPath(metadata.runId), `${JSON.stringify(record)}\n`, "utf-8");
}

export function attachSessionLog(
  session: CopilotSession,
  options: {
    agentName: string;
    agentType: string;
    markActive?: boolean;
  },
): AttachedSessionLog {
  const metadata: SessionLogMetadata = {
    runId: session.sessionId,
    sessionId: session.sessionId,
    agentName: options.agentName,
    agentType: options.agentType,
  };

  if (options.markActive) {
    persistActiveSessionRunId(metadata.runId);
  }

  session.on((event) => {
    try {
      appendSessionEvent(metadata, event);
    } catch {
      // Best-effort logging only — never break the live session on log write failures.
    }
  });

  return {
    ...metadata,
    filePath: getSessionLogPath(metadata.runId),
  };
}
