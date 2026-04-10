import test from "node:test";
import assert from "node:assert/strict";
import { withMaxHome } from "../test/support/max-home.js";
import { withPatchedProperty } from "../test/support/fixtures.js";

interface SessionLogRecordInput {
  timestamp: string;
  runId: string;
  event: { type: string; data: Record<string, unknown> };
}

function createJsonlRecord(input: SessionLogRecordInput): string {
  return JSON.stringify({
    timestamp: input.timestamp,
    runId: input.runId,
    sessionId: `${input.runId}-session`,
    agentName: "orchestrator",
    agentType: "coder",
    event: input.event,
  });
}

function readHeader(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }

  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }

  if (Array.isArray(headers)) {
    const entry = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return entry?.[1];
  }

  const headerMap = headers as Record<string, string>;
  const key = Object.keys(headerMap).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headerMap[key] : undefined;
}

test("the session-tail Telegram flow posts the formatted tail to the local API", async (t) => {
  await withMaxHome(t, async (fixture) => {
    const runId = "telegram-run";
    const records = [
      createJsonlRecord({
        timestamp: "2026-04-10T15:00:00.000Z",
        runId,
        event: {
          type: "user.message",
          data: { content: "first line" },
        },
      }),
      createJsonlRecord({
        timestamp: "2026-04-10T15:01:00.000Z",
        runId,
        event: {
          type: "assistant.message",
          data: { content: "second line" },
        },
      }),
      createJsonlRecord({
        timestamp: "2026-04-10T15:02:00.000Z",
        runId,
        event: {
          type: "tool.execution_complete",
          data: {
            success: true,
            result: { content: "third line" },
          },
        },
      }),
    ];
    fixture.writeFile("api-token", "telegram-api-token");
    fixture.writeFile(`session-logs/${runId}.jsonl`, `${records.join("\n")}\n`);

    const { buildSessionTailMessage } =
      await fixture.importMaxModule<typeof import("./session-tail.js")>("telegram/session-tail.js");
    const { sendLocalTelegramMessage } =
      await fixture.importMaxModule<typeof import("../api/local-client.js")>("api/local-client.js");

    const calls: Array<{ url: string; init?: RequestInit }> = [];

    await withPatchedProperty(
      globalThis,
      "fetch",
      (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return new Response("", { status: 200 });
      }) as typeof fetch,
      async () => {
        const match = `${runId} 2`;
        const [parsedRunId = "", requestedLines] = match.split(/\s+/, 2);
        const text = buildSessionTailMessage(parsedRunId, requestedLines);
        await sendLocalTelegramMessage(text);
      },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "http://127.0.0.1:7777/send-message");
    assert.equal(readHeader(calls[0]?.init?.headers, "authorization"), "Bearer telegram-api-token");
    assert.equal(readHeader(calls[0]?.init?.headers, "content-type"), "application/json");
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      text: [
        `Session tail for ${runId} (2 lines):`,
        "",
        "2026-04-10 15:01:00Z  orchestrator (coder)  assistant.message  second line",
        "2026-04-10 15:02:00Z  orchestrator (coder)  tool.execution_complete  ok: third line",
      ].join("\n"),
    });
  });
});
