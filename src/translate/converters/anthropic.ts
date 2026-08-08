import type {
  CommonChunk,
  CommonContentPart,
  CommonMessage,
  CommonRequest,
  CommonResponse,
  CommonTool,
  CommonToolCall,
} from "../types.js";

// ---------------------------------------------------------------------------
// Anthropic wire types (loose — we only translate the fields we care about)
// ---------------------------------------------------------------------------

export interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface AnthropicImageBlock {
  type: "image";
  source: { type: "base64" | "url"; media_type?: string; data?: string; url?: string };
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: "text"; text: string }>;
}

export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicRequest {
  model: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  system?: string | AnthropicTextBlock[];
  messages: AnthropicMessage[];
  tools?: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>;
  tool_choice?: unknown;
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "pause_turn" | null;
  stop_sequence: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export interface AnthropicChunk {
  type: string;
  index?: number;
  content_block?: AnthropicContentBlock;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string;
    stop_sequence?: string | null;
  };
  message?: AnthropicResponse;
  usage?: AnthropicResponse["usage"];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function imageToUrl(source: AnthropicImageBlock["source"]): string {
  if (source.type === "url" && source.url) return source.url;
  if (source.type === "base64" && source.data) {
    return `data:${source.media_type ?? "image/png"};base64,${source.data}`;
  }
  return "";
}

function urlToImageSource(url: string): AnthropicImageBlock["source"] {
  if (url.startsWith("data:")) {
    const m = url.match(/^data:([^;,]+);base64,(.+)$/);
    if (m) return { type: "base64", media_type: m[1], data: m[2] };
    return { type: "url", url };
  }
  return { type: "url", url };
}

function contentToString(content: string | Array<{ type: "text"; text: string }>): string {
  if (typeof content === "string") return content;
  return content.map((b) => b.text).join("\n");
}

function mapStopReason(reason: string | null | undefined): CommonChunk["choices"][0]["finish_reason"] {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return null;
  }
}

function mapFinishReason(reason: string | null | undefined): string {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "content_filter";
    default:
      return "end_turn";
  }
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}`;
}

function oaData(data: unknown): string {
  return `data: ${JSON.stringify(data)}`;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export function fromAnthropicRequest(body: AnthropicRequest): CommonRequest {
  const messages: CommonMessage[] = [];
  if (body.system) {
    const text = Array.isArray(body.system)
      ? body.system.map((b) => b.text).join("\n")
      : body.system;
    if (text) messages.push({ role: "system", content: text });
  }
  for (const m of body.messages ?? []) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    const parts: CommonContentPart[] = [];
    const toolCalls: CommonToolCall[] = [];
    const toolResults: Array<{ tool_call_id: string; content: string }> = [];
    const thinking: string[] = [];
    for (const block of m.content ?? []) {
      switch (block.type) {
        case "thinking":
          if (block.thinking) thinking.push(block.thinking);
          break;
        case "text":
          parts.push({ type: "text", text: block.text });
          break;
        case "image":
          parts.push({ type: "image_url", image_url: { url: imageToUrl(block.source) } });
          break;
        case "tool_use":
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
          break;
        case "tool_result":
          toolResults.push({ tool_call_id: block.tool_use_id, content: contentToString(block.content) });
          break;
      }
    }
    // Thinking-mode providers require the assistant's reasoning trace to come
    // back verbatim on the next turn, so carry it on the assistant message.
    const reasoning = thinking.length > 0 ? { reasoning_content: thinking.join("") } : {};
    if (m.role === "assistant" && toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: parts.length > 0 ? parts : undefined,
        tool_calls: toolCalls,
        ...reasoning,
      });
    } else if (toolResults.length > 0) {
      for (const tr of toolResults) {
        messages.push({ role: "tool", tool_call_id: tr.tool_call_id, content: tr.content });
      }
      if (parts.length > 0) messages.push({ role: m.role, content: parts });
    } else {
      messages.push({ role: m.role, content: parts.length > 0 ? parts : undefined, ...reasoning });
    }
  }
  return {
    model: body.model,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop_sequences,
    messages,
    stream: body.stream ?? false,
    tools: body.tools?.map(
      (t): CommonTool => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }),
    ),
    tool_choice: body.tool_choice,
  };
}

export function toAnthropicRequest(req: CommonRequest): AnthropicRequest {
  const system: AnthropicTextBlock[] = [];
  const messages: AnthropicMessage[] = [];

  for (const m of req.messages) {
    if (m.role === "system") {
      const text =
        typeof m.content === "string"
          ? m.content
          : (m.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join("\n");
      if (text) system.push({ type: "text", text });
      continue;
    }
    if (m.role === "tool") {
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id ?? "",
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          },
        ],
      });
      continue;
    }
    const content: AnthropicContentBlock[] = [];
    if (typeof m.content === "string") {
      if (m.content) content.push({ type: "text", text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === "text") content.push({ type: "text", text: p.text });
        else if (p.type === "image_url") {
          content.push({ type: "image", source: urlToImageSource(p.image_url.url) });
        }
      }
    }
    for (const tc of m.tool_calls ?? []) {
      content.push({
        type: "tool_use",
        id: tc.id ?? `toolu_${Math.random().toString(36).slice(2, 12)}`,
        name: tc.function.name ?? "",
        input: safeJsonParse(tc.function.arguments),
      });
    }
    messages.push({ role: m.role, content });
  }

  // cache_control on the first 4 system blocks (spec §8.2).
  for (let i = 0; i < Math.min(system.length, 4); i++) {
    const block = system[i];
    if (block) block.cache_control = { type: "ephemeral" };
  }

  return {
    model: req.model,
    max_tokens: req.max_tokens,
    temperature: req.temperature,
    top_p: req.top_p,
    stop_sequences: req.stop,
    system: system.length > 0 ? system : undefined,
    messages,
    stream: req.stream,
    tools: req.tools?.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    })),
    tool_choice: req.tool_choice,
  };
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export function fromAnthropicResponse(resp: AnthropicResponse): CommonResponse {
  const textParts: string[] = [];
  const toolCalls: CommonToolCall[] = [];
  const thinking: string[] = [];
  for (const block of resp.content ?? []) {
    if (block.type === "text") textParts.push(block.text);
    else if (block.type === "thinking") thinking.push(block.thinking);
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  return {
    id: resp.id.replace(/^msg_/, "chatcmpl_"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: resp.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: textParts.length > 0 ? textParts.join("") : undefined,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          ...(thinking.length > 0 ? { reasoning_content: thinking.join("") } : {}),
        },
        finish_reason: mapStopReason(resp.stop_reason),
      },
    ],
    usage: resp.usage
      ? {
          prompt_tokens: resp.usage.input_tokens ?? 0,
          completion_tokens: resp.usage.output_tokens ?? 0,
          total_tokens: (resp.usage.input_tokens ?? 0) + (resp.usage.output_tokens ?? 0),
          ...(resp.usage.cache_read_input_tokens !== undefined
            ? { prompt_tokens_details: { cached_tokens: resp.usage.cache_read_input_tokens } }
            : {}),
        }
      : undefined,
  };
}

export function toAnthropicResponse(resp: CommonResponse): AnthropicResponse {
  const content: AnthropicContentBlock[] = [];
  const msg = resp.choices[0].message;
  if (msg.reasoning_content) content.push({ type: "thinking", thinking: msg.reasoning_content });
  if (msg.content) content.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: tc.id ?? `toolu_${Math.random().toString(36).slice(2, 12)}`,
      name: tc.function.name ?? "",
      input: safeJsonParse(tc.function.arguments),
    });
  }
  return {
    id: resp.id.replace(/^chatcmpl_/, "msg_"),
    type: "message",
    role: "assistant",
    model: resp.model,
    content,
    stop_reason: mapFinishReason(resp.choices[0].finish_reason) as AnthropicResponse["stop_reason"],
    stop_sequence: null,
    usage: resp.usage
      ? {
          input_tokens: resp.usage.prompt_tokens,
          output_tokens: resp.usage.completion_tokens,
          cache_read_input_tokens: resp.usage.prompt_tokens_details?.cached_tokens,
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** Parse an anthropic SSE block into {event, data}. */
export function parseAnthropicBlock(block: string): { event: string; data: AnthropicChunk } | null {
  let event = "message";
  let dataLine: string | undefined;
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
  }
  if (dataLine === undefined) return null;
  try {
    return { event, data: JSON.parse(dataLine) as AnthropicChunk };
  } catch {
    return null;
  }
}

/**
 * Stateful anthropic SSE → oa-compat SSE converter. Returns the oa-compat
 * block string, or "" when the event produces no canonical chunk.
 */
export function createFromAnthropicChunk(): (part: string) => string {
  let toolIndex = -1;
  let toolId = "";
  let toolName = "";
  let toolArgs = "";
  let sawFinish = false;

  return (part: string): string => {
    const parsed = parseAnthropicBlock(part);
    if (!parsed) return part; // unparseable → passthrough
    const { event, data } = parsed;
    const id = data.message?.id ?? "chatcmpl_unknown";
    const model = data.message?.model ?? "";

    const chunk = (
      delta: CommonChunk["choices"][0]["delta"],
      finish: CommonChunk["choices"][0]["finish_reason"] = null,
      usage?: CommonChunk["usage"],
    ): string =>
      oaData({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
        usage,
      });

    switch (event) {
      case "message_start":
      case "message_stop":
      case "ping":
        return "";
      case "content_block_start": {
        const cb = data.content_block;
        if (cb?.type === "tool_use") {
          toolIndex = data.index ?? 0;
          toolId = cb.id;
          toolName = cb.name;
          toolArgs = "";
          return chunk({
            tool_calls: [{ index: toolIndex, id: toolId, type: "function", function: { name: toolName, arguments: "" } }],
          });
        }
        if (cb?.type === "thinking") return chunk({ reasoning_content: cb.thinking ?? "" });
        // text block start → empty content delta
        return chunk({ content: "" });
      }
      case "content_block_delta": {
        const d = data.delta;
        if (d?.type === "text_delta") return chunk({ content: d.text ?? "" });
        if (d?.type === "thinking_delta") return chunk({ reasoning_content: d.thinking ?? "" });
        if (d?.type === "input_json_delta") {
          toolArgs += d.partial_json ?? "";
          return chunk({
            tool_calls: [{ index: toolIndex, function: { name: toolName, arguments: d.partial_json ?? "" } }],
          });
        }
        return "";
      }
      case "content_block_stop":
        return "";
      case "message_delta": {
        const finish = mapStopReason(data.delta?.stop_reason ?? null);
        const usage = data.usage
          ? {
              prompt_tokens: data.usage.input_tokens ?? 0,
              completion_tokens: data.usage.output_tokens ?? 0,
              total_tokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
              prompt_tokens_details: { cached_tokens: data.usage.cache_read_input_tokens },
            }
          : undefined;
        if ((finish && !sawFinish) || usage) {
          if (finish) sawFinish = true;
          return chunk({}, finish, usage);
        }
        return "";
      }
      default:
        return "";
    }
  };
}

/**
 * Stateful oa-compat chunk → anthropic SSE converter. Emits a synthetic
 * `message_start` first, then content/tool deltas, and a final `message_delta`
 * with stop_reason + usage. Returns the anthropic SSE block(s) joined by
 * blank lines.
 */
export function createToAnthropicChunk(): (chunk: CommonChunk) => string {
  let started = false;
  let blockIndex = 0;
  /** oa-compat tool_call index → anthropic content block index. */
  const toolBlocks = new Map<number, number>();
  let textBlockIndex = -1;
  let thinkingBlockIndex = -1;
  let sawFinish = false;
  let sawUsage = false;
  let stopReason: string | null = null;

  return (chunk: CommonChunk): string => {
    const events: string[] = [];
    if (!started) {
      started = true;
      events.push(
        sse("message_start", {
          type: "message_start",
          message: {
            id: `msg_${Math.random().toString(36).slice(2, 12)}`,
            type: "message",
            role: "assistant",
            model: chunk.model,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );
    }

    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (delta?.reasoning_content) {
      // One open thinking block spanning consecutive reasoning deltas; closed
      // as soon as text/tool content or the finish arrives.
      if (thinkingBlockIndex === -1) {
        thinkingBlockIndex = blockIndex++;
        events.push(
          sse("content_block_start", {
            type: "content_block_start",
            index: thinkingBlockIndex,
            content_block: { type: "thinking", thinking: "" },
          }),
        );
      }
      events.push(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: thinkingBlockIndex,
          delta: { type: "thinking_delta", thinking: delta.reasoning_content },
        }),
      );
    }
    if (thinkingBlockIndex !== -1 && (delta?.content || delta?.tool_calls?.length || choice?.finish_reason)) {
      events.push(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: thinkingBlockIndex,
          delta: { type: "signature_delta", signature: "" },
        }),
      );
      events.push(sse("content_block_stop", { type: "content_block_stop", index: thinkingBlockIndex }));
      thinkingBlockIndex = -1;
    }
    if (delta?.content) {
      for (const target of toolBlocks.values()) {
        events.push(sse("content_block_stop", { type: "content_block_stop", index: target }));
      }
      toolBlocks.clear();
      // One text block spanning every consecutive text delta. Opening and
      // closing a block per delta is legal SSE but renders as one content
      // block per token, which the client lays out as separate lines.
      if (textBlockIndex === -1) {
        textBlockIndex = blockIndex++;
        events.push(
          sse("content_block_start", {
            type: "content_block_start",
            index: textBlockIndex,
            content_block: { type: "text", text: "" },
          }),
        );
      }
      events.push(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: textBlockIndex,
          delta: { type: "text_delta", text: delta.content },
        }),
      );
    }

    for (const tc of delta?.tool_calls ?? []) {
      // Parallel tool calls stream interleaved, keyed by the oa-compat
      // `index`. Each one owns its own anthropic block for the whole stream —
      // a single "current tool block" would route call 0's argument deltas
      // into call 1's block and hand the model's input to the wrong tool.
      const callIndex = tc.index ?? 0;
      if (tc.function?.name) {
        // A tool call ends the text block that preceded it.
        if (textBlockIndex !== -1) {
          events.push(sse("content_block_stop", { type: "content_block_stop", index: textBlockIndex }));
          textBlockIndex = -1;
        }
        events.push(
          sse("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: {
              type: "tool_use",
              id: tc.id ?? `toolu_${Math.random().toString(36).slice(2, 12)}`,
              name: tc.function.name,
              input: {},
            },
          }),
        );
        toolBlocks.set(callIndex, blockIndex);
        blockIndex++;
      }
      if (tc.function?.arguments) {
        const target = toolBlocks.get(callIndex);
        // Arguments before any name: the upstream never opened the call, so
        // there is no block to attach them to. Dropping beats corrupting a
        // sibling call's input.
        if (target !== undefined) {
          events.push(
            sse("content_block_delta", {
              type: "content_block_delta",
              index: target,
              delta: { type: "input_json_delta", partial_json: tc.function.arguments },
            }),
          );
        }
      }
    }

    const finish = choice?.finish_reason;
    if (finish && !sawFinish) {
      sawFinish = true;
      stopReason = mapFinishReason(finish);
      for (const target of toolBlocks.values()) {
        events.push(sse("content_block_stop", { type: "content_block_stop", index: target }));
      }
      toolBlocks.clear();
      if (textBlockIndex !== -1) {
        events.push(sse("content_block_stop", { type: "content_block_stop", index: textBlockIndex }));
        textBlockIndex = -1;
      }
      events.push(
        sse("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: 0 },
        }),
      );
    }

    if (chunk.usage && !sawUsage) {
      sawUsage = true;
      events.push(
        sse("message_delta", {
          type: "message_delta",
          // Usage lands in its own message_delta because oa-compat only sends
          // it after the finish chunk. Repeat the stop reason rather than
          // sending null, which reads as "undo the stop reason I just gave".
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: {
            input_tokens: chunk.usage.prompt_tokens ?? 0,
            output_tokens: chunk.usage.completion_tokens ?? 0,
            cache_read_input_tokens: chunk.usage.prompt_tokens_details?.cached_tokens,
          },
        }),
      );
    }

    return events.join("\n\n");
  };
}