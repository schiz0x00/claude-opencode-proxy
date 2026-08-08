import type { ProviderHelper, ProviderHelperOptions } from "./provider.js";
import type { UsageInfo } from "./types.js";

type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  // moonshot
  cached_tokens?: number;
  // xai / alibaba
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  completion_tokens_details?: { reasoning_tokens?: number };
};

/** OpenAI-compatible chat/completions provider helper (spec §7.2). */
export function oaCompatHelper(opts: ProviderHelperOptions): ProviderHelper {
  return {
    format: "oa-compat",
    modifyUrl: (providerApi: string) => `${providerApi}/chat/completions`,
    modifyHeaders: (headers: Headers, apiKey: string, stickyId: string) => {
      headers.set("authorization", `Bearer ${apiKey}`);
      if (stickyId) headers.set("x-session-affinity", stickyId);
    },
    modifyBody: (body: Record<string, any>) => ({
      ...body,
      ...(body.stream ? { stream_options: { include_usage: true } } : {}),
    }),
    createBinaryStreamDecoder: () => undefined,
    createUsageParser: () => {
      let usage: Usage | undefined;
      return {
        parse: (chunk: string) => {
          // `data:{...}` without the optional space is equally valid SSE;
          // matching only "data: " silently dropped usage from such upstreams.
          const data = chunk.split("\n").find((l) => l.startsWith("data:"));
          if (!data) return;
          let json: any;
          try {
            json = JSON.parse(data.slice(5).trim());
          } catch {
            return;
          }
          if (json && typeof json === "object" && json.usage) usage = json.usage;
        },
        retrieve: () => usage,
      };
    },
    extractUsage: (response: any) => response?.usage,
    normalizeUsage: (usage: Usage): UsageInfo => {
      const inputTokens = usage?.prompt_tokens ?? 0;
      const outputTokens = usage?.completion_tokens ?? 0;
      const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;
      let cacheReadTokens = usage?.cached_tokens ?? usage?.prompt_tokens_details?.cached_tokens;
      if (opts.adjustCacheUsage && !cacheReadTokens) {
        cacheReadTokens = Math.floor(inputTokens * 0.9);
      }
      return {
        inputTokens: inputTokens - (cacheReadTokens ?? 0),
        outputTokens,
        reasoningTokens,
        cacheReadTokens,
        cacheWrite5mTokens: usage?.prompt_tokens_details?.cache_creation_input_tokens,
      };
    },
  };
}