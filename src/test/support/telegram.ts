import type { Context } from "grammy";

export interface TelegramUserFixture {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChatFixture {
  id: number;
  type: "private";
}

export interface TelegramPhotoFixture {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramMessageFixture {
  message_id: number;
  date: number;
  chat: TelegramChatFixture;
  from: TelegramUserFixture;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoFixture[];
  reply_to_message?: TelegramMessageFixture;
}

export interface TelegramUpdateFixture {
  update_id: number;
  message: TelegramMessageFixture;
}

export interface RecordedTelegramReply {
  text: string;
  extra?: unknown;
}

export interface RecordedTelegramPhotoReply {
  photo: unknown;
  extra?: unknown;
}

export interface FakeTelegramFile {
  file_id: string;
  file_path?: string;
}

let nextMessageId = 1;
let nextUpdateId = 1;
let nextFileId = 1;

function defaultUser(overrides: Partial<TelegramUserFixture> = {}): TelegramUserFixture {
  return {
    id: overrides.id ?? 42,
    is_bot: overrides.is_bot ?? false,
    first_name: overrides.first_name ?? "Max Tester",
    username: overrides.username,
  };
}

function defaultChat(overrides: Partial<TelegramChatFixture> = {}): TelegramChatFixture {
  return {
    id: overrides.id ?? 42,
    type: overrides.type ?? "private",
  };
}

function nextPhotoSize(fileId?: string, width = 640, height = 480): TelegramPhotoFixture {
  const resolvedId = fileId ?? `photo-${nextFileId++}`;
  return {
    file_id: resolvedId,
    file_unique_id: `${resolvedId}-unique`,
    width,
    height,
  };
}

export function createTelegramPhotoSizes(fileIds: string[]): TelegramPhotoFixture[] {
  return fileIds.map((fileId, index) => nextPhotoSize(fileId, 320 + index * 320, 240 + index * 240));
}

export function createTelegramTextMessage(
  text: string,
  overrides: Partial<TelegramMessageFixture> = {},
): TelegramMessageFixture {
  return {
    message_id: overrides.message_id ?? nextMessageId++,
    date: overrides.date ?? 1_700_000_000,
    chat: {
      ...defaultChat(),
      ...(overrides.chat ?? {}),
    },
    from: {
      ...defaultUser(),
      ...(overrides.from ?? {}),
    },
    text,
    caption: overrides.caption,
    photo: overrides.photo,
    reply_to_message: overrides.reply_to_message,
  };
}

export function createTelegramPhotoMessage(
  options: {
    caption?: string;
    fileIds?: string[];
    replyToMessage?: TelegramMessageFixture;
    overrides?: Partial<TelegramMessageFixture>;
  } = {},
): TelegramMessageFixture {
  const overrides = options.overrides ?? {};
  return {
    message_id: overrides.message_id ?? nextMessageId++,
    date: overrides.date ?? 1_700_000_000,
    chat: {
      ...defaultChat(),
      ...(overrides.chat ?? {}),
    },
    from: {
      ...defaultUser(),
      ...(overrides.from ?? {}),
    },
    caption: options.caption ?? overrides.caption,
    photo: overrides.photo ?? createTelegramPhotoSizes(options.fileIds ?? ["photo-small", "photo-large"]),
    reply_to_message: options.replyToMessage ?? overrides.reply_to_message,
    text: overrides.text,
  };
}

export function createTelegramUpdate(message: TelegramMessageFixture): TelegramUpdateFixture {
  return {
    update_id: nextUpdateId++,
    message,
  };
}

export class FakeTelegramContext {
  readonly message: TelegramMessageFixture;
  readonly chat: TelegramChatFixture;
  readonly from: TelegramUserFixture;
  readonly replies: RecordedTelegramReply[] = [];
  readonly chatActions: string[] = [];
  readonly photoReplies: RecordedTelegramPhotoReply[] = [];
  match?: string;

  constructor(
    message: TelegramMessageFixture,
    options: {
      match?: string;
    } = {},
  ) {
    this.message = message;
    this.chat = message.chat;
    this.from = message.from;
    this.match = options.match;
  }

  asContext(): Context {
    return this as unknown as Context;
  }

  async reply(text: string, extra?: unknown): Promise<{ message_id: number }> {
    this.replies.push({ text, extra });
    return { message_id: this.replies.length };
  }

  async replyWithChatAction(action: string): Promise<void> {
    this.chatActions.push(action);
  }

  async replyWithPhoto(photo: unknown, extra?: unknown): Promise<{ message_id: number }> {
    this.photoReplies.push({ photo, extra });
    return { message_id: this.photoReplies.length };
  }
}

export class FakeTelegramApi {
  readonly getFileCalls: string[] = [];
  readonly sendMessageCalls: Array<{ chatId: number; text: string; extra?: unknown }> = [];
  readonly sendPhotoCalls: Array<{ chatId: number; photo: unknown; extra?: unknown }> = [];

  private readonly files = new Map<string, FakeTelegramFile>();

  constructor(files: Record<string, string> = {}) {
    for (const [fileId, filePath] of Object.entries(files)) {
      this.files.set(fileId, { file_id: fileId, file_path: filePath });
    }
  }

  setFile(fileId: string, filePath?: string): void {
    this.files.set(fileId, { file_id: fileId, file_path: filePath });
  }

  async getFile(fileId: string): Promise<FakeTelegramFile> {
    this.getFileCalls.push(fileId);
    return this.files.get(fileId) ?? { file_id: fileId };
  }

  async sendMessage(chatId: number, text: string, extra?: unknown): Promise<void> {
    this.sendMessageCalls.push({ chatId, text, extra });
  }

  async sendPhoto(chatId: number, photo: unknown, extra?: unknown): Promise<void> {
    this.sendPhotoCalls.push({ chatId, photo, extra });
  }
}

export function createTelegramContext(
  message: TelegramMessageFixture,
  options: {
    match?: string;
  } = {},
): FakeTelegramContext {
  return new FakeTelegramContext(message, options);
}

export function createTelegramApi(files: Record<string, string> = {}): FakeTelegramApi {
  return new FakeTelegramApi(files);
}
