import { describe, expect, it } from "vitest";
import { stripUnsupported } from "../src/capability.js";
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