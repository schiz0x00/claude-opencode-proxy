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