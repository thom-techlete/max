import { createServer, type ServerResponse } from "http";
import type { AddressInfo } from "net";
import type { TestContext } from "node:test";
import { createCleanupStack, createDeferred } from "./fixtures.js";

type MaybePromise<T> = T | Promise<T>;

export interface RecordedHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  text(): string;
  json<T = unknown>(): T;
}

export interface HttpTestServer {
  origin: string;
  requests: RecordedHttpRequest[];
  url(path?: string): string;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  nextRequest(timeoutMs?: number): Promise<RecordedHttpRequest>;
  close(): Promise<void>;
}

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

export type HttpRequestHandler = (
  req: RecordedHttpRequest,
  res: ServerResponse,
) => MaybePromise<void>;

function createRecordedRequest(
  method: string | undefined,
  url: string | undefined,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
): RecordedHttpRequest {
  return {
    method: method ?? "GET",
    url: url ?? "/",
    headers,
    body,
    text(): string {
      return body.toString("utf-8");
    },
    json<T = unknown>(): T {
      return JSON.parse(this.text()) as T;
    },
  };
}

function toResponseBody(body: unknown): BodyInit | null {
  if (body === undefined || body === null) {
    return null;
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  return JSON.stringify(body);
}

export async function startHttpTestServer(
  t?: TestContext,
  handler?: HttpRequestHandler,
): Promise<HttpTestServer> {
  const cleanupStack = createCleanupStack(t);
  const requests: RecordedHttpRequest[] = [];
  const pending = new Set<ReturnType<typeof createDeferred<RecordedHttpRequest>>>();

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const recorded = createRecordedRequest(
      req.method,
      req.url,
      req.headers,
      Buffer.concat(chunks),
    );

    requests.push(recorded);

    const waiter = pending.values().next().value as ReturnType<typeof createDeferred<RecordedHttpRequest>> | undefined;
    if (waiter) {
      pending.delete(waiter);
      waiter.resolve(recorded);
    }

    if (handler) {
      await handler(recorded, res);
      if (!res.writableEnded) {
        res.end();
      }
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "No test handler configured" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  cleanupStack.add(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    requests,
    url(path = "/"): string {
      return new URL(path, origin).toString();
    },
    fetch(path: string, init?: RequestInit): Promise<Response> {
      return fetch(new URL(path, origin), init);
    },
    nextRequest(timeoutMs = 1_000): Promise<RecordedHttpRequest> {
      if (requests.length > 0) {
        return Promise.resolve(requests[requests.length - 1]);
      }

      const deferred = createDeferred<RecordedHttpRequest>();
      pending.add(deferred);

      const timer = setTimeout(() => {
        pending.delete(deferred);
        deferred.reject(new Error(`Timed out waiting for HTTP request after ${timeoutMs}ms`));
      }, timeoutMs);

      return deferred.promise.finally(() => {
        clearTimeout(timer);
        pending.delete(deferred);
      });
    },
    async close(): Promise<void> {
      await cleanupStack.cleanup();
    },
  };
}

export function createJsonResponse(
  body: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

export function createTextResponse(
  body: string,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "text/plain; charset=utf-8");
  }

  return new Response(body, {
    ...init,
    headers,
  });
}

export function createResponse(
  body?: unknown,
  init: ResponseInit = {},
): Response {
  return new Response(toResponseBody(body), init);
}

export function createSseEvent(
  data: string | Record<string, unknown>,
  options: {
    event?: string;
    id?: string;
    retry?: number;
  } = {},
): string {
  const lines: string[] = [];

  if (options.event) {
    lines.push(`event: ${options.event}`);
  }
  if (options.id) {
    lines.push(`id: ${options.id}`);
  }
  if (options.retry !== undefined) {
    lines.push(`retry: ${options.retry}`);
  }

  const payload = typeof data === "string" ? data : JSON.stringify(data);
  for (const line of payload.split("\n")) {
    lines.push(`data: ${line}`);
  }

  return `${lines.join("\n")}\n\n`;
}

function parseSseBlock(block: string): SseEvent | undefined {
  const event: SseEvent = { data: "" };

  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    const rawValue = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1).replace(/^ /, "");

    switch (field) {
      case "event":
        event.event = rawValue;
        break;
      case "data":
        event.data = event.data.length > 0 ? `${event.data}\n${rawValue}` : rawValue;
        break;
      case "id":
        event.id = rawValue;
        break;
      case "retry":
        event.retry = Number(rawValue);
        break;
      default:
        break;
    }
  }

  return event.data.length > 0 || event.event || event.id || event.retry !== undefined
    ? event
    : undefined;
}

export async function collectSseEvents(
  response: Response,
  options: {
    limit?: number;
  } = {},
): Promise<SseEvent[]> {
  const reader = response.body?.getReader();
  if (!reader) {
    return [];
  }

  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const delimiterIndex = buffer.indexOf("\n\n");
      if (delimiterIndex === -1) {
        break;
      }

      const block = buffer.slice(0, delimiterIndex);
      buffer = buffer.slice(delimiterIndex + 2);

      const event = parseSseBlock(block);
      if (!event) {
        continue;
      }

      events.push(event);

      if (options.limit !== undefined && events.length >= options.limit) {
        await reader.cancel();
        return events;
      }
    }
  }

  const trailing = parseSseBlock(buffer.trim());
  if (trailing) {
    events.push(trailing);
  }

  return events;
}
