import { existsSync, readFileSync } from "fs";
import { config } from "../config.js";
import { API_TOKEN_PATH } from "../paths.js";

const API_BASE = process.env.MAX_API_URL || `http://127.0.0.1:${config.apiPort}`;

function readApiToken(): string | undefined {
  if (!existsSync(API_TOKEN_PATH)) {
    return undefined;
  }

  const token = readFileSync(API_TOKEN_PATH, "utf-8").trim();
  return token || undefined;
}

async function postLocalJson(path: string, body: Record<string, unknown>): Promise<void> {
  const token = readApiToken();
  if (!token) {
    throw new Error(`Local API token not found at ${API_TOKEN_PATH}.`);
  }

  const response = await fetch(new URL(path, API_BASE), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (response.ok) {
    return;
  }

  const details = (await response.text()).trim();
  const suffix = details ? `: ${details}` : "";
  throw new Error(`Local API request failed (${response.status}${suffix})`);
}

export async function sendLocalTelegramMessage(text: string): Promise<void> {
  await postLocalJson("/send-message", { text });
}
