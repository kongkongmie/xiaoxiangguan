import { modelRefusalError } from "./model-output.mjs";

// Explicit allowlist: credentials must never enter persisted task/revision metadata.
export function providerSnapshot(provider) {
  const snapshot = { backend: provider.backend || "http" };
  for (const key of ["protocol", "model", "reasoningEffort", "baseUrl", "maxOutputTokens", "inputPrice", "outputPrice", "cliPath", "translationBlockChars"]) {
    if (provider[key] !== undefined) snapshot[key] = provider[key];
  }
  if (provider.backend === "opencode" && provider.opencodeMode === "server") {
    for (const key of ["opencodeMode", "opencodeServerUrl", "opencodeDirectory"]) snapshot[key] = provider[key];
  }
  // Display-only labels for comparing versions; never credentials.
  for (const key of ["providerName", "profileId", "profileName", "profileColor"]) if (typeof provider[key] === "string" && provider[key]) snapshot[key] = provider[key];
  return snapshot;
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
  const timeout = AbortSignal.timeout(provider.timeoutMs || 300000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const headers = { "content-type": "application/json" }; if (!provider.noAuth) headers.authorization = `Bearer ${provider.apiKey}`;
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: combined });
  const raw = await response.text(); combined.throwIfAborted();
  let value; try { value = JSON.parse(raw); } catch { throw new Error(`API 返回了无法解析的内容：${raw.slice(0, 200)}`); }
  if (!response.ok || value.error) {
    const code = value.error?.code || value.error?.type;
    if (["content_filter", "content_policy_violation", "safety_violation", "moderation_blocked"].includes(code)) throw modelRefusalError(value.error?.message, code);
    throw new Error(value.error?.message || value.message || `API 请求失败 (${response.status})`);
  }
  const content = value.choices?.[0]?.message?.content;
  const text = responses ? value.output_text || (value.output || []).flatMap((i) => i.content || []).filter((i) => i.type === "output_text").map((i) => i.text).join("\n") : typeof content === "string" ? content : (content || []).map((i) => i.text || "").join("\n");
  const usage = value.usage || {};
  const refusal = responses ? (value.output || []).flatMap((item) => item.content || []).filter((item) => item.type === "refusal").map((item) => item.refusal || "refusal").join("\n") : value.choices?.[0]?.message?.refusal;
  const result = assertFinished({ text: text.trim(), refusal, finishReason: responses ? value.incomplete_details?.reason || value.status : value.choices?.[0]?.finish_reason,
    usage: { inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? null, outputTokens: usage.completion_tokens ?? usage.output_tokens ?? null }, runId: value.id || null, backend: "http" });
  onEvent?.({ type: "completed", runId: result.runId }); return result;
}
