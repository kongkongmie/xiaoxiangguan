import { modelRefusalError } from "./model-output.mjs";

// Explicit allowlist: credentials must never enter persisted task/revision metadata.
export function providerSnapshot(provider) {
  const snapshot = { backend: provider.backend || "http" };
  for (const key of ["protocol", "model", "reasoningEffort", "baseUrl", "maxOutputTokens", "inputPrice", "outputPrice", "cliPath", "translationBlockChars", "stream"]) {
    if (provider[key] !== undefined) snapshot[key] = provider[key];
  }
  if (provider.backend === "opencode" && provider.opencodeMode === "server") {
    for (const key of ["opencodeMode", "opencodeServerUrl", "opencodeDirectory"]) snapshot[key] = provider[key];
  }
  // Display-only labels for comparing versions; never credentials.
  for (const key of ["providerName", "profileId", "profileName", "profileColor"]) if (typeof provider[key] === "string" && provider[key]) snapshot[key] = provider[key];
  return snapshot;
}

// Model list from an OpenAI-compatible service (OpenAI, DeepSeek, Ollama, most relays) or Anthropic's own endpoint.
export async function listHttpModels(provider, fetchImpl = fetch) {
  if (!provider.baseUrl) throw new Error("请先填写 API 基础地址");
  if (!provider.apiKey && !provider.noAuth) throw new Error("请先填写 API 密钥");
  const base = provider.baseUrl.replace(/\/+$/, "").replace(/\/(chat\/completions|responses)$/i, "");
  const host = new URL(base).hostname;
  const headers = {};
  if (!provider.noAuth) headers.authorization = `Bearer ${provider.apiKey}`;
  if (host === "api.anthropic.com") Object.assign(headers, { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" });
  const response = await fetchImpl(`${base}/models`, { headers, signal: AbortSignal.timeout(15000) });
  const raw = await response.text();
  let value; try { value = JSON.parse(raw); } catch { throw new Error(`模型列表不是有效 JSON（HTTP ${response.status}）：${raw.slice(0, 160)}`); }
  if (!response.ok || value.error) throw new Error(`读取模型列表失败（HTTP ${response.status}）：${value.error?.message || value.message || raw.slice(0, 160)}`);
  const rows = Array.isArray(value.data) ? value.data : Array.isArray(value.models) ? value.models : Array.isArray(value) ? value : [];
  const models = [...new Map(rows.map((row) => {
    const id = typeof row === "string" ? row : row?.id || row?.name || row?.model;
    return id ? [id, { id, name: row?.display_name && row.display_name !== id ? `${row.display_name} · ${id}` : id }] : null;
  }).filter(Boolean)).values()].sort((a, b) => a.id.localeCompare(b.id));
  if (!models.length) throw new Error("服务商没有返回可用模型；可以手动填写模型 ID");
  return { backend: "http", models, source: "remote", fetchedAt: new Date().toISOString(), hint: `来自 ${host} 的模型列表；实际可用范围以账号权限为准。` };
}

export function assertFinished(result) {
  if (result.refusal || ["content_filter", "refusal", "safety", "blocked"].includes(String(result.finishReason).toLowerCase())) {
    throw modelRefusalError(result.refusal, result.finishReason);
  }
  if (!["stop", "completed", "end_turn"].includes(result.finishReason)) {
    const hint = ["length", "max_output_tokens"].includes(result.finishReason) ? "，可提高输出上限后从此块重试" : "，可从此块重试";
    const error = new Error(`模型输出未完整结束（${result.finishReason || "unknown"}）；此块未采用${hint}`);
    error.code = "INCOMPLETE_OUTPUT"; error.partialText = result.text; error.finishReason = result.finishReason;
    throw error;
  }
  if (!result.text?.trim()) throw new Error("模型没有返回最终正文");
  return result;
}
// Node's fetch reports every network problem as "fetch failed"; the real reason is in error.cause.
const NETWORK_REASONS = [
  [/UND_ERR_SOCKET|ECONNRESET|EPIPE|other side closed|terminated/i, "服务端或中转站中途断开了连接"],
  [/UND_ERR_HEADERS_TIMEOUT/i, "等待服务端响应超时"], [/UND_ERR_BODY_TIMEOUT/i, "接收内容时超时"],
  [/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT/i, "连接服务器超时"], [/ENOTFOUND|EAI_AGAIN/i, "域名解析失败（地址写错或网络/代理不通）"],
  [/ECONNREFUSED/i, "连接被拒绝（地址或端口不对，或服务没开）"], [/CERT|SSL|TLS|self.signed|UNABLE_TO_VERIFY/i, "HTTPS 证书校验失败"]
];
export function networkError(error, info) {
  const cause = error?.cause || {}; const code = cause.code || cause.name || error?.code || "";
  const said = [code, cause.message || (error?.message !== "fetch failed" ? error?.message : "")].filter(Boolean).join(" · ");
  const seconds = Math.round(info.elapsedMs / 1000);
  const reason = info.timedOut ? `超过 ${Math.round(info.idleMs / 1000)} 秒没有收到任何数据` : NETWORK_REASONS.find(([pattern]) => pattern.test(`${code} ${cause.message || ""} ${error?.message || ""}`))?.[1] || "网络连接失败";
  const where = { connect: "连接或等待回复时", read: "读取回复时", stream: "接收流式输出时" }[info.stage] || "";
  const hint = !info.timedOut && !info.stream && seconds >= 60 ? "。请求在等待 " + seconds + " 秒后被切断，常见于中转站/CDN 的空闲超时：请开启流式传输，或调小每块字数"
    : info.stage === "stream" ? `。已收到 ${info.partialChars || 0} 字，此块可从断点重试` : "";
  const message = `${where}${where ? "，" : ""}${reason}（${seconds} 秒${said ? `；底层错误：${said}` : ""}）${hint}`;
  return Object.assign(new Error(message), { code: "NETWORK_ERROR", detail: { kind: "network", endpoint: info.endpoint, model: info.model, stage: info.stage, streaming: info.stream, elapsedMs: info.elapsedMs, status: info.status, cause: said || "fetch failed", partialChars: info.partialChars } });
}
export async function generate({ provider, messages, responseSchema, signal, onEvent, sessionTitle, onSession }) {
  signal?.throwIfAborted();
  if (provider.backend === "opencode" && provider.opencodeMode === "server") {
    const { generateOpenCodeServer } = await import("./opencode-server.mjs");
    return assertFinished(await generateOpenCodeServer({ provider, messages, signal, sessionTitle, onSession }));
  }
  if (provider.backend && provider.backend !== "http") {
    const { generateCli } = await import("./cli-provider.mjs");
    return assertFinished(await generateCli({ provider, messages, responseSchema, signal, onEvent }));
  }
  if (!provider.baseUrl || !provider.model || (!provider.apiKey && !provider.noAuth)) throw new Error("请先在设置中选择翻译引擎并配置连接");
  const responses = provider.protocol === "openai-responses";
  const base = provider.baseUrl.replace(/\/+$/, "");
  const url = responses ? (/\/responses$/i.test(base) ? base : `${base}/responses`) : (/\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`);
  const deepseek = new URL(base).hostname === "api.deepseek.com";
  const body = responses
    ? { model: provider.model, input: messages.map((m) => ({ role: m.role, content: [{ type: "input_text", text: m.content }] })), max_output_tokens: provider.maxOutputTokens || 8192 }
    : { model: provider.model, messages, max_tokens: provider.maxOutputTokens || 8192, ...(deepseek ? { thinking: { type: "disabled" }, reasoning_effort: "none" } : {}) };
  // Prompt-level JSON remains compatible with OpenAI-compatible services without schema support.
  if (responseSchema && deepseek && !responses) body.response_format = { type: "json_object" };
  else if (responseSchema && provider.structuredOutput) {
    if (responses) body.text = { format: { type: "json_schema", name: "translation", strict: true, schema: responseSchema } };
    else body.response_format = { type: "json_schema", json_schema: { name: "translation", strict: true, schema: responseSchema } };
  }
  // Chat requests stream by default: bytes keep flowing while a slow model thinks, so relays and CDNs
  // that drop quiet connections after ~100 s do not cut the request. The timeout is an idle timeout.
  const stream = !responses && provider.stream !== false;
  const idleMs = provider.timeoutMs || 300000; const startedAt = Date.now();
  const endpoint = new URL(url).host + new URL(url).pathname;
  const headers = { "content-type": "application/json" }; if (!provider.noAuth) headers.authorization = `Bearer ${provider.apiKey}`;
  const attempt = async (payload) => {
    const idle = new AbortController(); let timer; const touch = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(new DOMException("idle", "TimeoutError")), idleMs); };
    const combined = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
    const fail = (error, stage, extra = {}) => { signal?.throwIfAborted(); throw networkError(error, { stage, stream, endpoint, model: provider.model, elapsedMs: Date.now() - startedAt, idleMs, timedOut: idle.signal.aborted, ...extra }); };
    touch();
    try {
      let response; try { response = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: combined }); } catch (error) { fail(error, "connect"); }
      touch();
      const type = response.headers?.get?.("content-type") || "";
      if (!payload.stream || !response.ok || !/event-stream/i.test(type) || !response.body?.getReader) {
        let raw; try { raw = await response.text(); } catch (error) { fail(error, "read", { status: response.status }); }
        return { response, raw };
      }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "", text = "", finishReason = null, usage = {}, id = null, events = 0;
      const consume = (line) => {
        if (!line.startsWith("data:")) return; const data = line.slice(5).trim(); if (!data || data === "[DONE]") return;
        let chunk; try { chunk = JSON.parse(data); } catch { return; }
        events++; if (chunk.error) throw Object.assign(new Error(`API 在输出中途报错：${chunk.error.message || JSON.stringify(chunk.error).slice(0, 200)}`), { detail: { kind: "http", status: response.status, endpoint, model: provider.model, response: data.slice(0, 1500) } });
        id ||= chunk.id; if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0]; if (!choice) return;
        const piece = choice.delta?.content; if (typeof piece === "string") text += piece; else if (Array.isArray(piece)) text += piece.map((p) => p.text || "").join("");
        if (choice.finish_reason) finishReason = String(choice.finish_reason).toLowerCase();
      };
      for (;;) {
        let part; try { part = await reader.read(); } catch (error) { fail(error, "stream", { status: response.status, partialChars: text.length, events }); }
        if (part.done) break; touch();
        buffer += decoder.decode(part.value, { stream: true });
        const lines = buffer.split(/\r?\n/); buffer = lines.pop(); for (const line of lines) consume(line);
      }
      consume(buffer.trim());
      if (!finishReason && text) finishReason = "interrupted";
      return { response, streamed: { text, finishReason, usage, id } };
    } finally { clearTimeout(timer); }
  };
  const payload = stream ? { ...body, stream: true, stream_options: { include_usage: true } } : body;
  let reply = await attempt(payload);
  // A few services reject stream_options; retry once without it rather than failing the block.
  if (stream && !reply.response.ok && reply.response.status === 400 && /stream_options/i.test(reply.raw || "")) { const { stream_options, ...plain } = payload; reply = await attempt(plain); }
  const { response } = reply;
  if (reply.streamed) {
    const { text, finishReason, usage, id } = reply.streamed;
    const result = assertFinished({ text: text.trim(), refusal: null, finishReason, usage: { inputTokens: usage.prompt_tokens ?? null, outputTokens: usage.completion_tokens ?? null }, runId: id || null, backend: "http" });
    onEvent?.({ type: "completed", runId: result.runId }); return result;
  }
  const raw = reply.raw;
  // The raw reply is kept (truncated) on failures so the task list can show what the service actually said.
  const detail = { kind: "http", status: response.status, endpoint, model: provider.model, response: raw.slice(0, 1500) };
  let value; try { value = JSON.parse(raw); } catch { throw Object.assign(new Error(`API 返回了无法解析的内容（HTTP ${response.status}）：${raw.slice(0, 200)}`), { detail }); }
  if (!response.ok || value.error) {
    const code = value.error?.code || value.error?.type;
    if (["content_filter", "content_policy_violation", "safety_violation", "moderation_blocked"].includes(code)) throw Object.assign(modelRefusalError(value.error?.message, code), { detail });
    const message = value.error?.message || value.message || (typeof value.error === "string" ? value.error : "");
    throw Object.assign(new Error(`API 请求失败（HTTP ${response.status}${code ? ` · ${code}` : ""}）${message ? `：${message}` : ""}`), { detail });
  }
  const content = value.choices?.[0]?.message?.content;
  const text = responses ? value.output_text || (value.output || []).flatMap((i) => i.content || []).filter((i) => i.type === "output_text").map((i) => i.text).join("\n") : typeof content === "string" ? content : (content || []).map((i) => i.text || "").join("\n");
  const usage = value.usage || {};
  const refusal = responses ? (value.output || []).flatMap((item) => item.content || []).filter((item) => item.type === "refusal").map((item) => item.refusal || "refusal").join("\n") : value.choices?.[0]?.message?.refusal;
  const result = assertFinished({ text: text.trim(), refusal, finishReason: responses ? value.incomplete_details?.reason || value.status : value.choices?.[0]?.finish_reason,
    usage: { inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? null, outputTokens: usage.completion_tokens ?? usage.output_tokens ?? null }, runId: value.id || null, backend: "http" });
  onEvent?.({ type: "completed", runId: result.runId }); return result;
}
