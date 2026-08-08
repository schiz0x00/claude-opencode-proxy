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
 * Strip every auth header from an upstream request (spec §7.4). The free
 * backend sends no credential at all, and the provider helpers unconditionally
 * write one, so this runs after them.
 */
export function clearAuth(headers: Headers): void {
  headers.delete("x-api-key");
  headers.delete("authorization");
  headers.delete("x-goog-api-key");
}
