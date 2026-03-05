import type { ProviderHelper, ProviderHelperOptions } from "./provider.js";
import type { UsageInfo } from "./types.js";

type Usage = {
  input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
  total_tokens?: number;
};

/** OpenAI Responses provider helper (spec §7.2). */
export function openaiHelper(_opts: ProviderHelperOptions): ProviderHelper {
  return {
    format: "openai",
    modifyUrl: (providerApi: string) => `${providerApi}/responses`,
    modifyHeaders: (headers: Headers, apiKey: string, _stickyId: string) => {
      headers.set("authorization", `Bearer ${apiKey}`);
    },
    modifyBody: (body: Record<string, any>) => body,
    createBinaryStreamDecoder: () => undefined,
    createUsageParser: () => {
      let usage: Usage | undefined;
      return {
        parse: (chunk: string) => {
          const [event, data] = chunk.split("\n");
          if (event !== "event: response.completed") return;
          if (!data?.startsWith("data: ")) return;
          let json: any;
          try {
            json = JSON.parse(data.slice(6));
          } catch {
            return;
          }
          if (json?.usage) usage = json.usage;
        },
        retrieve: () => usage,
      };
    },
    extractUsage: (response: any) => response?.usage,
    normalizeUsage: (usage: Usage): UsageInfo => {
      const inputTokens = usage?.input_tokens ?? 0;
      const cacheReadTokens = usage?.input_tokens_details?.cached_tokens;
      return {
        inputTokens: inputTokens - (cacheReadTokens ?? 0),
        outputTokens: usage?.output_tokens ?? 0,
        reasoningTokens: usage?.output_tokens_details?.reasoning_tokens,
        cacheReadTokens,
        cacheWrite5mTokens: usage?.input_tokens_details?.cache_write_tokens,
      };
    },
  };
}