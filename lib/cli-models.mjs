// Model discovery follows the local Story Bible Studio adapters: no generation turns.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliExecutable, runCliProcess } from "./cli-provider.mjs";

const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const variantPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$/;
export function validateCliChoice({ backend, model = "", reasoningEffort = "" }, catalog) {
  if (model && (typeof model !== "string" || !modelPattern.test(model) || backend === "opencode" && !/^[^/]+\/.+/.test(model))) throw new Error("模型 ID 无效；OpenCode 需使用 provider/model 格式");
  if (!reasoningEffort) return;
  const valid = typeof reasoningEffort === "string" && (backend === "codex" ? efforts.includes(reasoningEffort) : backend === "claude" ? claudeEfforts.includes(reasoningEffort) : backend === "antigravity" ? ["low", "medium", "high"].includes(reasoningEffort) : variantPattern.test(reasoningEffort));
  if (!valid) throw new Error("推理强度无效，请从模型支持的选项中选择");
  const selected = catalog?.models.find((m) => m.id === model);
  if (!selected?.reasoningEfforts?.includes(reasoningEffort)) throw new Error("所选模型未提供此推理强度；请刷新模型列表，或使用默认强度");
}
export function normalizeCodexModels(rows) {
  if (!Array.isArray(rows)) throw new Error("Codex 模型目录格式无效");
  return rows.filter((r) => r && !r.hidden && typeof (r.model || r.id) === "string").map((r) => {
    if (!Array.isArray(r.supportedReasoningEfforts)) throw new Error("Codex 模型缺少推理强度信息");
    return { id: r.model || r.id, name: r.displayName || r.model || r.id, reasoningEfforts: [...new Set(r.supportedReasoningEfforts.map((e) => e.reasoningEffort).filter((e) => efforts.includes(e)))], defaultReasoningEffort: r.defaultReasoningEffort || "", isDefault: Boolean(r.isDefault) };
  });
}
export async function discoverCodexModels(executable, cwd, runner = runCliProcess, timeoutMs = 20000) {
  let channel, requestId = 1, initialized = false, complete = false;
  const models = new Map(), cursors = new Set();
  const nextPage = (cursor) => channel.send({ id: ++requestId, method: "model/list", params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) } });
  await runner({ executable, args: ["app-server"], cwd, timeoutMs, env: { CODEX_THREAD_ID: undefined },
    onStart: (value) => { channel = value; channel.send({ id: 1, method: "initialize", params: { clientInfo: { name: "xiaoxiangguan", title: "瀟湘館", version: "1.9.0" } } }); },
    onLine: (line) => {
      let event; try { event = JSON.parse(line); } catch { return; }
      if (event.id !== requestId) return;
      if (event.error || !event.result || typeof event.result !== "object") throw new Error("Codex 无法提供模型目录，请检查 CLI 登录与配置");
      if (!initialized) { initialized = true; channel.send({ method: "initialized" }); nextPage(); return; }
      for (const row of normalizeCodexModels(event.result.data)) models.set(row.id, row);
      const cursor = event.result.nextCursor;
      if (!cursor) { complete = true; channel.end(); return; }
      if (typeof cursor !== "string" || cursors.has(cursor) || cursors.size >= 100) throw new Error("Codex 模型目录分页异常");
      cursors.add(cursor); nextPage(cursor);
    }
  });
  if (!complete) throw new Error("Codex 模型查询提前退出");
  return [...models.values()];
}
export function parseOpenCodeModels(text) {
  const models = new Map(); const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const id = lines[index].trim(); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id)) continue;
    const row = { id, name: id }; let start = index + 1;
    while (start < lines.length && !lines[start].trim()) start++;
    if (lines[start]?.trim().startsWith("{")) {
      let payload = "";
      for (let end = start; end < lines.length; end++) {
        payload += `${lines[end]}\n`;
        try { const info = JSON.parse(payload); row.name = info.name ? `${info.name} · ${id}` : id; row.reasoningEfforts = Object.entries(info.variants || {}).filter(([key, value]) => variantPattern.test(key) && value && typeof value === "object" && !value.disabled).map(([key]) => key); index = end; break; } catch { /* multiline JSON, or unknown capability */ }
        if (end > start && /^[A-Za-z0-9][A-Za-z0-9._:-]*\//.test(lines[end])) break;
      }
    }
    models.set(id, row);
  }
  return [...models.values()];
}
export function parseAntigravityModels(text) {
  return text.split(/\r?\n/).flatMap((line) => { const match = line.trim().match(/^([a-z0-9][a-z0-9._:/-]*)\s+(.+)$/); return match ? [{ id: match[1], name: match[2], reasoningEfforts: ["low", "medium", "high"] }] : []; });
}
const claudeEfforts = ["low", "medium", "high", "xhigh", "max"];
// Claude Code has no model-list command; aliases always resolve to the newest model the account can use.
export const claudeModels = [
  { id: "sonnet", name: "Sonnet · 最新版（推荐，快）", reasoningEfforts: claudeEfforts },
  { id: "opus", name: "Opus · 最新版（文笔更细，慢）", reasoningEfforts: claudeEfforts },
  { id: "fable", name: "Fable · 最新版（需账号支持）", reasoningEfforts: claudeEfforts },
  { id: "haiku", name: "Haiku · 最新版（最省额度）", reasoningEfforts: [] }
];
const cache = new Map();
export async function discoverCliModels(backend, cliPath, refresh = false) {
  const executable = cliExecutable(backend, cliPath); const key = `${backend}:${executable}`;
  if (!refresh && cache.has(key) && Date.now() - cache.get(key).at < 300000) return cache.get(key).catalog;
  const folder = await mkdtemp(join(tmpdir(), "xiaoxiangguan-models-"));
  try {
    let models;
    if (backend === "codex") models = await discoverCodexModels(executable, folder);
    else if (backend === "claude") { await runCliProcess({ executable, cwd: folder, args: ["--version"], timeoutMs: 20000 }); models = claudeModels; }
    else {
      const { stdout } = await runCliProcess({ executable, cwd: folder, args: backend === "opencode" ? ["models", "--verbose"] : ["models"], timeoutMs: 20000 });
      models = backend === "opencode" ? parseOpenCodeModels(stdout) : parseAntigravityModels(stdout);
    }
    if (!models.length) throw new Error("未返回可识别的模型目录");
    const catalog = { backend, models, source: "local-cli", fetchedAt: new Date().toISOString(), hint: backend === "claude" ? "Claude Code 使用模型别名，自动指向账号可用的最新版本；实际调用权限以订阅为准。" : "来自本机 CLI 的模型目录；实际调用权限以账号为准。" };
    cache.set(key, { at: Date.now(), catalog }); return catalog;
  } catch { throw new Error(`无法读取 ${backend} 模型目录，请检查 CLI 安装、登录和网络；也可手动填写模型 ID 并使用默认强度`); }
  finally { await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {}); }
}
