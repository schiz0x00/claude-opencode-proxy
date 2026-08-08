import { describe, expect, it } from "vitest";
import {
  createBodyConverter,
  createResponseConverter,
  createStreamPartConverter,
} from "../src/translate/converters/index.js";

// ---------------------------------------------------------------------------
// Fixtures (spec §11: fixture-driven converter tests)
// ---------------------------------------------------------------------------

const anthropicRequest = {
  model: "claude-sonnet-4-6",
  max_tokens: 1024,
  stream: false,
  system: [{ type: "text", text: "You are a helpful assistant." }],
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "let me check" },
        { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "ls" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "file1 file2" }],
    },
  ],
  tools: [
    { name: "Bash", description: "Run a shell command", input_schema: { type: "object", properties: {} } },
  ],
};

const oaCompatRequest = {
  model: "deepseek-v4-flash-free",
  max_tokens: 1024,
  stream: false,
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "let me check" }],
      tool_calls: [
        { id: "toolu_01", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } },
      ],
    },
    { role: "tool", tool_call_id: "toolu_01", content: "file1 file2" },
  ],
  tools: [
    {
      type: "function",
      function: { name: "Bash", description: "Run a shell command", parameters: { type: "object", properties: {} } },
    },
  ],
};

const anthropicResponse = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-6",
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 5 },
};

const oaCompatResponse = {
  id: "chatcmpl_01",
  object: "chat.completion",
  created: 1700000000,
  model: "deepseek-v4-flash-free",
  choices: [
    { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

const openAIResponse = {
  id: "resp_01",
  object: "response",
  model: "gpt-5",
  output: [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
  ],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
};

const googleResponse = {
  candidates: [
    { content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP", index: 0 },
  ],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
};

// ---------------------------------------------------------------------------
// Request converters
// ---------------------------------------------------------------------------

describe("createBodyConverter", () => {
  it("is identity when from === to", () => {
    const conv = createBodyConverter("oa-compat", "oa-compat");
    expect(conv(oaCompatRequest)).toBe(oaCompatRequest);
  });

  it("anthropic → oa-compat → anthropic round-trips", () => {
    const toOa = createBodyConverter("anthropic", "oa-compat");
    const toAnthropic = createBodyConverter("oa-compat", "anthropic");
    const oa = toOa(anthropicRequest);
    expect(oa.messages[0]).toEqual({ role: "system", content: "You are a helpful assistant." });
    expect(oa.messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "hi" }] });
    expect(oa.messages[2].tool_calls).toEqual([
      { id: "toolu_01", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } },
    ]);
    expect(oa.messages[3]).toEqual({ role: "tool", tool_call_id: "toolu_01", content: "file1 file2" });
    expect(oa.tools?.[0]).toEqual({
      type: "function",
      function: { name: "Bash", description: "Run a shell command", parameters: { type: "object", properties: {} } },
    });

    const back = toAnthropic(oa);
    expect(back.model).toBe("claude-sonnet-4-6"); // model preserved through round-trip
    expect(back.system).toEqual([
      { type: "text", text: "You are a helpful assistant.", cache_control: { type: "ephemeral" } },
    ]);
    // system is extracted out of messages: [user, assistant, user]
    expect(back.messages[0].content[0]).toEqual({ type: "text", text: "hi" });
    expect(back.messages[1].content[0]).toEqual({ type: "text", text: "let me check" });
    expect(back.messages[1].content[1]).toEqual({
      type: "tool_use",
      id: "toolu_01",
      name: "Bash",
      input: { command: "ls" },
    });
    expect(back.messages[2].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_01",
      content: "file1 file2",
    });
  });

  it("oa-compat → anthropic → oa-compat round-trips", () => {
    const toAnthropic = createBodyConverter("oa-compat", "anthropic");
    const toOa = createBodyConverter("anthropic", "oa-compat");
    const anthropic = toAnthropic(oaCompatRequest);
    expect(anthropic.system).toEqual([
      { type: "text", text: "You are a helpful assistant.", cache_control: { type: "ephemeral" } },
    ]);
    // system is extracted out of messages, so the assistant message is index 1
    expect(anthropic.messages[1].content[1]).toEqual({
      type: "tool_use",
      id: "toolu_01",
      name: "Bash",
      input: { command: "ls" },
    });
    const back = toOa(anthropic);
    expect(back.messages[2].tool_calls).toEqual(oaCompatRequest.messages[2].tool_calls);
    expect(back.messages[3]).toEqual(oaCompatRequest.messages[3]);
  });

  it("anthropic → openai maps system/tools/tool_use", () => {
    const conv = createBodyConverter("anthropic", "openai");
    const out = conv(anthropicRequest);
    expect(out.instructions).toBe("You are a helpful assistant.");
    expect(out.input[0].role).toBe("user");
    expect(out.input[1].role).toBe("assistant");
    expect(out.input[1].content).toContainEqual({
      type: "function_call",
      call_id: "toolu_01",
      name: "Bash",
      arguments: '{"command":"ls"}',
    });
    expect(out.input[2].role).toBe("user");
    expect(out.input[2].content).toEqual([
      { type: "function_call_output", call_id: "toolu_01", output: "file1 file2" },
    ]);
  });

  it("anthropic → google maps system, tools, functionCall", () => {
    const conv = createBodyConverter("anthropic", "google");
    const out = conv(anthropicRequest);
    expect(out.systemInstruction).toEqual({ parts: [{ text: "You are a helpful assistant." }] });
    expect(out.contents[1].role).toBe("model");
    expect(out.contents[1].parts).toContainEqual({
      functionCall: { name: "Bash", args: { command: "ls" } },
    });
    expect(out.contents[2].parts).toEqual([
      { functionResponse: { name: "Bash", response: "file1 file2" } },
    ]);
    expect(out.tools?.[0].functionDeclarations[0].name).toBe("Bash");
  });
});

// ---------------------------------------------------------------------------
// Response converters
// ---------------------------------------------------------------------------

describe("createResponseConverter", () => {
  it("is identity when from === to", () => {
    const conv = createResponseConverter("oa-compat", "oa-compat");
    expect(conv(oaCompatResponse)).toBe(oaCompatResponse);
  });

  it("anthropic → oa-compat maps stop_reason and usage", () => {
    const conv = createResponseConverter("anthropic", "oa-compat");
    const out = conv(anthropicResponse);
    expect(out.choices[0].message.content).toBe("hi");
    expect(out.choices[0].finish_reason).toBe("stop");
    expect(out.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it("oa-compat → anthropic maps finish_reason and usage", () => {
    const conv = createResponseConverter("oa-compat", "anthropic");
    const out = conv(oaCompatResponse);
    expect(out.content).toEqual([{ type: "text", text: "hi" }]);
    expect(out.stop_reason).toBe("end_turn");
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("openai → anthropic maps output items", () => {
    const conv = createResponseConverter("openai", "anthropic");
    const out = conv(openAIResponse);
    expect(out.content).toEqual([{ type: "text", text: "hi" }]);
    expect(out.stop_reason).toBe("end_turn");
    expect(out.usage.input_tokens).toBe(10);
  });

  it("google → anthropic maps candidates and usage", () => {
    const conv = createResponseConverter("google", "anthropic");
    const out = conv(googleResponse);
    expect(out.content).toEqual([{ type: "text", text: "hi" }]);
    expect(out.stop_reason).toBe("end_turn");
    expect(out.usage.input_tokens).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Stream converters
// ---------------------------------------------------------------------------

describe("createStreamPartConverter", () => {
  it("is identity when from === to", () => {
    const conv = createStreamPartConverter("oa-compat", "oa-compat");
    const part = 'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}';
    expect(conv(part)).toBe(part);
  });

  it("oa-compat → anthropic emits message_start, text delta, message_delta", () => {
    const conv = createStreamPartConverter("oa-compat", "anthropic");
    const parts = [
      'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
    ];
    const out = parts.map((p) => conv(p)).join("\n\n");
    expect(out).toContain('event: message_start');
    expect(out).toContain('"type":"text_delta","text":"hi"');
    expect(out).toContain('"stop_reason":"end_turn"');
    expect(out).toContain('"output_tokens":5');
  });

  it("oa-compat → anthropic emits tool_use blocks", () => {
    const conv = createStreamPartConverter("oa-compat", "anthropic");
    const parts = [
      'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"toolu_01","type":"function","function":{"name":"Bash","arguments":""}}]},"finish_reason":null}]}',
      'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}}]},"finish_reason":null}]}',
      'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
    ];
    const out = parts.map((p) => conv(p)).join("\n\n");
    expect(out).toContain('"type":"tool_use"');
    expect(out).toContain('"name":"Bash"');
    expect(out).toContain('"input_json_delta"');
    expect(out).toContain('"stop_reason":"tool_use"');
  });

  it("openai → anthropic converts output_text.delta and completed", () => {
    const conv = createStreamPartConverter("openai", "anthropic");
    const parts = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","object":"response","model":"m","output":[],"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}',
    ];
    const out = parts.map((p) => conv(p)).join("\n\n");
    expect(out).toContain('event: message_start');
    expect(out).toContain('"text":"hi"');
    expect(out).toContain('"stop_reason":"end_turn"');
    expect(out).toContain('"output_tokens":5');
  });

  it("openai → anthropic emits a single tool_use block per tool (no duplicates)", () => {
    const conv = createStreamPartConverter("openai", "anthropic");
    const parts = [
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"fc_1","name":"Bash","arguments":""}}',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"command\\":\\"ls\\"}"}',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"}"}',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","object":"response","model":"m","output":[],"usage":{"input_tokens":10,"output_tokens":5}}}',
    ];
    const out = parts.map((p) => conv(p)).join("\n\n");
    // Each argument delta must NOT re-open the tool block.
    expect(out.match(/event: content_block_start/g) ?? []).toHaveLength(1);
    expect(out).toContain('"type":"tool_use"');
    expect(out).toContain('"name":"Bash"');
    expect(out).toContain('"input_json_delta"');
    expect(out).toContain('"stop_reason":"end_turn"');
  });
  it("google → anthropic maps text parts and usage", () => {

    const conv = createStreamPartConverter("google", "anthropic");
    const parts = [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]},"finishReason":null,"index":0}]}',
      'data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15}}',
    ];
    const out = parts.map((p) => conv(p)).join("\n\n");
    expect(out).toContain('event: message_start');
    expect(out).toContain('"text":"hi"');
    expect(out).toContain('"stop_reason":"end_turn"');
    expect(out).toContain('"output_tokens":5');
  });

  it("anthropic → oa-compat converts SSE events to chat chunks", () => {
    const conv = createStreamPartConverter("anthropic", "oa-compat");
    const parts = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"usage":{"input_tokens":0,"output_tokens":0}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
    ];
    const out = parts.map((p) => conv(p)).join("\n\n");
    expect(out).toContain('"delta":{"content":"hi"}');
    expect(out).toContain('"finish_reason":"stop"');
    expect(out).toContain('"completion_tokens":5');
  });

  it("passes through unparseable blocks (errors / keep-alives)", () => {
    const conv = createStreamPartConverter("oa-compat", "anthropic");
    const err = 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}';
    expect(conv(err)).toBe(err);
    expect(conv("data: [DONE]")).toBe("data: [DONE]");
  });
});
// ---------------------------------------------------------------------------
// Thinking mode: reasoning_content must survive the round trip, or providers
// reject the follow-up turn ("The `reasoning_content` in the thinking mode
// must be passed back to the API").
// ---------------------------------------------------------------------------

describe("thinking mode round trip", () => {
  it("streams reasoning_content out as thinking blocks and back in", () => {
    const toAnthropic = createStreamPartConverter("oa-compat", "anthropic");
    const out = [
      toAnthropic!(
        'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"reasoning_content":"pon"},"finish_reason":null}]}',
      ),
      toAnthropic!(
        'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"reasoning_content":"der"},"finish_reason":null}]}',
      ),
      toAnthropic!(
        'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}',
      ),
    ].join("\n\n");

    expect(out).toContain('"type":"thinking"');
    expect(out).toContain('"thinking":"pon"');
    expect(out).toContain('"thinking":"der"');
    // Thinking block closes before the text block opens.
    expect(out.indexOf("content_block_stop")).toBeLessThan(out.indexOf('"text_delta"'));

    // Client echoes the assembled thinking block back on the next turn.
    const toUpstream = createBodyConverter("anthropic", "oa-compat");
    const body = toUpstream!({
      model: "m",
      max_tokens: 16,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "ponder", signature: "sig" },
            { type: "text", text: "hi" },
          ],
        },
        { role: "user", content: [{ type: "text", text: "again" }] },
      ],
    }) as any;

    expect(body.messages[1].reasoning_content).toBe("ponder");
  });
});

describe("streamed text blocks", () => {
  it("keeps one text block open across deltas instead of one per token", () => {
    const to = createStreamPartConverter("oa-compat", "anthropic")!;
    const chunk = (delta: unknown, finish: string | null = null) =>
      to(
        `data: ${JSON.stringify({
          id: "c",
          object: "chat.completion.chunk",
          created: 0,
          model: "m",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}`,
      );

    const out = [
      chunk({ content: "Hi" }),
      chunk({ content: " there" }),
      chunk({ content: "!" }),
      chunk({}, "stop"),
    ].join("\n\n");

    const starts = out.match(/"type":"content_block_start"/g) ?? [];
    const stops = out.match(/"type":"content_block_stop"/g) ?? [];
    const deltas = out.match(/"type":"text_delta"/g) ?? [];
    expect(starts).toHaveLength(1); // one block…
    expect(deltas).toHaveLength(3); // …carrying every token…
    expect(stops).toHaveLength(1); // …closed once, at the finish.
    // Every delta targets that same block index.
    expect(out.match(/"content_block_delta","index":(\d+)/g)?.every((m) => m.endsWith(":0"))).toBe(true);
  });

  it("keeps parallel tool calls in separate blocks", () => {
    const to = createStreamPartConverter("oa-compat", "anthropic")!;
    const chunk = (delta: unknown, finish: string | null = null) =>
      to(
        `data: ${JSON.stringify({
          id: "c",
          object: "chat.completion.chunk",
          created: 0,
          model: "m",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}`,
      );
    chunk({ tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "Read", arguments: "" } }] });
    chunk({ tool_calls: [{ index: 1, id: "b", type: "function", function: { name: "Grep", arguments: "" } }] });
    // Arguments for call 0 arrive after call 1 opened: they belong to block 0.
    const out = chunk({ tool_calls: [{ index: 0, function: { arguments: '{"p":1}' } }] });
    expect(out).toContain('"content_block_delta","index":0');
    expect(out).not.toContain('"content_block_delta","index":1');
    // Both blocks are closed at the finish.
    const end = chunk({}, "tool_calls");
    expect(end).toContain('"content_block_stop","index":0');
    expect(end).toContain('"content_block_stop","index":1');
  });

  it("closes the text block before opening a tool block", () => {
    const to = createStreamPartConverter("oa-compat", "anthropic")!;
    const chunk = (delta: unknown) =>
      to(
        `data: ${JSON.stringify({
          id: "c",
          object: "chat.completion.chunk",
          created: 0,
          model: "m",
          choices: [{ index: 0, delta, finish_reason: null }],
        })}`,
      );
    chunk({ content: "let me look" });
    const out = chunk({
      tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "Read", arguments: "" } }],
    });
    expect(out.indexOf("content_block_stop")).toBeLessThan(out.indexOf('"type":"tool_use"'));
  });
});
