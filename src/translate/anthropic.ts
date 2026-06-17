import type { ProviderHelper, ProviderHelperOptions } from "./provider.js";
import type { UsageInfo } from "./types.js";

type Usage = {
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
};

/** Anthropic Messages provider helper (spec §7.2). */
export function anthropicHelper(opts: ProviderHelperOptions): ProviderHelper {
  // 1M-context support is derived from the registry entry / `[1m]` variant
  // (passed via opts.supports1m) and drives the `context-1m` beta header.
  // Fall back to a name heuristic only when the flag isn't provided by the
  // caller.
  const supports1m =
    opts.supports1m ??
    (opts.model.includes("sonnet") || opts.model.includes("opus-4-6"));
  return {
    format: "anthropic",
    modifyUrl: (providerApi: string) => `${providerApi}/messages`,
    modifyHeaders: (headers: Headers, apiKey: string, _stickyId: string) => {
      headers.set("x-api-key", apiKey);
      headers.set("anthropic-version", headers.get("anthropic-version") ?? "2023-06-01");
      if (supports1m) headers.set("anthropic-beta", "context-1m-2025-08-07");
    },
    modifyBody: (body: Record<string, any>) => body,
    createBinaryStreamDecoder: () => undefined,
    createUsageParser: () => {
      let usage: Usage | undefined;
      return {
        parse: (chunk: string) => {
          const data = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!data) return;
          let json: any;
          try {
            json = JSON.parse(data.slice(6));
          } catch {
            return;
          }
          if (json && typeof json === "object" && json.usage) usage = json.usage;
        },
        retrieve: () => usage,
      };
    },
    extractUsage: (response: any) => response?.usage,
    normalizeUsage: (usage: Usage): UsageInfo => ({
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadTokens: usage?.cache_read_input_tokens,
      cacheWrite5mTokens:
        usage?.cache_creation?.ephemeral_5m_input_tokens ?? usage?.cache_creation_input_tokens,
      cacheWrite1hTokens: usage?.cache_creation?.ephemeral_1h_input_tokens,
    }),
  };
}