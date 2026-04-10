import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve as resolvePath } from "path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "url";
import {
  createCleanupStack,
  createFixtureDir,
  importFreshModule,
  withEnv,
} from "./fixtures.js";

type EnvValue = string | number | boolean | undefined;

export interface MaxHomeFixtureOptions {
  prefix?: string;
  env?: Record<string, EnvValue>;
  apiToken?: string;
  files?: Record<string, string | Uint8Array>;
}

export interface MaxHomeFixture {
  rootDir: string;
  homeDir: string;
  maxHomeDir: string;
  envPath: string;
  dbPath: string;
  apiTokenPath: string;
  sessionsDir: string;
  skillsDir: string;
  wikiDir: string;
  cleanup(): Promise<void>;
  run<T>(callback: () => Promise<T> | T): Promise<T>;
  resolve(...segments: string[]): string;
  importMaxModule<TModule>(relativePath: string): Promise<TModule>;
  writeEnv(values: Record<string, EnvValue>): void;
  readEnv(): string;
  writeFile(relativePath: string, contents: string | Uint8Array): void;
  readFile(relativePath: string): string;
}

const DIST_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
let maxHomeLock: Promise<void> = Promise.resolve();

function serializeEnv(values: Record<string, EnvValue>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("\n");
}

function ensureParentDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

async function withMaxHomeLock<T>(callback: () => Promise<T>): Promise<T> {
  const previous = maxHomeLock;
  let release!: () => void;
  maxHomeLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  try {
    return await callback();
  } finally {
    release();
  }
}

export function createMaxHomeFixture(
  t?: TestContext,
  options: MaxHomeFixtureOptions = {},
): MaxHomeFixture {
  const cleanupStack = createCleanupStack(t);
  const rootDir = createFixtureDir(t, options.prefix ?? "max-home-");
  const homeDir = join(rootDir, "home");
  const maxHomeDir = join(homeDir, ".max");
  const envPath = join(maxHomeDir, ".env");
  const dbPath = join(maxHomeDir, "max.db");
  const apiTokenPath = join(maxHomeDir, "api-token");
  const sessionsDir = join(maxHomeDir, "sessions");
  const skillsDir = join(maxHomeDir, "skills");
  const wikiDir = join(maxHomeDir, "wiki");

  mkdirSync(homeDir, { recursive: true });
  mkdirSync(maxHomeDir, { recursive: true });

  const fixture: MaxHomeFixture = {
    rootDir,
    homeDir,
    maxHomeDir,
    envPath,
    dbPath,
    apiTokenPath,
    sessionsDir,
    skillsDir,
    wikiDir,
    async cleanup(): Promise<void> {
      await cleanupStack.cleanup();
    },
    async run<T>(callback: () => Promise<T> | T): Promise<T> {
      return withEnv(
        {
          HOME: homeDir,
          USERPROFILE: homeDir,
          HOMEDRIVE: undefined,
          HOMEPATH: undefined,
        },
        callback,
      );
    },
    resolve(...segments: string[]): string {
      return join(maxHomeDir, ...segments);
    },
    async importMaxModule<TModule>(relativePath: string): Promise<TModule> {
      const normalizedPath = relativePath.replace(/^[./]+/, "");
      return importFreshModule<TModule>(resolvePath(DIST_ROOT, normalizedPath));
    },
    writeEnv(values: Record<string, EnvValue>): void {
      mkdirSync(maxHomeDir, { recursive: true });
      const serialized = serializeEnv(values);
      writeFileSync(envPath, serialized.length > 0 ? `${serialized}\n` : "");
    },
    readEnv(): string {
      return existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
    },
    writeFile(relativePath: string, contents: string | Uint8Array): void {
      const filePath = join(maxHomeDir, relativePath);
      ensureParentDir(filePath);
      writeFileSync(filePath, contents);
    },
    readFile(relativePath: string): string {
      return readFileSync(join(maxHomeDir, relativePath), "utf-8");
    },
  };

  if (options.env) {
    fixture.writeEnv(options.env);
  }

  if (options.apiToken !== undefined) {
    fixture.writeFile("api-token", options.apiToken);
  }

  for (const [relativePath, contents] of Object.entries(options.files ?? {})) {
    fixture.writeFile(relativePath, contents);
  }

  return fixture;
}

export async function withMaxHome<T>(
  t: TestContext,
  callback: (fixture: MaxHomeFixture) => Promise<T> | T,
  options: MaxHomeFixtureOptions = {},
): Promise<T> {
  return withMaxHomeLock(async () => {
    const fixture = createMaxHomeFixture(t, options);
    return fixture.run(() => callback(fixture));
  });
}
