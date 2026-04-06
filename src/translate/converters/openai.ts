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
// OpenAI Responses API wire types
// ---------------------------------------------------------------------------

export interface OpenAIRequest {
  model: string;
  instructions?: string;
  input: Array<{
    role: "user" | "assistant" | "system";
    content?: Array<{
      type: string;
      text?: string;
      image_url?: string;
      call_id?: string;
      name?: string;
      arguments?: string;
      output?: string;
    }>;
  }>;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: CommonTool[];
  tool_choice?: unknown;
}

export interface OpenAIResponse {
  id: string;
  object: "response";
  model: string;
  output?: Array<{
    type: string;
    role?: string;
    content?: Array<{ type: string; text?: string }>;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export function fromOpenAIRequest(body: OpenAIRequest): CommonRequest {
  const messages: CommonMessage[] = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });
  for (const item of body.input ?? []) {
    const parts: CommonContentPart[] = [];
    const toolCalls: CommonToolCall[] = [];
    let toolResult: { call_id: string; output: string } | undefined;
    for (const c of item.content ?? []) {
      switch (c.type) {
        case "input_text":
        case "output_text":
          if (c.text) parts.push({ type: "text", text: c.text });
          break;
        case "input_image":
          if (c.image_url) parts.push({ type: "image_url", image_url: { url: c.image_url } });
          break;
        case "function_call":
          toolCalls.push({
            id: c.call_id ?? "",
            type: "function",
            function: { name: c.name ?? "", arguments: c.arguments ?? "{}" },
          });
          break;
        case "function_call_output":
          toolResult = { call_id: c.call_id ?? "", output: c.output ?? "" };
          break;
      }
    }
    if (item.role === "assistant" && toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: parts.length > 0 ? parts : undefined,
        tool_calls: toolCalls,
      });
    } else if (toolResult) {
      messages.push({ role: "tool", tool_call_id: toolResult.call_id, content: toolResult.output });
    } else if (parts.length > 0) {
      messages.push({ role: item.role === "system" ? "system" : item.role, content: parts });
    }
  }
  return {
    model: body.model,
    max_tokens: body.max_output_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    messages,
    stream: body.stream ?? false,
    tools: body.tools,
    tool_choice: body.tool_choice,
  };
}

export function toOpenAIRequest(req: CommonRequest): OpenAIRequest {
  const instructions: string[] = [];
  const input: OpenAIRequest["input"] = [];
  for (const m of req.messages) {
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : "";
      if (text) instructions.push(text);
      continue;
    }
    if (m.role === "tool") {
      input.push({
        role: "user",
        content: [
          {
            type: "function_call_output",
            call_id: m.tool_call_id ?? "",
            output: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          },
        ],
      });
      continue;
    }
    const content: NonNullable<OpenAIRequest["input"]>[number]["content"] = [];
    if (typeof m.content === "string") {
      if (m.content) content.push({ type: "input_text", text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === "text") content.push({ type: "input_text", text: p.text });
        else if (p.type === "image_url") content.push({ type: "input_image", image_url: p.image_url.url });
      }
    }
    for (const tc of m.tool_calls ?? []) {
      content.push({
        type: "function_call",
        call_id: tc.id ?? "",
        name: tc.function.name,
        arguments: tc.function.arguments,
      });
    }
    input.push({ role: m.role, content });
  }
  return {
    model: req.model,
    instructions: instructions.length > 0 ? instructions.join("\n") : undefined,
    input,
    max_output_tokens: req.max_tokens,
    temperature: req.temperature,
    top_p: req.top_p,
    stream: req.stream,
    tools: req.tools,
    tool_choice: req.tool_choice,
  };
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export function fromOpenAIResponse(resp: OpenAIResponse): CommonResponse {
  const textParts: string[] = [];
  const toolCalls: CommonToolCall[] = [];
  for (const item of resp.output ?? []) {
    if (item.type === "message") {
      for (const c of item.content ?? []) if (c.text) textParts.push(c.text);
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id ?? item.id ?? "",
        type: "function",
        function: { name: item.name ?? "", arguments: item.arguments ?? "{}" },
      });
    }
  }
  return {
    id: resp.id.replace(/^resp_/, "chatcmpl_"),
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
        },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: resp.usage
      ? {
          prompt_tokens: resp.usage.input_tokens ?? 0,
          completion_tokens: resp.usage.output_tokens ?? 0,
          total_tokens: resp.usage.total_tokens,
          prompt_tokens_details: { cached_tokens: resp.usage.input_tokens_details?.cached_tokens },
        }
      : undefined,
  };
}

export function toOpenAIResponse(resp: CommonResponse): OpenAIResponse {
  const output: OpenAIResponse["output"] = [];
  const msg = resp.choices[0].message;
  if (msg.content) {
    output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: msg.content }] });
  }
  for (const tc of msg.tool_calls ?? []) {
    output.push({
      type: "function_call",
      id: tc.id ?? "",
      call_id: tc.id ?? "",
      name: tc.function.name,
      arguments: tc.function.arguments,
    });
  }
  return {
    id: resp.id.replace(/^chatcmpl_/, "resp_"),
    object: "response",
    model: resp.model,
    output,
    usage: resp.usage
      ? {
          input_tokens: resp.usage.prompt_tokens,
          output_tokens: resp.usage.completion_tokens,
          total_tokens: resp.usage.total_tokens,
          input_tokens_details: { cached_tokens: resp.usage.prompt_tokens_details?.cached_tokens },
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export interface OpenAIStreamEvent {
  event: string;
  data: any;
}

/** Parse an OpenAI Responses SSE block into {event, data}. */
export function parseOpenAIBlock(block: string): OpenAIStreamEvent | null {
  let event = "message";
  let dataLine: string | undefined;
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
  }
  if (dataLine === undefined) return null;
  try {
    return { event, data: JSON.parse(dataLine) };
  } catch {
    return null;
  }
}

/**
 * Stateful OpenAI Responses SSE → oa-compat chunk converter. Returns a
 * CommonChunk or null (skip).
 */
export function createFromOpenAIChunk(): (part: string) => CommonChunk | null {
  let toolIndex = -1;
  let toolId = "";
  let toolName = "";
  let toolArgs = "";
  let sawFinish = false;

  return (part: string): CommonChunk | null => {
    const parsed = parseOpenAIBlock(part);
    if (!parsed) return null;
    const { event, data } = parsed;
    const id = "chatcmpl_" + (data.item_id ?? "unknown");
    const model = data.model ?? "";

    const chunk = (
      delta: CommonChunk["choices"][0]["delta"],
      finish: CommonChunk["choices"][0]["finish_reason"] = null,
      usage?: CommonChunk["usage"],
    ): CommonChunk => ({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      usage,
    });

    switch (event) {
      case "response.output_text.delta":
        return chunk({ content: data.delta ?? "" });
      case "response.output_item.added": {
        const item = data.item;
        if (item?.type === "function_call") {
          toolIndex = data.output_index ?? 0;
          toolId = item.id ?? item.call_id ?? "";
          toolName = item.name ?? "";
          toolArgs = "";
          return chunk({
            tool_calls: [{ index: toolIndex, id: toolId, type: "function", function: { name: toolName, arguments: "" } }],
          });
        }
        return null;
      }
      case "response.function_call_arguments.delta":
        toolArgs += data.delta ?? "";
        return chunk({
          tool_calls: [{ index: toolIndex, function: { name: toolName, arguments: data.delta ?? "" } }],
        });
      case "response.completed": {
        const usage = data.response?.usage;
        const finish: CommonChunk["choices"][0]["finish_reason"] = sawFinish ? null : "stop";
        sawFinish = true;
        return chunk(
          {},
          finish,
          usage
            ? {
                prompt_tokens: usage.input_tokens ?? 0,
                completion_tokens: usage.output_tokens ?? 0,
                total_tokens: usage.total_tokens,
                prompt_tokens_details: { cached_tokens: usage.input_tokens_details?.cached_tokens },
              }
            : undefined,
        );
      }
      default:
        return null;
    }
  };
}