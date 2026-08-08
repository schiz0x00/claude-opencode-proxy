import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { STATIC_MODELS, type StaticModelEntry } from "./data/models.static.js";
import type { Logger } from "./logging.js";
import type { Backend, Capabilities } from "./types.js";
import type { Format } from "./translate/types.js";

export type { Capabilities } from "./types.js";

/**
 * Reasoning knobs a model accepts, read from the catalog's `reasoning_options`
 * (spec §11.1). Providers disagree on the wire field, so we record what the
 * catalog advertises and let the request path pick one.
 */
export interface ReasoningOptions {
  /** Accepted `reasoning_effort` values, in catalog order (weakest first). */
  effort?: string[];
  /** Model takes a plain on/off reasoning toggle. */
  toggle?: boolean;
  /** Model takes an explicit thinking-token budget. */
  budgetTokens?: { min?: number; max?: number };
}

export interface ModelEntry {
  id: string;
  format: Format;
  contextWindow: number;
  maxOutput: number;
  displayName?: string;
  capabilities: Capabilities;
  provider?: string;
  reasoningOptions?: ReasoningOptions;
}

export interface ResolvedModel {
  entry: ModelEntry;
  /** Set when the requested id carried a `[1m]` context-variant suffix. */
  contextVariant?: "1m";
}

export interface RegistryRefreshOptions {
  /** Upstream base URL used for live `GET {base}/v1/models` discovery. */
  baseUrl: string;
  /** Cache file path (mode 0600). */
  cacheFile: string;
  logger: Logger;
  /** Per-fetch timeout in ms (default 3000). */
  timeoutMs?: number;
}

export interface ModelRegistry {
  getBackendModels(): ModelEntry[];
  resolveModel(id: string): ResolvedModel | undefined;
  toAliasId(entry: ModelEntry): string;
  fromAliasId(alias: string): string | undefined;
  modelCount(): number;
  /** Live discovery + catalog merge + cache (spec §10.4). */
  refresh(opts: RegistryRefreshOptions): Promise<void>;
}

const ALIAS_PREFIX = "claude-ocx-";
const CATALOG_URL = "https://models.opencode.ai/catalog.json";

/** Catalog provider key per backend (`providers.<id>.models`). */
const CATALOG_PROVIDER: Record<Backend, string> = {
  zen: "opencode",
  free: "opencode",
  go: "opencode-go",
};
const CACHE_VERSION = 1;

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

interface CacheFile {
  version: number;
  backend: Backend;
  fetchedAt: number;
  models: Array<{
    id: string;
    format: Format;
    contextWindow: number;
    maxOutput: number;
    displayName?: string;
    provider?: string;
    capabilities?: Partial<Capabilities>;
    reasoningOptions?: ReasoningOptions;
  }>;
}

interface CatalogMeta {
  contextWindow?: number;
  maxOutput?: number;
  capabilities?: Partial<Capabilities>;
  reasoningOptions?: ReasoningOptions;
}

/** Expand `~` in a cache path. */
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

/**
 * Create a registry bound to one backend (spec §10). Static snapshot is the
 * authoritative baseline; `refresh()` merges live discovery + catalog on top
 * and persists to a 0600 cache file.
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
      capabilities: { ...defaultCapabilities(), ...(s.capabilities ?? {}) },
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

  /** Load the cache file; returns entries or undefined on any failure. */
  async function loadCache(cacheFile: string): Promise<CacheFile["models"] | undefined> {
    try {
      const raw = await readFile(expandHome(cacheFile), "utf8");
      const parsed = JSON.parse(raw) as CacheFile;
      if (parsed.version !== CACHE_VERSION || parsed.backend !== backend) return undefined;
      if (!Array.isArray(parsed.models)) return undefined;
      return parsed.models;
    } catch {
      return undefined;
    }
  }

  /** Persist the current entries to the cache file (mode 0600). */
  async function saveCache(cacheFile: string): Promise<void> {
    const data: CacheFile = {
      version: CACHE_VERSION,
      backend,
      fetchedAt: Math.floor(Date.now() / 1000),
      models: [...entries.values()].map((e) => ({
        id: e.id,
        format: e.format,
        contextWindow: e.contextWindow,
        maxOutput: e.maxOutput,
        displayName: e.displayName,
        provider: e.provider,
        capabilities: e.capabilities,
        reasoningOptions: e.reasoningOptions,
      })),
    };
    const file = expandHome(cacheFile);
    // Ensure the parent directory exists (fresh installs have no
    // `~/.claude-opencode-proxy/` yet); otherwise writeFile throws ENOENT.
    await mkdir(path.dirname(file), { recursive: true });
    // Write atomically (temp file + rename) so a crash/torn write never leaves
    // a partially-written cache (spec §3.2/§10.4), and keep mode 0600.
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await rename(tmp, file);
  }

  /**
   * Fetch live model ids from `{base}/models` (bare ids, spec §10.4). The
   * base URL already carries `/v1`, so appending it again 404s and silently
   * disables discovery *and* the catalog merge that rides along with it.
   */
  async function fetchLiveIds(baseUrl: string, timeoutMs: number): Promise<string[]> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/models`, { signal: controller.signal });
      if (!res.ok) return [];
      const json = (await res.json()) as { data?: Array<{ id?: string }> };
      return (json.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
    } finally {
      clearTimeout(t);
    }
  }

  /** Fetch catalog metadata (context/output/capabilities) from models.opencode.ai. */
  async function fetchCatalog(
    timeoutMs: number,
  ): Promise<Map<string, CatalogMeta>> {
    const out = new Map<string, CatalogMeta>();
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(CATALOG_URL, { signal: controller.signal });
      if (!res.ok) return out;
      const json = (await res.json()) as {
        models?: Record<string, unknown>;
        providers?: Record<string, { models?: Record<string, unknown> }>;
      };
      // Top-level `models` is keyed `<provider>/<model>` (e.g.
      // "deepseek/deepseek-v4-pro"). Map to the bare id used by live discovery
      // and the static snapshot.
      for (const [key, value] of Object.entries(json.models ?? {})) {
        const id = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
        out.set(id, catalogMeta(value));
      }
      // The OpenCode-served models are absent from that top-level map — they
      // live only under `providers.<id>.models`, keyed by bare id. Read those
      // last so the provider's own metadata wins for the ids we actually route.
      const providerModels = json.providers?.[CATALOG_PROVIDER[backend]]?.models ?? {};
      for (const [id, value] of Object.entries(providerModels)) {
        out.set(id, catalogMeta(value));
      }
    } catch {
      // ignore — catalog is best-effort
    } finally {
      clearTimeout(t);
    }
    return out;
  }

  /**
   * Read the catalog's `reasoning_options` array — a list of the knobs the
   * model accepts, e.g. `[{type:"toggle"},{type:"effort",values:[...]}]` or
   * `[{type:"budget_tokens",min:1024}]`. Returns undefined when the model
   * advertises none (the array is present-but-empty for non-reasoning models).
   */
  function parseReasoningOptions(raw: unknown): ReasoningOptions | undefined {
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    const out: ReasoningOptions = {};
    for (const opt of raw) {
      if (!opt || typeof opt !== "object") continue;
      const o = opt as Record<string, any>;
      if (o.type === "toggle") out.toggle = true;
      else if (o.type === "effort" && Array.isArray(o.values)) {
        const values = o.values.filter((v: unknown): v is string => typeof v === "string");
        if (values.length > 0) out.effort = values;
      } else if (o.type === "budget_tokens") {
        out.budgetTokens = {
          ...(typeof o.min === "number" ? { min: o.min } : {}),
          ...(typeof o.max === "number" ? { max: o.max } : {}),
        };
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /** Extract capability metadata from a catalog entry (spec §11.1). */
  function catalogMeta(value: unknown): CatalogMeta {
    const v = (value ?? {}) as Record<string, any>;
    const limit = (v.limit ?? {}) as Record<string, any>;
    const modalities = (v.modalities ?? {}) as Record<string, any>;
    const input = Array.isArray(modalities.input) ? modalities.input : [];
    return {
      contextWindow: limit.context,
      maxOutput: limit.output,
      reasoningOptions: parseReasoningOptions(v.reasoning_options),
      capabilities: {
        reasoning: v.reasoning === true,
        tools: v.tool_call !== false,
        vision: input.includes("image"),
        audio: input.includes("audio"),
        structuredOutput: v.structured_output === true,
        fileCompatibility: v.attachment === true,
      },
    };
  }

  // In-flight guard: never run two refreshes concurrently (spec §3.2).
  let refreshInFlight: Promise<void> | null = null;

  async function refresh(opts: RegistryRefreshOptions): Promise<void> {
    // A scheduled refresh that fires while one is already running simply joins
    // the in-flight refresh rather than duplicating network + cache writes.
    if (refreshInFlight) {
      await refreshInFlight;
      return;
    }
    refreshInFlight = doRefresh(opts).finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  async function doRefresh(opts: RegistryRefreshOptions): Promise<void> {
    const { baseUrl, cacheFile, logger } = opts;
    const timeoutMs = opts.timeoutMs ?? 3000;

    // 1. Cache is the fastest baseline (offline startup works). Merge it over
    // the static snapshot so checked-in capability metadata survives; the
    // cache fills in last-known context/output and adds discovered ids.
    const cached = await loadCache(cacheFile);
    if (cached && cached.length > 0) {
      applyCache(cached);
      logger.debug(`model cache loaded (${cached.length} models)`);
    }

    // 2. Live discovery + catalog metadata.
    let liveIds: string[] = [];
    let catalog: Map<string, CatalogMeta> = new Map();
    try {
      [liveIds, catalog] = await Promise.all([fetchLiveIds(baseUrl, timeoutMs), fetchCatalog(timeoutMs)]);
    } catch {
      // fall through with whatever we have
    }

    if (liveIds.length > 0) {
      // Live ids win: keep existing metadata where known, else defaults.
      const merged: Array<Omit<ModelEntry, "capabilities"> & { capabilities?: Partial<Capabilities> }> = [];
      for (const id of liveIds) {
        const existing = entries.get(id);
        const cat = catalog.get(id);
        merged.push({
          id,
          format: existing?.format ?? defaultFormatFor(id),
          contextWindow: cat?.contextWindow ?? existing?.contextWindow ?? 200_000,
          maxOutput: cat?.maxOutput ?? existing?.maxOutput ?? 64_000,
          displayName: existing?.displayName,
          provider: existing?.provider,
          reasoningOptions: cat?.reasoningOptions ?? existing?.reasoningOptions,
          // Catalog caps win where known; otherwise keep the existing
          // (static/cached) capabilities instead of resetting to defaults.
          capabilities: { ...(existing?.capabilities ?? {}), ...(cat?.capabilities ?? {}) },
        });
      }
      // Static-only models not seen live are kept (docs may lag the API).
      for (const [id, e] of entries) {
        if (!merged.some((m) => m.id === id)) merged.push(e);
      }
      mergeEntries(merged);
      logger.info(`model discovery: ${liveIds.length} live ids, ${entries.size} total`);
    } else if (catalog.size > 0) {
      // Discovery unavailable (offline, 404, auth): still take catalog
      // metadata for the ids we already know, so reasoning options and
      // context limits are not lost with it.
      for (const [id, e] of entries) {
        const cat = catalog.get(id);
        if (!cat) continue;
        entries.set(id, {
          ...e,
          contextWindow: cat.contextWindow ?? e.contextWindow,
          maxOutput: cat.maxOutput ?? e.maxOutput,
          reasoningOptions: cat.reasoningOptions ?? e.reasoningOptions,
          capabilities: { ...e.capabilities, ...(cat.capabilities ?? {}) },
        });
      }
      logger.debug(`catalog merge only: ${entries.size} models`);
    }

    // 3. Persist.
    await saveCache(cacheFile);
  }

  /** Default format for a live id with no static metadata (conservative). */
  function defaultFormatFor(_id: string): Format {
    // Every currently-known free/undocumented model routes through
    // chat/completions; chat/completions is also the safest default.
    return "oa-compat";
  }

  /**
   * Merge cached models over the current (static) entries. Static entries
   * keep their checked-in capability metadata; the cache supplies last-known
   * context/output and adds discovered ids not present in the snapshot.
   */
  function applyCache(cached: CacheFile["models"]): void {
    for (const c of cached) {
      const existing = entries.get(c.id);
      if (existing) {
        entries.set(c.id, {
          ...existing,
          ...c,
          capabilities: { ...existing.capabilities, ...(c.capabilities ?? {}) },
        });
      } else {
        entries.set(c.id, {
          ...c,
          capabilities: { ...defaultCapabilities(), ...(c.capabilities ?? {}) },
        });
      }
    }
  }

  function mergeEntries(models: Array<Omit<ModelEntry, "capabilities"> & { capabilities?: Partial<Capabilities> }>): void {
    entries.clear();
    for (const m of models) {
      entries.set(m.id, {
        ...m,
        capabilities: { ...defaultCapabilities(), ...(m.capabilities ?? {}) },
      });
    }
  }

  return {
    getBackendModels: () => [...entries.values()],
    resolveModel,
    toAliasId,
    fromAliasId,
    modelCount: () => entries.size,
    refresh,
  };
}