#!/usr/bin/env node

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function buildHelpText(version = getVersion()): string {
  return `
max v${version} — AI orchestrator powered by Copilot SDK

Usage:
  max <command>

Commands:
  start       Start the Max daemon (Telegram bot + HTTP API)
  sessions    Show detailed active worker sessions from the daemon
  tui         Connect to the daemon via terminal UI
  setup       Interactive first-run configuration
  update      Check for updates and install the latest version
  help        Show this help message

Flags (start):
  --self-edit Allow Max to modify his own source code (off by default)

Examples:
  max start           Start the daemon
  max sessions        Show detailed active worker sessions
  max start --self-edit  Start with self-edit enabled
  max tui             Open the terminal client
  max setup           Configure Telegram token and settings
`.trim();
}

function printHelp(): void {
  console.log(buildHelpText());
}

export async function runCli(args = process.argv.slice(2)): Promise<number> {
  const command = args[0] || "help";

  switch (command) {
    case "start": {
      const startFlags = args.slice(1);
      if (startFlags.includes("--self-edit")) {
        process.env.MAX_SELF_EDIT = "1";
      }
      await import("./daemon.js");
      return 0;
    }
    case "sessions":
    case "workers": {
      const { runSessionsCommand } = await import("./commands/sessions.js");
      const [{ config }, { API_TOKEN_PATH }] = await Promise.all([
        import("./config.js"),
        import("./paths.js"),
      ]);
      return runSessionsCommand({
        apiPort: config.apiPort,
        tokenPath: API_TOKEN_PATH,
      });
    }
    case "tui":
      await import("./tui/index.js");
      return 0;
    case "setup":
      await import("./setup.js");
      return 0;
    case "update": {
      const { checkForUpdate, performUpdate } = await import("./update.js");
      const check = await checkForUpdate();
      if (!check.checkSucceeded) {
        console.error("⚠ Could not reach the npm registry. Check your network and try again.");
        return 1;
      }
      if (!check.updateAvailable) {
        console.log(`max v${check.current} is already the latest version.`);
        return 0;
      }
      console.log(`Update available: v${check.current} → v${check.latest}`);
      console.log("Installing...");
      const result = await performUpdate();
      if (result.ok) {
        console.log(`✅ Updated to v${check.latest}`);
        return 0;
      }
      console.error(`❌ Update failed: ${result.output}`);
      return 1;
    }
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return 0;
    case "--version":
    case "-v":
      console.log(getVersion());
      return 0;
    default:
      console.error(`Unknown command: ${command}\n`);
      printHelp();
      return 1;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return !!entry && import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  const exitCode = await runCli();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
