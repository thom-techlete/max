import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";

/** Base directory for all Max user data: ~/.max */
export const MAX_HOME = join(homedir(), ".max");

/** Path to the SQLite database */
export const DB_PATH = join(MAX_HOME, "max.db");

/** Path to the user .env file */
export const ENV_PATH = join(MAX_HOME, ".env");

/** Path to user-local skills */
export const SKILLS_DIR = join(MAX_HOME, "skills");

/** Path to Max's isolated session state (keeps CLI history clean) */
export const SESSIONS_DIR = join(MAX_HOME, "sessions");

/** Path to persisted Copilot session event logs */
export const SESSION_LOGS_DIR = join(MAX_HOME, "session-logs");

/** Path to the current active orchestrator run-id */
export const ACTIVE_SESSION_RUN_ID_PATH = join(SESSION_LOGS_DIR, "current-run-id");

/** Path to TUI readline history */
export const HISTORY_PATH = join(MAX_HOME, "tui_history");

/** Path to optional TUI debug log */
export const TUI_DEBUG_LOG_PATH = join(MAX_HOME, "tui-debug.log");

/** Path to the API bearer token file */
export const API_TOKEN_PATH = join(MAX_HOME, "api-token");

/** Root of the LLM-maintained wiki knowledge base */
export const WIKI_DIR = join(MAX_HOME, "wiki");

/** Wiki pages (entity, concept, summary files) */
export const WIKI_PAGES_DIR = join(WIKI_DIR, "pages");

/** Raw ingested source documents (immutable) */
export const WIKI_SOURCES_DIR = join(WIKI_DIR, "sources");

/** Ensure ~/.max/ exists */
export function ensureMaxHome(): void {
  mkdirSync(MAX_HOME, { recursive: true });
}

/** Ensure ~/.max/session-logs/ exists */
export function ensureSessionLogsDir(): void {
  ensureMaxHome();
  mkdirSync(SESSION_LOGS_DIR, { recursive: true });
}
