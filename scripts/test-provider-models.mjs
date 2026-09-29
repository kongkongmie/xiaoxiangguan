import assert from "node:assert/strict";
import { listHttpModels, generate } from "../lib/providers.mjs";

const fake = (status, body, seen) => async (url, init) => { seen?.push({ url, headers: init?.headers || {} }); return { ok: status < 400, status, text: async () => typeof body === "string" ? body : JSON.stringify(body) }; };

// OpenAI-compatible list, trailing endpoint paths trimmed, bearer auth.
const seen = [];
const list = await listHttpModels({ baseUrl: "https://api.deepseek.com/v1/chat/completions", apiKey: "sk-test" }, fake(200, { data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-flash" }, { id: "deepseek-flash" }] }, seen));
assert.equal(seen[0].url, "https://api.deepseek.com/v1/models"); assert.equal(seen[0].headers.authorization, "Bearer sk-test");
assert.deepEqual(list.models.map((m) => m.id), ["deepseek-flash", "deepseek-v4-pro"]);
// Anthropic needs its own headers and returns display names.
const anth = [];
const claude = await listHttpModels({ baseUrl: "https://api.anthropic.com/v1", apiKey: "ak" }, fake(200, { data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }] }, anth));
assert.equal(anth[0].headers["x-api-key"], "ak"); assert.equal(anth[0].headers["anthropic-version"], "2023-06-01");
assert.equal(claude.models[0].name, "Claude Sonnet 5 · claude-sonnet-5");
// Local servers without auth; failures explain themselves.
assert.equal((await listHttpModels({ baseUrl: "http://127.0.0.1:11434/v1", noAuth: true }, fake(200, { data: [{ id: "qwen3:8b" }] }))).models[0].id, "qwen3:8b");
await assert.rejects(listHttpModels({ baseUrl: "https://x.test/v1", apiKey: "bad" }, fake(401, { error: { message: "Invalid API key" } })), /HTTP 401.*Invalid API key/);
await assert.rejects(listHttpModels({ baseUrl: "https://x.test/v1" }), /密钥/);
await assert.rejects(listHttpModels({ baseUrl: "https://x.test/v1", apiKey: "k" }, fake(200, { data: [] })), /手动填写/);

// A failed translation request keeps status and the raw reply for the task record.
const realFetch = globalThis.fetch;
globalThis.fetch = fake(429, { error: { type: "rate_limit_error", message: "Too many requests" } });
try {
  await assert.rejects(generate({ provider: { backend: "http", protocol: "openai-chat", baseUrl: "https://x.test/v1", model: "m", apiKey: "k" }, messages: [{ role: "user", content: "hi" }] }), (error) => {
    assert.match(error.message, /HTTP 429 · rate_limit_error.*Too many requests/);
    assert.equal(error.detail.status, 429); assert.equal(error.detail.model, "m"); assert.match(error.detail.response, /rate_limit_error/); assert.equal(error.detail.endpoint, "x.test/v1/chat/completions");
    assert.equal(JSON.stringify(error.detail).includes("\"k\""), false, "no key in the detail");
    return true;
  });
} finally { globalThis.fetch = realFetch; }
console.log("provider models and error details passed");
