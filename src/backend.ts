import type { Backend } from "./types.js";

const BACKENDS: readonly Backend[] = ["zen", "go", "free"];

export const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
export const GO_BASE_URL = "https://opencode.ai/zen/go/v1";

/**
 * Resolve the backend per spec §4.2 (normative precedence):
 * 1. `OPENCODE_BACKEND` explicit override (validated) wins.
 * 2. Else `OPENCODE_GO_API_KEY` set → "go".
 * 3. Else `OPENCODE_ZEN_API_KEY` set → "zen".
 * 4. Else → "free".
 */
export function resolveBackend(env: NodeJS.ProcessEnv): Backend {
  const explicit = env.OPENCODE_BACKEND;
  if (explicit !== undefined && explicit !== "") {
    if (!BACKENDS.includes(explicit as Backend)) {
      throw new Error(
        `OPENCODE_BACKEND must be one of ${BACKENDS.join("|")} (got "${explicit}")`,
      );
    }
    return explicit as Backend;
  }
  if (env.OPENCODE_GO_API_KEY) return "go";
  if (env.OPENCODE_ZEN_API_KEY) return "zen";
  return "free";
}

/**
 * Base URL resolution per spec §4.2: `OPENCODE_BASE_URL` override wins;
 * else `zen`/`free` → Zen base, `go` → Go base. Trailing slashes stripped.
 */
export function resolveBaseUrl(backend: Backend, override?: string): string {
  if (override !== undefined && override !== "") {
    return stripTrailingSlash(override);
  }
  return backend === "go" ? GO_BASE_URL : ZEN_BASE_URL;
}

export function isFree(backend: Backend): boolean {
  return backend === "free";
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}