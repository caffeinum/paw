// A loopback stand-in for the Anthropic Messages API. Records every request body to <dir>/req-N.json
// and answers with one canned assistant text, as SSE when the caller asked for a stream (the real
// `claude` binary does) or as JSON otherwise (the lean PoC). Lets the round-trip run offline, with
// no API key and no subscription usage, while capturing exactly what `claude --resume` rebuilt
// from the transcript.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeServer {
  url: string;
  requests: () => any[];
  close: () => Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

type Reply = string | Array<Record<string, any>>;

function message(model: string, reply: Reply) {
  const content = typeof reply === "string" ? [{ type: "text", text: reply }] : reply;
  return {
    id: `msg_fake_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

function sse(res: ServerResponse, msg: ReturnType<typeof message>): void {
  const text = msg.content.map((b) => b.text ?? "").join("");
  res.writeHead(200, { "content-type": "text/event-stream", "request-id": `req_fake_${Date.now()}` });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", { type: "message_start", message: { ...msg, content: [], stop_reason: null } });
  send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
  send("message_stop", { type: "message_stop" });
  res.end();
}

export function startFake(dir: string, reply: (body: any, n: number) => Reply): Promise<FakeServer> {
  mkdirSync(dir, { recursive: true });
  const seen: any[] = [];
  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const path = (req.url ?? "").split("?")[0];
    if (req.method !== "POST" || !path.endsWith("/v1/messages")) {
      // count_tokens, model listing, telemetry: answer minimally, record nothing
      res.writeHead(path.endsWith("/count_tokens") ? 200 : 404, { "content-type": "application/json" });
      res.end(path.endsWith("/count_tokens") ? JSON.stringify({ input_tokens: 1 }) : "{}");
      return;
    }
    const body = JSON.parse(raw);
    const n = seen.push(body);
    writeFileSync(join(dir, `req-${n}.json`), JSON.stringify(body, null, 1));
    const msg = message(body.model, reply(body, n));
    if (body.stream) sse(res, msg);
    else {
      res.writeHead(200, { "content-type": "application/json", "request-id": `req_fake_${n}` });
      res.end(JSON.stringify(msg));
    }
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("fake-anthropic: no listening address");
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        requests: () => seen,
        close: () => new Promise((r) => server.close(() => r())),
      });
    }),
  );
}
