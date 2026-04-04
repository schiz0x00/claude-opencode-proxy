import type { CommonChunk, CommonRequest, CommonResponse } from "../types.js";

// ---------------------------------------------------------------------------
// oa-compat (OpenAI chat/completions) — the canonical IR is oa-compat-shaped,
// so these converters are thin normalizers.
// ---------------------------------------------------------------------------

export interface OaCompatRequest extends CommonRequest {
  stream_options?: { include_usage?: boolean };
}

export interface OaCompatResponse extends CommonResponse {
  // already canonical-shaped
}

export interface OaCompatChunk extends CommonChunk {
  // already canonical-shaped
}

export function fromOaCompatRequest(body: OaCompatRequest): CommonRequest {
  return {
    model: body.model,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop,
    messages: body.messages,
    stream: body.stream ?? false,
    tools: body.tools,
    tool_choice: body.tool_choice,
  };
}

export function toOaCompatRequest(req: CommonRequest): OaCompatRequest {
  return {
    model: req.model,
    max_tokens: req.max_tokens,
    temperature: req.temperature,
    top_p: req.top_p,
    stop: req.stop,
    messages: req.messages,
    stream: req.stream,
    tools: req.tools,
    tool_choice: req.tool_choice,
  };
}

export function fromOaCompatResponse(resp: OaCompatResponse): CommonResponse {
  return resp;
}

export function toOaCompatResponse(resp: CommonResponse): OaCompatResponse {
  return resp;
}

/** Parse an oa-compat SSE block (`data: {...}`) into a CommonChunk. */
export function parseOaCompatBlock(block: string): CommonChunk | null {
  let dataLine: string | undefined;
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) dataLine = line.slice(5).trim();
  }
  if (dataLine === undefined || dataLine === "[DONE]") return null;
  try {
    const parsed = JSON.parse(dataLine) as CommonChunk;
    // Only treat it as a chat chunk when it actually carries choices; error
    // envelopes and keep-alives must pass through untouched.
    if (!Array.isArray(parsed.choices)) return null;
    return parsed;
  } catch {
    return null;
  }
}