import type { CommonChunk, CommonRequest, CommonResponse, Format } from "../types.js";
import {
  createFromAnthropicChunk,
  createToAnthropicChunk,
  fromAnthropicRequest,
  fromAnthropicResponse,
  parseAnthropicBlock,
  toAnthropicRequest,
  toAnthropicResponse,
} from "./anthropic.js";
import {
  fromOaCompatRequest,
  fromOaCompatResponse,
  parseOaCompatBlock,
  toOaCompatRequest,
  toOaCompatResponse,
} from "./oa-compat.js";
import {
  createFromOpenAIChunk,
  fromOpenAIRequest,
  fromOpenAIResponse,
  parseOpenAIBlock,
  toOpenAIRequest,
  toOpenAIResponse,
} from "./openai.js";
import {
  createFromGoogleChunk,
  fromGoogleRequest,
  fromGoogleResponse,
  parseGoogleBlock,
  toGoogleRequest,
  toGoogleResponse,
} from "./google.js";

export type BodyConverter = (body: any) => any;
export type ResponseConverter = (resp: any) => any;
export type StreamPartConverter = (part: string) => string;

// ---------------------------------------------------------------------------
// Body converters: from<Format>Request → canonical → to<Format>Request
// ---------------------------------------------------------------------------

export function createBodyConverter(from: Format, to: Format): BodyConverter {
  if (from === to) return (body) => body;
  switch (`${from}->${to}`) {
    case "anthropic->oa-compat":
      return (b) => toOaCompatRequest(fromAnthropicRequest(b));
    case "anthropic->openai":
      return (b) => toOpenAIRequest(fromAnthropicRequest(b));
    case "anthropic->google":
      return (b) => toGoogleRequest(fromAnthropicRequest(b));
    case "oa-compat->anthropic":
      return (b) => toAnthropicRequest(fromOaCompatRequest(b));
    case "oa-compat->openai":
      return (b) => toOpenAIRequest(fromOaCompatRequest(b));
    case "oa-compat->google":
      return (b) => toGoogleRequest(fromOaCompatRequest(b));
    case "openai->anthropic":
      return (b) => toAnthropicRequest(fromOpenAIRequest(b));
    case "openai->oa-compat":
      return (b) => toOaCompatRequest(fromOpenAIRequest(b));
    case "openai->google":
      return (b) => toGoogleRequest(fromOpenAIRequest(b));
    case "google->anthropic":
      return (b) => toAnthropicRequest(fromGoogleRequest(b));
    case "google->oa-compat":
      return (b) => toOaCompatRequest(fromGoogleRequest(b));
    case "google->openai":
      return (b) => toOpenAIRequest(fromGoogleRequest(b));
    default:
      throw new Error(`request translation ${from} → ${to} not implemented`);
  }
}

// ---------------------------------------------------------------------------
// Response converters: from<X>Response → canonical → to<X>Response
// ---------------------------------------------------------------------------

export function createResponseConverter(from: Format, to: Format): ResponseConverter {
  if (from === to) return (resp) => resp;
  switch (`${from}->${to}`) {
    case "anthropic->oa-compat":
      return (r) => toOaCompatResponse(fromAnthropicResponse(r));
    case "anthropic->openai":
      return (r) => toOpenAIResponse(fromAnthropicResponse(r));
    case "anthropic->google":
      return (r) => toGoogleResponse(fromAnthropicResponse(r));
    case "oa-compat->anthropic":
      return (r) => toAnthropicResponse(fromOaCompatResponse(r));
    case "oa-compat->openai":
      return (r) => toOpenAIResponse(fromOaCompatResponse(r));
    case "oa-compat->google":
      return (r) => toGoogleResponse(fromOaCompatResponse(r));
    case "openai->anthropic":
      return (r) => toAnthropicResponse(fromOpenAIResponse(r));
    case "openai->oa-compat":
      return (r) => toOaCompatResponse(fromOpenAIResponse(r));
    case "openai->google":
      return (r) => toGoogleResponse(fromOpenAIResponse(r));
    case "google->anthropic":
      return (r) => toAnthropicResponse(fromGoogleResponse(r));
    case "google->oa-compat":
      return (r) => toOaCompatResponse(fromGoogleResponse(r));
    case "google->openai":
      return (r) => toOpenAIResponse(fromGoogleResponse(r));
    default:
      throw new Error(`Unknown translation ${from} → ${to} not implemented`);
  }
}

// ---------------------------------------------------------------------------
// Stream converters: parse upstream block → canonical chunk → target block.
// Unparseable blocks (errors / keep-alives) pass through unchanged.
// ---------------------------------------------------------------------------

export function createStreamPartConverter(from: Format, to: Format): StreamPartConverter {
  if (from === to) return (part) => part;

  // --- to anthropic (the client-facing direction) ---
  if (to === "anthropic") {
    const toAnthropic = createToAnthropicChunk();
    let parse: (part: string) => CommonChunk | null;
    if (from === "oa-compat") {
      parse = parseOaCompatBlock;
    } else if (from === "openai") {
      const fromOpenAI = createFromOpenAIChunk();
      parse = (part) => fromOpenAI(part);
    } else if (from === "google") {
      const fromGoogle = createFromGoogleChunk();
      parse = (part) => fromGoogle(part);
    } else {
      parse = () => null;
    }
    return (part: string): string => {
      const chunk = parse(part);
      if (!chunk) return part; // passthrough (error / keep-alive / [DONE])
      return toAnthropic(chunk);
    };
  }

  // --- from anthropic (only when the client is non-anthropic) ---
  if (from === "anthropic") {
    const fromAnthropic = createFromAnthropicChunk();
    return (part: string): string => {
      if (!parseAnthropicBlock(part)) return part;
      const out = fromAnthropic(part); // oa-compat `data: {...}` block
      if (!out) return "";
      const chunk = parseOaCompatBlock(out);
      if (!chunk) return "";
      return toTarget(chunk, to);
    };
  }

  // --- oa-compat → openai / google ---
  if (from === "oa-compat") {
    return (part: string): string => {
      const chunk = parseOaCompatBlock(part);
      if (!chunk) return part;
      return toTarget(chunk, to);
    };
  }

  // --- openai → oa-compat / google ---
  if (from === "openai") {
    const fromOpenAI = createFromOpenAIChunk();
    return (part: string): string => {
      if (!parseOpenAIBlock(part)) return part;
      const chunk = fromOpenAI(part);
      if (!chunk) return "";
      return toTarget(chunk, to);
    };
  }

  // --- google → oa-compat / openai ---
  if (from === "google") {
    const fromGoogle = createFromGoogleChunk();
    return (part: string): string => {
      if (!parseGoogleBlock(part)) return part;
      const chunk = fromGoogle(part);
      if (!chunk) return "";
      return toTarget(chunk, to);
    };
  }

  return (part) => part;
}

// ---------------------------------------------------------------------------
// Target serialization for non-anthropic clients
// ---------------------------------------------------------------------------

function toTarget(chunk: CommonChunk, to: Format): string {
  if (to === "oa-compat") return `data: ${JSON.stringify(chunk)}`;
  if (to === "openai") return openaiChunkToSse(chunk);
  if (to === "google") return `data: ${JSON.stringify(googleChunkFromCommon(chunk))}`;
  return "";
}

// ---------------------------------------------------------------------------
// Small helpers for the non-anthropic stream directions
// ---------------------------------------------------------------------------

function openaiChunkToSse(chunk: CommonChunk): string {
  const events: string[] = [];
  const delta = chunk.choices[0].delta;
  if (delta.content) {
    events.push(
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: delta.content })}`,
    );
  }
  for (const tc of delta.tool_calls ?? []) {
    if (tc.function?.name) {
      events.push(
        `event: response.output_item.added\ndata: ${JSON.stringify({
          type: "response.output_item.added",
          output_index: tc.index ?? 0,
          item: { type: "function_call", id: tc.id ?? "", call_id: tc.id ?? "", name: tc.function.name, arguments: "" },
        })}`,
      );
    }
    if (tc.function?.arguments) {
      events.push(
        `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
          type: "response.function_call_arguments.delta",
          output_index: tc.index ?? 0,
          delta: tc.function.arguments,
        })}`,
      );
    }
  }
  if (chunk.choices[0].finish_reason) {
    events.push(
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: { id: chunk.id, object: "response", model: chunk.model, output: [], usage: chunk.usage },
      })}`,
    );
  }
  return events.join("\n\n");
}

function googleChunkFromCommon(chunk: CommonChunk): Record<string, unknown> {
  const parts: Array<Record<string, unknown>> = [];
  const delta = chunk.choices[0].delta;
  if (delta.content) parts.push({ text: delta.content });
  for (const tc of delta.tool_calls ?? []) {
    if (tc.function?.name) parts.push({ functionCall: { name: tc.function.name, args: {} } });
  }
  return {
    candidates: [
      {
        index: chunk.choices[0].index,
        content: { role: "model", parts },
        finishReason: chunk.choices[0].finish_reason
          ? chunk.choices[0].finish_reason === "stop"
            ? "STOP"
            : chunk.choices[0].finish_reason === "tool_calls"
              ? "TOOL_CALLS"
              : chunk.choices[0].finish_reason === "length"
                ? "MAX_TOKENS"
                : "STOP"
          : undefined,
      },
    ],
    usageMetadata: chunk.usage
      ? {
          promptTokenCount: chunk.usage.prompt_tokens,
          candidatesTokenCount: chunk.usage.completion_tokens,
          totalTokenCount: chunk.usage.total_tokens,
          cachedContentTokenCount: chunk.usage.prompt_tokens_details?.cached_tokens,
        }
      : undefined,
  };
}