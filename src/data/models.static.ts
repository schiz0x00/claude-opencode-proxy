import type { Backend, Capabilities } from "../types.js";
import type { Format } from "../translate/types.js";

/**
 * Checked-in static model snapshot (spec §10.1, §10.5). Authoritative
 * baseline; the dynamic registry refresh (Phase 4) merges live data on top.
 * Context-window metadata per spec §10.5.
 */

export interface StaticModelEntry {
  id: string;
  format: Format;
  contextWindow: number;
  maxOutput: number;
  displayName?: string;
  provider?: string;
  /** Verified capability overrides; unset fields fall back to defaults. */
  capabilities?: Partial<Capabilities>;
}

const DEFAULT_CONTEXT = 200_000;
const DEFAULT_OUTPUT = 64_000;

/** [context, maxOutput] per spec §10.5. */
const CTX: Record<string, [number, number]> = {
  "deepseek-v4-pro": [1_000_000, 384_000],
  "deepseek-v4-flash": [1_000_000, 384_000],
  "glm-5.2": [1_000_000, 131_072],
  "glm-5.1": [200_000, 131_072],
  "glm-5": [200_000, 131_072],
  "kimi-k3": [1_048_576, 131_072],
  "kimi-k2.7-code": [262_144, 262_144],
  "kimi-k2.6": [262_144, 262_144],
  "kimi-k2.5": [262_144, 262_144],
  "minimax-m3": [512_000, 128_000],
  "minimax-m2.7": [204_800, 131_072],
  "minimax-m2.5": [204_800, 131_072],
  "qwen3.8-max": [1_000_000, 131_072],
  "qwen3.7-max": [1_000_000, 65_536],
  "qwen3.7-plus": [1_000_000, 64_000],
  "qwen3.6-plus": [1_000_000, 64_000],
  "qwen3.5-plus": [1_000_000, 64_000],
  "claude-fable-5": [1_000_000, 128_000],
  "claude-opus-5": [1_000_000, 128_000],
  "claude-opus-4-8": [1_000_000, 128_000],
  "claude-opus-4-7": [1_000_000, 128_000],
  "claude-opus-4-6": [1_000_000, 128_000],
  "claude-opus-4-5": [1_000_000, 128_000],
  "claude-sonnet-5": [1_000_000, 128_000],
  "claude-sonnet-4-6": [1_000_000, 64_000],
  "claude-sonnet-4-5": [200_000, 64_000],
  "claude-haiku-4-5": [200_000, 64_000],
  "gpt-5.6-sol": [1_050_000, 128_000],
  "gpt-5.6-terra": [1_050_000, 128_000],
  "gpt-5.6-luna": [1_050_000, 128_000],
  "gpt-5.5": [1_050_000, 128_000],
  "gpt-5.5-pro": [1_050_000, 128_000],
  "gpt-5.4": [1_050_000, 128_000],
  "gpt-5.4-pro": [1_050_000, 128_000],
  "gpt-5.4-mini": [1_050_000, 128_000],
  "gpt-5.4-nano": [1_050_000, 128_000],
  "gpt-5.3-codex": [400_000, 128_000],
  "gpt-5.3-codex-spark": [400_000, 128_000],
  "gpt-5.2": [400_000, 128_000],
  "gpt-5.2-codex": [400_000, 128_000],
  "gpt-5.1": [400_000, 128_000],
  "gpt-5.1-codex": [400_000, 128_000],
  "gpt-5.1-codex-max": [400_000, 128_000],
  "gpt-5.1-codex-mini": [400_000, 128_000],
  "gpt-5": [400_000, 128_000],
  "gpt-5-codex": [400_000, 128_000],
  "gpt-5-nano": [400_000, 128_000],
  "grok-4.5": [500_000, 500_000],
  "grok-build-0.1": [256_000, 256_000],
  "gemini-3.6-flash": [1_048_576, 65_536],
  "gemini-3.5-flash": [1_048_576, 65_536],
  "gemini-3.5-flash-lite": [1_048_576, 65_536],
  "gemini-3.1-pro": [1_048_576, 65_536],
  "gemini-3-flash": [1_048_576, 65_536],
  "north-mini-code-1-0": [256_000, 64_000],
  "nemotron-3-ultra-550b-a55b": [1_000_000, 128_000],
  "longcat-2.0": [1_000_000, 131_072],
  "laguna-s-2.1": [1_048_576, 32_768],
  "mimo-v2.5": [1_048_576, 131_072],
  "mimo-v2.5-pro": [1_048_576, 131_072],
  "mimo-v2-pro": [1_048_576, 131_072],
  "mimo-v2-omni": [1_048_576, 131_072],
  "hy3": [256_000, 64_000],
  "hy3-preview": [256_000, 64_000],
};

/** Free-tier display names (user-facing in the Claude Code picker). */
const DISPLAY: Record<string, string> = {
  "big-pickle": "Big Pickle",
  "deepseek-v4-flash-free": "DeepSeek V4 Flash (Free)",
  "mimo-v2.5-free": "MiMo-V2.5 (Free)",
  "laguna-s-2.1-free": "Laguna S 2.1 (Free)",
  "ling-3.0-tiny-free": "Ling-3.0 Tiny (Free)",
  "ling-3.0-flash-free": "Ling-3.0 Flash (Free)",
  "longcat-2.0-free": "LongCat-2.0 (Free)",
  "north-mini-code-free": "North Mini Code (Free)",
  "nemotron-3-ultra-free": "Nemotron 3 Ultra (Free)",
};

/**
 * Verified capability overrides for models whose conservative defaults would
 * otherwise strip supported features (spec §11.1). Values mirror the paid
 * sibling's OpenCode catalog entry (`models.opencode.ai/catalog.json`).
 */
const CAPS: Record<string, Partial<Capabilities>> = {
  // deepseek/deepseek-v4-flash (catalog): reasoning, tool_call,
  // structured_output. The free lane shares the V4 Flash feature set
  // (incl. multi-level reasoning), so thinking / output_config / cache_control
  // must pass through instead of being stripped.
  "deepseek-v4-flash-free": {
    reasoning: true,
    structuredOutput: true,
    promptCaching: true,
  },
  // xiaomi/mimo-v2.5 (catalog): reasoning, tool_call, multimodal
  // (input: text/image/audio/video).
  "mimo-v2.5-free": {
    reasoning: true,
    vision: true,
    audio: true,
    fileCompatibility: true,
  },
  // poolside/laguna-s-2.1 (catalog): reasoning, tool_call; text only.
  "laguna-s-2.1-free": {
    reasoning: true,
  },
  // meituan/longcat-2.0 (catalog): reasoning, tool_call; text only.
  "longcat-2.0-free": {
    reasoning: true,
  },
};

function m(id: string, format: Format, provider?: string): StaticModelEntry {
  const [contextWindow, maxOutput] = CTX[id] ?? [DEFAULT_CONTEXT, DEFAULT_OUTPUT];
  return {
    id,
    format,
    contextWindow,
    maxOutput,
    displayName: DISPLAY[id],
    provider,
    capabilities: CAPS[id],
  };
}

const ZEN_ANTHROPIC = [
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
  "qwen3.5-plus",
];

const ZEN_OPENAI = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5",
  "gpt-5-codex",
  "gpt-5-nano",
  "grok-4.5",
  "grok-build-0.1",
];

const ZEN_OA_COMPAT = [
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.5",
  "glm-5.2",
  "glm-5.1",
  "glm-5",
  "kimi-k3",
  "kimi-k2.7-code",
  "kimi-k2.6",
  "kimi-k2.5",
];

const ZEN_GOOGLE = [
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-pro",
  "gemini-3-flash",
];

const GO_OA_COMPAT = [
  "grok-4.5",
  "glm-5.2",
  "glm-5.1",
  "kimi-k3",
  "kimi-k2.7-code",
  "kimi-k2.6",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "hy3",
];

const GO_OPENAI = ["gpt-5.6-luna"];

const GO_ANTHROPIC = [
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.5",
  "qwen3.8-max",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
];

/** Undocumented Go models — default to oa-compat, flagged for probing. */
const GO_UNKNOWN = [
  "kimi-k2.5",
  "glm-5",
  "qwen3.5-plus",
  "mimo-v2-pro",
  "mimo-v2-omni",
  "hy3-preview",
];

const FREE = [
  "big-pickle",
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "laguna-s-2.1-free",
  "ling-3.0-tiny-free",
  "ling-3.0-flash-free",
  "longcat-2.0-free",
  "north-mini-code-free",
  "nemotron-3-ultra-free",
];

export const STATIC_MODELS: Record<Backend, StaticModelEntry[]> = {
  zen: [
    ...ZEN_ANTHROPIC.map((id) => m(id, "anthropic", "anthropic")),
    ...ZEN_OPENAI.map((id) => m(id, "openai", "openai")),
    ...ZEN_OA_COMPAT.map((id) => m(id, "oa-compat")),
    ...ZEN_GOOGLE.map((id) => m(id, "google", "google")),
  ],
  go: [
    ...GO_OA_COMPAT.map((id) => m(id, "oa-compat")),
    ...GO_OPENAI.map((id) => m(id, "openai", "openai")),
    ...GO_ANTHROPIC.map((id) => m(id, "anthropic", "anthropic")),
    ...GO_UNKNOWN.map((id) => m(id, "oa-compat")),
  ],
  free: FREE.map((id) => m(id, "oa-compat")),
};