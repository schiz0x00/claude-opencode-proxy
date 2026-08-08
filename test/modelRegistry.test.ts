import { describe, expect, it } from "vitest";
import { createRegistry } from "../src/modelRegistry.js";

describe("createRegistry", () => {
  it("loads static models for a backend", () => {
    const r = createRegistry("zen");
    expect(r.modelCount()).toBeGreaterThan(0);
    expect(r.resolveModel("claude-sonnet-4-6")).toBeDefined();
  });

  it("resolves real ids", () => {
    const r = createRegistry("free");
    const m = r.resolveModel("deepseek-v4-flash-free");
    expect(m?.entry.format).toBe("oa-compat");
  });

  it("resolves alias ids", () => {
    const r = createRegistry("zen");
    const alias = r.toAliasId(r.resolveModel("claude-sonnet-4-6")!.entry);
    expect(alias.startsWith("claude-ocx-")).toBe(true);
    const m = r.resolveModel(alias);
    expect(m?.entry.id).toBe("claude-sonnet-4-6");
  });

  it("strips [1m] context variant", () => {
    const r = createRegistry("zen");
    const m = r.resolveModel("claude-sonnet-4-6[1m]");
    expect(m?.entry.id).toBe("claude-sonnet-4-6");
    expect(m?.contextVariant).toBe("1m");
  });

  it("rejects an alias whose format does not match the registry", () => {
    const r = createRegistry("free");
    // deepseek-v4-flash-free is oa-compat; an anthropic-flavoured alias for it
    // would otherwise resolve and be sent through the wrong translator.
    expect(r.resolveModel("claude-ocx-oa-compat--deepseek-v4-flash-free")).toBeDefined();
    expect(r.resolveModel("claude-ocx-anthropic--deepseek-v4-flash-free")).toBeUndefined();
  });

  it("returns undefined for unknown ids", () => {
    const r = createRegistry("free");
    expect(r.resolveModel("does-not-exist")).toBeUndefined();
  });
});

describe("static capability metadata", () => {
  it("applies verified overrides for deepseek-v4-flash-free", () => {
    const r = createRegistry("free");
    const m = r.resolveModel("deepseek-v4-flash-free");
    // These were previously stripped (wrong warnings): thinking, output_config,
    // cache_control. The model shares the V4 Flash feature set.
    expect(m?.entry.capabilities.reasoning).toBe(true);
    expect(m?.entry.capabilities.structuredOutput).toBe(true);
    expect(m?.entry.capabilities.promptCaching).toBe(true);
    expect(m?.entry.capabilities.tools).toBe(true);
  });

  it("applies catalog-derived overrides for mimo-v2.5-free", () => {
    const r = createRegistry("free");
    const m = r.resolveModel("mimo-v2.5-free");
    expect(m?.entry.capabilities.reasoning).toBe(true);
    expect(m?.entry.capabilities.vision).toBe(true);
    expect(m?.entry.capabilities.audio).toBe(true);
  });

  it("keeps conservative defaults for unverified free models", () => {
    const r = createRegistry("free");
    const m = r.resolveModel("north-mini-code-free");
    expect(m?.entry.capabilities.reasoning).toBe(false);
    expect(m?.entry.capabilities.structuredOutput).toBe(false);
    expect(m?.entry.capabilities.promptCaching).toBe(false);
  });
});
describe("catalog refresh drives context windows", () => {
  it("takes the free lane's own window from the catalog, not the static default", async () => {
    const catalog = {
      models: { "deepseek/deepseek-v4-flash": { limit: { context: 1_000_000, output: 384_000 } } },
      providers: {
        opencode: {
          models: {
            // Same model, free lane: separately capped. The static snapshot has
            // no entry, so this is the only source of truth.
            "deepseek-v4-flash-free": { limit: { context: 200_000, output: 128_000 }, cost: { input: 0, output: 0 } },
            "longcat-2.0-free": { limit: { context: 1_000_000, output: 131_072 }, cost: { input: 0, output: 0 } },
            "claude-opus-5": { limit: { context: 1_000_000, output: 128_000 }, cost: { input: 5, output: 25 } },
          },
        },
      },
    };
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: any) =>
      new Response(
        JSON.stringify(
          String(url).includes("catalog.json")
            ? catalog
            : { data: [{ id: "deepseek-v4-flash-free" }, { id: "longcat-2.0-free" }, { id: "claude-opus-5" }] },
        ),
        { status: 200 },
      )) as typeof fetch;
    try {
      const r = createRegistry("free");
      await r.refresh({
        baseUrl: "https://example.invalid/v1",
        cacheFile: `/tmp/registry-test-${Date.now()}.json`,
        logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
      });
      expect(r.resolveModel("deepseek-v4-flash-free")?.entry.contextWindow).toBe(200_000);
      // A paid model returned by the shared Zen /models endpoint is not
      // servable on the free lane, which sends no key.
      expect(r.resolveModel("claude-opus-5")).toBeUndefined();
      expect(r.resolveModel("longcat-2.0-free")?.entry.contextWindow).toBe(1_000_000);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("cache freshness", () => {
  it("skips the network while the cache is younger than the TTL", async () => {
    const { writeFile } = await import("node:fs/promises");
    const cacheFile = `/tmp/registry-fresh-${Date.now()}.json`;
    await writeFile(
      cacheFile,
      JSON.stringify({
        version: 1,
        backend: "free",
        fetchedAt: Math.floor(Date.now() / 1000),
        models: [{ id: "cached-only-model", format: "oa-compat", contextWindow: 1234, maxOutput: 10 }],
      }),
    );
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const r = createRegistry("free");
      await r.refresh({
        baseUrl: "https://example.invalid/v1",
        cacheFile,
        logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
        maxCacheAgeSeconds: 86_400,
      });
      expect(calls).toBe(0);
      expect(r.resolveModel("cached-only-model")?.entry.contextWindow).toBe(1234);
    } finally {
      globalThis.fetch = original;
    }
  });
});
