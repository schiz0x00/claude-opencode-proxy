import type { Logger } from "./logging.js";
import type { ReasoningOptions } from "./modelRegistry.js";
import type { Capabilities } from "./types.js";

/** Effort ladder, weakest first. Catalog values are a subset of this order. */
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Claude Code expresses reasoning effort only as `thinking.budget_tokens`
 * ("think" ≈ 4k, "megathink" ≈ 10k, "ultrathink" ≈ 32k). Non-anthropic
 * backends want a different knob, and which knob varies per model — the
 * catalog's `reasoning_options` says which (spec §11.1). Map the budget onto
 * whatever the model actually accepts, mutating `upstreamBody` in place.
 *
 * No-op when the request has no thinking block or the model advertises no
 * reasoning options, so models that reject these fields never see them.
 */
export function applyReasoningEffort(
  upstreamBody: Record<string, any>,
  thinking: unknown,
  options: ReasoningOptions | undefined,
): void {
  if (!options) return;
  const t = thinking as { type?: string; budget_tokens?: number } | undefined;
  if (!t || typeof t !== "object") return;
  if (t.type !== "enabled") return;

  const budget = typeof t.budget_tokens === "number" ? t.budget_tokens : undefined;

  // An explicit budget is the most faithful mapping — pass it through, clamped
  // to the range the model documents.
  if (options.budgetTokens && budget !== undefined) {
    const { min, max } = options.budgetTokens;
    let value = budget;
    if (min !== undefined) value = Math.max(value, min);
    if (max !== undefined) value = Math.min(value, max);
    upstreamBody.thinking = { type: "enabled", budget_tokens: value };
    return;
  }

  if (options.effort && options.effort.length > 0) {
    upstreamBody.reasoning_effort = pickEffort(options.effort, budget);
    return;
  }

  // Toggle-only models take no level, just "reason at all".
  if (options.toggle) upstreamBody.thinking = { type: "enabled" };
}

/**
 * DeepSeek-family thinking mode rejects any request whose history contains an
 * assistant message without `reasoning_content` once tools are in play
 * ("The `reasoning_content` in the thinking mode must be passed back to the
 * API.", HTTP 400). Claude Code drops thinking blocks from older turns, so the
 * trace is genuinely gone by then — an empty string satisfies the check.
 *
 * Only fills messages that carry none; real traces translated from `thinking`
 * blocks are left untouched. Mutates `upstreamBody` in place.
 */
export function backfillReasoningContent(upstreamBody: Record<string, any>): void {
  if (!Array.isArray(upstreamBody.messages)) return;
  for (const msg of upstreamBody.messages) {
    if (msg?.role !== "assistant") continue;
    if (typeof msg.reasoning_content !== "string") msg.reasoning_content = "";
  }
}

/**
 * Pick the advertised effort value closest to the requested budget. The
 * thresholds mirror Claude Code's three tiers; `none`/`minimal` are never
 * chosen for an enabled thinking block, since asking to think and being told
 * not to is worse than the nearest real level.
 */
function pickEffort(values: string[], budget: number | undefined): string {
  const ladder = values
    .filter((v) => EFFORT_ORDER.includes(v))
    .sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  if (ladder.length === 0) return values[0] as string;
  const usable = ladder.filter((v) => v !== "none" && v !== "minimal");
  const scale = usable.length > 0 ? usable : ladder;
  // <8k → weakest, <20k → middle, else strongest.
  const tier = budget === undefined || budget >= 20_000 ? 2 : budget >= 8_000 ? 1 : 0;
  const index = [0, Math.floor((scale.length - 1) / 2), scale.length - 1][tier] as number;
  return scale[index] as string;
}

/**
 * Strip/downgrade unsupported capabilities from an Anthropic request body
 * before forwarding (spec §11.2). Never let an unsupported capability reach
 * the backend — it 400s and breaks the session.
 *
 * Mutates `body` in place and returns it. `warned` tracks which capabilities
 * were stripped so a single request logs each warning once.
 */
export function stripUnsupported(
  body: Record<string, any>,
  caps: Capabilities,
  logger: Logger,
): Record<string, any> {
  const warned = new Set<string>();
  const warnOnce = (key: string, msg: string): void => {
    if (warned.has(key)) return;
    warned.add(key);
    logger.warn(msg);
  };

  // Tool calling.
  if (!caps.tools && (body.tools !== undefined || body.tool_choice !== undefined)) {
    delete body.tools;
    delete body.tool_choice;
    warnOnce("tools", "stripping tools/tool_choice: model does not support tool calling");
  }

  // Reasoning / thinking.
  if (!caps.reasoning && body.thinking !== undefined) {
    delete body.thinking;
    warnOnce("thinking", "stripping thinking: model does not support reasoning");
  }

  // Structured output.
  if (!caps.structuredOutput) {
    if (body.output_config !== undefined) {
      delete body.output_config;
      warnOnce("output_config", "stripping output_config: model does not support structured output");
    }
    if (body.response_format !== undefined) {
      delete body.response_format;
      warnOnce("response_format", "stripping response_format: model does not support structured output");
    }
  }

  // Prompt caching: strip cache_control from system blocks and tools.
  if (!caps.promptCaching) {
    let stripped = false;
    if (Array.isArray(body.system)) {
      for (const block of body.system) {
        if (block && typeof block === "object" && "cache_control" in block) {
          delete block.cache_control;
          stripped = true;
        }
      }
    }
    if (Array.isArray(body.tools)) {
      for (const tool of body.tools) {
        if (tool && typeof tool === "object" && "cache_control" in tool) {
          delete tool.cache_control;
          stripped = true;
        }
      }
    }
    if (stripped) warnOnce("cache_control", "stripping cache_control: model does not support prompt caching");
  }

  // Vision / audio / file blocks inside message content.
  if (!caps.vision || !caps.audio || !caps.fileCompatibility) {
    const stripTypes: string[] = [];
    if (!caps.vision) stripTypes.push("image");
    if (!caps.audio) stripTypes.push("audio");
    if (!caps.fileCompatibility) stripTypes.push("document", "file");
    if (stripTypes.length > 0 && Array.isArray(body.messages)) {
      let removed = 0;
      for (const msg of body.messages) {
        if (!msg || !Array.isArray(msg.content)) continue;
        msg.content = msg.content.filter((block: any) => {
          if (block && typeof block === "object" && stripTypes.includes(block.type)) {
            removed++;
            return false;
          }
          return true;
        });
      }
      if (removed > 0) {
        warnOnce("blocks", `stripping ${removed} unsupported content block(s) (${stripTypes.join(", ")})`);
      }
    }
  }

  // Computer-use / web-search tools.
  if (!caps.computerUse || !caps.webSearch) {
    const banned: string[] = [];
    if (!caps.computerUse) banned.push("computer");
    if (!caps.webSearch) banned.push("web_search");
    if (banned.length > 0 && Array.isArray(body.tools)) {
      const before = body.tools.length;
      body.tools = body.tools.filter((tool: any) => !banned.includes(tool?.name));
      if (body.tools.length !== before) {
        warnOnce("tools-banned", `stripping ${before - body.tools.length} tool(s): ${banned.join(", ")}`);
      }
    }
  }

  return body;
}