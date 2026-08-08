import type { ProviderHelper, ProviderHelperOptions } from "./provider.js";
import type { UsageInfo } from "./types.js";

type Usage = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
};

/** Gemini generateContent provider helper (spec §7.2). Model id in the URL. */
export function googleHelper(opts: ProviderHelperOptions): ProviderHelper {
  return {
    format: "google",
    modifyUrl: (providerApi: string, isStream?: boolean) =>
      `${providerApi}/models/${opts.providerModel}:${
        isStream ? "streamGenerateContent?alt=sse" : "generateContent"
      }`,
    modifyHeaders: (headers: Headers, apiKey: string, _stickyId: string) => {
      headers.set("x-goog-api-key", apiKey);
    },
    modifyBody: (body: Record<string, any>) => body,
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
          if (json?.usageMetadata) usage = json.usageMetadata;
        },
        retrieve: () => usage,
      };
    },
    extractUsage: (response: any) => response?.usageMetadata,
    normalizeUsage: (usage: Usage): UsageInfo => {
      const inputTokens = usage?.promptTokenCount ?? 0;
      const cacheReadTokens = usage?.cachedContentTokenCount;
      return {
        inputTokens: inputTokens - (cacheReadTokens ?? 0),
        outputTokens: usage?.candidatesTokenCount ?? 0,
        reasoningTokens: usage?.thoughtsTokenCount,
        cacheReadTokens,
      };
    },
  };
}