import test from "node:test";
import assert from "node:assert/strict";
import { withMaxHome } from "../test/support/max-home.js";

interface SessionLogRecordInput {
  timestamp: string;
  runId: string;
  sessionId?: string;
  agentName?: string;
  agentType?: string;
  event: { type: string; data: Record<string, unknown> };
}

function createJsonlRecord(input: SessionLogRecordInput): string {
  return JSON.stringify({
    timestamp: input.timestamp,
    runId: input.runId,
    sessionId: input.sessionId ?? `${input.runId}-session`,
    agentName: input.agentName ?? "orchestrator",
    agentType: input.agentType ?? "coder",
    event: input.event,
  });
}

function createBuffer() {
  const chunks: string[] = [];
  return {
    writer: { write: (chunk: string) => chunks.push(chunk) },
    read(): string {
      return chunks.join("");
    },
  };
}

test("runSessionLogTailCommand covers key CLI cases", async (t) => {
  await withMaxHome(t, async (fixture) => {
    const { runSessionLogTailCommand } =
      await fixture.importMaxModule<typeof import("./session-log-tail-cmd.js")>(
        "cli/session-log-tail-cmd.js",
      );

    await t.test("uses the default line count", async () => {
      const runId = "default-lines-run";
      const records = Array.from({ length: 25 }, (_, index) =>
        createJsonlRecord({
          timestamp: `2026-04-10T12:${String(index).padStart(2, "0")}:00.000Z`,
          runId,
          event: {
            type: "user.message",
            data: { content: `message ${index + 1}` },
          },
        })
      );
      fixture.writeFile(`session-logs/${runId}.jsonl`, `${records.join("\n")}\n`);

      const stdout = createBuffer();
      const stderr = createBuffer();
      const exitCode = await runSessionLogTailCommand([runId], {
        stdout: stdout.writer,
        stderr: stderr.writer,
      });

      const output = stdout.read();
      assert.equal(exitCode, 0);
      assert.equal(stderr.read(), "");
      assert.equal(output.trimEnd().split("\n").length, 20);
      assert.doesNotMatch(output, /message 5\b/);
      assert.match(output, /message 6\b/);
      assert.match(output, /message 25\b/);
    });

    await t.test("honors an explicit line count", async () => {
      const runId = "explicit-lines-run";
      const records = Array.from({ length: 5 }, (_, index) =>
        createJsonlRecord({
          timestamp: `2026-04-10T13:0${index}:00.000Z`,
          runId,
          event: {
            type: "user.message",
            data: { content: `entry ${index + 1}` },
          },
        })
      );
      fixture.writeFile(`session-logs/${runId}.jsonl`, `${records.join("\n")}\n`);

      const stdout = createBuffer();
      const stderr = createBuffer();
      const exitCode = await runSessionLogTailCommand([runId, "--lines", "2"], {
        stdout: stdout.writer,
        stderr: stderr.writer,
      });

      const output = stdout.read();
      assert.equal(exitCode, 0);
      assert.equal(stderr.read(), "");
      assert.equal(output.trimEnd().split("\n").length, 2);
      assert.doesNotMatch(output, /entry 3\b/);
      assert.match(output, /entry 4\b/);
      assert.match(output, /entry 5\b/);
    });

    await t.test("reports a missing run-id", async () => {
      const stdout = createBuffer();
      const stderr = createBuffer();
      const exitCode = await runSessionLogTailCommand([], {
        stdout: stdout.writer,
        stderr: stderr.writer,
      });

      const errorOutput = stderr.read();
      assert.equal(exitCode, 1);
      assert.equal(stdout.read(), "");
      assert.match(errorOutput, /Missing required run-id\./);
      assert.match(errorOutput, /Usage: max session-log-tail <run-id> \[--lines N\]/);
    });

    await t.test("rejects an invalid line count", async () => {
      const stdout = createBuffer();
      const stderr = createBuffer();
      const exitCode = await runSessionLogTailCommand(["run-123", "--lines", "0"], {
        stdout: stdout.writer,
        stderr: stderr.writer,
      });

      const errorOutput = stderr.read();
      assert.equal(exitCode, 1);
      assert.equal(stdout.read(), "");
      assert.match(errorOutput, /Invalid value for --lines: 0/);
      assert.match(errorOutput, /Usage: max session-log-tail <run-id> \[--lines N\]/);
    });

    await t.test("reports a missing session log file", async () => {
      const stdout = createBuffer();
      const stderr = createBuffer();
      const exitCode = await runSessionLogTailCommand(["missing-run"], {
        stdout: stdout.writer,
        stderr: stderr.writer,
      });

      assert.equal(exitCode, 1);
      assert.equal(stdout.read(), "");
      assert.match(stderr.read(), /No session log found for run-id "missing-run" at .*missing-run\.jsonl\./);
    });

    await t.test("formats representative JSONL records for humans", async () => {
      const runId = "formatting-run";
      const records = [
        createJsonlRecord({
          timestamp: "2026-04-10T14:15:16.000Z",
          runId,
          agentName: "planner",
          agentType: "orchestrator",
          event: {
            type: "user.message",
            data: { content: "Ship   the\nrelease" },
          },
        }),
        createJsonlRecord({
          timestamp: "2026-04-10T14:15:17.123Z",
          runId,
          agentName: "planner",
          agentType: "orchestrator",
          event: {
            type: "tool.execution_complete",
            data: {
              success: true,
              result: { content: "Saved   3 files" },
            },
          },
        }),
        createJsonlRecord({
          timestamp: "2026-04-10T14:15:18.000Z",
          runId,
          agentName: "planner",
          agentType: "orchestrator",
          event: {
            type: "assistant.turn_start",
            data: { turnId: "turn-7" },
          },
        }),
      ];
      fixture.writeFile(`session-logs/${runId}.jsonl`, `${records.join("\n")}\n`);

      const stdout = createBuffer();
      const stderr = createBuffer();
      const exitCode = await runSessionLogTailCommand([runId, "--lines", "3"], {
        stdout: stdout.writer,
        stderr: stderr.writer,
      });

      const output = stdout.read();
      assert.equal(exitCode, 0);
      assert.equal(stderr.read(), "");
      assert.match(
        output,
        /2026-04-10 14:15:16Z  planner \(orchestrator\)  user\.message  Ship the release/,
      );
      assert.match(
        output,
        /2026-04-10 14:15:17Z  planner \(orchestrator\)  tool\.execution_complete  ok: Saved 3 files/,
      );
      assert.match(
        output,
        /2026-04-10 14:15:18Z  planner \(orchestrator\)  assistant\.turn_start  turn turn-7 started/,
      );
    });
  });
});
