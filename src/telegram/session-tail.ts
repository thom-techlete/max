import {
  DEFAULT_SESSION_LOG_TAIL_LINES,
  formatSessionLogTail,
  readSessionLogTail,
} from "../logging/session-tail.js";

const MAX_TAIL_LINES = 50;

export function buildSessionTailMessage(runId: string, requestedLines?: string): string {
  const trimmedRunId = runId.trim();
  if (!trimmedRunId) {
    return "Usage: /session-tail <run-id> [N]";
  }

  const lineCount = requestedLines?.trim()
    ? Number.parseInt(requestedLines.trim(), 10)
    : DEFAULT_SESSION_LOG_TAIL_LINES;

  if (!Number.isInteger(lineCount) || lineCount < 1) {
    return "Usage: /session-tail <run-id> [N]\nN must be a positive integer.";
  }

  const safeLineCount = Math.min(lineCount, MAX_TAIL_LINES);
  try {
    const entries = readSessionLogTail(trimmedRunId, safeLineCount);
    if (entries.length === 0) {
      return `No log entries found for run-id "${trimmedRunId}".`;
    }

    return [
      `Session tail for ${trimmedRunId} (${entries.length} line${entries.length === 1 ? "" : "s"}):`,
      "",
      formatSessionLogTail(entries).trimEnd(),
    ].join("\n");
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
