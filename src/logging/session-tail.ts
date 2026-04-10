import type { SessionEvent, SessionEventPayload } from "@github/copilot-sdk";
import { existsSync, readFileSync } from "fs";
import { getSessionLogPath } from "./session-log.js";

export const DEFAULT_SESSION_LOG_TAIL_LINES = 20;
const MAX_SHORT_CONTENT_LENGTH = 160;

type MessageContentEvent =
  | SessionEventPayload<"user.message">
  | SessionEventPayload<"assistant.message">
  | SessionEventPayload<"assistant.reasoning">;

type DeltaContentEvent =
  | SessionEventPayload<"assistant.message_delta">
  | SessionEventPayload<"assistant.reasoning_delta">;

type StatusMessageEvent =
  | SessionEventPayload<"session.error">
  | SessionEventPayload<"session.info">
  | SessionEventPayload<"session.warning">;

type TurnEvent =
  | SessionEventPayload<"assistant.turn_start">
  | SessionEventPayload<"assistant.turn_end">;

export interface SessionLogRecord {
  timestamp: string;
  runId: string;
  sessionId: string;
  agentName: string;
  agentType: string;
  event: SessionEvent;
}

export interface SessionLogTailEntry {
  timestamp: string;
  agent: string;
  type: string;
  shortContent: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function parseSessionLogRecord(line: string, lineNumber: number): SessionLogRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`Invalid JSON in session log at line ${lineNumber}.`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`Invalid session log record at line ${lineNumber}.`);
  }

  const {
    timestamp,
    runId,
    sessionId,
    agentName,
    agentType,
    event,
  } = parsed;

  if (
    typeof timestamp !== "string"
    || typeof runId !== "string"
    || typeof sessionId !== "string"
    || typeof agentName !== "string"
    || typeof agentType !== "string"
    || !isRecord(event)
    || typeof event.type !== "string"
  ) {
    throw new Error(`Invalid session log record at line ${lineNumber}.`);
  }

  return {
    timestamp,
    runId,
    sessionId,
    agentName,
    agentType,
    event: event as SessionEvent,
  };
}

function formatTimestamp(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.valueOf())) {
    return timestamp;
  }
  return parsed.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength = MAX_SHORT_CONTENT_LENGTH): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

function readTextField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function summarizeMessageContent(event: MessageContentEvent): string {
  return readTextField(event.data.content) ?? "(no content)";
}

function summarizeDeltaContent(event: DeltaContentEvent): string {
  return readTextField(event.data.deltaContent) ?? "(streaming update)";
}

function summarizeStatusMessage(event: StatusMessageEvent): string {
  return readTextField(event.data.message) ?? "(message)";
}

function summarizeTurnEvent(event: TurnEvent): string {
  const turnId = readTextField(event.data.turnId);

  if (event.type === "assistant.turn_start") {
    return turnId ? `turn ${turnId} started` : "turn started";
  }

  return turnId ? `turn ${turnId} ended` : "turn ended";
}

function formatToolExecutionComplete(event: SessionEventPayload<"tool.execution_complete">): string {
  const resultText =
    readTextField(event.data.result?.content)
    ?? readTextField(event.data.result?.detailedContent);
  const errorText = readTextField(event.data.error?.message);

  if (event.data.success) {
    return resultText ? `ok: ${resultText}` : "ok";
  }

  return errorText ? `failed: ${errorText}` : "failed";
}

function readFallbackEventText(event: SessionEvent): string | undefined {
  const data = isRecord(event.data) ? event.data as Record<string, unknown> : undefined;

  return data
    ? readTextField(data.message)
      ?? readTextField(data.content)
      ?? readTextField(data.deltaContent)
      ?? readTextField(data.intent)
      ?? readTextField(data.toolName)
      ?? readTextField(data.name)
      ?? readTextField(data.title)
      ?? readTextField(data.path)
    : undefined;
}

function summarizeEvent(event: SessionEvent): string {
  switch (event.type) {
    case "user.message":
    case "assistant.message":
    case "assistant.reasoning":
      return summarizeMessageContent(event);
    case "assistant.message_delta":
    case "assistant.reasoning_delta":
      return summarizeDeltaContent(event);
    case "assistant.intent":
      return readTextField(event.data.intent) ?? "(intent update)";
    case "session.error":
    case "session.info":
    case "session.warning":
      return summarizeStatusMessage(event);
    case "tool.execution_start":
      return readTextField(event.data.toolName) ?? "tool started";
    case "tool.execution_complete":
      return formatToolExecutionComplete(event);
    case "tool.execution_progress":
      return readTextField(event.data.progressMessage) ?? "(progress update)";
    case "tool.execution_partial_result":
      return readTextField(event.data.partialOutput) ?? "(partial result)";
    case "session.start":
      return "session started";
    case "session.resume":
      return "session resumed";
    case "session.idle":
      return event.data.aborted === true ? "idle (aborted)" : "idle";
    case "assistant.turn_start":
    case "assistant.turn_end":
      return summarizeTurnEvent(event);
    case "session.model_change":
      return readTextField(event.data.newModel) ?? "model changed";
    case "session.mode_changed":
      return readTextField(event.data.newMode) ?? "mode changed";
    case "session.plan_changed":
      return readTextField(event.data.operation) ?? "plan changed";
    case "session.workspace_file_changed":
      if (event.data.path && event.data.operation) {
        return `${event.data.operation} ${event.data.path}`;
      }
      return event.data.path ?? event.data.operation ?? "workspace file changed";
    case "skill.invoked":
      return readTextField(event.data.name) ?? "skill invoked";
    default:
      return readFallbackEventText(event) ?? "(no summary)";
  }
}

export function readSessionLogTail(runId: string, lineCount: number): SessionLogTailEntry[] {
  const filePath = getSessionLogPath(runId);
  if (!existsSync(filePath)) {
    throw new Error(`No session log found for run-id "${runId}" at ${filePath}.`);
  }

  const lines = readFileSync(filePath, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.slice(-lineCount).map((line, index, tailLines) => {
    const lineNumber = lines.length - tailLines.length + index + 1;
    const record = parseSessionLogRecord(line, lineNumber);
    const shortContent = truncate(collapseWhitespace(summarizeEvent(record.event)));

    return {
      timestamp: formatTimestamp(record.timestamp),
      agent: `${record.agentName} (${record.agentType})`,
      type: record.event.type,
      shortContent,
    };
  });
}

export function formatSessionLogTail(entries: SessionLogTailEntry[]): string {
  return `${entries
    .map((entry) => `${entry.timestamp}  ${entry.agent}  ${entry.type}  ${entry.shortContent}`)
    .join("\n")}\n`;
}
