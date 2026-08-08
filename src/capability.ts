import type { Logger } from "./logging.js";
import type { Capabilities } from "./types.js";

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