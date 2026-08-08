import { describe, expect, it } from "vitest";
import { applyReasoningEffort, stripUnsupported } from "../src/capability.js";
import { createLogger } from "../src/logging.js";

const logger = createLogger("error");

function caps(overrides: Partial<Record<string, boolean>> = {}) {
  return {
    tools: true,
    vision: true,
    reasoning: true,
    streaming: true,
    promptCaching: true,
    structuredOutput: true,
    fileCompatibility: true,
    computerUse: true,
    audio: true,
    webSearch: true,
    embeddings: true,
    ...overrides,
  };
}

describe("stripUnsupported", () => {
  it("removes tools + tool_choice when tool calling unsupported", () => {
    const body = { tools: [{ name: "Bash" }], tool_choice: { type: "auto" }, messages: [] };
    stripUnsupported(body, caps({ tools: false }), logger);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it("removes thinking when reasoning unsupported", () => {
    const body = { thinking: { type: "enabled", budget_tokens: 1024 }, messages: [] };
    stripUnsupported(body, caps({ reasoning: false }), logger);
    expect(body.thinking).toBeUndefined();
  });

  it("strips output_config / response_format when structured output unsupported", () => {
    const body = { output_config: { effort: "high" }, response_format: { type: "json" }, messages: [] };
    stripUnsupported(body, caps({ structuredOutput: false }), logger);
    expect(body.output_config).toBeUndefined();
    expect(body.response_format).toBeUndefined();
  });

  it("strips cache_control from system and tools when prompt caching unsupported", () => {
    const body = {
      system: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "Bash", cache_control: { type: "ephemeral" } }],
      messages: [],
    };
    stripUnsupported(body, caps({ promptCaching: false }), logger);
    expect(body.system[0].cache_control).toBeUndefined();
    expect(body.tools[0].cache_control).toBeUndefined();
  });

  it("removes image blocks when vision unsupported", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: "a" }, { type: "image", source: { type: "url", url: "x" } }] },
      ],
    };
    stripUnsupported(body, caps({ vision: false }), logger);
    expect(body.messages[0].content).toEqual([{ type: "text", text: "a" }]);
  });

  it("removes computer and web_search tools when unsupported", () => {
    const body = {
      tools: [{ name: "Bash" }, { name: "computer" }, { name: "web_search" }],
      messages: [],
    };
    stripUnsupported(body, caps({ computerUse: false, webSearch: false }), logger);
    expect(body.tools).toEqual([{ name: "Bash" }]);
  });

  it("leaves a fully-capable body untouched", () => {
    const body = {
      tools: [{ name: "Bash" }],
      thinking: { type: "enabled", budget_tokens: 1024 },
      system: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "a" }, { type: "image", source: { type: "url", url: "x" } }] },
      ],
    };
    const before = JSON.stringify(body);
    stripUnsupported(body, caps(), logger);
    expect(JSON.stringify(body)).toBe(before);
  });
});
// ---------------------------------------------------------------------------
// Reasoning effort: Claude Code only sends `thinking.budget_tokens`, so the
// budget must land on whatever knob the catalog says the model accepts.
// ---------------------------------------------------------------------------

describe("applyReasoningEffort", () => {
  const think = (budget: number) => ({ type: "enabled", budget_tokens: budget });

  it("maps budgets onto the model's advertised effort ladder", () => {
    // deepseek-v4-flash-free advertises ["low","high","max"].
    const values = ["low", "high", "max"];
    const at = (budget: number) => {
      const body: Record<string, any> = {};
      applyReasoningEffort(body, think(budget), { effort: values });
      return body.reasoning_effort;
    };
    expect(at(4_000)).toBe("low"); // "think"
    expect(at(10_000)).toBe("high"); // "megathink"
    expect(at(32_000)).toBe("max"); // "ultrathink"
  });

  it("never picks none/minimal for an enabled thinking block", () => {
    const body: Record<string, any> = {};
    applyReasoningEffort(body, think(1_000), { effort: ["none", "minimal", "low", "high"] });
    expect(body.reasoning_effort).toBe("low");
  });

  it("prefers an explicit budget, clamped to the documented range", () => {
    const body: Record<string, any> = {};
    applyReasoningEffort(body, think(500), { budgetTokens: { min: 1024 } });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  it("sends a bare toggle when that is all the model takes", () => {
    const body: Record<string, any> = {};
    applyReasoningEffort(body, think(32_000), { toggle: true });
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("touches nothing without a thinking block or without catalog options", () => {
    const a: Record<string, any> = {};
    applyReasoningEffort(a, undefined, { effort: ["low", "high"] });
    expect(a).toEqual({});
    const b: Record<string, any> = {};
    applyReasoningEffort(b, think(10_000), undefined);
    expect(b).toEqual({});
  });
});
