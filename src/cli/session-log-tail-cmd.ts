import {
  DEFAULT_SESSION_LOG_TAIL_LINES,
  formatSessionLogTail,
  readSessionLogTail,
} from "../logging/session-tail.js";

class SessionLogTailUsageError extends Error {}

export interface SessionLogTailCommandOptions {
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
}

function buildUsageText(): string {
  return "Usage: max session-log-tail <run-id> [--lines N]";
}

function parseLineCount(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new SessionLogTailUsageError(`Invalid value for --lines: ${value}`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new SessionLogTailUsageError(`Invalid value for --lines: ${value}`);
  }

  return parsed;
}

function parseArgs(args: string[]): { runId: string; lineCount: number } {
  let runId: string | undefined;
  let lineCount = DEFAULT_SESSION_LOG_TAIL_LINES;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--lines") {
      const value = args[index + 1];
      if (!value) {
        throw new SessionLogTailUsageError("Missing value for --lines.");
      }
      lineCount = parseLineCount(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--lines=")) {
      lineCount = parseLineCount(arg.slice("--lines=".length));
      continue;
    }

    if (arg.startsWith("-")) {
      throw new SessionLogTailUsageError(`Unknown flag: ${arg}`);
    }

    if (runId) {
      throw new SessionLogTailUsageError(`Unexpected argument: ${arg}`);
    }

    runId = arg;
  }

  if (!runId) {
    throw new SessionLogTailUsageError("Missing required run-id.");
  }

  return { runId, lineCount };
}

export async function runSessionLogTailCommand(
  args: string[],
  options: SessionLogTailCommandOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  if (args.includes("--help") || args.includes("-h")) {
    stdout.write(`${buildUsageText()}\n`);
    return 0;
  }

  try {
    const { runId, lineCount } = parseArgs(args);
    const entries = readSessionLogTail(runId, lineCount);

    if (entries.length === 0) {
      stdout.write(`No log entries found for run-id "${runId}".\n`);
      return 0;
    }

    stdout.write(formatSessionLogTail(entries));
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`${message}\n`);
    if (err instanceof SessionLogTailUsageError) {
      stderr.write(`${buildUsageText()}\n`);
    }
    return 1;
  }
}
