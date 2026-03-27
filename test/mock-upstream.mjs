// Mock OpenCode Zen upstream for manual testing (not part of the proxy).
// Serves POST /messages with an Anthropic-style SSE stream.
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 9999);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "POST" && url.pathname === "/v1/messages") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      const stream = parsed.stream === true;
      res.writeHead(200, {
        "content-type": stream ? "text/event-stream" : "application/json",
        "cache-control": "no-cache",
      });
      if (!stream) {
        res.end(
          JSON.stringify({
            id: "msg_mock",
            type: "message",
            role: "assistant",
            model: parsed.model,
            content: [{ type: "text", text: "mock reply" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
        );
        return;
      }
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", {
        type: "message_start",
        message: {
          id: "msg_mock",
          type: "message",
          role: "assistant",
          model: parsed.model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      });
      send("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      send("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "mock " },
      });
      send("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "reply" },
      });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      });
      send("message_stop", { type: "message_stop" });
      res.end();
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      const text = JSON.stringify(parsed.messages ?? []);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: Math.ceil(text.length / 4), output_tokens: 0 }));
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { type: "not_found_error", message: "not found" } }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock upstream listening on http://127.0.0.1:${port}`);
});