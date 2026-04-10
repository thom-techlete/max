import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { TestContext } from "node:test";
import { pathToFileURL } from "url";

export type Cleanup = () => void | Promise<void>;

type MaybePromise<T> = T | Promise<T>;

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export interface CleanupStack {
  add(cleanup: Cleanup): void;
  cleanup(): Promise<void>;
}

const cleanupStacks = new WeakMap<object, CleanupStackImpl>();
let importCounter = 0;

class CleanupStackImpl implements CleanupStack {
  private readonly cleanups: Cleanup[] = [];
  private cleanedUp = false;

  add(cleanup: Cleanup): void {
    if (this.cleanedUp) {
      throw new Error("Cannot register cleanup after cleanup() has started");
    }
    this.cleanups.push(cleanup);
  }

  async cleanup(): Promise<void> {
    if (this.cleanedUp) return;
    this.cleanedUp = true;

    const errors: unknown[] = [];

    while (this.cleanups.length > 0) {
      const cleanup = this.cleanups.pop()!;
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 1) {
      throw errors[0];
    }

    if (errors.length > 1) {
      throw new AggregateError(errors, "Multiple fixture cleanups failed");
    }
  }
}

function getCleanupStack(t?: TestContext): CleanupStackImpl {
  if (!t) {
    return new CleanupStackImpl();
  }

  const key = t as unknown as object;
  const existing = cleanupStacks.get(key);
  if (existing) {
    return existing;
  }

  const stack = new CleanupStackImpl();
  cleanupStacks.set(key, stack);
  t.after(async () => {
    await stack.cleanup();
  });
  return stack;
}

export function createCleanupStack(t?: TestContext): CleanupStack {
  return getCleanupStack(t);
}

export function createFixtureDir(t?: TestContext, prefix = "max-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  getCleanupStack(t).add(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

export async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  run: () => MaybePromise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

export async function withPatchedProperty<
  TObject extends object,
  TKey extends keyof TObject,
  TResult,
>(
  object: TObject,
  key: TKey,
  value: TObject[TKey],
  run: () => MaybePromise<TResult>,
): Promise<TResult> {
  const hadOwnProperty = Object.prototype.hasOwnProperty.call(object, key);
  const previous = object[key];

  object[key] = value;

  try {
    return await run();
  } finally {
    if (hadOwnProperty) {
      object[key] = previous;
    } else {
      delete (object as Record<PropertyKey, unknown>)[key as PropertyKey];
    }
  }
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

export async function waitForMicrotasks(turns = 1): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}

export async function importFreshModule<TModule>(absolutePath: string): Promise<TModule> {
  const href = pathToFileURL(absolutePath).href;
  const separator = href.includes("?") ? "&" : "?";
  return import(`${href}${separator}max-test-import=${++importCounter}`) as Promise<TModule>;
}
