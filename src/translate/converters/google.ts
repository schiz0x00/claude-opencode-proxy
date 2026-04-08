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
// Gemini generateContent wire types
// ---------------------------------------------------------------------------

export interface GooglePart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name?: string; response?: unknown };
}

export interface GoogleContent {
  role?: "user" | "model";
  parts: GooglePart[];
}

export interface GoogleRequest {
  model?: string;
  stream?: boolean;
  contents: GoogleContent[];
  systemInstruction?: { parts: Array<{ text?: string }> };
  generationConfig?: {
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
  };
  tools?: Array<{ functionDeclarations?: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }> }>;
  toolConfig?: unknown;
}

export interface GoogleResponse {
  model?: string;
  candidates?: Array<{
    content?: GoogleContent;
    finishReason?: string;
    index?: number;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapFinishReason(reason: string | undefined): CommonChunk["choices"][0]["finish_reason"] {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "TOOL_CALLS":
      return "tool_calls";
    case "SAFETY":
    case "RECITATION":
      return "content_filter";
    default:
      return null;
  }
}

function mapToGoogleFinish(reason: string | null | undefined): string {
  switch (reason) {
    case "stop":
      return "STOP";
    case "length":
      return "MAX_TOKENS";
    case "tool_calls":
      return "TOOL_CALLS";
    case "content_filter":
      return "SAFETY";
    default:
      return "STOP";
  }
}

function oaData(data: unknown): string {
  return `data: ${JSON.stringify(data)}`;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export function fromGoogleRequest(body: GoogleRequest): CommonRequest {
  const messages: CommonMessage[] = [];
  if (body.systemInstruction?.parts?.length) {
    const text = body.systemInstruction.parts.map((p) => p.text ?? "").join("\n");
    if (text) messages.push({ role: "system", content: text });
  }
  for (const content of body.contents ?? []) {
    const parts: CommonContentPart[] = [];
    const toolCalls: CommonToolCall[] = [];
    let toolResult: { name: string; response: unknown } | undefined;
    for (const part of content.parts ?? []) {
      if (part.text !== undefined) parts.push({ type: "text", text: part.text });
      else if (part.inlineData) {
        const { mimeType, data } = part.inlineData;
        parts.push({ type: "image_url", image_url: { url: `data:${mimeType ?? "image/png"};base64,${data ?? ""}` } });
      } else if (part.functionCall) {
        toolCalls.push({
          id: `call_${part.functionCall.name}`,
          type: "function",
          function: { name: part.functionCall.name ?? "", arguments: JSON.stringify(part.functionCall.args ?? {}) },
        });
      } else if (part.functionResponse) {
        toolResult = { name: part.functionResponse.name ?? "", response: part.functionResponse.response };
      }
    }
    if (content.role === "model" && toolCalls.length > 0) {
      messages.push({ role: "assistant", content: parts.length > 0 ? parts : undefined, tool_calls: toolCalls });
    } else if (toolResult) {
      messages.push({ role: "tool", tool_call_id: `call_${toolResult.name}`, content: JSON.stringify(toolResult.response) });
    } else if (parts.length > 0) {
      messages.push({ role: content.role === "model" ? "assistant" : "user", content: parts });
    }
  }
  return {
    model: body.model ?? "",
    max_tokens: body.generationConfig?.maxOutputTokens,
    temperature: body.generationConfig?.temperature,
    top_p: body.generationConfig?.topP,
    stop: body.generationConfig?.stopSequences,
    messages,
    stream: body.stream ?? false,
    tools: body.tools
      ?.flatMap((t) => t.functionDeclarations ?? [])
      .map(
        (f): CommonTool => ({ type: "function", function: { name: f.name, description: f.description, parameters: f.parameters } }),
      ),
    tool_choice: body.toolConfig,
  };
}

export function toGoogleRequest(req: CommonRequest): GoogleRequest {
  const contents: GoogleContent[] = [];
  let systemInstruction: GoogleRequest["systemInstruction"];
  // Map tool_call_id → function name from prior assistant tool calls, so
  // functionResponse.name is the real function name (not the anthropic id).
  const toolCallNames = new Map<string, string>();
  for (const m of req.messages) {
    for (const tc of m.tool_calls ?? []) {
      if (tc.id) toolCallNames.set(tc.id, tc.function.name);
    }
  }
  for (const m of req.messages) {
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : "";
      if (text) systemInstruction = { parts: [{ text }] };
      continue;
    }
    if (m.role === "tool") {
      const id = m.tool_call_id ?? "";
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: toolCallNames.get(id) ?? id.replace(/^call_/, ""),
              response: safeJsonParse(m.content),
            },
          },
        ],
      });
      continue;
    }
    const parts: GooglePart[] = [];
    if (typeof m.content === "string") {
      if (m.content) parts.push({ text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === "text") parts.push({ text: p.text });
        else if (p.type === "image_url") {
          const url = p.image_url.url;
          const m2 = url.match(/^data:([^;,]+);base64,(.+)$/);
          if (m2) parts.push({ inlineData: { mimeType: m2[1], data: m2[2] } });
          else parts.push({ text: url });
        }
      }
    }
    for (const tc of m.tool_calls ?? []) {
      parts.push({ functionCall: { name: tc.function.name, args: safeJsonParse(tc.function.arguments) as Record<string, unknown> | undefined } });
    }
    contents.push({ role: m.role === "assistant" ? "model" : "user", parts });
  }
  return {
    model: req.model,
    stream: req.stream,
    contents,
    systemInstruction,
    generationConfig: {
      maxOutputTokens: req.max_tokens,
      temperature: req.temperature,
      topP: req.top_p,
      stopSequences: req.stop,
    },
    tools: req.tools?.map((t) => ({
      functionDeclarations: [
        { name: t.function.name, description: t.function.description, parameters: t.function.parameters },
      ],
    })),
    toolConfig: req.tool_choice as GoogleRequest["toolConfig"],
  };
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export function fromGoogleResponse(resp: GoogleResponse): CommonResponse {
  const candidate = resp.candidates?.[0];
  const textParts: string[] = [];
  const toolCalls: CommonToolCall[] = [];
  for (const part of candidate?.content?.parts ?? []) {
    if (part.text !== undefined) textParts.push(part.text);
    else if (part.functionCall) {
      toolCalls.push({
        id: `call_${part.functionCall.name}`,
        type: "function",
        function: { name: part.functionCall.name ?? "", arguments: JSON.stringify(part.functionCall.args ?? {}) },
      });
    }
  }
  return {
    id: "chatcmpl_google",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: resp.model ?? "",
    choices: [
      {
        index: candidate?.index ?? 0,
        message: {
          role: "assistant",
          content: textParts.length > 0 ? textParts.join("") : undefined,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: mapFinishReason(candidate?.finishReason ?? undefined),
      },
    ],
    usage: resp.usageMetadata
      ? {
          prompt_tokens: resp.usageMetadata.promptTokenCount ?? 0,
          completion_tokens: resp.usageMetadata.candidatesTokenCount ?? 0,
          total_tokens: resp.usageMetadata.totalTokenCount,
          prompt_tokens_details: { cached_tokens: resp.usageMetadata.cachedContentTokenCount },
        }
      : undefined,
  };
}

export function toGoogleResponse(resp: CommonResponse): GoogleResponse {
  const parts: GooglePart[] = [];
  const msg = resp.choices[0].message;
  if (msg.content) parts.push({ text: msg.content });
  for (const tc of msg.tool_calls ?? []) {
    parts.push({ functionCall: { name: tc.function.name, args: safeJsonParse(tc.function.arguments) as Record<string, unknown> | undefined } });
  }
  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason: mapToGoogleFinish(resp.choices[0].finish_reason),
        index: resp.choices[0].index,
      },
    ],
    usageMetadata: resp.usage
      ? {
          promptTokenCount: resp.usage.prompt_tokens,
          candidatesTokenCount: resp.usage.completion_tokens,
          totalTokenCount: resp.usage.total_tokens,
          cachedContentTokenCount: resp.usage.prompt_tokens_details?.cached_tokens,
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** Parse a google SSE block (`data: {...}`) into a GoogleResponse chunk. */
export function parseGoogleBlock(block: string): GoogleResponse | null {
  let dataLine: string | undefined;
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) dataLine = line.slice(5).trim();
  }
  if (dataLine === undefined) return null;
  try {
    return JSON.parse(dataLine) as GoogleResponse;
  } catch {
    return null;
  }
}

/**
 * Stateful google SSE → oa-compat chunk converter. Returns a CommonChunk or
 * null (skip).
 */
export function createFromGoogleChunk(): (part: string) => CommonChunk | null {
  let toolIndex = -1;
  let toolName = "";
  let sawFinish = false;

  return (part: string): CommonChunk | null => {
    const resp = parseGoogleBlock(part);
    if (!resp) return null;
    const candidate = resp.candidates?.[0];
    const model = resp.model ?? "";

    const chunk = (
      delta: CommonChunk["choices"][0]["delta"],
      finish: CommonChunk["choices"][0]["finish_reason"] = null,
      usage?: CommonChunk["usage"],
    ): CommonChunk => ({
      id: "chatcmpl_google",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: candidate?.index ?? 0, delta, finish_reason: finish }],
      usage,
    });

    let out: CommonChunk | null = null;
    for (const part of candidate?.content?.parts ?? []) {
      if (part.text !== undefined) {
        out = chunk({ content: part.text });
      } else if (part.functionCall) {
        toolName = part.functionCall.name ?? "";
        toolIndex = candidate?.index ?? 0;
        out = chunk({
          tool_calls: [
            { index: toolIndex, id: `call_${toolName}`, type: "function", function: { name: toolName, arguments: "" } },
          ],
        });
      }
    }
    if (candidate?.finishReason && !sawFinish) {
      sawFinish = true;
      out = chunk(
        {},
        mapFinishReason(candidate.finishReason),
        resp.usageMetadata
          ? {
              prompt_tokens: resp.usageMetadata.promptTokenCount ?? 0,
              completion_tokens: resp.usageMetadata.candidatesTokenCount ?? 0,
              total_tokens: resp.usageMetadata.totalTokenCount,
              prompt_tokens_details: { cached_tokens: resp.usageMetadata.cachedContentTokenCount },
            }
          : undefined,
      );
    } else if (resp.usageMetadata) {
      out = chunk(
        {},
        null,
        {
          prompt_tokens: resp.usageMetadata.promptTokenCount ?? 0,
          completion_tokens: resp.usageMetadata.candidatesTokenCount ?? 0,
          total_tokens: resp.usageMetadata.totalTokenCount,
          prompt_tokens_details: { cached_tokens: resp.usageMetadata.cachedContentTokenCount },
        },
      );
    }
    return out;
  };
}

function safeJsonParse(s: string | unknown): unknown {
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}