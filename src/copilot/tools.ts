import { z } from "zod";
import {
  approveAll,
  defineTool,
  type CopilotClient,
  type CopilotSession,
  type Tool,
} from "@github/copilot-sdk";
import { getDb, addMemory, searchMemories, removeMemory } from "../store/db.js";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, sep, resolve, dirname } from "path";
import { homedir } from "os";
import { listSkills, createSkill, removeSkill } from "./skills.js";
import { config, persistModel } from "../config.js";
import { SESSIONS_DIR } from "../paths.js";
import { getCurrentSourceChannel, switchSessionModel } from "./orchestrator.js";
import { getRouterConfig, updateRouterConfig } from "./router.js";
import { formatSessionsOutput, toWorkerSessionSummary } from "../worker-sessions.js";
import { ensureWikiStructure, readPage, writePage, deletePage, listPages, writeRawSource, listSources, getWikiDir } from "../wiki/fs.js";
import { searchIndex, addToIndex, removeFromIndex, parseIndex, type IndexEntry } from "../wiki/index-manager.js";
import { appendLog } from "../wiki/log-manager.js";

function isTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|timed?\s*out/i.test(msg);
}

function formatWorkerError(workerName: string, startedAt: number, timeoutMs: number, err: unknown): string {
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  const limit = Math.round(timeoutMs / 1000);
  const msg = err instanceof Error ? err.message : String(err);

  if (isTimeoutError(err)) {
    return `Worker '${workerName}' timed out after ${elapsed}s (limit: ${limit}s). The task was still running but had to be stopped. To allow more time, set WORKER_TIMEOUT=${timeoutMs * 2} in ~/.max/.env`;
  }
  return `Worker '${workerName}' failed after ${elapsed}s: ${msg}`;
}

const BLOCKED_WORKER_DIRS = [
  ".ssh", ".gnupg", ".aws", ".azure", ".config/gcloud",
  ".kube", ".docker", ".npmrc", ".pypirc",
];

const MAX_CONCURRENT_WORKERS = 5;

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

export interface ToolDeps {
  client: CopilotClient;
  workers: Map<string, WorkerInfo>;
  onWorkerComplete: (name: string, result: string) => void;
}

type NamedAgent = {
  name?: string;
  displayName?: string;
};

function selectCustomAgent(agentName: string | undefined, customAgents: NamedAgent[]): NamedAgent | undefined {
  if (!agentName) {
    return undefined;
  }

  const wanted = agentName.trim().toLowerCase();
  return customAgents.find((agent) =>
    agent.name?.toLowerCase() === wanted || agent.displayName?.toLowerCase() === wanted
  );
}

export function createTools(deps: ToolDeps): Tool<any>[] {
  return [
    defineTool("create_worker_session", {
      description:
        "Create a new Copilot CLI worker session in a specific directory. " +
        "Use for coding tasks, debugging, file operations. " +
        "Returns confirmation with session name.",
      parameters: z.object({
        name: z.string().describe("Short descriptive name for the session, e.g. 'auth-fix'"),
        working_dir: z.string().describe("Absolute path to the directory to work in"),
        initial_prompt: z.string().optional().describe("Optional initial prompt to send to the worker"),
        model: z.string().optional().describe("Model to use for the worker session"),
        skill_directories: z.array(z.string()).optional().describe("Optional array of skill directory paths to load into the worker session"),
      }),
      handler: async (args) => {
        if (deps.workers.has(args.name)) {
          return `Worker '${args.name}' already exists. Use send_to_worker to interact with it.`;
        }

        const home = homedir();
        const resolvedDir = resolve(args.working_dir);
        for (const blocked of BLOCKED_WORKER_DIRS) {
          const blockedPath = join(home, blocked);
          if (resolvedDir === blockedPath || resolvedDir.startsWith(blockedPath + sep)) {
            return `Refused: '${args.working_dir}' is a sensitive directory. Workers cannot operate in ${blocked}.`;
          }
        }

        if (deps.workers.size >= MAX_CONCURRENT_WORKERS) {
          const names = Array.from(deps.workers.keys()).join(", ");
          return `Worker limit reached (${MAX_CONCURRENT_WORKERS}). Active: ${names}. Kill a session first.`;
        }

        const skillDirs: string[] = Array.isArray(args.skill_directories) ? [...args.skill_directories] : [];

        // Load agents from agents/ folder in the working directory or parent directories
        let agentsFolderPath: string | null = null;
        let current = resolvedDir;
        while (current !== sep) {
          const potentialPath = join(current, "agents");
          try {
            if (statSync(potentialPath).isDirectory()) {
              agentsFolderPath = potentialPath;
              break;
            }
          } catch {}
          current = dirname(current);
        }

        // Load all agents from agents/ by reading their agent.json files
        const customAgents: any[] = [];
        if (agentsFolderPath) {
          try {
            const agentDirs = readdirSync(agentsFolderPath);
            for (const agentFile of agentDirs) {
              const agentPath = join(agentsFolderPath, agentFile);
              try {
                // Handle both agent directories and agent.json files
                const stat = statSync(agentPath);
                let jsonPath: string | null = null;

                if (stat.isDirectory()) {
                  // Look for agent.json inside the directory
                  jsonPath = join(agentPath, "agent.json");
                } else if (agentFile.endsWith(".agent.json")) {
                  // Direct agent.json file
                  jsonPath = agentPath;
                }

                if (jsonPath) {
                  try {
                    const raw = readFileSync(jsonPath, "utf-8");
                    const parsed = JSON.parse(raw);
                    if (parsed.name) {
                      customAgents.push(parsed);
                      // Add agent dir to skillDirs if it's a directory
                      if (stat.isDirectory() && !skillDirs.includes(agentPath)) {
                        skillDirs.push(agentPath);
                      }
                    }
                  } catch {
                    // Skip invalid JSON files
                  }
                }
              } catch {
                // Skip unreadable files
              }
            }
          } catch {
            // agents/ exists but can't be read
          }
        }

        const sessionModel = args.model || config.copilotModel;
        const availableCustomAgents = customAgents;
        const workerAgent = "orchestrator"
        const createdAt = Date.now();

        const session = await deps.client.createSession({
          model: sessionModel,
          configDir: SESSIONS_DIR,
          workingDirectory: args.working_dir,
          skillDirectories: skillDirs.length ? skillDirs : undefined,
          customAgents: availableCustomAgents,
          agent: workerAgent,
          onPermissionRequest: approveAll,
        });

        const worker: WorkerInfo = {
          name: args.name,
          session,
          workingDir: args.working_dir,
          status: "idle",
          model: sessionModel,
          agent: workerAgent,
          createdAt,
          lastActivityAt: createdAt,
          originChannel: getCurrentSourceChannel(),
        };
        deps.workers.set(args.name, worker);

        // Persist to SQLite
        const db = getDb();
        db.prepare(
          `INSERT OR REPLACE INTO worker_sessions (name, copilot_session_id, working_dir, status)
           VALUES (?, ?, ?, 'idle')`
        ).run(args.name, session.sessionId, args.working_dir);

        if (args.initial_prompt) {
          worker.status = "running";
          worker.startedAt = Date.now();
          worker.lastActivityAt = worker.startedAt;
          worker.currentTask = args.initial_prompt;
          db.prepare(
            `UPDATE worker_sessions SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE name = ?`
          ).run(args.name);

          const timeoutMs = config.workerTimeoutMs;
          // Non-blocking: dispatch work and return immediately
          const promptPayload: any = { prompt: `Working directory: ${args.working_dir}\n\n${args.initial_prompt}` };
          if (args.skill_directories && Array.isArray(args.skill_directories)) {
            promptPayload.skillDirectories = args.skill_directories;
          }

          session.sendAndWait(promptPayload, timeoutMs).then((result) => {
            worker.lastOutput = result?.data?.content || "No response";
            deps.onWorkerComplete(args.name, worker.lastOutput);
          }).catch((err) => {
            const errMsg = formatWorkerError(args.name, worker.startedAt!, timeoutMs, err);
            worker.lastOutput = errMsg;
            deps.onWorkerComplete(args.name, errMsg);
          }).finally(() => {
            // Auto-destroy background workers after completion to free memory (~400MB per worker)
            session.destroy().catch(() => {});
            deps.workers.delete(args.name);
            getDb().prepare(`DELETE FROM worker_sessions WHERE name = ?`).run(args.name);
          });

          return `Worker '${args.name}' created in ${args.working_dir}. Task dispatched — I'll notify you when it's done.`;
        }

        return `Worker '${args.name}' created in ${args.working_dir}. Use send_to_worker to send it prompts.`;
      },
    }),

    defineTool("send_to_worker", {
      description:
        "Send a prompt to an existing worker session and wait for its response. " +
        "Use for follow-up instructions or questions about ongoing work.",
      parameters: z.object({
        name: z.string().describe("Name of the worker session"),
        prompt: z.string().describe("The prompt to send"),
      }),
      handler: async (args) => {
        const worker = deps.workers.get(args.name);
        if (!worker) {
          return `No worker named '${args.name}'. Use list_sessions to see available workers.`;
        }
        if (worker.status === "running") {
          return `Worker '${args.name}' is currently busy. Wait for it to finish or kill it.`;
        }

        worker.status = "running";
        worker.startedAt = Date.now();
        worker.lastActivityAt = worker.startedAt;
        worker.currentTask = args.prompt;
        const db = getDb();
        db.prepare(`UPDATE worker_sessions SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE name = ?`).run(
          args.name
        );

        const timeoutMs = config.workerTimeoutMs;
        // Non-blocking: dispatch work and return immediately
        worker.session.sendAndWait({ prompt: args.prompt }, timeoutMs).then((result) => {
          worker.lastOutput = result?.data?.content || "No response";
          deps.onWorkerComplete(args.name, worker.lastOutput);
        }).catch((err) => {
          const errMsg = formatWorkerError(args.name, worker.startedAt!, timeoutMs, err);
          worker.lastOutput = errMsg;
          deps.onWorkerComplete(args.name, errMsg);
        }).finally(() => {
          // Auto-destroy after each send_to_worker dispatch to free memory
          worker.session.destroy().catch(() => {});
          deps.workers.delete(args.name);
          getDb().prepare(`DELETE FROM worker_sessions WHERE name = ?`).run(args.name);
        });

        return `Task dispatched to worker '${args.name}'. I'll notify you when it's done.`;
      },
    }),

    defineTool("list_sessions", {
      description:
        "List all active worker sessions with their name, status, working directory, model, role, timing, and current task.",
      parameters: z.object({}),
      handler: async () => {
        if (deps.workers.size === 0) {
          return "No active worker sessions.";
        }
        return formatSessionsOutput(
          Array.from(deps.workers.values()).map((worker) => toWorkerSessionSummary(worker)),
          "plain"
        ).trimEnd();
      },
    }),

    defineTool("check_session_status", {
      description: "Get detailed status of a specific worker session, including its last output.",
      parameters: z.object({
        name: z.string().describe("Name of the worker session"),
      }),
      handler: async (args) => {
        const worker = deps.workers.get(args.name);
        if (!worker) {
          return `No worker named '${args.name}'.`;
        }
        const summary = formatSessionsOutput([toWorkerSessionSummary(worker)], "plain").trimEnd();
        const output = worker.lastOutput
          ? `\n\nLast output:\n${worker.lastOutput.slice(0, 2000)}`
          : "";
        return `${summary}${output}`;
      },
    }),

    defineTool("kill_session", {
      description: "Terminate a worker session and free its resources.",
      parameters: z.object({
        name: z.string().describe("Name of the worker session to kill"),
      }),
      handler: async (args) => {
        const worker = deps.workers.get(args.name);
        if (!worker) {
          return `No worker named '${args.name}'.`;
        }
        try {
          await worker.session.destroy();
        } catch {
          // Session may already be gone
        }
        deps.workers.delete(args.name);

        const db = getDb();
        db.prepare(`DELETE FROM worker_sessions WHERE name = ?`).run(args.name);

        return `Worker '${args.name}' terminated.`;
      },
    }),

    defineTool("list_machine_sessions", {
      description:
        "List ALL Copilot CLI sessions on this machine — including sessions started from VS Code, " +
        "the terminal, or other tools. Shows session ID, summary, working directory. " +
        "Use this when the user asks about existing sessions running on the machine. " +
        "By default shows the 20 most recently active sessions.",
      parameters: z.object({
        cwd_filter: z.string().optional().describe("Optional: only show sessions whose working directory contains this string"),
        limit: z.number().int().min(1).max(100).optional().describe("Max sessions to return (default 20)"),
      }),
      handler: async (args) => {
        const sessionStateDir = join(homedir(), ".copilot", "session-state");
        const limit = args.limit || 20;

        let entries: { id: string; cwd: string; summary: string; updatedAt: Date }[] = [];

        try {
          const dirs = readdirSync(sessionStateDir);
          for (const dir of dirs) {
            const yamlPath = join(sessionStateDir, dir, "workspace.yaml");
            try {
              const content = readFileSync(yamlPath, "utf-8");
              const parsed = parseSimpleYaml(content);
              if (args.cwd_filter && !parsed.cwd?.includes(args.cwd_filter)) continue;
              entries.push({
                id: parsed.id || dir,
                cwd: parsed.cwd || "unknown",
                summary: parsed.summary || "",
                updatedAt: parsed.updated_at ? new Date(parsed.updated_at) : new Date(0),
              });
            } catch {
              // Skip dirs without valid workspace.yaml
            }
          }
        } catch (err: unknown) {
          if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
            return "No Copilot sessions found on this machine (session state directory does not exist yet).";
          }
          return "Could not read session state directory.";
        }

        // Sort by most recently updated
        entries.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        entries = entries.slice(0, limit);

        if (entries.length === 0) {
          return "No Copilot sessions found on this machine.";
        }

        const lines = entries.map((s) => {
          const age = formatAge(s.updatedAt);
          const summary = s.summary ? ` — ${s.summary}` : "";
          return `• ID: ${s.id}\n  ${s.cwd} (${age})${summary}`;
        });

        return `Found ${entries.length} session(s) (most recent first):\n${lines.join("\n")}`;
      },
    }),

    defineTool("attach_machine_session", {
      description:
        "Attach to an existing Copilot CLI session on this machine (e.g. one started from VS Code or terminal). " +
        "Resumes the session and adds it as a managed worker so you can send prompts to it.",
      parameters: z.object({
        session_id: z.string().describe("The session ID to attach to (from list_machine_sessions)"),
        name: z.string().describe("A short name to reference this session by, e.g. 'vscode-main'"),
      }),
      handler: async (args) => {
        if (deps.workers.has(args.name)) {
          return `A worker named '${args.name}' already exists. Choose a different name.`;
        }

        try {
          const session = await deps.client.resumeSession(args.session_id, {
            model: config.copilotModel,
            onPermissionRequest: approveAll,
          });

          const worker: WorkerInfo = {
            name: args.name,
            session,
            workingDir: "(attached)",
            status: "idle",
            model: config.copilotModel,
            agent: "attached",
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
            originChannel: getCurrentSourceChannel(),
          };
          deps.workers.set(args.name, worker);

          const db = getDb();
          db.prepare(
            `INSERT OR REPLACE INTO worker_sessions (name, copilot_session_id, working_dir, status)
             VALUES (?, ?, '(attached)', 'idle')`
          ).run(args.name, args.session_id);

          return `Attached to session ${args.session_id.slice(0, 8)}… as worker '${args.name}'. You can now send_to_worker to interact with it.`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Failed to attach to session: ${msg}`;
        }
      },
    }),

    defineTool("list_skills", {
      description:
        "List all available skills that Max knows. Skills are instruction documents that teach Max " +
        "how to use external tools and services (e.g. Gmail, browser automation, YouTube transcripts). " +
        "Shows skill name, description, and whether it's a local or global skill.",
      parameters: z.object({}),
      handler: async () => {
        const skills = listSkills();
        if (skills.length === 0) {
          return "No skills installed yet. Use learn_skill to teach me something new.";
        }
        const lines = skills.map(
          (s) => `• ${s.name} (${s.source}) — ${s.description}`
        );
        return `Available skills (${skills.length}):\n${lines.join("\n")}`;
      },
    }),

    defineTool("learn_skill", {
      description:
        "Teach Max a new skill by creating a SKILL.md instruction file. Use this when the user asks Max " +
        "to do something it doesn't know how to do yet (e.g. 'check my email', 'search the web'). " +
        "First, use a worker session to research what CLI tools are available on the system (run 'which', " +
        "'--help', etc.), then create the skill with the instructions you've learned. " +
        "The skill becomes available on the next message (no restart needed).",
      parameters: z.object({
        slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).describe("Short kebab-case identifier for the skill, e.g. 'gmail', 'web-search'"),
        name: z.string().refine(s => !s.includes('\n'), "must be single-line").describe("Human-readable name for the skill, e.g. 'Gmail', 'Web Search'"),
        description: z.string().refine(s => !s.includes('\n'), "must be single-line").describe("One-line description of when to use this skill"),
        instructions: z.string().describe(
          "Markdown instructions for how to use the skill. Include: what CLI tool to use, " +
          "common commands with examples, authentication steps if needed, tips and gotchas. " +
          "This becomes the SKILL.md content body."
        ),
      }),
      handler: async (args) => {
        return createSkill(args.slug, args.name, args.description, args.instructions);
      },
    }),

    defineTool("uninstall_skill", {
      description:
        "Remove a skill from Max's local skills directory (~/.max/skills/). " +
        "The skill will no longer be available on the next message. " +
        "Only works for local skills — bundled and global skills cannot be removed this way.",
      parameters: z.object({
        slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).describe("The kebab-case slug of the skill to remove, e.g. 'gmail', 'web-search'"),
      }),
      handler: async (args) => {
        const result = removeSkill(args.slug);
        return result.message;
      },
    }),

    defineTool("list_models", {
      description:
        "List all available Copilot models. Shows model id, name, and billing tier. " +
        "Marks the currently active model. Use when the user asks what models are available " +
        "or wants to know which model is in use.",
      parameters: z.object({}),
      handler: async () => {
        try {
          const models = await deps.client.listModels();
          if (models.length === 0) {
            return "No models available.";
          }
          const current = config.copilotModel;
          const lines = models.map((m) => {
            const active = m.id === current ? " ← active" : "";
            const billing = m.billing ? ` (${m.billing.multiplier}x)` : "";
            return `• ${m.id}${billing}${active}`;
          });
          return `Available models (${models.length}):\n${lines.join("\n")}\n\nCurrent: ${current}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Failed to list models: ${msg}`;
        }
      },
    }),

    defineTool("switch_model", {
      description:
        "Switch the Copilot model Max uses for conversations. Takes effect on the next message. " +
        "The change is persisted across restarts. Use when the user asks to change or switch models.",
      parameters: z.object({
        model_id: z.string().describe("The model id to switch to (from list_models)"),
      }),
      handler: async (args) => {
        try {
          const models = await deps.client.listModels();
          const match = models.find((m) => m.id === args.model_id);
          if (!match) {
            const suggestions = models
              .filter((m) => m.id.includes(args.model_id) || m.id.toLowerCase().includes(args.model_id.toLowerCase()))
              .map((m) => m.id);
            const hint = suggestions.length > 0
              ? ` Did you mean: ${suggestions.join(", ")}?`
              : " Use list_models to see available options.";
            return `Model '${args.model_id}' not found.${hint}`;
          }

          const previous = config.copilotModel;
          config.copilotModel = args.model_id;
          persistModel(args.model_id);

          // Apply model change to the live session immediately
          try {
            await switchSessionModel(args.model_id);
          } catch (err) {
            console.log(`[max] setModel() failed during switch_model (will apply on next session): ${err instanceof Error ? err.message : err}`);
          }

          // Disable router when manually switching — user has explicit preference
          if (getRouterConfig().enabled) {
            updateRouterConfig({ enabled: false });
            return `Switched model from '${previous}' to '${args.model_id}'. Auto-routing disabled (use /auto or toggle_auto to re-enable).`;
          }

          return `Switched model from '${previous}' to '${args.model_id}'.`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Failed to switch model: ${msg}`;
        }
      },
    }),

    defineTool("toggle_auto", {
      description:
        "Enable or disable automatic model routing (auto mode). When enabled, Max automatically picks " +
        "the best model (fast/standard/premium) for each message to save cost and optimize speed. " +
        "Use when the user asks to turn auto-routing on or off.",
      parameters: z.object({
        enabled: z.boolean().describe("true to enable auto-routing, false to disable"),
      }),
      handler: async (args) => {
        const updated = updateRouterConfig({ enabled: args.enabled });
        if (args.enabled) {
          const tiers = updated.tierModels;
          return `Auto-routing enabled. Tier models:\n• fast: ${tiers.fast}\n• standard: ${tiers.standard}\n• premium: ${tiers.premium}\n\nMax will automatically pick the best model for each message.`;
        }
        return `Auto-routing disabled. Using fixed model: ${config.copilotModel}`;
      },
    }),

    // ----- Wiki-backed memory facades (preserve existing remember/recall/forget UX) -----

    defineTool("remember", {
      description:
        "Save something to Max's wiki knowledge base. Use when the user says 'remember that...', " +
        "states a preference, shares a fact about themselves, or mentions something important " +
        "that should be remembered across conversations. Also use proactively when you detect " +
        "important information worth persisting.",
      parameters: z.object({
        category: z.enum(["preference", "fact", "project", "person", "routine"])
          .describe("Category: preference (likes/dislikes/settings), fact (general knowledge), project (codebase/repo info), person (people info), routine (schedules/habits)"),
        content: z.string().describe("The thing to remember — a concise, self-contained statement"),
        source: z.enum(["user", "auto"]).optional().describe("'user' if explicitly asked to remember, 'auto' if Max detected it (default: 'user')"),
      }),
      handler: async (args) => {
        ensureWikiStructure();
        const categoryMap: Record<string, string> = {
          preference: "pages/preferences.md",
          fact: "pages/facts.md",
          project: "pages/projects.md",
          person: "pages/people.md",
          routine: "pages/routines.md",
        };
        const pagePath = categoryMap[args.category] || `pages/${args.category}.md`;
        const title = args.category.charAt(0).toUpperCase() + args.category.slice(1);
        const now = new Date().toISOString().slice(0, 10);
        const tag = args.source === "auto" ? "auto" : "user";

        const existing = readPage(pagePath);
        if (existing) {
          // Append to existing page
          const updated = existing.replace(
            /^(---[\s\S]*?updated:\s*)[\d-]+/m,
            `$1${now}`
          );
          writePage(pagePath, updated.trimEnd() + `\n- ${args.content} _(${tag}, ${now})_\n`);
        } else {
          const page = [
            "---",
            `title: ${title}`,
            `tags: [${args.category}]`,
            `created: ${now}`,
            `updated: ${now}`,
            "---",
            "",
            `# ${title}`,
            "",
            `- ${args.content} _(${tag}, ${now})_`,
            "",
          ].join("\n");
          writePage(pagePath, page);
        }

        addToIndex({
          path: pagePath,
          title: `${title}`,
          summary: `${title} stored in Max's wiki`,
          section: "Knowledge",
        });
        appendLog("update", `remember (${args.category}): ${args.content.slice(0, 80)}`);

        // Also write to SQLite for backwards compat during transition
        const id = addMemory(args.category, args.content, args.source || "user");
        return `Remembered (wiki + #${id}, ${args.category}): "${args.content}"`;
      },
    }),

    defineTool("recall", {
      description:
        "Search Max's wiki knowledge base for stored facts, preferences, or information. " +
        "Use when you need to look up something the user told you before, or when the user " +
        "asks 'do you remember...?' or 'what do you know about...?'",
      parameters: z.object({
        keyword: z.string().optional().describe("Search term to match against wiki pages"),
        category: z.enum(["preference", "fact", "project", "person", "routine"]).optional()
          .describe("Optional: filter by category"),
      }),
      handler: async (args) => {
        ensureWikiStructure();

        // Search wiki index
        const query = [args.keyword, args.category].filter(Boolean).join(" ");
        const matches = searchIndex(query || "", 5);

        if (matches.length === 0) {
          // Fall back to SQLite search for pre-migration content
          const results = searchMemories(args.keyword, args.category);
          if (results.length === 0) return "No matching memories found in wiki or database.";
          const lines = results.map(
            (m) => `• [db#${m.id}] [${m.category}] ${m.content} (${m.source}, ${m.created_at})`
          );
          return `Found ${results.length} in legacy database:\n${lines.join("\n")}`;
        }

        const sections: string[] = [];
        for (const match of matches) {
          const content = readPage(match.path);
          if (!content) continue;
          const body = content.replace(/^---[\s\S]*?---\s*/, "").trim();
          const trimmed = body.length > 800 ? body.slice(0, 800) + "…" : body;
          sections.push(`**${match.title}** (${match.path}):\n${trimmed}`);
        }

        return sections.length > 0
          ? `Found ${matches.length} wiki page(s):\n\n${sections.join("\n\n")}`
          : "No matching content found.";
      },
    }),

    defineTool("forget", {
      description:
        "Remove specific content from Max's knowledge base. For wiki content, specify the " +
        "page path and the text to remove. For legacy database entries, specify the memory_id.",
      parameters: z.object({
        memory_id: z.number().int().optional().describe("Legacy database memory ID to remove"),
        page_path: z.string().optional().describe("Wiki page path containing the content to remove"),
        content: z.string().optional().describe("The specific text to remove from the wiki page"),
      }),
      handler: async (args) => {
        const results: string[] = [];

        // Remove from legacy DB if ID provided
        if (args.memory_id !== undefined) {
          const removed = removeMemory(args.memory_id);
          results.push(removed
            ? `Removed db#${args.memory_id}.`
            : `db#${args.memory_id} not found.`);
        }

        // Remove from wiki if page + content provided
        if (args.page_path && args.content) {
          const page = readPage(args.page_path);
          if (page) {
            const lines = page.split("\n");
            const before = lines.length;
            // Only remove bullet-point lines that contain the target content
            const updated = lines
              .filter((line) => {
                if (line.trim().startsWith("-") && line.includes(args.content!)) {
                  return false;
                }
                return true;
              })
              .join("\n");
            const removed = before - updated.split("\n").length;
            if (removed > 0) {
              writePage(args.page_path, updated);
              appendLog("update", `forget: removed ${removed} line(s) matching "${args.content!.slice(0, 60)}" from ${args.page_path}`);
              results.push(`Removed ${removed} line(s) from ${args.page_path}.`);
            } else {
              results.push(`No matching bullet points found in ${args.page_path}.`);
            }
          } else {
            results.push(`Page ${args.page_path} not found.`);
          }
        }

        return results.length > 0 ? results.join(" ") : "Nothing to remove — provide memory_id or page_path + content.";
      },
    }),

    // ----- New wiki tools -----

    defineTool("wiki_search", {
      description:
        "Search Max's wiki knowledge base. Returns matching page titles, paths, and summaries " +
        "from the wiki index. Use this to find relevant knowledge before answering questions.",
      parameters: z.object({
        query: z.string().describe("What to search for in the wiki"),
      }),
      handler: async (args) => {
        ensureWikiStructure();
        const matches = searchIndex(args.query, 10);
        if (matches.length === 0) return "No matching wiki pages found.";
        const lines = matches.map(
          (m) => `• [${m.title}](${m.path}) — ${m.summary}`
        );
        return `Found ${matches.length} page(s):\n${lines.join("\n")}`;
      },
    }),

    defineTool("wiki_read", {
      description:
        "Read a specific wiki page by path. Use after wiki_search to read full page content. " +
        "Paths are relative to the wiki root (e.g. 'pages/preferences.md', 'index.md').",
      parameters: z.object({
        path: z.string().describe("Path to the wiki page (e.g. 'pages/people/burke.md', 'index.md')"),
      }),
      handler: async (args) => {
        ensureWikiStructure();
        const content = readPage(args.path);
        if (!content) return `Page not found: ${args.path}`;
        return content;
      },
    }),

    defineTool("wiki_update", {
      description:
        "Create or update a wiki page. You provide the full page content (markdown with optional " +
        "YAML frontmatter). The page will be written to disk and the index updated. Use this for " +
        "rich knowledge pages, entity pages, synthesis documents — anything more structured than " +
        "a quick 'remember' call. After creating/updating a page, the index is automatically updated.",
      parameters: z.object({
        path: z.string().describe("Page path relative to wiki root (e.g. 'pages/projects/max.md')"),
        title: z.string().describe("Page title for the index"),
        summary: z.string().describe("One-line summary for the index"),
        section: z.string().optional().describe("Index section (default: 'Knowledge')"),
        content: z.string().describe("Full page content (markdown)"),
      }),
      handler: async (args) => {
        ensureWikiStructure();
        writePage(args.path, args.content);
        addToIndex({
          path: args.path,
          title: args.title,
          summary: args.summary,
          section: args.section || "Knowledge",
        });
        appendLog("update", `wiki_update: ${args.title} (${args.path})`);
        return `Wiki page updated: ${args.title} (${args.path})`;
      },
    }),

    defineTool("wiki_ingest", {
      description:
        "Ingest a source into the wiki. Saves the raw content as an immutable source document, " +
        "then returns it so you can create wiki pages from it. Supports URLs (fetches the page) " +
        "or raw text passed directly. For local files, read the file yourself and pass content as text.",
      parameters: z.object({
        type: z.enum(["url", "text"]).describe("Source type: 'url' to fetch a web page, 'text' for raw content"),
        source: z.string().describe("URL or raw text content"),
        name: z.string().optional().describe("Name for the source (auto-generated if omitted)"),
      }),
      handler: async (args) => {
        ensureWikiStructure();
        let content: string;
        let sourceName: string;

        if (args.type === "url") {
          // Validate URL scheme
          let parsedUrl: URL;
          try {
            parsedUrl = new URL(args.source);
          } catch {
            return "Invalid URL format.";
          }
          if (!["http:", "https:"].includes(parsedUrl.protocol)) {
            return "Only http and https URLs are supported.";
          }
          // Block private/internal addresses
          const host = parsedUrl.hostname.toLowerCase();
          if (host === "localhost" || host === "127.0.0.1" || host === "::1" ||
              host.startsWith("10.") || host.startsWith("192.168.") ||
              host.startsWith("169.254.") || host === "metadata.google.internal") {
            return "Cannot fetch internal/private URLs.";
          }
          try {
            const res = await fetch(args.source);
            if (!res.ok) {
              return `Fetch failed: ${res.status} ${res.statusText}`;
            }
            content = await res.text();
            // Strip HTML tags for a rough markdown conversion
            content = content.replace(/<script[\s\S]*?<\/script>/gi, "")
              .replace(/<style[\s\S]*?<\/style>/gi, "")
              .replace(/<[^>]+>/g, " ")
              .replace(/\s{2,}/g, " ")
              .trim();
          } catch (err) {
            return `Failed to fetch URL: ${err instanceof Error ? err.message : err}`;
          }
          sourceName = args.name || parsedUrl.hostname + "-" + Date.now();
        } else {
          content = args.source;
          sourceName = args.name || "text-" + Date.now();
        }

        const fileName = `${new Date().toISOString().slice(0, 10)}-${sourceName}.md`;
        writeRawSource(fileName, content);
        appendLog("ingest", `Ingested ${args.type}: ${sourceName} (${content.length} chars)`);

        // Return the content so the LLM can create wiki pages from it
        const preview = content.length > 3000 ? content.slice(0, 3000) + "\n\n…(truncated)" : content;
        return `Source saved as sources/${fileName} (${content.length} chars).\n\n` +
          "Now create wiki pages from this content using wiki_update. " +
          "Update existing pages and the index as needed.\n\n" +
          `--- Source content ---\n${preview}`;
      },
    }),

    defineTool("wiki_lint", {
      description:
        "Health-check the wiki. Looks for: orphan pages (not in index), index entries pointing " +
        "to missing pages, and pages with no cross-references. Returns a report.",
      parameters: z.object({}),
      handler: async () => {
        ensureWikiStructure();
        const indexEntries = parseIndex();
        const pages = listPages();
        const sources = listSources();

        const indexPaths = new Set(indexEntries.map((e) => e.path));
        const orphans = pages.filter((p) => !indexPaths.has(p));
        const missing = indexEntries.filter((e) => !readPage(e.path));

        const report: string[] = [`Wiki health report (${pages.length} pages, ${sources.length} sources):`];

        if (orphans.length > 0) {
          report.push(`\n**Orphan pages** (not in index):\n${orphans.map((p) => `- ${p}`).join("\n")}`);
        }
        if (missing.length > 0) {
          report.push(`\n**Missing pages** (in index but not on disk):\n${missing.map((e) => `- ${e.path}: ${e.title}`).join("\n")}`);
        }
        if (orphans.length === 0 && missing.length === 0) {
          report.push("\n✅ No issues found. Index and pages are in sync.");
        }

        report.push(`\n**Suggestions**: Look for pages that should link to each other, topics mentioned but lacking their own page, and stale content that needs updating.`);

        appendLog("lint", `${orphans.length} orphans, ${missing.length} missing`);
        return report.join("\n");
      },
    }),

    defineTool("restart_max", {
      description:
        "Restart the Max daemon process. Use when the user asks Max to restart himself, " +
        "or when a restart is needed to pick up configuration changes. " +
        "Spawns a new process and exits the current one.",
      parameters: z.object({
        reason: z.string().optional().describe("Optional reason for the restart"),
      }),
      handler: async (args) => {
        const reason = args.reason ? ` (${args.reason})` : "";
        // Dynamic import to avoid circular dependency
        const { restartDaemon } = await import("../daemon.js");
        // Schedule restart after returning the response
        setTimeout(() => {
          restartDaemon().catch((err) => {
            console.error("[max] Restart failed:", err);
          });
        }, 1000);
        return `Restarting Max${reason}. I'll be back in a few seconds.`;
      },
    }),
  ];
}

function formatAge(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const idx = line.indexOf(": ");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 2).trim();
      result[key] = value;
    }
  }
  return result;
}
