import { modelRefusalError } from "./model-output.mjs";

// Explicit allowlist: credentials must never enter persisted task/revision metadata.
export function providerSnapshot(provider) {
  const snapshot = { backend: provider.backend || "http" };
  for (const key of ["protocol", "model", "reasoningEffort", "baseUrl", "maxOutputTokens", "inputPrice", "outputPrice", "cliPath", "translationBlockChars", "stream", "geminiRetries", "thinkingBudget"]) {
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
  const gemini = provider.protocol === "gemini";
  const base = gemini ? `${geminiRoot(provider.baseUrl)}/v1beta` : provider.baseUrl.replace(/\/+$/, "").replace(/\/(chat\/completions|responses)$/i, "");
  const host = new URL(base).hostname;
  const headers = {};
  if (gemini) { if (!provider.noAuth && provider.apiKey) headers["x-goog-api-key"] = provider.apiKey; }
  else if (!provider.noAuth) headers.authorization = `Bearer ${provider.apiKey}`;
  if (host === "api.anthropic.com") Object.assign(headers, { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" });
  const response = await fetchImpl(`${base}/models${gemini ? "?pageSize=1000" : ""}`, { headers, signal: AbortSignal.timeout(15000) });
  const raw = await response.text();
  let value; try { value = JSON.parse(raw); } catch { throw new Error(`模型列表不是有效 JSON（HTTP ${response.status}）：${raw.slice(0, 160)}`); }
  if (!response.ok || value.error) throw new Error(`读取模型列表失败（HTTP ${response.status}）：${value.error?.message || value.message || raw.slice(0, 160)}`);
  const rows = (Array.isArray(value.data) ? value.data : Array.isArray(value.models) ? value.models : Array.isArray(value) ? value : [])
    // Gemini lists embedding and other models too; keep the ones that can write text.
    .filter((row) => !Array.isArray(row?.supportedGenerationMethods) || row.supportedGenerationMethods.includes("generateContent"));
  const models = [...new Map(rows.map((row) => {
    const id = typeof row === "string" ? row : String(row?.id || row?.name || row?.model || "").replace(/^models\//, "");
    const label = row?.display_name || row?.displayName;
    return id ? [id, { id, name: label && label !== id ? `${label} · ${id}` : id }] : null;
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
// onLive receives what the model is doing while it works: { type: "status", note } | { type: "reasoning" | "text", text }.
export async function generate({ provider, messages, responseSchema, signal, onEvent, onLive, sessionTitle, onSession }) {
  signal?.throwIfAborted();
  if (provider.backend === "opencode" && provider.opencodeMode === "server") {
    const { generateOpenCodeServer } = await import("./opencode-server.mjs");
    return assertFinished(await generateOpenCodeServer({ provider, messages, signal, sessionTitle, onSession }));
  }
  if (provider.backend && provider.backend !== "http") {
    const { generateCli } = await import("./cli-provider.mjs");
    return assertFinished(await generateCli({ provider, messages, responseSchema, signal, onEvent, onLive }));
  }
  if (!provider.baseUrl || !provider.model || (!provider.apiKey && !provider.noAuth)) throw new Error("请先在设置中选择翻译引擎并配置连接");
  if (provider.protocol === "gemini") { const result = await generateGemini({ provider, messages, responseSchema, signal, onLive }); onEvent?.({ type: "completed", runId: result.runId }); return result; }
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
  const headers = { "content-type": "application/json" }; if (!provider.noAuth) headers.authorization = `Bearer ${provider.apiKey}`;
  let text = "", finishReason = null, usage = {}, id = null;
  const onData = (chunk) => {
    id ||= chunk.id; if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0]; if (!choice) return;
    const piece = choice.delta?.content; const added = typeof piece === "string" ? piece : Array.isArray(piece) ? piece.map((p) => p.text || "").join("") : "";
    if (added) { text += added; onLive?.({ type: "text", text: added }); }
    const thought = choice.delta?.reasoning_content ?? choice.delta?.reasoning ?? choice.delta?.reasoning_text;
    if (typeof thought === "string" && thought) onLive?.({ type: "reasoning", text: thought });
    if (choice.finish_reason) finishReason = String(choice.finish_reason).toLowerCase();
  };
  const payload = stream ? { ...body, stream: true, stream_options: { include_usage: true } } : body;
  const started = Date.now();
  let reply = await send({ url, headers, payload, stream, provider, signal, onData, onLive, partial: () => text, startedAt: started });
  // A few services reject stream_options; retry once without it rather than failing the block.
  if (stream && !reply.response.ok && reply.response.status === 400 && /stream_options/i.test(reply.raw || "")) { const { stream_options, ...plain } = payload; reply = await send({ url, headers, payload: plain, stream, provider, signal, onData, onLive, partial: () => text, startedAt: started }); }
  if (reply.streamed) {
    if (!finishReason && text) finishReason = "interrupted";
    const result = assertFinished({ text: text.trim(), refusal: null, finishReason, usage: { inputTokens: usage.prompt_tokens ?? null, outputTokens: usage.completion_tokens ?? null }, runId: id || null, backend: "http" });
    onEvent?.({ type: "completed", runId: result.runId }); return result;
  }
  const value = parseReply(reply, provider);
  const content = value.choices?.[0]?.message?.content;
  const whole = responses ? value.output_text || (value.output || []).flatMap((i) => i.content || []).filter((i) => i.type === "output_text").map((i) => i.text).join("\n") : typeof content === "string" ? content : (content || []).map((i) => i.text || "").join("\n");
  if (whole) onLive?.({ type: "text", text: whole });
  const used = value.usage || {};
  const refusal = responses ? (value.output || []).flatMap((item) => item.content || []).filter((item) => item.type === "refusal").map((item) => item.refusal || "refusal").join("\n") : value.choices?.[0]?.message?.refusal;
  const result = assertFinished({ text: whole.trim(), refusal, finishReason: responses ? value.incomplete_details?.reason || value.status : value.choices?.[0]?.finish_reason,
    usage: { inputTokens: used.prompt_tokens ?? used.input_tokens ?? null, outputTokens: used.completion_tokens ?? used.output_tokens ?? null }, runId: value.id || null, backend: "http" });
  onEvent?.({ type: "completed", runId: result.runId }); return result;
}

// One HTTP request with an idle timeout. Streaming replies are read as server-sent events and handed to onData;
// anything else (errors, services that ignore streaming) comes back whole as raw text.
async function send({ url, headers, payload, stream, provider, signal, onData, onLive, partial, startedAt = Date.now() }) {
  const idleMs = provider.timeoutMs || 300000; const endpoint = new URL(url).host + new URL(url).pathname;
  const idle = new AbortController(); let timer; const touch = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(new DOMException("idle", "TimeoutError")), idleMs); };
  const combined = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
  let events = 0;
  const fail = (error, stage, extra = {}) => { signal?.throwIfAborted(); throw networkError(error, { stage, stream, endpoint, model: provider.model, elapsedMs: Date.now() - startedAt, idleMs, timedOut: idle.signal.aborted, ...extra }); };
  touch();
  onLive?.({ type: "status", note: `已发出请求（${stream ? "流式" : "整段返回"}），等待服务响应` });
  try {
    let response; try { response = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: combined }); } catch (error) { fail(error, "connect"); }
    touch();
    onLive?.({ type: "status", note: `服务已响应 HTTP ${response.status}${stream && response.ok ? "，开始接收" : "，等待整段内容"}` });
    if (!stream || !response.ok || !response.body?.getReader) {
      let raw; try { raw = await response.text(); } catch (error) { fail(error, "read", { status: response.status }); }
      return { response, raw, endpoint };
    }
    // Some relays send server-sent events without saying so (content-type: application/json or text/plain),
    // and some services ignore the stream flag: decide by what the body actually starts with.
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "", mode = /event-stream/i.test(response.headers?.get?.("content-type") || "") ? "sse" : "";
    const consume = (line) => {
      if (!line.startsWith("data:")) return; const data = line.slice(5).trim(); if (!data || data === "[DONE]") return;
      let chunk; try { chunk = JSON.parse(data); } catch { return; }
      events++;
      if (chunk.error) throw Object.assign(new Error(`API 在输出中途报错：${chunk.error.message || JSON.stringify(chunk.error).slice(0, 200)}`), { detail: { kind: "http", status: response.status, endpoint, model: provider.model, response: data.slice(0, 1500) } });
      onData(chunk);
    };
    for (;;) {
      let part; try { part = await reader.read(); } catch (error) { fail(error, "stream", { status: response.status, partialChars: partial().length, events }); }
      if (part.done) break; touch();
      buffer += decoder.decode(part.value, { stream: true });
      if (!mode) { const head = buffer.trimStart(); if (!head) continue; mode = /^(data|event|id|retry):|^:/.test(head) ? "sse" : head.length >= 6 || /[{\[]/.test(head[0]) ? "whole" : ""; }
      if (mode !== "sse") continue;
      const lines = buffer.split(/\r?\n/); buffer = lines.pop(); for (const line of lines) consume(line);
    }
    buffer += decoder.decode();
    if (mode !== "sse") return { response, raw: buffer, endpoint };
    consume(buffer.trim());
    return { response, streamed: true, endpoint };
  } finally { clearTimeout(timer); }
}

// A whole (non-streamed) reply as JSON, or an error that says what the service actually returned.
function parseReply({ response, raw, endpoint }, provider) {
  // The raw reply is kept (truncated) on failures so the task list can show what the service actually said.
  const detail = { kind: "http", status: response.status, endpoint, model: provider.model, response: raw.slice(0, 1500) };
  const relay = /BROWSER_NOT_CONNECTED|BROWSER_DISCONNECTED/.test(raw) ? "。反代的中继网页没有连上：请打开 AI Studio 中继网页并保持“已连接”，本地服务也要开着" : "";
  let value; try { value = JSON.parse(raw); } catch { throw Object.assign(new Error(`API 返回了无法解析的内容（HTTP ${response.status}）：${raw.slice(0, 200)}${relay}`), { detail }); }
  const error = Array.isArray(value) ? value[0]?.error : value.error;
  if (!response.ok || error) {
    const code = error?.status || error?.code || error?.type;
    if (["content_filter", "content_policy_violation", "safety_violation", "moderation_blocked"].includes(code)) throw Object.assign(modelRefusalError(error?.message, code), { detail });
    const message = error?.message || value.message || (typeof error === "string" ? error : "");
    throw Object.assign(new Error(`API 请求失败（HTTP ${response.status}${code ? ` · ${code}` : ""}）${message ? `：${message}` : ""}${relay}`), { detail });
  }
  return value;
}

// Google's own generateContent protocol: Google AI Studio keys, and local AI Studio relays that SillyTavern
// reaches through its "Google AI Studio" reverse-proxy setting.
export function geminiRoot(baseUrl) { return String(baseUrl || "").replace(/\/+$/, "").replace(/\/(v1beta|v1alpha|v1)(\/models)?$/i, ""); }
const GEMINI_SAFETY = ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"].map((category) => ({ category, threshold: "BLOCK_NONE" }));
const GEMINI_FINISH = { STOP: "stop", MAX_TOKENS: "length", SAFETY: "safety", RECITATION: "blocked", PROHIBITED_CONTENT: "blocked", BLOCKLIST: "blocked", SPII: "blocked", IMAGE_SAFETY: "blocked" };
// Google's input/output moderation for Gemini is known to misfire on literary text, and a fresh request with
// the same text (streamed or not) usually goes through; so a blocked reply is re-sent unchanged a few times.
export function geminiRetries(provider) { const n = Number(provider.geminiRetries); return Number.isInteger(n) && n >= 0 ? Math.min(n, 5) : 2; }
async function generateGemini({ provider, messages, responseSchema, signal, onLive }) {
  const retries = geminiRetries(provider), streamFirst = provider.stream !== false, reasons = [];
  for (let attempt = 0; ; attempt++) {
    // Retries alternate between streaming and a whole reply; both paths are moderated differently.
    const stream = attempt % 2 === 0 ? streamFirst : !streamFirst;
    try { return await geminiOnce({ provider, messages, responseSchema, signal, stream, onLive }); }
    catch (error) {
      const blocked = error.code === "MODEL_REFUSAL" && ["blocked", "safety"].includes(error.finishReason);
      if (!blocked) throw error;
      reasons.push(`${stream ? "流式" : "非流式"}：${error.geminiReason || "拦截"}`);
      onLive?.({ type: "status", note: `Gemini 拦截（${error.geminiReason || "拦截"}）${attempt < retries ? `，稍后原样重发（第 ${attempt + 1} 次）` : ""}` });
      if (attempt >= retries) {
        if (attempt > 0) error.message += `（已原样重发 ${attempt} 次，${reasons.join("；")}）`;
        throw error;
      }
      await new Promise((resolve, reject) => { const t = setTimeout(resolve, 1200 * (attempt + 1)); signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); }, { once: true }); });
    }
  }
}
async function geminiOnce({ provider, messages, responseSchema, signal, stream, onLive }) {
  const model = String(provider.model).replace(/^models\//, "");
  const url = `${geminiRoot(provider.baseUrl)}/v1beta/models/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
  const headers = { "content-type": "application/json" }; if (!provider.noAuth && provider.apiKey) headers["x-goog-api-key"] = provider.apiKey;
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const budget = provider.thinkingBudget === "" || provider.thinkingBudget == null ? null : Number(provider.thinkingBudget);
  const payload = {
    // Gemini wants turns to alternate, so back-to-back messages of one role become parts of one turn.
    contents: messages.filter((m) => m.role !== "system").reduce((turns, m) => { const role = m.role === "assistant" ? "model" : "user"; if (turns.at(-1)?.role === role) turns.at(-1).parts.push({ text: m.content }); else turns.push({ role, parts: [{ text: m.content }] }); return turns; }, []),
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    // Literary translation: let the text through; a real refusal still comes back as a finish reason.
    safetySettings: GEMINI_SAFETY,
    generationConfig: { maxOutputTokens: provider.maxOutputTokens || 8192, ...(responseSchema && provider.structuredOutput ? { responseMimeType: "application/json" } : {}), ...(Number.isInteger(budget) && budget >= 0 ? { thinkingConfig: { thinkingBudget: budget } } : {}) }
  };
  let text = "", finishReason = null, refusal = null, usage = {}, id = null, reason = "";
  const onData = (chunk) => {
    id ||= chunk.responseId || null; if (chunk.usageMetadata) usage = chunk.usageMetadata;
    if (chunk.promptFeedback?.blockReason) { reason = `提示词被拦截 ${chunk.promptFeedback.blockReason}`; refusal = `提示词被拦截：${chunk.promptFeedback.blockReason}`; finishReason = "blocked"; }
    const candidate = chunk.candidates?.[0]; if (!candidate) return;
    // Thought summaries are not part of the answer.
    for (const part of candidate.content?.parts || []) {
      if (typeof part.text !== "string" || !part.text) continue;
      if (part.thought) onLive?.({ type: "reasoning", text: part.text }); else { text += part.text; onLive?.({ type: "text", text: part.text }); }
    }
    if (candidate.finishReason) { finishReason = GEMINI_FINISH[candidate.finishReason] || String(candidate.finishReason).toLowerCase(); if (["safety", "blocked"].includes(finishReason)) { reason ||= `输出被拦截 ${candidate.finishReason}`; refusal ||= `Gemini 拦截了输出：${candidate.finishReason}`; } }
  };
  const reply = await send({ url, headers, payload, stream, provider, signal, onData, onLive, partial: () => text });
  if (!reply.streamed) { const value = parseReply(reply, provider); for (const chunk of Array.isArray(value) ? value : [value]) onData(chunk); }
  if (!finishReason && text) finishReason = "interrupted";
  try { return assertFinished({ text: text.trim(), refusal, finishReason, usage: { inputTokens: usage.promptTokenCount ?? null, outputTokens: usage.candidatesTokenCount == null ? null : usage.candidatesTokenCount + (usage.thoughtsTokenCount || 0) }, runId: id, backend: "http" }); }
  catch (error) { error.geminiReason = reason; throw error; }
}
