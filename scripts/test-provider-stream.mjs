// Streaming chat requests and the diagnostics recorded when a connection fails.
import assert from "node:assert/strict";
import http from "node:http";
import { generate } from "../lib/providers.mjs";

const requests = [];
const server = http.createServer(async (req, res) => {
  let body = ""; for await (const part of req) body += part;
  const request = JSON.parse(body); requests.push(request);
  const sse = (chunks) => { res.writeHead(200, { "content-type": "text/event-stream" }); for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`); res.end("data: [DONE]\n\n"); };
  switch (request.model) {
    case "stream-ok": if (!request.stream) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "一次性" } }] })); }
      return sse([
      { id: "run-1", choices: [{ delta: { reasoning_content: "思考中" } }] },
      { choices: [{ delta: { content: "你好，" } }] }, { choices: [{ delta: { content: "世界" }, finish_reason: "STOP" }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } }]);
    case "ignores-stream": res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "整段返回" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
    case "cut-mid-stream": res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "半句话" } }] })}\n\n`); return setTimeout(() => res.socket.destroy(), 50);
    case "cut-before-reply": return setTimeout(() => req.socket.destroy(), 50);
    case "silent": return; // never answers
    case "no-stream-options": if (request.stream_options) { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "Unrecognized request argument supplied: stream_options" } })); }
      return sse([{ choices: [{ delta: { content: "好" }, finish_reason: "stop" }] }]);
    case "error-mid-stream": return sse([{ choices: [{ delta: { content: "开头" } }] }, { error: { message: "upstream overloaded" } }]);
    case "no-finish": return sse([{ choices: [{ delta: { content: "没说完" } }] }]);
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const provider = (model, extra = {}) => ({ backend: "http", protocol: "openai-chat", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model, noAuth: true, ...extra });
const run = (model, extra) => generate({ provider: provider(model, extra), messages: [{ role: "user", content: "hi" }] });
const failure = async (model, extra) => { try { await run(model, extra); } catch (error) { return error; } assert.fail(`${model} should fail`); };

try {
  const ok = await run("stream-ok");
  assert.equal(ok.text, "你好，世界"); assert.equal(ok.finishReason, "stop"); assert.equal(ok.usage.inputTokens, 12); assert.equal(ok.usage.outputTokens, 4); assert.equal(ok.runId, "run-1");
  assert.equal(requests.at(-1).stream, true); assert.deepEqual(requests.at(-1).stream_options, { include_usage: true });

  assert.equal((await run("ignores-stream")).text, "整段返回");
  await run("stream-ok", { stream: false }); assert.equal(requests.at(-1).stream, undefined, "stream can be switched off");

  const cut = await failure("cut-mid-stream");
  assert.equal(cut.code, "NETWORK_ERROR"); assert.equal(cut.detail.stage, "stream"); assert.equal(cut.detail.partialChars, 3);
  assert.match(cut.message, /接收流式输出时/); assert.match(cut.message, /已收到 3 字/); assert.ok(cut.detail.cause && cut.detail.cause !== "fetch failed", cut.detail.cause);

  const early = await failure("cut-before-reply", { stream: false });
  assert.equal(early.detail.stage, "connect"); assert.equal(early.detail.streaming, false); assert.match(early.message, /中途断开|网络连接失败/); assert.match(early.detail.cause, /UND_ERR_SOCKET|ECONNRESET|other side closed/i);
  assert.ok(Number.isFinite(early.detail.elapsedMs));

  const silent = await failure("silent", { timeoutMs: 1000 });
  assert.match(silent.message, /超过 1 秒没有收到任何数据/);

  assert.equal((await run("no-stream-options")).text, "好");
  assert.equal(requests.at(-1).stream_options, undefined, "retried without stream_options");

  const mid = await failure("error-mid-stream"); assert.match(mid.message, /upstream overloaded/); assert.equal(mid.detail.kind, "http");
  const partial = await failure("no-finish"); assert.equal(partial.code, "INCOMPLETE_OUTPUT"); assert.equal(partial.partialText, "没说完");
  console.log("provider stream tests passed");
} finally { server.close(); server.closeAllConnections?.(); }
