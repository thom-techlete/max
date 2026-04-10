import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildHelpText } from "../cli.js";
import { formatSessionsOutput, runSessionsCommand } from "./sessions.js";

function createTokenFile(token = "secret-token"): string {
  const dir = mkdtempSync(join(tmpdir(), "max-sessions-test-"));
  const tokenPath = join(dir, "api-token");
  writeFileSync(tokenPath, token);
  return tokenPath;
}

function createMockResponse(body: unknown, init?: { ok?: boolean; status?: number; statusText?: string }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    async json(): Promise<unknown> {
      return body;
    },
    async text(): Promise<string> {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

test("buildHelpText includes the sessions command", () => {
  const help = buildHelpText("1.2.3");
  assert.match(help, /sessions\s+Show detailed active worker sessions from the daemon/);
  assert.match(help, /max sessions\s+Show detailed active worker sessions/);
});

test("formatSessionsOutput renders detailed worker session blocks", () => {
  const output = formatSessionsOutput([
    {
      name: "docs-fix",
      status: "idle",
      workingDir: "/repo/docs",
      model: "gpt-5.4",
      agent: "default",
      startedAt: "2026-04-10 11:00:00 UTC",
      lastActivityAt: "2026-04-10 11:01:00 UTC",
      currentTask: "Waiting for prompt",
    },
    {
      name: "auth-refactor",
      status: "running",
      workingDir: "/repo/app",
      model: "claude-sonnet-4.6",
      agent: "coder",
      startedAt: "2026-04-10 11:02:00 UTC",
      lastActivityAt: "2026-04-10 11:03:00 UTC",
      currentTask: "Fix the auth flow",
    },
  ]);

  assert.match(output, /Active worker sessions \(2\):/);
  assert.match(output, /docs-fix/);
  assert.match(output, /Working directory: \/repo\/docs/);
  assert.match(output, /Model: claude-sonnet-4\.6/);
  assert.match(output, /Agent\/role: coder/);
  assert.match(output, /Current task: Fix the auth flow/);
});

test("formatSessionsOutput renders Telegram-friendly session blocks", () => {
  const output = formatSessionsOutput([
    {
      name: "docs-fix",
      status: "running",
      workingDir: "/repo/docs",
      model: "gpt-5.4",
      agent: "designer",
      startedAt: "2026-04-10 11:00:00 UTC",
      lastActivityAt: "2026-04-10 11:01:00 UTC",
      currentTask: "Polish the landing page",
    },
  ], "telegram");

  assert.match(output, /\*\*docs-fix\*\*/);
  assert.match(output, /Working directory: `\/repo\/docs`/);
  assert.match(output, /Agent\/role: designer/);
});

test("runSessionsCommand prints active sessions and sends the API token", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const tokenPath = createTokenFile();
  let authorizationHeader = "";

  const exitCode = await runSessionsCommand({
    apiPort: 7777,
    tokenPath,
    stdout: { write: (chunk: string) => stdout.push(chunk) },
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    fetchImpl: async (_input, init) => {
      authorizationHeader = init?.headers?.Authorization || "";
      return createMockResponse([
        {
          name: "lint-pass",
          status: "running",
          workingDir: "/repo",
          model: "gpt-5.4",
          agent: "coder",
          startedAt: "2026-04-10 11:00:00 UTC",
          lastActivityAt: "2026-04-10 11:01:00 UTC",
          currentTask: "Run lint and fix failures",
        },
      ]);
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.join(""), "");
  assert.equal(authorizationHeader, "Bearer secret-token");
  assert.match(stdout.join(""), /lint-pass/);
  assert.match(stdout.join(""), /Model: gpt-5\.4/);
  assert.match(stdout.join(""), /Current task: Run lint and fix failures/);
});

test("runSessionsCommand prints the empty state", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const exitCode = await runSessionsCommand({
    apiPort: 7777,
    tokenPath: join(tmpdir(), "missing-max-token"),
    stdout: { write: (chunk: string) => stdout.push(chunk) },
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    fetchImpl: async () => createMockResponse([]),
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.join(""), "");
  assert.equal(stdout.join(""), "No active worker sessions.\n");
});

test("runSessionsCommand reports daemon connectivity errors", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const exitCode = await runSessionsCommand({
    apiPort: 7777,
    tokenPath: join(tmpdir(), "missing-max-token"),
    stdout: { write: (chunk: string) => stdout.push(chunk) },
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:7777");
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.join(""), "");
  assert.match(stderr.join(""), /Start it with 'max start'/);
});
