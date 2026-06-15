/** Canonical intermediate representation (spec §6) — OpenAI chat-completion-like. */

export type Format = "anthropic" | "google" | "openai" | "oa-compat";

export interface CommonMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | CommonContentPart[];
  tool_call_id?: string; // role === "tool"
  tool_calls?: CommonToolCall[]; // role === "assistant"
  name?: string;
}

export type CommonContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface CommonToolCall {
  id?: string; // omitted on streaming continuation deltas
  type?: "function";
  // `name` is required on the opening tool-call chunk but omitted on
  // continuation/argument deltas (streaming). Guard with `?.` downstream.
  function: { name?: string; arguments: string }; // arguments = JSON string
  index?: number; // streaming converters track the tool-call index
}

export interface CommonTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>; // JSON Schema
  };
}

export interface CommonRequest {
  model: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  messages: CommonMessage[];
  stream: boolean;
  tools?: CommonTool[];
  tool_choice?: unknown;
}

export interface CommonResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: [
    {
      index: number;
      message: { role: "assistant"; content?: string; tool_calls?: CommonToolCall[] };
      finish_reason: "stop" | "tool_calls" | "length" | "content_filter" | null;
    },
  ];
  usage?: CommonUsage;
}

export interface CommonChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: [
    {
      index: number;
      delta: { role?: "assistant"; content?: string; tool_calls?: CommonToolCall[] };
      finish_reason: "stop" | "tool_calls" | "length" | "content_filter" | null;
    },
  ];
  usage?: CommonUsage;
}

export interface CommonUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
}