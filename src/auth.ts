import type { Format } from "./translate/types.js";

/**
 * Extract the OpenCode key from a client request (spec §7.4):
 * 1. `x-api-key`
 * 2. `Authorization: Bearer <token>`
 * else null.
 */
export function extractApiKey(headers: Headers): string | null {
  const x = headers.get("x-api-key");
  if (x) return x;
  const auth = headers.get("authorization");
  if (auth && auth.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  return null;
}

/**
 * Inject the key into upstream headers in the format-correct position
 * (spec §7.4). `apiKey === undefined` (free backend) → remove all auth
 * headers.
 */
export function injectAuth(headers: Headers, format: Format, apiKey?: string): void {
  if (apiKey === undefined) {
    headers.delete("x-api-key");
    headers.delete("authorization");
    headers.delete("x-goog-api-key");
    return;
  }
  if (format === "anthropic" || format === "google") {
    headers.set("x-api-key", apiKey);
    headers.delete("authorization");
  } else {
    headers.set("authorization", `Bearer ${apiKey}`);
    headers.delete("x-api-key");
  }
}