import { randomUUID } from "crypto";
import type { CopilotClient, CopilotSession } from "@github/copilot-sdk";

type MaybePromise<T> = T | Promise<T>;
type SessionEventName = "assistant.message_delta" | "tool.execution_complete";

export interface FakeCopilotModel {
  id: string;
}

export interface FakeCopilotResult {
  data: {
    content: string;
  };
}

export interface FakeSessionCall {
  payload: unknown;
  timeoutMs?: number;
}

export interface FakeCopilotSessionOptions {
  sessionId?: string;
  model?: string;
  defaultContent?: string;
  onSendAndWait?: (
    payload: unknown,
    timeoutMs: number | undefined,
    session: FakeCopilotSession,
  ) => MaybePromise<FakeCopilotResult>;
  onSetModel?: (model: string, session: FakeCopilotSession) => MaybePromise<void>;
}

export interface FakeCopilotClientOptions {
  state?: string;
  models?: Array<string | FakeCopilotModel>;
  sessionFactory?: (
    kind: "create" | "resume",
    options: {
      sessionId?: string;
      config: unknown;
      client: FakeCopilotClient;
    },
  ) => MaybePromise<FakeCopilotSession>;
}

type QueuedSessionOutcome =
  | string
  | FakeCopilotResult
  | Error
  | ((
      payload: unknown,
      timeoutMs: number | undefined,
      session: FakeCopilotSession,
    ) => MaybePromise<FakeCopilotResult>);

function normalizeResult(result: string | FakeCopilotResult): FakeCopilotResult {
  if (typeof result === "string") {
    return { data: { content: result } };
  }
  return result;
}

function normalizeModels(models?: Array<string | FakeCopilotModel>): FakeCopilotModel[] {
  const source = models ?? ["gpt-4.1", "claude-sonnet-4.6", "claude-opus-4.6"];
  return source.map((model) => (typeof model === "string" ? { id: model } : { id: model.id }));
}

export class FakeCopilotSession {
  readonly sessionId: string;
  model: string;
  defaultContent: string;
  destroyed = false;
  readonly sendAndWaitCalls: FakeSessionCall[] = [];
  readonly setModelCalls: string[] = [];
  destroyCalls = 0;

  private readonly listeners = new Map<SessionEventName, Set<(event: any) => void>>();
  private readonly queuedOutcomes: QueuedSessionOutcome[] = [];
  private readonly onSendAndWait?: FakeCopilotSessionOptions["onSendAndWait"];
  private readonly onSetModel?: FakeCopilotSessionOptions["onSetModel"];

  constructor(options: FakeCopilotSessionOptions = {}) {
    this.sessionId = options.sessionId ?? randomUUID();
    this.model = options.model ?? "claude-sonnet-4.6";
    this.defaultContent = options.defaultContent ?? "ok";
    this.onSendAndWait = options.onSendAndWait;
    this.onSetModel = options.onSetModel;
  }

  asSession(): CopilotSession {
    return this as unknown as CopilotSession;
  }

  queueResult(result: QueuedSessionOutcome): this {
    this.queuedOutcomes.push(result);
    return this;
  }

  emitDelta(deltaContent: string): void {
    this.emit("assistant.message_delta", { data: { deltaContent } });
  }

  emitToolExecutionComplete(): void {
    this.emit("tool.execution_complete", { data: {} });
  }

  on(eventName: SessionEventName, listener: (event: any) => void): () => void {
    const listeners = this.listeners.get(eventName) ?? new Set<(event: any) => void>();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(eventName);
      }
    };
  }

  async sendAndWait(payload: unknown, timeoutMs?: number): Promise<FakeCopilotResult> {
    this.sendAndWaitCalls.push({ payload, timeoutMs });

    const queued = this.queuedOutcomes.shift();
    if (queued !== undefined) {
      if (queued instanceof Error) {
        throw queued;
      }
      if (typeof queued === "function") {
        return queued(payload, timeoutMs, this);
      }
      return normalizeResult(queued);
    }

    if (this.onSendAndWait) {
      return this.onSendAndWait(payload, timeoutMs, this);
    }

    return { data: { content: this.defaultContent } };
  }

  async setModel(model: string): Promise<void> {
    this.model = model;
    this.setModelCalls.push(model);
    if (this.onSetModel) {
      await this.onSetModel(model, this);
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.destroyCalls += 1;
  }

  private emit(eventName: SessionEventName, event: any): void {
    for (const listener of this.listeners.get(eventName) ?? []) {
      listener(event);
    }
  }
}

export class FakeCopilotClient {
  state: string;
  readonly createSessionCalls: unknown[] = [];
  readonly resumeSessionCalls: Array<{ sessionId: string; config: unknown }> = [];
  readonly startedSessions: FakeCopilotSession[] = [];
  readonly queuedSessions: FakeCopilotSession[] = [];
  readonly models: FakeCopilotModel[];
  startCalls = 0;
  stopCalls = 0;
  listModelsCalls = 0;

  private readonly sessionFactory?: FakeCopilotClientOptions["sessionFactory"];

  constructor(options: FakeCopilotClientOptions = {}) {
    this.state = options.state ?? "connected";
    this.models = normalizeModels(options.models);
    this.sessionFactory = options.sessionFactory;
  }

  asClient(): CopilotClient {
    return this as unknown as CopilotClient;
  }

  enqueueSession(session: FakeCopilotSession): FakeCopilotSession {
    this.queuedSessions.push(session);
    return session;
  }

  setState(state: string): void {
    this.state = state;
  }

  setModels(models: Array<string | FakeCopilotModel>): void {
    this.models.splice(0, this.models.length, ...normalizeModels(models));
  }

  getState(): string {
    return this.state;
  }

  async start(): Promise<void> {
    this.startCalls += 1;
    this.state = "connected";
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.state = "stopped";
  }

  async listModels(): Promise<FakeCopilotModel[]> {
    this.listModelsCalls += 1;
    return this.models.map((model) => ({ ...model }));
  }

  async createSession(config: unknown): Promise<CopilotSession> {
    this.createSessionCalls.push(config);
    const session = await this.getNextSession("create", { config, client: this });
    this.startedSessions.push(session);
    return session.asSession();
  }

  async resumeSession(sessionId: string, config: unknown): Promise<CopilotSession> {
    this.resumeSessionCalls.push({ sessionId, config });
    const session = await this.getNextSession("resume", { sessionId, config, client: this });
    this.startedSessions.push(session);
    return session.asSession();
  }

  private async getNextSession(
    kind: "create" | "resume",
    options: {
      sessionId?: string;
      config: unknown;
      client: FakeCopilotClient;
    },
  ): Promise<FakeCopilotSession> {
    const queuedSession = this.queuedSessions.shift();
    if (queuedSession) {
      return queuedSession;
    }

    if (this.sessionFactory) {
      return this.sessionFactory(kind, options);
    }

    const config = options.config as { model?: string } | undefined;
    return new FakeCopilotSession({
      sessionId: options.sessionId,
      model: config?.model,
    });
  }
}

export function createFakeCopilotClient(options: FakeCopilotClientOptions = {}): FakeCopilotClient {
  return new FakeCopilotClient(options);
}

export function createFakeCopilotSession(options: FakeCopilotSessionOptions = {}): FakeCopilotSession {
  return new FakeCopilotSession(options);
}

export function createStreamingSessionResult(
  chunks: string[],
  options: {
    finalContent?: string;
    emitToolCompletionBeforeEachChunk?: boolean;
  } = {},
): (
  payload: unknown,
  timeoutMs: number | undefined,
  session: FakeCopilotSession,
) => Promise<FakeCopilotResult> {
  return async (_payload, _timeoutMs, session) => {
    for (const chunk of chunks) {
      if (options.emitToolCompletionBeforeEachChunk) {
        session.emitToolExecutionComplete();
      }
      session.emitDelta(chunk);
    }

    return {
      data: {
        content: options.finalContent ?? chunks.join(""),
      },
    };
  };
}
