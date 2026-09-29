import { discoverCliModels, validateCliChoice } from "./lib/cli-models.mjs";
import { probeCli } from "./lib/cli-provider.mjs";
import { providerSnapshot, listHttpModels } from "./lib/providers.mjs";
import { OpenCodeServer, usesOpenCodeServer, discoverOpenCodeServerModels, probeOpenCodeServer, stopOpenCodeSessions } from "./lib/opencode-server.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
import { sourceParagraphs, sourceFingerprint, revisionSegments, DEFAULT_TRANSLATION_BLOCK_CHARS, validateTranslationBlockChars } from "./lib/alignment.mjs";
import http from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createEpub } from "./lib/epub.mjs";
import { isIllustrationText } from "./public/illustrations.js";
import { analyzeChapterEntities, checkControl, waitControl, extractDocument, identifyHighRisk, japaneseOcrPath, ocrStatus, readChapterText, testProviderConnection, alignSelection, bookImages, bookImagesDir, translateChapter, writeTranslation } from "./lib/engine.mjs";
import { SOURCE_LANGUAGES, sourceLanguage } from "./public/languages.js";
import { searchResearchSources, verifyIssue } from "./lib/research.mjs";
import { createSearchBudget } from "./lib/search-budget.mjs";
import { comparableVersions, partialVersions, composeRevision, engineKey, isVersionColor, VERSION_PALETTE } from "./public/compare-core.js";
import { activeRevisionPath, preserveLegacyRevision, canAutoRevise, canAutoReviseFromEvidence, newRevisionId, preserveChapterRevisionState } from "./lib/revisions.mjs";
import { dataRoot } from "./lib/data-paths.mjs";
import { toolCandidates } from "./lib/tool-paths.mjs";
import { trackChild, stopChildProcesses } from "./lib/child-processes.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, "public");
const DATA_ROOT = dataRoot({ root: ROOT });
const DATA = join(DATA_ROOT, "data");
const DATA_FILE = join(DATA, "library.json");
const SECRETS = join(DATA_ROOT, "secrets");
const PROVIDER_FILE = join(SECRETS, "provider.json");
const SEARCH_FILE = join(SECRETS, "search.json");
const PROFILES_FILE = join(SECRETS, "engine-profiles.json");
const SEARCH_CACHE_FILE = join(DATA, "search-cache.json");
const EXPORTS = join(DATA_ROOT, "exports");
const LIBRARY = join(DATA_ROOT, "library");
const PORT = Number(process.env.PORT || 4327);
const MAX_UPLOAD = 512 * 1024 * 1024;
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".epub": "application/epub+zip" };

await mkdir(DATA, { recursive: true });
if (!existsSync(DATA_FILE)) await writeFile(DATA_FILE, '{"books":[],"exports":[]}\n', { encoding: "utf8", flag: "wx" }).catch((error) => { if (error.code !== "EEXIST") throw error; });
await mkdir(EXPORTS, { recursive: true });
await mkdir(LIBRARY, { recursive: true });
await mkdir(SECRETS, { recursive: true });

try {
  const startupData = JSON.parse(await readFile(DATA_FILE, "utf8")); let changed = false;
  for (const book of startupData.books || []) for (const task of book.tasks || []) if (["queued", "running", "paused"].includes(task.status)) { task.status = "failed"; task.error = "应用在任务执行期间重启；已完成块保留，可继续翻译"; const chapter = book.chapters?.find((c) => c.translationRun?.id === task.id); if (chapter?.translationRun?.status === "running") { chapter.translationRun.status = "failed"; chapter.translationRun.error = task.error; } changed = true; }
  if (changed) await writeFile(DATA_FILE, `${JSON.stringify(startupData, null, 2)}\n`, "utf8");
} catch { /* library initialization will report a useful error later */ }

async function readLibrary() { return JSON.parse(await readFile(DATA_FILE, "utf8")); }
let libraryWriteQueue = Promise.resolve();
async function saveLibrary(data) {
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  const operation = libraryWriteQueue.then(async () => {
    const temp = `${DATA_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await writeFile(temp, payload, "utf8");
      for (let attempt = 0; ; attempt++) {
        try { await rename(temp, DATA_FILE); break; }
        catch (error) {
          if (!['EPERM', 'EACCES'].includes(error.code) || attempt >= 7) throw error;
          await new Promise((resolveWait) => setTimeout(resolveWait, 25 * (attempt + 1)));
        }
      }
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  });
  libraryWriteQueue = operation.catch(() => {});
  return operation;
}
function json(res, status, payload) { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(payload)); }
function safeName(value) { return basename(value).replace(/[^\p{L}\p{N}._ -]/gu, "-").slice(0, 160) || "book"; }
const providerDefaults = { backend: "http", cliPath: "", reasoningEffort: "", timeoutMs: 300000, translationBlockChars: DEFAULT_TRANSLATION_BLOCK_CHARS, opencodeMode: "cli", opencodeServerUrl: "http://127.0.0.1:4096", opencodeDirectory: ROOT, opencodeUsername: "opencode", providerName: "OpenAI · Luna", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1", model: "gpt-6-luna", maxOutputTokens: 8192, inputPrice: 0.1, outputPrice: 0.5, noAuth: false };
const searchDefaults = { dailyLimit: 30, autoItemsPerChapter: 3, requestsPerItem: 2 };
let searchDailyLimit = 30;
const searchBudget = createSearchBudget({ file: join(DATA, "search-usage.json"), cacheFile: SEARCH_CACHE_FILE, dailyLimit: () => searchDailyLimit });
function secretOperation(mode, value) {
  return new Promise((resolveSecret, reject) => {
    const child = trackChild(spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "scripts", "secret.ps1"), "-Mode", mode], { windowsHide: true, detached: process.platform !== "win32" }));
    let stdout = ""; let stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk.toString(); }); child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject); child.on("close", (code) => code === 0 ? resolveSecret(stdout) : reject(new Error(stderr || "Windows credential protection failed"))); child.stdin.end(value);
  });
}
async function readProvider() {
  if (!existsSync(PROVIDER_FILE)) return { ...providerDefaults };
  return decodeProvider(JSON.parse(await readFile(PROVIDER_FILE, "utf8")));
}
// Turns the on-disk form (keys still DPAPI-protected) into a usable provider. Shared by the active engine and saved profiles.
async function decodeProvider(stored) {
  stored = { ...stored };
  const apiKey = stored.apiKeyProtected ? await secretOperation("Unprotect", stored.apiKeyProtected) : (stored.apiKey || "");
  const opencodePassword = stored.opencodePasswordProtected ? await secretOperation("Unprotect", stored.opencodePasswordProtected) : (stored.opencodePassword || "");
  delete stored.opencodePasswordProtected; delete stored.opencodePassword;
  delete stored.apiKeyProtected; delete stored.apiKey;
  if (!stored.providerName && !stored.baseUrl && !stored.model) return { ...providerDefaults, apiKey };
  const merged = { ...providerDefaults, ...stored, apiKey, opencodePassword };
  merged.translationBlockChars = validateTranslationBlockChars(merged.translationBlockChars);
  for (const key of ["providerName", "baseUrl", ...(!merged.backend || merged.backend === "http" ? ["model"] : [])]) if (!merged[key]) merged[key] = providerDefaults[key];
  return merged;
}
async function readSearchSettings() {
  if (!existsSync(SEARCH_FILE)) return { ...searchDefaults, apiKey: "" };
  const stored = JSON.parse(await readFile(SEARCH_FILE, "utf8"));
  const apiKey = stored.apiKeyProtected ? await secretOperation("Unprotect", stored.apiKeyProtected) : (stored.apiKey || "");
  searchDailyLimit = stored.dailyLimit ?? searchDefaults.dailyLimit;
  return { ...searchDefaults, dailyLimit: searchDailyLimit, autoItemsPerChapter: stored.autoItemsPerChapter ?? 3, requestsPerItem: stored.requestsPerItem ?? 2, apiKey, keyProtection: stored.keyProtection };
}
async function publicSearchSettings(settings) {
  const { apiKey, apiKeyProtected, ...safe } = settings;
  return { ...safe, hasApiKey: Boolean(apiKey), keyHint: apiKey ? `••••${apiKey.slice(-4)}` : "", ...(await searchBudget.usage()) };
}
async function saveSearchSettings(body) {
  const previous = await readSearchSettings();
  const within = (value, old, max) => {
    const next = value === undefined ? old : Number(value);
    if (!Number.isInteger(next) || next < 0 || next > max) throw new Error(`搜索额度必须是 0 到 ${max} 的整数`);
    return next;
  };
  const apiKey = body.clearKey ? "" : String(body.apiKey || "").trim() || previous.apiKey;
  const next = { dailyLimit: within(body.dailyLimit, previous.dailyLimit, 30), autoItemsPerChapter: within(body.autoItemsPerChapter, previous.autoItemsPerChapter, 3), requestsPerItem: within(body.requestsPerItem, previous.requestsPerItem, 2) };
  if (apiKey) {
    try { next.apiKeyProtected = await secretOperation("Protect", apiKey); next.keyProtection = "windows-dpapi"; }
    catch { next.apiKey = apiKey; next.keyProtection = "local-file-fallback"; }
  } else next.keyProtection = "none";
  const temp = `${SEARCH_FILE}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(temp, SEARCH_FILE);
  await chmod(SEARCH_FILE, 0o600).catch(() => {});
  if (apiKey !== previous.apiKey) await unlink(SEARCH_CACHE_FILE).catch((error) => { if (error.code !== "ENOENT") throw error; });
  searchDailyLimit = next.dailyLimit;
  return publicSearchSettings({ ...next, apiKey });
}
// Engine profiles keep whole provider files as stored on disk, so saved keys stay protected and never pass through the browser.
async function readProfiles() {
  if (!existsSync(PROFILES_FILE)) return [];
  try { const value = JSON.parse(await readFile(PROFILES_FILE, "utf8")); return Array.isArray(value.profiles) ? value.profiles : []; } catch { return []; }
}
async function writeProfiles(profiles) {
  const temp = `${PROFILES_FILE}.tmp`;
  await writeFile(temp, `${JSON.stringify({ profiles }, null, 2)}\n`, "utf8"); await rename(temp, PROFILES_FILE); await chmod(PROFILES_FILE, 0o600).catch(() => {});
}
async function storedProvider() { return existsSync(PROVIDER_FILE) ? JSON.parse(await readFile(PROVIDER_FILE, "utf8")) : null; }
function profileSummary(profile, activeKey) {
  const s = profile.stored || {}; const key = engineKey(s);
  let host = ""; try { host = s.baseUrl ? new URL(s.baseUrl).host : ""; } catch { /* keep blank */ }
  return { id: profile.id, name: profile.name, color: profile.color, engineKey: key, active: key === activeKey, backend: s.backend || "http", model: s.model || "", providerName: s.providerName || "", host, reasoningEffort: s.reasoningEffort || "", inputPrice: Number(s.inputPrice) || 0, outputPrice: Number(s.outputPrice) || 0, translationBlockChars: s.translationBlockChars || 0, keyProtection: s.keyProtection || "none", createdAt: profile.createdAt, updatedAt: profile.updatedAt };
}
async function listProfiles() {
  const current = await storedProvider(); const activeKey = current ? engineKey(current) : "";
  return { profiles: (await readProfiles()).map((p) => profileSummary(p, activeKey)), palette: VERSION_PALETTE, activeKey };
}
function profileFields(body, existing = {}) {
  const name = String(body.name ?? existing.name ?? "").trim().slice(0, 40);
  if (!name) throw new Error("请给引擎档案起个名字");
  const color = String(body.color ?? existing.color ?? "").toLowerCase();
  if (!isVersionColor(color)) throw new Error("颜色无效，请从色板中选择");
  return { name, color };
}
async function saveProfileFromCurrent(body) {
  const current = await storedProvider();
  if (!current || (!current.backend || current.backend === "http") && !(current.baseUrl && current.model)) throw new Error("请先在上方配置并保存一个翻译引擎，再存为档案");
  const profiles = await readProfiles(); const now = new Date().toISOString();
  const existing = body.id ? profiles.find((p) => p.id === body.id) : null;
  if (body.id && !existing) throw new Error("引擎档案不存在");
  const fields = profileFields(body, existing || {});
  if (existing) Object.assign(existing, fields, { stored: current, updatedAt: now });
  else profiles.push({ id: `profile-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`, ...fields, stored: current, createdAt: now, updatedAt: now });
  await writeProfiles(profiles); return listProfiles();
}
async function updateProfile(id, body) {
  const profiles = await readProfiles(); const profile = profiles.find((p) => p.id === id); if (!profile) throw new Error("引擎档案不存在");
  Object.assign(profile, profileFields(body, profile), { updatedAt: new Date().toISOString() }); await writeProfiles(profiles); return listProfiles();
}
async function deleteProfile(id) {
  const profiles = await readProfiles(); const next = profiles.filter((p) => p.id !== id); if (next.length === profiles.length) throw new Error("引擎档案不存在");
  await writeProfiles(next); return listProfiles();
}
async function activateProfile(id) {
  const profile = (await readProfiles()).find((p) => p.id === id); if (!profile) throw new Error("引擎档案不存在");
  const temp = `${PROVIDER_FILE}.tmp`;
  await writeFile(temp, `${JSON.stringify(profile.stored, null, 2)}\n`, "utf8"); await rename(temp, PROVIDER_FILE); await chmod(PROVIDER_FILE, 0o600).catch(() => {});
  return publicProvider(await readProvider());
}
// Provider for one translation: an explicit profile, or the active engine tagged with the profile it matches.
async function providerForTranslation(profileId) {
  const profiles = await readProfiles();
  if (profileId) {
    const profile = profiles.find((p) => p.id === profileId); if (!profile) throw new Error("所选引擎档案不存在，请在设置中检查");
    return { provider: await decodeProvider(profile.stored), profile };
  }
  const provider = await readProvider(); const key = engineKey(provider);
  return { provider, profile: profiles.find((p) => engineKey(p.stored || {}) === key) || null };
}
function publicProvider(settings) {
  const { apiKey, apiKeyProtected, opencodePassword, opencodePasswordProtected, ...safe } = settings;
  return { ...safe, hasApiKey: Boolean(apiKey), keyHint: apiKey ? `••••${apiKey.slice(-4)}` : "", hasOpenCodePassword: Boolean(opencodePassword), supportsOpenCodeServer: true };
}
function openCodeSettings(body, existing) {
  const next = Object.fromEntries(["opencodeMode", "opencodeServerUrl", "opencodeDirectory", "opencodeUsername"].map((key) => [key, String(body[key] ?? existing[key] ?? providerDefaults[key]).trim()]));
  next.opencodeServerUrl = next.opencodeServerUrl.replace(/\/+$/, "");
  if (!["cli", "server"].includes(next.opencodeMode)) throw new Error("不支持的 OpenCode 连接方式");
  const sameServer = next.opencodeServerUrl === existing.opencodeServerUrl && next.opencodeUsername === existing.opencodeUsername;
  next.opencodePassword = body.clearOpenCodePassword ? "" : String(body.opencodePassword || "") || (sameServer ? existing.opencodePassword || "" : "");
  return next;
}
// Unsaved form values over the saved engine; the saved key is reused only for the same service origin.
async function candidateProvider(body) {
  const previous = await readProvider();
  let sameOrigin = true; try { sameOrigin = !body.baseUrl || new URL(body.baseUrl).origin === new URL(previous.baseUrl).origin; } catch { sameOrigin = false; }
  return { ...previous, ...body, ...openCodeSettings(body, previous), apiKey: body.clearKey ? "" : body.apiKey || (sameOrigin ? previous.apiKey : "") };
}
async function providerForRequest(body) {
  const existing = await readProvider();
  return { ...existing, ...body, ...openCodeSettings(body, existing) };
}
async function discoverProviderModels(provider, refresh = false) {
  return usesOpenCodeServer(provider) ? discoverOpenCodeServerModels(provider) : discoverCliModels(provider.backend, provider.cliPath, refresh);
}
async function saveProvider(body) {
  const existing = await readProvider();
  const backend = body.backend || existing.backend || "http";
  if (!["http", "codex", "opencode", "antigravity", "claude"].includes(backend)) throw new Error("不支持的翻译引擎");
  const protocol = String(body.protocol || existing.protocol);
  if (!["openai-chat", "openai-responses", "gemini"].includes(protocol)) throw new Error("不支持的接口协议");
  const baseUrl = String(body.baseUrl ?? existing.baseUrl).trim().replace(/\/+$/, "");
  if (baseUrl) {
    const parsed = new URL(baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("API 地址必须使用 HTTP 或 HTTPS");
  }
  const incomingKey = String(body.apiKey || "").trim();
  const previousOrigin = (() => { try { return new URL(existing.baseUrl).origin; } catch { return ""; } })();
  const nextOrigin = (() => { try { return new URL(baseUrl).origin; } catch { return ""; } })();
  const providerChanged = Boolean(previousOrigin && nextOrigin && previousOrigin !== nextOrigin);
  const next = {
    ...openCodeSettings(body, existing),
    backend, reasoningEffort: String(body.reasoningEffort ?? existing.reasoningEffort ?? ""), cliPath: String(body.cliPath ?? existing.cliPath ?? "").trim(), timeoutMs: Math.max(1000, Math.min(1800000, Number(body.timeoutMs || existing.timeoutMs || 300000))),
    translationBlockChars: validateTranslationBlockChars(body.translationBlockChars === undefined ? existing.translationBlockChars : body.translationBlockChars),
    providerName: String(body.providerName ?? existing.providerName).trim(), protocol, baseUrl,
    model: String(body.model ?? existing.model).trim(),
    maxOutputTokens: Math.min(131072, Math.max(256, Number(body.maxOutputTokens || existing.maxOutputTokens || 8192))),
    inputPrice: Math.max(0, Number(body.inputPrice ?? existing.inputPrice ?? 0)),
    outputPrice: Math.max(0, Number(body.outputPrice ?? existing.outputPrice ?? 0)),
    noAuth: Boolean(body.noAuth), stream: body.stream === undefined ? existing.stream !== false : Boolean(body.stream),
    apiKey: incomingKey || (body.clearKey || providerChanged ? "" : (existing.apiKey || "")), updatedAt: new Date().toISOString()
  };
  if (backend !== "http") {
    if (usesOpenCodeServer(next)) new OpenCodeServer(next);
    const catalog = next.reasoningEffort ? await discoverProviderModels(next) : null;
    validateCliChoice(next, catalog);
  }
  const temp = `${PROVIDER_FILE}.tmp`;
  const { apiKey, opencodePassword, ...stored } = next;
  if (opencodePassword) {
    try { stored.opencodePasswordProtected = await secretOperation("Protect", opencodePassword); stored.opencodePasswordProtection = "windows-dpapi"; }
    catch { stored.opencodePassword = opencodePassword; stored.opencodePasswordProtection = "local-file-fallback"; }
  } else stored.opencodePasswordProtection = "none";
  if (apiKey) {
    try { stored.apiKeyProtected = await secretOperation("Protect", apiKey); stored.keyProtection = "windows-dpapi"; }
    catch { stored.apiKey = apiKey; stored.keyProtection = "local-file-fallback"; }
  } else stored.keyProtection = "none";
  await writeFile(temp, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  await rename(temp, PROVIDER_FILE);
  await chmod(PROVIDER_FILE, 0o600).catch(() => {}); next.keyProtection = stored.keyProtection;
  return publicProvider(next);
}
async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error("请求数据过大"); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
function calibrePath() {
  const candidates = ["C:\\Program Files\\Calibre2\\ebook-convert.exe", "C:\\Program Files (x86)\\Calibre2\\ebook-convert.exe"];
  return toolCandidates("CALIBRE_PATH", "ebook-convert", candidates)[0] || null;
}
function tesseractPath() {
  return japaneseOcrPath();
}
function bookRoot(book) { return join(LIBRARY, book.id); }
async function preserveExistingRevision(root, chapter) {
  if (!activeRevisionPath(chapter) && chapter.translation?.trim()) chapter.translationPath = await writeTranslation(root, chapter, chapter.translation, false, `legacy-${newRevisionId()}`);
  preserveLegacyRevision(chapter);
}
async function initializeProject(root, book, sourceFile) {
  for (const path of ["extracted", "chapters", "translations/working", "translations/polished", "state"]) await mkdir(join(root, path), { recursive: true });
  const state = join(root, "state"); const now = new Date().toISOString();
  await writeFile(join(state, "project.json"), `${JSON.stringify({ schemaVersion: 1, title: book.title, author: book.author, sourceLanguage: sourceLanguage(book), targetLanguage: "zh-CN", translationProfile: book.profile, sourceFile, createdAt: now }, null, 2)}\n`, "utf8");
  await writeFile(join(state, "progress.json"), `${JSON.stringify({ schemaVersion: 1, currentUnit: null, units: [], lastUpdated: now }, null, 2)}\n`, "utf8");
  await writeFile(join(state, "style-guide.md"), `# 翻译风格指南\n\n- 翻译模式：${book.profile}\n- 使用中文全角标点。\n- 专名、称谓和术语以书库术语表为准。\n- 不擅自补充原文没有的信息。\n`, "utf8");
  await writeFile(join(state, "glossary.csv"), "japanese,reading,chinese,category,first_occurrence,context_notes,status,verification,source_url,verification_note,verified_at\n", "utf8");
  await writeFile(join(state, "characters.csv"), "japanese_name,reading,chinese_name,identity,forms_of_address,relationships,first_occurrence,notes,status,verification,source_url,verification_note,verified_at\n", "utf8");
  await writeFile(join(state, "source-map.csv"), "unit_id,paragraph_id,source_file,source_type,source_locator,pdf_page_index,printed_page,chapter,notes\n", "utf8");
  await writeFile(join(state, "uncertainties.md"), "# 疑难与待确认事项\n\n暂无。\n", "utf8");
}
function csvCell(value) { const text = String(value ?? ""); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
async function saveGlossaryState(book) {
  if (book.demo) return;
  const header = "japanese,reading,chinese,category,first_occurrence,context_notes,status,verification,source_url,verification_note,verified_at,definition,translator_note";
  const rows = (book.glossary || []).map((item) => [item.japanese, item.reading, item.chinese, item.category, item.firstOccurrence, item.notes, item.status, item.verification, item.sourceUrl, item.verificationNote, item.verifiedAt, item.definition, item.translatorNote].map(csvCell).join(","));
  await writeFile(join(bookRoot(book), "state", "glossary.csv"), `${[header, ...rows].join("\n")}\n`, "utf8");
}
async function saveCharactersState(book) {
  if (book.demo) return;
  const header = "japanese_name,reading,chinese_name,identity,forms_of_address,relationships,first_occurrence,notes,status,verification,source_url,verification_note,verified_at,definition,translator_note";
  const rows = (book.characters || []).map((item) => [item.japanese || item.japaneseName, item.reading, item.chinese || item.chineseName, item.identity, item.formsOfAddress, item.relationships, item.firstOccurrence, item.notes, item.status, item.verification, item.sourceUrl, item.verificationNote, item.verifiedAt, item.definition, item.translatorNote].map(csvCell).join(","));
  await writeFile(join(bookRoot(book), "state", "characters.csv"), `${[header, ...rows].join("\n")}\n`, "utf8");
}
async function saveUncertaintiesState(book) {
  if (book.demo) return;
  const items = book.uncertainties || [];
  const lines = ["# 疑难与待确认事项", "", ...items.flatMap((item) => [
    `## ${item.chapter || "未知章节"} · ${item.text || "未命名问题"}`,
    "",
    `- 状态：${item.status === "resolved" ? "已解决" : "待处理"}`,
    `- 类型：${item.type || "其他"}`,
    `- 疑点：${item.note || ""}`,
    `- 最终判断：${item.resolution || ""}`,
    `- 核实来源：${item.sourceUrl || "未附来源"}`,
    `- 核实说明：${item.verificationNote || ""}`,
    ""
  ])];
  await writeFile(join(bookRoot(book), "state", "uncertainties.md"), `${lines.join("\n")}\n`, "utf8");
}
function checkedSourceUrl(value) {
  const sourceUrl = String(value || "").trim();
  if (sourceUrl) {
    let parsed;
    try { parsed = new URL(sourceUrl); } catch { throw new Error("核实来源不是有效网址"); }
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("核实来源必须是 HTTP 或 HTTPS 地址");
  }
  return sourceUrl;
}
function verifiedByResearch(item, sourceUrl) {
  return Boolean(sourceUrl && item?.research?.verdict === "supported" && item.research.sourceUrls?.includes(sourceUrl));
}
async function syncProjectState(book) {
  if (book.demo) return;
  const stateDir = join(bookRoot(book), "state"); await mkdir(stateDir, { recursive: true });
  const units = (book.chapters || []).filter((chapter) => !chapter.id.endsWith("-pending")).map((chapter) => ({ id: chapter.id, title: chapter.title, status: chapter.status, sourceLocator: chapter.sourceLocator || "", sourcePath: chapter.sourcePath || "", translationPath: chapter.translationPath || "", polishedPath: chapter.polishedPath || "", updatedAt: chapter.updatedAt || null }));
  const current = units.find((unit) => ["extracting", "translating"].includes(unit.status))?.id || null;
  await writeFile(join(stateDir, "progress.json"), `${JSON.stringify({ schemaVersion: 1, currentUnit: current, units, lastUpdated: new Date().toISOString() }, null, 2)}\n`, "utf8");
  const header = "unit_id,paragraph_id,source_file,source_type,source_locator,pdf_page_index,printed_page,chapter,notes";
  const rows = (book.chapters || []).filter((chapter) => chapter.sourcePath).map((chapter) => [chapter.id, "", book.sourceFile, book.format, chapter.sourceLocator, "", "", chapter.title, chapter.sourcePath].map(csvCell).join(","));
  await writeFile(join(stateDir, "source-map.csv"), `${[header, ...rows].join("\n")}\n`, "utf8");
}
async function syncProjectMetadata(book) {
  if (book.demo) return;
  const path = join(bookRoot(book), "state", "project.json");
  let project = {};
  try { project = JSON.parse(await readFile(path, "utf8")); } catch { /* repair missing metadata file */ }
  Object.assign(project, { schemaVersion: 1, title: book.title, author: book.author, sourceLanguage: sourceLanguage(book), targetLanguage: "zh-CN", translationProfile: book.profile, updatedAt: new Date().toISOString() });
  await writeFile(path, `${JSON.stringify(project, null, 2)}\n`, "utf8");
}
const taskControls = new Map();
let taskQueue = Promise.resolve();
let stopping = false, shutdownPromise, shutdownDeadline;
// All library read/modify/write transactions share one lock, including different books.
const mutationContext = new AsyncLocalStorage();
let mutationQueue = Promise.resolve();
function withBookMutation(bookId, operation) {
  if (mutationContext.getStore()) return operation();
  const next = mutationQueue.then(() => mutationContext.run(true, operation));
  mutationQueue = next.catch(() => {}); return next;
}
async function updateTask(taskId, changes) {
  return withBookMutation(null, async () => {
    const data = await readLibrary();
    for (const book of data.books) { const task = (book.tasks || []).find((i) => i.id === taskId); if (task) { Object.assign(task, changes, { updatedAt: new Date().toISOString() }); await saveLibrary(data); return task; } }
    return null;
  });
}
function taskErrorDetail(error) {
  const detail = error?.detail && typeof error.detail === "object" ? error.detail : {};
  const clip = (value, n) => (typeof value === "string" ? value.slice(0, n) : value ?? undefined);
  const out = { kind: detail.kind, status: detail.status, endpoint: detail.endpoint, backend: detail.backend, model: detail.model, reasoningEffort: detail.reasoningEffort, stage: detail.stage, streaming: detail.streaming, elapsedMs: detail.elapsedMs, cause: detail.cause, partialChars: detail.partialChars, response: clip(detail.response, 1500), stderr: clip(detail.stderr, 1500), result: clip(detail.result, 1500), finishReason: error?.finishReason, partialText: clip(error?.partialText, 400) };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && v !== ""));
}
async function startTask(bookId, type, detail, runner, metadata = {}) {
  return withBookMutation(bookId, async () => {
    if (stopping) throw new Error("后台正在关闭，请重新启动后再操作");
    const data = await readLibrary(); const book = data.books.find((i) => i.id === bookId); if (!book) throw new Error("作品不存在");
    const requestKey = metadata.requestKey || detail;
    const duplicate = (book.tasks || []).find((i) => ["queued", "running", "paused"].includes(i.status) && i.type === type && i.requestKey === requestKey);
    if (duplicate) return duplicate;
    const task = { id: `task-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`, type, status: "queued", progress: 0, detail, requestKey, createdAt: new Date().toISOString(), ...metadata, requestKey };
    book.tasks ||= []; book.tasks.unshift(task); await saveLibrary(data);
    const controller = new AbortController();
    const control = { paused: false, cancelled: false, started: false, controller, signal: controller.signal }; taskControls.set(task.id, control);
    // Leave the mutation context before executing long-running model work.
    taskQueue = taskQueue.catch(() => {}).then(() => mutationContext.run(false, async () => {
      try {
        await waitControl(control); control.started = true; await updateTask(task.id, { status: "running", startedAt: new Date().toISOString() }); console.log(`任务开始：${type}`);
        await runner(task, control); checkControl(control); await updateTask(task.id, { status: "completed", progress: 100, finishedAt: new Date().toISOString() }); console.log(`任务完成：${type}`);
      } catch (error) {
        // Record what went wrong in full: message, code, and what the service or CLI actually returned.
        await updateTask(task.id, { status: control.cancelled ? "cancelled" : "failed", error: error.message, errorCode: error.code, errorDetail: taskErrorDetail(error), finishedAt: new Date().toISOString(), detail: `${detail} · ${error.message}` });
        console.log(`任务${control.cancelled ? "已停止" : "未完成"}：${type}`);
      }
      finally { taskControls.delete(task.id); }
    }));
    return task;
  });
}
async function extractBookTask(bookId) {
  return startTask(bookId, "章节提取", "识别目录和正文", async (task, control) => {
    const data = await readLibrary(); const book = data.books.find((item) => item.id === bookId); await updateTask(task.id, { progress: 8, detail: book.format === "AZW3" ? "Calibre 正在转换 AZW3；大型合集可能需要数分钟" : "正在读取原文件" });
    const result = await extractDocument({ book, bookRoot: bookRoot(book), calibrePath: calibrePath(), signal: control.signal });
    checkControl(control);
    await withBookMutation(bookId, async () => {
    checkControl(control);
    const fresh = await readLibrary(); const target = fresh.books.find((item) => item.id === bookId); const previous = new Map((target.chapters || []).map((chapter) => [chapter.id, chapter]));
    target.chapters = result.chapters.map((chapter) => {
      const old = previous.get(chapter.id); if (!old) return chapter;
      return preserveChapterRevisionState(chapter, old);
    });
    const validIds = new Set(target.chapters.map((chapter) => chapter.id));
    target.works = (result.works || []).map((work) => ({ ...work, chapterIds: work.chapterIds.filter((id) => validIds.has(id)) })).filter((work) => work.chapterIds.length);
    target.scopes = (target.scopes || []).filter((scope) => !scope.auto).map((scope) => ({ ...scope, kind: "custom", chapterIds: (scope.chapterIds || []).filter((id) => validIds.has(id)) })).filter((scope) => scope.chapterIds.length);
    target.extractionManifest = result.manifestPath; target.extractedAt = new Date().toISOString();
    const importedStem = basename(target.sourceFile, extname(target.sourceFile));
    if (result.metadata.title && (!target.title || target.title === importedStem)) target.title = result.metadata.title;
    if (result.metadata.creator && !target.author) target.author = result.metadata.creator;
    if (result.pagesNeedingOcr.length) target.uncertainties.push({ id: `ocr-${Date.now()}`, chapter: "PDF", type: "OCR", text: `${result.pagesNeedingOcr.length} 页未提取到足够文本`, note: `可能需要 OCR：${result.pagesNeedingOcr.slice(0, 40).join("、")}`, status: "open" });
    await saveLibrary(fresh); await syncProjectState(target); await updateTask(task.id, { progress: 96, detail: `已整理 ${target.works.length || 1} 部作品、${result.chapters.length} 个正文单元` });
    });
  });
}
function selectSourceRange(source, range = { type: "whole" }) {
  const type = range?.type || "whole";
  if (type === "whole") return { source, label: "整章", partial: false };
  if (type === "paragraphs") {
    const paragraphs = source.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
    const start = Math.max(1, Number(range.start || 1)); const end = Math.min(paragraphs.length, Number(range.end || start));
    if (!Number.isInteger(start) || !Number.isInteger(end) || !paragraphs.length || end < start) throw new Error("段落范围无效");
    return { source: paragraphs.slice(start - 1, end).join("\n\n"), label: `第 ${start}–${end} 段`, partial: true, range: { type, start, end } };
  }
  if (type === "pages") {
    const start = Math.max(1, Number(range.start || 1)); const end = Math.max(start, Number(range.end || start));
    if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error("页码范围无效");
    const blocks = [...source.matchAll(/\[\[PDF_PAGE_(\d+)\]\]\s*([\s\S]*?)(?=\[\[PDF_PAGE_\d+\]\]|$)/g)]
      .filter((match) => Number(match[1]) >= start && Number(match[1]) <= end)
      .map((match) => match[2].trim()).filter(Boolean);
    if (!blocks.length) throw new Error("所选页码没有可翻译文本；请确认 PDF 页码范围");
    return { source: blocks.join("\n\n"), label: `PDF 第 ${start}–${end} 页`, partial: true, range: { type, start, end } };
  }
  throw new Error("不支持的翻译范围");
}
async function translateBookChapter(bookId, chapterId, mode, range, retry = false, profileId = "") {
  const rangeLabel = range?.type === "paragraphs" ? `第 ${range.start}–${range.end} 段` : range?.type === "pages" ? `PDF 第 ${range.start}–${range.end} 页` : "整章";
  // Freeze configuration when queued; never persist API keys in task or block metadata.
  const { provider, profile } = await providerForTranslation(profileId);
  if (provider.backend && provider.backend !== "http") validateCliChoice(provider, provider.reasoningEffort ? await discoverProviderModels(provider) : null);
  const engine = { ...providerSnapshot(provider), ...(profile ? { profileId: profile.id, profileName: profile.name, profileColor: profile.color } : {}) };
  const detail = `${chapterId} · ${rangeLabel}${profileId && profile ? ` · ${profile.name}` : ""}`;
  // Different engines on the same chapter are separate requests; only an identical engine is a duplicate.
  return startTask(bookId, mode === "refine" ? "译文精校" : "章节翻译", detail, async (task, control) => {
    let data = await readLibrary(); let book = data.books.find((i) => i.id === bookId); let chapter = book?.chapters.find((i) => i.id === chapterId); if (!chapter) throw new Error("章节不存在");
    const root = bookRoot(book); const fullSource = await readChapterText(root, chapter, "source"); if (!fullSource.trim()) throw new Error("本章没有可翻译原文");
    const selected = selectSourceRange(fullSource, range);
    if (selected.partial && mode === "refine") throw new Error("节选请在节选卡片中编辑");
    const allParagraphs = sourceParagraphs(fullSource, chapterId);
    const paragraphs = selected.range?.type === "paragraphs" ? allParagraphs.slice(selected.range.start - 1, selected.range.end) : selected.partial ? sourceParagraphs(selected.source, chapterId) : allParagraphs;
    const fingerprint = sourceFingerprint(paragraphs);
    const existingDraft = await readChapterText(root, chapter, "current");
    const startingRevisionId = chapter.activeRevisionId || chapter.revisionId || null;

    const previous = book.chapters[book.chapters.findIndex((i) => i.id === chapterId) - 1];
    const previousText = previous ? await readChapterText(root, previous, "current") : "";
    if (mode === "refine" && !existingDraft.trim()) throw new Error("请先完成本章初译");
    const oldRun = chapter.translationRun;
    // Older runs used 6500 characters. Resume with the original boundaries even after settings change.
    const previousEngine = oldRun && { ...oldRun.engine, translationBlockChars: oldRun.engine?.translationBlockChars ?? 6500 };
    if (retry && previousEngine) engine.translationBlockChars = provider.translationBlockChars = previousEngine.translationBlockChars;
    const compatible = oldRun && oldRun.fingerprint === fingerprint && oldRun.mode === mode && oldRun.baseRevisionId === startingRevisionId && oldRun.partial === selected.partial && JSON.stringify(oldRun.range) === JSON.stringify(selected.range || { type: "whole" });
    if (retry && !compatible) throw new Error("原文、当前译稿版本或翻译范围已变化，无法沿用旧断点；请重新开始翻译");
    const run = { id: task.id, mode, partial: selected.partial, range: selected.range || { type: "whole" }, fingerprint, baseRevisionId: startingRevisionId, engine, blocks: retry && compatible ? (oldRun.blocks || []).filter((b) => b.status === "completed").map((b) => ({ ...b, engine: b.engine || previousEngine })) : [], status: "running" };
    await updateTask(task.id, { engine });
    await withBookMutation(bookId, async () => {
      checkControl(control); const latest = await readLibrary(); const current = latest.books.find((b) => b.id === bookId)?.chapters.find((c) => c.id === chapterId);
      current.sourceParagraphs = allParagraphs; current.translationRun = run;
      await saveLibrary(latest);
    });
    const persistRun = async (status) => withBookMutation(bookId, async () => {
      const latest = await readLibrary(); const current = latest.books.find((b) => b.id === bookId)?.chapters.find((c) => c.id === chapterId);
      if (current?.translationRun?.id === task.id) { current.translationRun = { ...run, status }; await saveLibrary(latest); }
    });
    let result;
    try {
      result = await translateChapter({ provider, book, chapter, source: selected.source, paragraphs, existingDraft, mode, previousTail: previousText.slice(-1200), glossary: book.glossary || [], characters: book.characters || [], control, resumeBlocks: run.blocks,
        onProgress: (progress, detail) => updateTask(task.id, { progress, detail: `${chapter.title} · ${detail}` }),
        onBlock: (block) => withBookMutation(bookId, async () => {
          checkControl(control);
          run.blocks = [...run.blocks.filter((b) => b.id !== block.id), block].sort((a, b) => a.order - b.order);
          await persistRun("running"); checkControl(control);
        }) });
      await waitControl(control);
      await withBookMutation(bookId, async () => {
        checkControl(control); data = await readLibrary(); book = data.books.find((i) => i.id === bookId); chapter = book?.chapters.find((i) => i.id === chapterId); if (!chapter) throw new Error("作品已移除");
        await preserveExistingRevision(root, chapter);
        const revisionId = newRevisionId(); const outputPath = await writeTranslation(root, chapter, result.text, mode === "refine", `ai-${revisionId}`, control.signal);
        checkControl(control);
        const protectedRevision = (chapter.activeRevisionId || chapter.revisionId || null) !== startingRevisionId || chapter.draftOrigin === "reader" || chapter.status === "approved" || chapter.exportedAt;
        if (selected.partial) {
          chapter.segments ||= []; chapter.segments.unshift({ id: `segment-${revisionId}`, label: selected.label, range: selected.range, sourceParagraphIds: paragraphs.map((p) => p.id), segments: result.segments, engine, source: selected.source, translationPath: outputPath, status: "review", createdAt: new Date().toISOString() });
        } else {
          chapter.revisionHistory.push({ id: revisionId, path: outputPath, origin: "ai", segments: result.segments, engine, blockEngines: result.blocks.map((b) => ({ id: b.id, sourceParagraphIds: b.sourceParagraphIds, engine: b.engine })), createdAt: new Date().toISOString(), reason: protectedRevision ? "新译稿已保留，读者版本未覆盖；可在历史中采用" : mode === "refine" ? "AI 精校" : "AI 初译" });
          if (!protectedRevision) {
            if (mode === "refine") chapter.polishedPath = outputPath; else chapter.translationPath = outputPath;
            chapter.activeRevisionId = revisionId; chapter.revisionId = revisionId; chapter.draftOrigin = "ai"; chapter.status = "review"; chapter.exportedAt = null;
          }
          run.adopted = !protectedRevision;
        }
        run.status = "completed"; chapter.translationRun = run; chapter.updatedAt = new Date().toISOString(); chapter.lastModel = provider.model;
        chapter.usage ||= { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
        for (const key of ["inputTokens", "outputTokens", "estimatedCost"]) chapter.usage[key] = result[key] == null ? null : (chapter.usage[key] || 0) + result[key];
        checkControl(control); await saveLibrary(data); await syncProjectState(book);
      });
    } catch (error) { run.error = error.message; run.errorCode = error.code; await persistRun(control.cancelled ? "cancelled" : "failed"); throw error; }
    // Analysis is a separate, cancellable stage; it never replaces the adopted reader revision.
    if (mode === "draft" && !selected.partial && run.adopted) {
      try {
        checkControl(control); const analysis = await analyzeChapterEntities({ provider, book, chapter, source: selected.source, signal: control.signal });
        checkControl(control); await withBookMutation(bookId, async () => { checkControl(control); await storeChapterAnalysis(bookId, chapterId, analysis, provider.model); });
        const settings = await readSearchSettings();
        const risks = identifyHighRisk({ source: selected.source, draft: result.text, analysis, glossary: book.glossary || [], characters: book.characters || [] }).slice(0, settings.autoItemsPerChapter);
        const autoChecks = [];
        for (const risk of risks) {
          await waitControl(control);
          const research = await verifyIssue({ book, item: { japanese: risk.originalTerm, disambiguator: risk.disambiguator, chinese: risk.proposed, chapter: chapter.title }, kind: "term", apiKey: settings.apiKey, budget: searchBudget, provider, signal: control.signal, requestsPerItem: settings.requestsPerItem });
          checkControl(control);
          const autoRevised = await maybeAutoReviseChapter({ bookId, chapterId, source: selected.source, provider, risk, research, control });
          autoChecks.push({ ...risk, verdict: research.verdict, reason: research.reason || "", sources: research.sources || [], researchedAt: research.searchedAt, autoRevised });
        }
        await withBookMutation(bookId, async () => {
          checkControl(control); const latest = await readLibrary(); const current = latest.books.find((b) => b.id === bookId)?.chapters.find((c) => c.id === chapterId);
          if (current) { current.quality = { analyzedAt: new Date().toISOString(), autoChecks, unresolved: autoChecks.filter((c) => c.verdict !== "supported").length }; await saveLibrary(latest); }
        });
      } catch (error) {
        if (control.cancelled) throw error;
        await withBookMutation(bookId, async () => { const latest = await readLibrary(); const current = latest.books.find((b) => b.id === bookId)?.chapters.find((c) => c.id === chapterId); if (current) { current.analysisError = `译文已保存，注释分析未完成：${error.message}`; await saveLibrary(latest); } });
      }
    }
  }, { chapterId, mode, range: range || { type: "whole" }, engine, requestKey: `${chapterId} · ${rangeLabel} · ${engineKey(engine)}` });
}
async function storeChapterAnalysis(bookId, chapterId, result, model) {
  return withBookMutation(bookId, async () => {
    const fresh = await readLibrary(); const targetBook = fresh.books.find((item) => item.id === bookId); const targetChapter = targetBook.chapters.find((item) => item.id === chapterId);
    targetBook.termCandidates ||= []; targetBook.characterCandidates ||= []; targetBook.uncertainties ||= [];
    const existingTerms = new Set([...(targetBook.glossary || []), ...targetBook.termCandidates].map((item) => item.japanese));
    for (const item of result.terms) if (item.japanese && item.chinese && !existingTerms.has(item.japanese)) { targetBook.termCandidates.push({ ...item, id: `term-candidate-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`, chapter: targetChapter.title, chapterId, status: "suggested", verification: "AI 建议，未联网核实" }); existingTerms.add(item.japanese); }
    const existingPeople = new Set([...(targetBook.characters || []), ...targetBook.characterCandidates].map((item) => item.japanese || item.japaneseName));
    for (const item of result.characters) if (item.japanese && item.chinese && !existingPeople.has(item.japanese)) { targetBook.characterCandidates.push({ ...item, id: `character-candidate-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`, chapter: targetChapter.title, chapterId, status: "suggested", verification: "AI 建议，未联网核实" }); existingPeople.add(item.japanese); }
    const candidateNames = [...(targetBook.glossary || []), ...(targetBook.characters || []), ...result.terms, ...result.characters].map((item) => item.japanese || item.japaneseName).filter(Boolean);
    const existingQuestions = new Set(targetBook.uncertainties.map((item) => `${item.chapterId || item.chapter}|${item.text}`));
    for (const item of result.uncertainties) {
      if (candidateNames.includes(item.text)) continue;
      const key = `${chapterId}|${item.text}`; if (!existingQuestions.has(key)) { targetBook.uncertainties.push({ ...item, id: `uncertainty-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`, chapter: targetChapter.title, chapterId, status: "open", source: "AI 分析，待人工确认" }); existingQuestions.add(key); }
    }
    targetChapter.analysis = { analyzedAt: new Date().toISOString(), model, analyzedCharacters: result.analyzedCharacters, sourceCharacters: result.sourceCharacters, termSuggestions: result.terms.length, characterSuggestions: result.characters.length, uncertaintyCount: result.uncertainties.length };
    await saveLibrary(fresh); await syncProjectState(targetBook); await saveUncertaintiesState(targetBook);
    return { book: targetBook, chapter: targetChapter };
  });
}
async function maybeAutoReviseChapter({ bookId, chapterId, source, provider, risk, research, control = {} }) {
  const snapshot = await readLibrary(); const book = snapshot.books.find((entry) => entry.id === bookId); const chapter = book?.chapters.find((entry) => entry.id === chapterId);
  if (!chapter || !canAutoReviseFromEvidence(chapter, research) || research.suggestedChinese === risk.proposed) return false;
  const expectedRevisionId = chapter.revisionId;
  const polished = /[\\/]polished[\\/]/.test(activeRevisionPath(chapter));
  const existingDraft = await readChapterText(bookRoot(book), chapter, "current");
  let revised;
  try {
    revised = await translateChapter({ provider, book, chapter, source, existingDraft, mode: "refine", correction: { originalTerm: risk.originalTerm, currentChinese: risk.proposed, suggestedChinese: research.suggestedChinese, evidence: research.sources.map((entry) => `${entry.title || entry.url}：${entry.excerpt}`).join("；").slice(0, 1500) }, control });
  } catch { return false; }
  if (!revised.text.includes(research.suggestedChinese) || revised.text.includes(risk.proposed)) return false;
  return withBookMutation(bookId, async () => {
    const latest = await readLibrary(); const currentBook = latest.books.find((entry) => entry.id === bookId); const current = currentBook?.chapters.find((entry) => entry.id === chapterId);
    checkControl(control);
    if (!canAutoRevise(current, expectedRevisionId)) return false;
    const revisionId = newRevisionId();
    const outputPath = await writeTranslation(bookRoot(currentBook), current, revised.text, polished, `verified-${revisionId}`, control.signal);
    checkControl(control);
    if (polished) current.polishedPath = outputPath; else current.translationPath = outputPath;
    current.revisionId = revisionId; current.activeRevisionId = revisionId; current.updatedAt = new Date().toISOString();
    current.revisionHistory ||= [];
    current.revisionHistory.push({ id: revisionId, path: outputPath, origin: "ai", createdAt: current.updatedAt, segments: revised.segments, reason: `AI 联网纠正 ${risk.originalTerm}：${risk.proposed} → ${research.suggestedChinese}`, sources: research.sources });
    await saveLibrary(latest); await syncProjectState(currentBook);
    return true;
  });
}
async function analyzeBookChapter(bookId, chapterId) {
  return startTask(bookId, "术语人物分析", chapterId, async (task, control) => {
    const data = await readLibrary(); const book = data.books.find((item) => item.id === bookId); const chapter = book?.chapters.find((item) => item.id === chapterId);
    if (!chapter) throw new Error("章节不存在");
    const source = await readChapterText(bookRoot(book), chapter, "source"); if (!source.trim()) throw new Error("本章没有可分析的原文");
    await updateTask(task.id, { progress: 12, detail: `${chapter.title} · 正在识别术语、人名和疑难点` });
    const provider = await readProvider();
    const result = await analyzeChapterEntities({ provider, book, chapter, source, signal: control.signal });
    checkControl(control);
    await storeChapterAnalysis(bookId, chapterId, result, provider.model);
    await updateTask(task.id, { progress: 96, detail: `${chapter.title} · 找到 ${result.terms.length} 个术语、${result.characters.length} 个人名、${result.uncertainties.length} 个疑难点` });
  });
}
async function upload(req, res, url) {
  const original = safeName(url.searchParams.get("filename") || "book");
  const extension = extname(original).toLowerCase();
  if (![".pdf", ".epub", ".azw3"].includes(extension)) return json(res, 400, { error: "仅支持 PDF、EPUB 和 AZW3" });
  const selectedLanguage = url.searchParams.get("sourceLanguage") || "ja";
  if (!SOURCE_LANGUAGES.some((entry) => entry.code === selectedLanguage)) return json(res, 400, { error: "不支持的原文语种" });
  const id = `book-${Date.now()}`;
  const sourceDir = join(LIBRARY, id, "source");
  await mkdir(sourceDir, { recursive: true });
  const output = join(sourceDir, original);
  const stream = (await import("node:fs")).createWriteStream(output, { flags: "wx" });
  let size = 0;
  try {
    for await (const chunk of req) { size += chunk.length; if (size > MAX_UPLOAD) throw new Error("文件超过 512MB"); if (!stream.write(chunk)) await new Promise((resolve) => stream.once("drain", resolve)); }
    stream.end(); await new Promise((resolve, reject) => { stream.once("finish", resolve); stream.once("error", reject); });
  } catch (error) { stream.destroy(); return json(res, 400, { error: error.message }); }
  const data = await readLibrary();
  const book = { id, title: url.searchParams.get("title") || original.replace(extension, ""), author: url.searchParams.get("author") || "", format: extension.slice(1).toUpperCase(), profile: url.searchParams.get("profile") || "自动判断", sourceLanguage: selectedLanguage, demo: false, sourceFile: join("source", original), createdAt: new Date().toISOString(), chapters: [{ id: `${id}-pending`, title: "等待章节识别", status: "not_started", source: "文件已安全导入，尚未执行提取。", translation: "", paragraphCount: 0 }], glossary: [], characters: [], uncertainties: [], tasks: [{ id: `task-${Date.now()}`, type: "书籍导入", status: "completed", progress: 100, detail: original }] };
  await initializeProject(join(LIBRARY, id), book, book.sourceFile); data.books.unshift(book);
  await saveLibrary(data);
  const task = await extractBookTask(id);
  json(res, 201, { id, title: book.title, taskId: task.id });
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true, pid: process.pid, shutdown: true, readerProtocol: 1, consoleAttached: Boolean(process.stdout.isTTY) });
  if (req.method === "GET" && url.pathname === "/api/lifecycle") {
    const data = await readLibrary();
    return json(res, 200, { state: stopping ? "stopping" : "running", activeTasks: data.books.flatMap((book) => book.tasks || []).filter((task) => ["queued", "running", "paused"].includes(task.status)).length });
  }
  if (req.method === "POST" && url.pathname === "/api/shutdown") {
    if (!String(req.headers["content-type"] || "").startsWith("application/json") || (await readJson(req)).confirm !== true) return json(res, 400, { error: "请在工作台确认关闭后台" });
    await beginShutdown();
    res.once("finish", finishShutdown);
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/search-settings") return json(res, 200, await publicSearchSettings(await readSearchSettings()));
  if (req.method === "PUT" && url.pathname === "/api/search-settings") return json(res, 200, await saveSearchSettings(await readJson(req)));
  if (req.method === "POST" && url.pathname === "/api/search-settings/test") {
    const settings = await readSearchSettings();
    if (!settings.apiKey) return json(res, 400, { error: "请先填写独立的搜索 API Key" });
    const started = Date.now();
    try {
      const results = await searchResearchSources({ query: "OpenAI", apiKey: settings.apiKey, budget: searchBudget });
      return json(res, 200, { ok: true, resultCount: results.length, latencyMs: Date.now() - started, usage: await searchBudget.usage() });
    } catch (error) { return json(res, error.code === "SEARCH_DAILY_LIMIT" ? 429 : 502, { error: error.message, code: error.code || "SEARCH_SERVICE" }); }
  }
  if (req.method === "GET" && url.pathname === "/api/provider") return json(res, 200, publicProvider(await readProvider()));
  if (req.method === "PUT" && url.pathname === "/api/provider") return json(res, 200, await saveProvider(await readJson(req)));
  if (req.method === "GET" && url.pathname === "/api/engine-profiles") return json(res, 200, await listProfiles());
  if (req.method === "POST" && url.pathname === "/api/engine-profiles") return json(res, 200, await saveProfileFromCurrent(await readJson(req)));
  const profileMatch = url.pathname.match(/^\/api\/engine-profiles\/([^/]+)(\/activate)?$/);
  if (profileMatch && req.method === "POST" && profileMatch[2]) return json(res, 200, await activateProfile(profileMatch[1]));
  if (profileMatch && req.method === "PATCH" && !profileMatch[2]) return json(res, 200, await updateProfile(profileMatch[1], await readJson(req)));
  if (profileMatch && req.method === "DELETE" && !profileMatch[2]) return json(res, 200, await deleteProfile(profileMatch[1]));
  if (req.method === "POST" && url.pathname === "/api/provider/models") {
    const body = await readJson(req);
    if (!body.backend || body.backend === "http") return json(res, 200, await listHttpModels(await candidateProvider(body)));
    const provider = await providerForRequest(body); return json(res, 200, await discoverProviderModels(provider, true));
  }
  if (req.method === "POST" && url.pathname === "/api/provider/probe") { const provider = await providerForRequest(await readJson(req)); return json(res, 200, usesOpenCodeServer(provider) ? await probeOpenCodeServer(provider) : await probeCli(provider.backend, provider.cliPath)); }
  if (req.method === "POST" && url.pathname === "/api/provider/test") {
    const body = await readJson(req); const candidate = await candidateProvider(body);
    if (candidate.backend && candidate.backend !== "http") validateCliChoice(candidate, candidate.reasoningEffort ? await discoverProviderModels(candidate) : null);
    const result = await testProviderConnection(candidate);
    if (body.save) await saveProvider(body);
    return json(res, 200, result);
  }
  if (req.method === "GET" && url.pathname === "/api/library") return json(res, 200, await readLibrary());
  if (req.method === "DELETE" && url.pathname === "/api/tasks" && url.searchParams.get("finished") === "1") {
    const data = await readLibrary(); let deleted = 0;
    for (const book of data.books) { const before = (book.tasks || []).length; book.tasks = (book.tasks || []).filter((task) => ["queued", "running", "paused"].includes(task.status)); deleted += before - book.tasks.length; }
    await saveLibrary(data); return json(res, 200, { deleted });
  }
  const taskDeleteMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (req.method === "DELETE" && taskDeleteMatch) {
    const data = await readLibrary();
    for (const book of data.books) {
      const index = (book.tasks || []).findIndex((task) => task.id === taskDeleteMatch[1]); if (index < 0) continue;
      if (["queued", "running", "paused"].includes(book.tasks[index].status)) return json(res, 409, { error: "运行中或暂停的任务不能删除，请先取消" });
      book.tasks.splice(index, 1); await saveLibrary(data); return json(res, 200, { deleted: true });
    }
    return json(res, 404, { error: "任务不存在" });
  }
  if (req.method === "GET" && url.pathname === "/api/capabilities") return json(res, 200, { dataDirectory: DATA_ROOT, calibre: Boolean(calibrePath()), calibrePath: calibrePath(), ocr: Boolean(tesseractPath()), ocrPath: tesseractPath(), ocrLanguages: Object.fromEntries(SOURCE_LANGUAGES.map((entry) => [entry.code, ocrStatus(entry.code)])), epubExport: true, localOnly: true });
  if (req.method === "POST" && url.pathname === "/api/import") return upload(req, res, url);
  const extractMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/extract$/);
  if (req.method === "POST" && extractMatch) return json(res, 202, await extractBookTask(extractMatch[1]));
  const bookMatch = url.pathname.match(/^\/api\/books\/([^/]+)$/);
  if (req.method === "PATCH" && bookMatch) {
    const body = await readJson(req); const data = await readLibrary(); const book = data.books.find((item) => item.id === bookMatch[1]);
    if (!book) return json(res, 404, { error: "作品不存在" });
    const title = String(body.title ?? book.title).trim(); if (!title) return json(res, 400, { error: "书名不能为空" });
    book.title = title; book.author = String(body.author ?? book.author ?? "").trim();
    if (["自动判断", "现代文学", "古典文学", "学术文献"].includes(body.profile)) book.profile = body.profile;
    if (body.sourceLanguage !== undefined) {
      if (!SOURCE_LANGUAGES.some((entry) => entry.code === body.sourceLanguage)) return json(res, 400, { error: "不支持的原文语种" });
      book.sourceLanguage = body.sourceLanguage;
    }
    book.updatedAt = new Date().toISOString(); await saveLibrary(data); await syncProjectMetadata(book); return json(res, 200, book);
  }
  if (req.method === "DELETE" && bookMatch) {
    const data = await readLibrary(); const index = data.books.findIndex((item) => item.id === bookMatch[1]); if (index < 0) return json(res, 404, { error: "作品不存在" });
    const book = data.books[index]; const target = resolve(bookRoot(book)); const allowedRoot = `${resolve(LIBRARY)}${sep}`;
    if (!target.startsWith(allowedRoot)) throw new Error("作品目录不在书库范围内，已停止删除");
    for (const task of book.tasks || []) { const control = taskControls.get(task.id); if (control) { control.cancelled = true; control.controller.abort(); } }
    let trashedTo = "";
    if (existsSync(target)) { const trash = join(LIBRARY, ".trash"); await mkdir(trash, { recursive: true }); trashedTo = join(trash, `${book.id}-${Date.now()}`); await rename(target, trashedTo); }
    data.books.splice(index, 1);
    try { await saveLibrary(data); } catch (error) { if (trashedTo) await rename(trashedTo, target).catch(() => {}); throw error; }
    return json(res, 200, { deleted: true, recoverable: Boolean(trashedTo), title: book.title });
  }
  const searchMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/search$/);
  if (req.method === "GET" && searchMatch) {
    const query = (url.searchParams.get("q") || "").trim().slice(0, 120).toLocaleLowerCase();
    const book = (await readLibrary()).books.find((b) => b.id === searchMatch[1]); if (!book) return json(res, 404, { error: "作品不存在" });
    const results = [];
    if (query) for (const chapter of book.chapters) {
      const source = await readChapterText(bookRoot(book), chapter, "source"); const paragraphs = sourceParagraphs(source, chapter.id);
      const translated = revisionSegments(chapter) || [{ text: await readChapterText(bookRoot(book), chapter, "current"), sourceParagraphIds: [] }];
      for (const part of [...paragraphs.map((p) => ({ text: p.text, sourceParagraphIds: [p.id] })), ...translated]) {
        const index = part.text.toLocaleLowerCase().indexOf(query); if (index < 0) continue;
        results.push({ chapterId: chapter.id, title: chapter.title, paragraphId: part.sourceParagraphIds[0] || null, snippet: part.text.slice(Math.max(0, index - 30), index + query.length + 70) });
        if (results.length >= 50) break;
      }
      if (results.length >= 50) break;
    }
    return json(res, 200, results);
  }
  const chapterMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/chapters\/([^/]+)$/);
  if (req.method === "GET" && chapterMatch) {
    const data = await readLibrary(); const book = data.books.find((item) => item.id === chapterMatch[1]); const chapter = book?.chapters.find((item) => item.id === chapterMatch[2]);
    if (!chapter) return json(res, 404, { error: "章节不存在" });
    const root = bookRoot(book); const source = await readChapterText(root, chapter, "source"); const translation = await readChapterText(root, chapter, "current");
    const segments = [];
    for (const segment of chapter.segments || []) {
      let segmentTranslation = "";
      try { segmentTranslation = await readFile(join(root, segment.translationPath), "utf8"); } catch { /* keep missing segment visible */ }
      segments.push({ ...segment, translation: segmentTranslation });
    }
    const paragraphs = sourceParagraphs(source, chapter.id);
    const aligned = revisionSegments(chapter);
    const validAlignment = aligned && JSON.stringify(aligned.flatMap((s) => s.sourceParagraphIds)) === JSON.stringify(paragraphs.map((p) => p.id));
    return json(res, 200, { ...chapter, source, sourceParagraphs: paragraphs, translation, alignedSegments: validAlignment ? aligned : null, alignmentStatus: validAlignment ? "aligned" : translation ? "legacy" : "pending", segments });
  }
  if (req.method === "PATCH" && chapterMatch) {
    return withBookMutation(chapterMatch[1], async () => {
    const body = await readJson(req); const data = await readLibrary(); const book = data.books.find((item) => item.id === chapterMatch[1]); const chapter = book?.chapters.find((item) => item.id === chapterMatch[2]);
    if (!chapter) return json(res, 404, { error: "章节不存在" });
    if (!book.demo && body.translation !== undefined) {
      await preserveExistingRevision(bookRoot(book), chapter);
      const polished = /[\\/]polished[\\/]/.test(activeRevisionPath(chapter)); const revisionId = newRevisionId(); const savedPath = await writeTranslation(bookRoot(book), chapter, body.translation, polished, `reader-${revisionId}`);
      if (polished) chapter.polishedPath = savedPath; else chapter.translationPath = savedPath;
      chapter.draftOrigin = "reader"; chapter.revisionId = revisionId; chapter.activeRevisionId = revisionId; chapter.exportedAt = null;
      chapter.revisionHistory ||= []; chapter.revisionHistory.push({ id: revisionId, path: savedPath, origin: "reader", createdAt: new Date().toISOString(), reason: "读者修改" });
    } else if (body.translation !== undefined) chapter.translation = body.translation;
    Object.assign(chapter, { status: body.status ?? chapter.status, updatedAt: new Date().toISOString() }); await saveLibrary(data); await syncProjectState(book); return json(res, 200, { ...chapter, translation: body.translation });
    });
  }
  const restoreMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/chapters\/([^/]+)\/revisions\/([^/]+)\/restore$/);
  if (req.method === "POST" && restoreMatch) return withBookMutation(restoreMatch[1], async () => {
    const data = await readLibrary(); const book = data.books.find((entry) => entry.id === restoreMatch[1]); const chapter = book?.chapters.find((entry) => entry.id === restoreMatch[2]);
    const selected = chapter?.revisionHistory?.find((entry) => entry.id === restoreMatch[3]);
    if (!selected) return json(res, 404, { error: "译稿版本不存在" });
    const root = resolve(bookRoot(book)); const target = resolve(root, selected.path);
    if (!target.startsWith(`${root}${sep}`) || !existsSync(target)) return json(res, 409, { error: "历史译稿文件不可用，未进行恢复" });
    if (selected.path.replaceAll("\\", "/").includes("/polished/")) chapter.polishedPath = selected.path;
    else { chapter.translationPath = selected.path; chapter.polishedPath = ""; }
    chapter.draftOrigin = "reader"; chapter.exportedAt = null; chapter.status = "review"; chapter.revisionId = newRevisionId(); chapter.activeRevisionId = chapter.revisionId; chapter.updatedAt = new Date().toISOString();
    chapter.revisionHistory.push({ id: chapter.revisionId, path: selected.path, segments: selected.segments || null, ...(selected.engine ? { engine: selected.engine } : {}), ...(selected.segmentSources ? { segmentSources: selected.segmentSources } : {}), origin: "reader", createdAt: chapter.updatedAt, reason: `读者恢复版本 ${selected.id}` });
    await saveLibrary(data); await syncProjectState(book); return json(res, 200, chapter);
  });
  // Illustrations: which images a chapter has, and the image files themselves (only ones listed in the index).
  const imagesMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/(chapters\/([^/]+)\/images|images\/file)$/);
  if (imagesMatch && req.method === "GET") {
    const data = await readLibrary(); const book = data.books.find((b) => b.id === imagesMatch[1]); if (!book) return json(res, 404, { error: "作品不存在" });
    const index = await bookImages({ book, bookRoot: bookRoot(book) });
    const fileUrl = (path) => `/api/books/${encodeURIComponent(book.id)}/images/file?path=${encodeURIComponent(path)}`;
    if (imagesMatch[3]) {
      const chapter = book.chapters.find((c) => c.id === imagesMatch[3]); if (!chapter) return json(res, 404, { error: "章节不存在" });
      const href = String(chapter.sourceHref || "").replace(/\\/g, "/");
      return json(res, 200, { images: (index.chapters?.[href] || []).map((image) => ({ url: fileUrl(image.path), alt: image.alt || "" })), cover: index.cover ? fileUrl(index.cover) : null });
    }
    const wanted = url.searchParams.get("path") || "";
    const known = new Set([index.cover, ...Object.values(index.chapters || {}).flat().map((i) => i.path)].filter(Boolean));
    if (!known.has(wanted)) return json(res, 404, { error: "图片不存在" });
    const file = join(bookImagesDir(bookRoot(book)), "files", ...wanted.split("/"));
    const types = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".avif": "image/avif" };
    if (!existsSync(file)) return json(res, 404, { error: "图片不存在" });
    // Book content is untrusted: never let an SVG run script if opened directly.
    res.writeHead(200, { "content-type": types[extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox" });
    return createReadStream(file).pipe(res);
  }
  const alignMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/chapters\/([^/]+)\/align$/);
  if (alignMatch && req.method === "POST") {
    const body = await readJson(req); const data = await readLibrary(); const book = data.books.find((b) => b.id === alignMatch[1]);
    if (!book?.chapters.some((c) => c.id === alignMatch[2])) return json(res, 404, { error: "章节不存在" });
    const text = (value, max) => typeof value === "string" && value.trim() && value.length <= max ? value : null;
    const selection = text(body.selection, 300), sourceText = text(body.sourceText, 12000), translationText = text(body.translationText, 12000);
    if (!["source", "translation"].includes(body.side) || !selection || !sourceText || !translationText) return json(res, 400, { error: "请选中一段不超过 300 字的文字" });
    const { provider, profile } = await providerForTranslation(body.profileId);
    const result = await alignSelection({ provider, book, side: body.side, selection: selection.trim(), sourceText, translationText });
    return json(res, 200, { ...result, engine: profile?.name || provider.providerName || provider.backend || "" });
  }
  const composeMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/chapters\/([^/]+)\/compose(-draft)?$/);
  if (composeMatch && req.method === "PUT" && composeMatch[3]) return withBookMutation(composeMatch[1], async () => {
    // Unfinished picks survive reloads; they are hints only and are re-validated when composing.
    const body = await readJson(req); const data = await readLibrary(); const book = data.books.find((b) => b.id === composeMatch[1]); const chapter = book?.chapters.find((c) => c.id === composeMatch[2]);
    if (!chapter) return json(res, 404, { error: "章节不存在" });
    const clean = (value, max) => Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {}).filter(([k, v]) => typeof k === "string" && k.length < 4000 && typeof v === "string" && v.length <= max).slice(0, 5000));
    chapter.composeDraft = { picks: clean(body.picks, 200), custom: clean(body.custom, 20000), updatedAt: new Date().toISOString() };
    await saveLibrary(data); return json(res, 200, chapter.composeDraft);
  });
  if (composeMatch && req.method === "POST" && !composeMatch[3]) return withBookMutation(composeMatch[1], async () => {
    const body = await readJson(req); const data = await readLibrary(); const book = data.books.find((b) => b.id === composeMatch[1]); const chapter = book?.chapters.find((c) => c.id === composeMatch[2]);
    if (!chapter) return json(res, 404, { error: "章节不存在" });
    if (book.demo) return json(res, 409, { error: "演示作品不支持合成译稿" });
    const root = bookRoot(book); const ids = sourceParagraphs(await readChapterText(root, chapter, "source"), chapter.id).map((p) => p.id);
    const profiles = (await listProfiles()).profiles;
    const versions = [...comparableVersions(chapter, ids, profiles), ...partialVersions(chapter, ids, profiles)];
    const composed = composeRevision(ids, versions, body.choices);
    await preserveExistingRevision(root, chapter);
    const revisionId = newRevisionId(); const path = await writeTranslation(root, chapter, composed.text, false, `mix-${revisionId}`);
    chapter.translationPath = path; chapter.polishedPath = ""; chapter.revisionId = revisionId; chapter.activeRevisionId = revisionId;
    // A composed text is the reader's decision: later AI runs are kept in history instead of replacing it.
    chapter.draftOrigin = "reader"; chapter.status = "review"; chapter.exportedAt = null; chapter.updatedAt = new Date().toISOString();
    chapter.revisionHistory ||= [];
    chapter.revisionHistory.push({ id: revisionId, path, origin: "mix", segments: composed.segments, segmentSources: composed.segmentSources, createdAt: chapter.updatedAt, reason: typeof body.note === "string" && body.note.trim() ? `读者替换：${body.note.trim().slice(0, 80)}` : `多译本合成：${composed.summary}` });
    delete chapter.composeDraft;
    await saveLibrary(data); await syncProjectState(book); return json(res, 200, { revisionId, summary: composed.summary });
  });
  const translateMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/chapters\/([^/]+)\/translate$/);
  if (req.method === "POST" && translateMatch) { const body = await readJson(req); return json(res, 202, await translateBookChapter(translateMatch[1], translateMatch[2], body.mode === "refine" ? "refine" : "draft", body.range || { type: "whole" }, Boolean(body.retry), typeof body.profileId === "string" ? body.profileId : "")); }
  const analyzeMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/chapters\/([^/]+)\/analyze$/);
  if (req.method === "POST" && analyzeMatch) return json(res, 202, await analyzeBookChapter(analyzeMatch[1], analyzeMatch[2]));
  const segmentMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/chapters\/([^/]+)\/segments\/([^/]+)$/);
  if (req.method === "PATCH" && segmentMatch) {
    const body = await readJson(req); const data = await readLibrary(); const book = data.books.find((item) => item.id === segmentMatch[1]); const chapter = book?.chapters.find((item) => item.id === segmentMatch[2]); const segment = chapter?.segments?.find((item) => item.id === segmentMatch[3]);
    if (!segment) return json(res, 404, { error: "节选译文不存在" });
    if (body.translation !== undefined) {
      await writeFile(join(bookRoot(book), segment.translationPath), `${String(body.translation).trim()}\n`, "utf8");
      // Keep the aligned copy honest: same paragraph count updates it, anything else retires it from comparison.
      if (Array.isArray(segment.segments)) {
        const parts = String(body.translation).trim().split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean);
        if (parts.length === segment.segments.length) { segment.segments = segment.segments.map((s, i) => ({ ...s, text: parts[i] })); delete segment.alignedStale; }
        else segment.alignedStale = true;
      }
    }
    if (["review", "approved"].includes(body.status)) segment.status = body.status;
    segment.updatedAt = new Date().toISOString(); await saveLibrary(data); return json(res, 200, segment);
  }
  const scopeMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/scopes$/);
  if (req.method === "POST" && scopeMatch) {
    const body = await readJson(req); const data = await readLibrary(); const book = data.books.find((item) => item.id === scopeMatch[1]); if (!book) return json(res, 404, { error: "作品不存在" });
    const chapterIds = [...new Set((body.chapterIds || []).filter((id) => book.chapters.some((chapter) => chapter.id === id)))];
    if (!String(body.name || "").trim() || !chapterIds.length) return json(res, 400, { error: "请填写选集名称并至少选择一个章节" });
    book.scopes ||= []; const scope = { id: `scope-${Date.now()}`, name: String(body.name).trim(), chapterIds, createdAt: new Date().toISOString() }; book.scopes.push(scope); await saveLibrary(data); return json(res, 201, scope);
  }
  const scopeItemMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/scopes\/([^/]+)$/);
  if (req.method === "DELETE" && scopeItemMatch) {
    const data = await readLibrary(); const book = data.books.find((item) => item.id === scopeItemMatch[1]); if (!book) return json(res, 404, { error: "作品不存在" });
    const before = (book.scopes || []).length; book.scopes = (book.scopes || []).filter((scope) => scope.id !== scopeItemMatch[2] || scope.auto);
    if (book.scopes.length === before) return json(res, 404, { error: "选集不存在" });
    await saveLibrary(data); return json(res, 200, { ok: true });
  }
  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(pause|resume|cancel)$/);
  if (req.method === "POST" && taskMatch) {
    const control = taskControls.get(taskMatch[1]); if (!control) return json(res, 409, { error: "任务当前不在运行；应用重启后的任务请重新发起" });
    const action = taskMatch[2]; if (action === "pause") control.paused = true; if (action === "resume") control.paused = false; if (action === "cancel") { control.cancelled = true; control.controller.abort(); }
    const status = action === "pause" ? "paused" : action === "resume" ? (control.started ? "running" : "queued") : "cancelled"; return json(res, 200, await updateTask(taskMatch[1], { status }));
  }
  const researchMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/research\/(term|character|glossary|characters|uncertainty)\/([^/]+)$/);
  if (req.method === "DELETE" && researchMatch) {
    const [, bookId, kind, itemId] = researchMatch;
    const data = await readLibrary(); const book = data.books.find((entry) => entry.id === bookId);
    const listName = { term: "termCandidates", character: "characterCandidates", glossary: "glossary", characters: "characters", uncertainty: "uncertainties" }[kind];
    const item = (book?.[listName] || []).find((entry) => entry.id === itemId);
    if (!item) return json(res, 404, { error: "考证条目不存在" });
    delete item.research;
    if (item.verification === "AI 已检索资料，待译者确认") item.verification = item.status === "approved" ? "人工批准，未附来源" : "AI 建议，未联网核实";
    await saveLibrary(data); return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && researchMatch) {
    const [, bookId, kind, itemId] = researchMatch;
    const initial = await readLibrary(); const book = initial.books.find((entry) => entry.id === bookId);
    if (!book) return json(res, 404, { error: "作品不存在" });
    const listName = { term: "termCandidates", character: "characterCandidates", glossary: "glossary", characters: "characters", uncertainty: "uncertainties" }[kind];
    const item = (book[listName] || []).find((entry) => entry.id === itemId);
    if (!item) return json(res, 404, { error: "考证条目不存在" });
    const settings = await readSearchSettings();
    const research = await verifyIssue({ book, item, kind, apiKey: settings.apiKey, budget: searchBudget, provider: await readProvider(), requestsPerItem: settings.requestsPerItem });
    research.searchedAt ||= new Date().toISOString();
    return withBookMutation(bookId, async () => {
    const fresh = await readLibrary(); const currentBook = fresh.books.find((entry) => entry.id === bookId);
    const currentItem = (currentBook?.[listName] || []).find((entry) => entry.id === itemId);
    if (!currentItem) return json(res, 409, { error: "考证期间该条目已被修改，请刷新后重试" });
    currentItem.research = research; currentItem.verification = research.verdict === "supported" ? "资料支持" : research.verdict === "conflicted" ? "资料冲突" : research.verdict === "unavailable" ? "搜索不可用" : "证据不足";
    await saveLibrary(fresh); return json(res, 200, research);
    });
  }
  const glossaryMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/glossary$/);
  if (req.method === "POST" && glossaryMatch) {
    const body = await readJson(req); if (!String(body.japanese || "").trim() || !String(body.chinese || "").trim()) return json(res, 400, { error: "原文词条和中文译名不能为空" });
    const data = await readLibrary(); const book = data.books.find((item) => item.id === glossaryMatch[1]); if (!book) return json(res, 404, { error: "作品不存在" });
    const category = String(body.category || "术语").trim();
    const term = { id: `term-${Date.now()}`, japanese: String(body.japanese).trim(), reading: String(body.reading || "").trim(), chinese: String(body.chinese).trim(), category, definition: String(body.definition || body.translatorNote || "").trim(), status: "approved", verification: "人工添加" };
    if (category === "人物") { book.characters ||= []; term.identity = term.definition; book.characters.push(term); await saveLibrary(data); await saveCharactersState(book); }
    else { book.glossary ||= []; book.glossary.push(term); await saveLibrary(data); await saveGlossaryState(book); }
    return json(res, 201, term);
  }
  const candidateMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/(term|character)-candidates\/([^/]+)\/(approve|reject)$/);
  if (req.method === "POST" && candidateMatch) {
    const body = await readJson(req); const [, bookId, kind, candidateId, action] = candidateMatch; const data = await readLibrary(); const book = data.books.find((item) => item.id === bookId);
    if (!book) return json(res, 404, { error: "作品不存在" });
    const key = kind === "term" ? "termCandidates" : "characterCandidates"; const index = (book[key] || []).findIndex((item) => item.id === candidateId);
    if (index < 0) return json(res, 404, { error: "建议项不存在" });
    let sourceUrl = "";
    if (action === "approve") {
      try { sourceUrl = checkedSourceUrl(body.sourceUrl); } catch (error) { return json(res, 400, { error: error.message }); }
      if (!String(body.chinese || book[key][index].chinese || "").trim()) return json(res, 400, { error: "中文译名不能为空" });
    }
    const [candidate] = book[key].splice(index, 1);
    if (action === "approve") {
      const verified = verifiedByResearch(candidate, sourceUrl);
      const verification = verified ? "资料支持" : sourceUrl ? "人工提供来源，未由 AI 核实" : "人工批准，未附来源";
      const chinese = String(body.chinese || candidate.chinese).trim();
      const approved = { ...candidate, chinese, status: "approved", firstOccurrence: candidate.chapter, notes: candidate.note, definition: String(body.definition ?? candidate.research?.definition ?? candidate.research?.translatorNote ?? (kind === "character" ? candidate.identity : candidate.note) ?? "").trim(), verification, sourceUrl, verificationNote: String(body.verificationNote || "").trim(), verifiedAt: verified ? new Date().toISOString() : null };
      delete approved.translatorNote;
      if (kind === "term") { book.glossary ||= []; book.glossary.push(approved); await saveGlossaryState(book); }
      else { book.characters ||= []; book.characters.push(approved); await saveCharactersState(book); }
    }
    await saveLibrary(data); return json(res, 200, { ok: true, action, kind });
  }
  const approvedMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/(glossary|characters)\/([^/]+)$/);
  if (req.method === "PATCH" && approvedMatch) {
    const body = await readJson(req); const data = await readLibrary(); const book = data.books.find((entry) => entry.id === approvedMatch[1]);
    const list = approvedMatch[2] === "glossary" ? book?.glossary : book?.characters;
    const item = list?.find((entry) => entry.id === approvedMatch[3]); if (!item) return json(res, 404, { error: "固定译名不存在" });
    const chinese = String(body.chinese ?? item.chinese ?? item.chineseName ?? "").trim(); if (!chinese) return json(res, 400, { error: "中文译名不能为空" });
    let sourceUrl;
    try { sourceUrl = checkedSourceUrl(body.sourceUrl ?? item.sourceUrl); } catch (error) { return json(res, 400, { error: error.message }); }
    item.chinese = chinese; item.sourceUrl = sourceUrl; item.definition = String(body.definition ?? item.definition ?? item.translatorNote ?? "").trim(); item.verificationNote = String(body.verificationNote ?? item.verificationNote ?? "").trim();
    const verified = verifiedByResearch(item, sourceUrl);
    item.verification = verified ? "资料支持" : sourceUrl ? "人工提供来源，未由 AI 核实" : "人工批准，未附来源"; item.verifiedAt = verified ? new Date().toISOString() : null;
    item.updatedAt = new Date().toISOString(); await saveLibrary(data);
    if (approvedMatch[2] === "glossary") await saveGlossaryState(book); else await saveCharactersState(book);
    return json(res, 200, item);
  }
  const uncertaintyMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/uncertainties\/([^/]+)$/);
  if (req.method === "PATCH" && uncertaintyMatch) {
    const body = await readJson(req); const data = await readLibrary(); const book = data.books.find((item) => item.id === uncertaintyMatch[1]); const item = book?.uncertainties?.find((entry) => entry.id === uncertaintyMatch[2]);
    if (!item) return json(res, 404, { error: "疑难项不存在" });
    if (["open", "resolved"].includes(body.status)) item.status = body.status;
    if (body.resolution !== undefined) item.resolution = String(body.resolution).trim();
    if (body.sourceUrl !== undefined) { try { item.sourceUrl = checkedSourceUrl(body.sourceUrl); } catch (error) { return json(res, 400, { error: error.message }); } }
    if (body.verificationNote !== undefined) item.verificationNote = String(body.verificationNote).trim();
    if (body.translatorNote !== undefined) item.translatorNote = String(body.translatorNote).trim();
    if (item.status === "resolved" && !item.resolution) return json(res, 400, { error: "请写明最终判断后再标记为已解决" });
    const verified = verifiedByResearch(item, item.sourceUrl);
    item.verification = verified ? "资料支持" : item.sourceUrl ? "人工提供来源，未由 AI 核实" : "人工判断，未附来源";
    item.verifiedAt = verified ? new Date().toISOString() : null;
    item.updatedAt = new Date().toISOString(); await saveLibrary(data); await saveUncertaintiesState(book); return json(res, 200, item);
  }
  const exportMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/export\/epub$/);
  if (req.method === "POST" && exportMatch) {
    return withBookMutation(exportMatch[1], async () => {
    const body = await readJson(req); const data = await readLibrary(); const book = data.books.find((item) => item.id === exportMatch[1]);
    if (!book) return json(res, 404, { error: "作品不存在" });
    const hydrated = [];
    if (body.selectionOnly) {
      for (const chapter of book.chapters) for (const segment of chapter.segments || []) if (segment.status === "approved") {
        let translation = ""; try { translation = await readFile(join(bookRoot(book), segment.translationPath), "utf8"); } catch { /* skipped by exporter */ }
        hydrated.push({ ...segment, id: segment.id, title: `${chapter.title} · ${segment.label}`, translation, status: "approved" });
      }
    } else for (const chapter of book.chapters) if (!body.chapterIds?.length || body.chapterIds.includes(chapter.id)) hydrated.push({ ...chapter, source: await readChapterText(bookRoot(book), chapter, "source"), translation: await readChapterText(bookRoot(book), chapter, "current") });
    // Illustrations from the original EPUB: placeholders become images, and picture-only pages within the
    // exported range come along even though nobody translates them.
    let pictures = null;
    if (!body.selectionOnly && ["EPUB", "AZW3"].includes(String(book.format).toUpperCase())) {
      const index = await bookImages({ book, bookRoot: bookRoot(book) }).catch(() => null);
      if (index && (Object.keys(index.chapters || {}).length || index.cover)) {
        const imagesOf = (c) => index.chapters?.[String(c.sourceHref || "").replace(/\\/g, "/")] || [];
        const order = book.chapters.map((c) => c.id);
        const kept = hydrated.filter((c) => c.status === "approved" || (body.includeDraft && c.translation?.trim())).map((c) => order.indexOf(c.id)).filter((i) => i >= 0);
        if (kept.length) {
          const lo = body.chapterIds?.length ? Math.min(...kept) : 0, hi = body.chapterIds?.length ? Math.max(...kept) : order.length - 1;
          for (let i = lo; i <= hi; i++) {
            const chapter = book.chapters[i]; if (!imagesOf(chapter).length || kept.includes(i)) continue;
            const source = await readChapterText(bookRoot(book), chapter, "source"); if (!isIllustrationText(source)) continue;
            const entry = { ...chapter, source, translation: source, status: "approved", illustration: true };
            const at = hydrated.findIndex((h) => h.id === chapter.id); if (at >= 0) hydrated[at] = entry; else hydrated.push(entry);
          }
          hydrated.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        }
        pictures = { dir: join(bookImagesDir(bookRoot(book)), "files"), cover: index.cover, chapter: imagesOf };
      }
    }
    const selectionSuffix = body.selectionOnly ? "selections" : body.chapterIds?.length ? "selected" : (body.includeDraft ? "draft" : "approved");
    const exportId = `export-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const filename = `xiaoxiangguan-${selectionSuffix}-${exportId}.epub`; const outputPath = join(EXPORTS, filename);
    const result = await createEpub({ book, chapters: hydrated, outputPath, includeDraft: Boolean(body.includeDraft), pictures });
    const included = new Set(result.chapterIds);
    if (!body.selectionOnly) for (const chapter of book.chapters) if (included.has(chapter.id)) chapter.exportedAt = new Date().toISOString();
    data.exports.unshift({ id: exportId, bookId: book.id, bookTitle: book.title, filename, chapterCount: result.chapterCount, createdAt: new Date().toISOString(), includesDraft: Boolean(body.includeDraft) }); await saveLibrary(data);
    return json(res, 200, { ...result, downloadUrl: `/api/exports/${encodeURIComponent(filename)}` });
    });
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/exports/")) {
    const filename = safeName(decodeURIComponent(url.pathname.slice("/api/exports/".length))); const path = join(EXPORTS, filename);
    if (!existsSync(path)) return json(res, 404, { error: "导出文件不存在" });
    const info = await stat(path); res.writeHead(200, { "content-type": "application/epub+zip", "content-length": info.size, "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` }); return createReadStream(path).pipe(res);
  }
  return json(res, 404, { error: "API 不存在" });
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host;
  if (!new Set([`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`]).has(host) || (req.headers.origin && req.headers.origin !== `http://${host}`)) return json(res, 403, { error: "仅接受本机页面请求" });
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (stopping) return json(res, 503, { error: "后台正在关闭，请重新启动后再操作" });
    if (url.pathname.startsWith("/api/")) {
      const deferred = url.pathname === "/api/shutdown" || /^\/api\/tasks\/[^/]+\/(pause|resume|cancel)$/.test(url.pathname) || (req.method === "POST" && /\/(translate|extract|analyze|research|test|probe|models)(\/|$)/.test(url.pathname));
      if (req.method !== "GET" && !deferred) return await withBookMutation(null, () => api(req, res, url));
      return await api(req, res, url);
    }
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const path = normalize(join(PUBLIC, requested));
    if (!path.startsWith(PUBLIC) || !existsSync(path)) { res.writeHead(404); return res.end("Not found"); }
    const info = await stat(path); if (!info.isFile()) { res.writeHead(404); return res.end("Not found"); }
    // Local app code must never be served stale after an update; fonts may be cached.
    res.writeHead(200, { "content-type": mime[extname(path)] || "application/octet-stream", ...([".html", ".js", ".css"].includes(extname(path)) ? { "cache-control": "no-cache" } : {}) }); createReadStream(path).pipe(res);
  } catch (error) { console.error(error); json(res, 500, { error: error.message || "服务器错误" }); }
});

function beginShutdown() {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  console.log("正在关闭后台，保存已完成进度并停止任务…");
  server.close();
  shutdownDeadline = setTimeout(() => { console.error("退出等待超时；已保存的块将在下次启动时恢复。"); process.exit(1); }, 9000);
  shutdownDeadline.unref();
  shutdownPromise = mutationContext.run(false, async () => {
    for (const control of taskControls.values()) { control.cancelled = true; control.paused = false; control.controller.abort(new Error("后台已关闭；已完成块保留")); }
    await Promise.all([stopChildProcesses(), stopOpenCodeSessions()]);
    await taskQueue;
    await withBookMutation(null, async () => {
      const data = await readLibrary(); let changed = false;
      for (const book of data.books) for (const task of book.tasks || []) {
        if (!["queued", "running", "paused"].includes(task.status)) continue;
        task.status = "cancelled"; task.error = "后台已关闭；已完成块保留"; changed = true;
        const chapter = book.chapters?.find((c) => c.translationRun?.id === task.id);
        if (chapter?.translationRun?.status === "running") chapter.translationRun.status = "cancelled";
      }
      if (changed) await saveLibrary(data);
    });
    await libraryWriteQueue;
    const pidFile = join(ROOT, ".server.pid");
    try { if (Number((await readFile(pidFile, "utf8")).trim()) === process.pid) await unlink(pidFile); } catch { /* this server may not use the launcher */ }
  });
  return shutdownPromise;
}
function finishShutdown() {
  clearTimeout(shutdownDeadline); server.closeAllConnections();
  console.log("后台已关闭。书籍和已完成进度已保留。");
  setTimeout(() => process.exit(0), 50);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", ...(process.platform === "win32" ? ["SIGBREAK"] : [])]) process.on(signal, () => {
  beginShutdown().then(finishShutdown).catch((error) => { console.error(error); process.exit(1); });
});

server.listen(PORT, "127.0.0.1", () => {
  process.title = "瀟湘館后台 · 运行中";
  console.log(`翻译书库已启动：http://127.0.0.1:${server.address().port}`);
  console.log("此窗口是瀟湘館后台。最小化可继续运行；在工作台点击“关闭后台”、按 Ctrl+C 或关闭本窗口即可退出。关闭浏览器页面不会停止后台。");
});
