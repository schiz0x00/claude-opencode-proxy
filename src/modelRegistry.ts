import { STATIC_MODELS, type StaticModelEntry } from "./data/models.static.js";
import type { Backend } from "./types.js";
import type { Format } from "./translate/types.js";

export interface Capabilities {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  streaming: boolean;
  promptCaching: boolean;
  structuredOutput: boolean;
  fileCompatibility: boolean;
  computerUse: boolean;
  audio: boolean;
  webSearch: boolean;
  embeddings: boolean;
}

export interface ModelEntry {
  id: string;
  format: Format;
  contextWindow: number;
  maxOutput: number;
  displayName?: string;
  capabilities: Capabilities;
  provider?: string;
}

export interface ResolvedModel {
  entry: ModelEntry;
  /** Set when the requested id carried a `[1m]` context-variant suffix. */
  contextVariant?: "1m";
}

export interface ModelRegistry {
  getBackendModels(): ModelEntry[];
  resolveModel(id: string): ResolvedModel | undefined;
  toAliasId(entry: ModelEntry): string;
  fromAliasId(alias: string): string | undefined;
  modelCount(): number;
}

const ALIAS_PREFIX = "claude-ocx-";

/** Conservative defaults for unknown models (spec §11.1). */
function defaultCapabilities(): Capabilities {
  return {
    tools: true,
    vision: false,
    reasoning: false,
    streaming: true,
    promptCaching: false,
    structuredOutput: false,
    fileCompatibility: false,
    computerUse: false,
    audio: false,
    webSearch: false,
    embeddings: false,
  };
}

/**
 * Create a registry bound to one backend (spec §10). Phase 1: static
 * snapshot only; Phase 4 adds live discovery + cache + `/v1/models`.
 */
export function createRegistry(backend: Backend): ModelRegistry {
  const entries = new Map<string, ModelEntry>();
  for (const s of STATIC_MODELS[backend]) {
    entries.set(s.id, toEntry(s));
  }

  function toEntry(s: StaticModelEntry): ModelEntry {
    return {
      id: s.id,
      format: s.format,
      contextWindow: s.contextWindow,
      maxOutput: s.maxOutput,
      displayName: s.displayName,
      provider: s.provider,
      capabilities: defaultCapabilities(),
    };
  }

  function resolveModel(id: string): ResolvedModel | undefined {
    let contextVariant: "1m" | undefined;
    let base = id;
    if (base.endsWith("[1m]")) {
      contextVariant = "1m";
      base = base.slice(0, -4);
    }
    let entry = entries.get(base);
    if (!entry) {
      const real = fromAliasId(base);
      if (real) entry = entries.get(real);
    }
    if (!entry) return undefined;
    return { entry, contextVariant };
  }

  function toAliasId(entry: ModelEntry): string {
    return `${ALIAS_PREFIX}${entry.format}--${entry.id}`;
  }

  function fromAliasId(alias: string): string | undefined {
    if (!alias.startsWith(ALIAS_PREFIX)) return undefined;
    const rest = alias.slice(ALIAS_PREFIX.length);
    const sep = rest.indexOf("--");
    if (sep === -1) return undefined;
    return rest.slice(sep + 2);
  }

  return {
    getBackendModels: () => [...entries.values()],
    resolveModel,
    toAliasId,
    fromAliasId,
    modelCount: () => entries.size,
  };
}