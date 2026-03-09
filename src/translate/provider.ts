import type { Format, UsageInfo } from "./types.js";
import { anthropicHelper } from "./anthropic.js";
import { oaCompatHelper } from "./openai-compat.js";
import { openaiHelper } from "./openai.js";
import { googleHelper } from "./google.js";

/** Options bound to a single request (mirrors the reference helper factory). */
export interface ProviderHelperOptions {
  /** Model id as requested by the client (after alias resolution). */
  model: string;
  /** Real OpenCode model id. */
  providerModel: string;
  adjustCacheUsage?: boolean;
}

/**
 * Per-format provider helper (spec §7.1, mirrors `anomalyco/opencode`).
 * Helpers are created per-request so model-specific behavior (e.g. the
 * anthropic `context-1m` beta header, the google URL model id) can be bound.
 */
export interface ProviderHelper {
  format: Format;
  modifyUrl: (providerApi: string, isStream?: boolean) => string;
  modifyHeaders: (headers: Headers, apiKey: string, stickyId: string) => void;
  modifyBody: (body: Record<string, any>) => Record<string, any>;
  createBinaryStreamDecoder: () => ((chunk: Uint8Array) => Uint8Array | undefined) | undefined;
  createUsageParser: () => { parse: (chunk: string) => void; retrieve: () => any };
  extractUsage: (response: any) => any;
  normalizeUsage: (usage: any) => UsageInfo;
}

export type BodyConverter = (body: any) => any;
export type ResponseConverter = (resp: any) => any;
export type StreamPartConverter = (part: string) => string;

/**
 * Converter factories (spec §7.3). `from === to` → identity. Otherwise
 * `from<Format>X` → canonical → `to<Format>X`. Cross-format translation is
 * implemented in Phase 2; until then it fails loudly.
 */
export function createBodyConverter(from: Format, to: Format): BodyConverter {
  if (from === to) return (body) => body;
  return () => {
    throw new Error(`request translation ${from} → ${to} not implemented yet`);
  };
}

export function createResponseConverter(from: Format, to: Format): ResponseConverter {
  if (from === to) return (resp) => resp;
  return () => {
    throw new Error(`response translation ${from} → ${to} not implemented yet`);
  };
}

export function createStreamPartConverter(from: Format, to: Format): StreamPartConverter {
  if (from === to) return (part) => part;
  return () => {
    throw new Error(`stream translation ${from} → ${to} not implemented yet`);
  };
}

/** Select the provider helper for a format (spec §7.1). */
export function getProvider(format: Format, opts: ProviderHelperOptions): ProviderHelper {
  switch (format) {
    case "anthropic":
      return anthropicHelper(opts);
    case "oa-compat":
      return oaCompatHelper(opts);
    case "openai":
      return openaiHelper(opts);
    case "google":
      return googleHelper(opts);
  }
}