import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { inflateRawSync } from "node:zlib";
import { translateChapter } from "../lib/engine.mjs";
import { alignmentSchema, sourceParagraphs, validateSegments, translationBlocks, parseAlignedText } from "../lib/alignment.mjs";
import { generate, providerSnapshot } from "../lib/providers.mjs";

const storage = await mkdtemp(join(tmpdir(), "xxg-integrity-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let mode = "normal", requests = [], payloads = [], arrived, release, generatedCount = 0, invalidResponsesRemaining = 0, invalidShapesRemaining = 0;
const mock = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const payload = JSON.parse(body); const content = payload.messages?.[1]?.content || payload.input?.[1]?.content?.[0]?.text || "";
  payloads.push(payload);
  requests.push(content);
  const paragraphs = content.match(/原文段落：\n(\[[^\n]+\])/);
  if (paragraphs) generatedCount++;
  if ((mode === "slow" || mode === "after-one" && generatedCount > 1) && paragraphs) { arrived?.(); await new Promise((r) => { release = r; }); }
  const segments = paragraphs ? JSON.parse(paragraphs[1]).map((p, i) => ({ sourceParagraphIds: [p.id], text: `新译文${i + 1}。` })) : [];
  if (invalidShapesRemaining > 0 && segments[0]) { segments[0].sourceParagraphIds = segments[0].sourceParagraphIds[0]; invalidShapesRemaining--; }
  const invalidResponse = invalidResponsesRemaining > 0;
  if (invalidResponse) invalidResponsesRemaining--;
  const text = mode === "refusal-json" ? '{"segments":[],"refusal":"本块无法处理"}' : mode === "refusal-plain" ? "抱歉，我无法翻译这段内容。" : mode === "invalid-json" || invalidResponse ? '{"segments":[' : paragraphs ? JSON.stringify({ segments, refusal: null }) : content.includes("JSON") ? '{"terms":[],"characters":[],"uncertainties":[]}' : "连接成功";
  const truncated = mode === "truncated";
  if (mode === "http-blocked") { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "content_policy_violation", message: "blocked fixture" } })); return; }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(req.url.endsWith("responses") ? { status: truncated || mode === "filtered" ? "incomplete" : "completed", ...(truncated || mode === "filtered" ? { incomplete_details: { reason: truncated ? "max_output_tokens" : "content_filter" } } : {}), ...(mode === "native-refusal" ? { output: [{ content: [{ type: "refusal", refusal: "blocked fixture" }] }] } : { output_text: text }), usage: { input_tokens: 20, output_tokens: 10 } } : { choices: [{ message: mode === "native-refusal" ? { content: null, refusal: "blocked fixture" } : { content: text }, finish_reason: truncated ? "length" : mode === "filtered" ? "content_filter" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const provider = { protocol: "openai-chat", baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, model: "mock", noAuth: true };
let child;
const originalFetch = globalThis.fetch;
try {
  let deepseekPayload;
  globalThis.fetch = async (url, options) => {
    if (String(url) === "https://api.deepseek.com/chat/completions") {
      deepseekPayload = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"segments":[{"sourceParagraphIds":["p1"],"text":"译文"}],"refusal":null}' }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return originalFetch(url, options);
  };
  await generate({ provider: { protocol: "openai-chat", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", noAuth: true }, messages: [{ role: "system", content: "Return JSON" }, { role: "user", content: "Translate" }], responseSchema: alignmentSchema });
  assert.deepEqual(deepseekPayload.response_format, { type: "json_object" }, "official DeepSeek chat requests enable guaranteed JSON output");

  mode = "truncated";
  for (const protocol of ["openai-chat", "openai-responses"]) await assert.rejects(generate({ provider: { ...provider, protocol }, messages: [{ role: "user", content: "test" }] }), /未完整结束/);
  for (const failure of ["native-refusal", "filtered", "http-blocked"]) {
    mode = failure;
    for (const protocol of ["openai-chat", "openai-responses"]) await assert.rejects(generate({ provider: { ...provider, protocol }, messages: [{ role: "user", content: "test" }] }), { code: "MODEL_REFUSAL" });
  }
  assert.equal(Object.hasOwn(providerSnapshot({ ...provider, apiKey: "private-key", opencodePassword: "private-password" }), "apiKey"), false);
  assert.equal(JSON.stringify(providerSnapshot({ ...provider, opencodePassword: "private-password" })).includes("private-password"), false);
  for (const failure of ["refusal-json", "refusal-plain", "invalid-json"]) {
    mode = failure; const blocks = [];
    await assert.rejects(translateChapter({ provider, book: {}, chapter: { id: "refusal" }, source: "A neutral sentence.", onBlock: (block) => blocks.push(block) }), { code: failure === "invalid-json" ? "INVALID_TRANSLATION_JSON" : "MODEL_REFUSAL" });
    assert.equal(blocks.at(-1).status, "failed"); assert.ok(blocks.at(-1).partialText); assert.equal(blocks.some((block) => block.status === "completed"), false);
  }
  mode = "normal"; requests = []; invalidResponsesRemaining = 1;
  const recoveredJson = await translateChapter({ provider, book: {}, chapter: { id: "retry-invalid-json" }, source: "A neutral sentence." });
  assert.equal(requests.length, 2, "a malformed model JSON response is retried automatically");
  assert.equal(recoveredJson.segments.length, 1, "the valid retry is adopted");
  assert.deepEqual([recoveredJson.inputTokens, recoveredJson.outputTokens], [40, 20], "retry usage includes every billed attempt");
  requests = []; invalidShapesRemaining = 1;
  const recoveredShape = await translateChapter({ provider, book: {}, chapter: { id: "retry-invalid-shape" }, source: "A neutral sentence." });
  assert.equal(requests.length, 2, "a structurally invalid paragraph mapping is retried automatically");
  assert.equal(recoveredShape.segments.length, 1, "the structurally valid retry is adopted");
  assert.equal(parseAlignedText('{"segments":[{"sourceParagraphIds":["p1"],"text":"抱歉，我无法帮助你。"}]}', ["p1"])[0].text, "抱歉，我无法帮助你。", "literary dialogue inside valid segments is not treated as a refusal");
  mode = "normal";
  const smallSource = ["A", "B", "C", "D"].map((text) => text.repeat(700)).join("\n\n");
  const smallParagraphs = sourceParagraphs(smallSource, "sized");
  const smallDrafts = smallParagraphs.map((p, i) => ({ sourceParagraphIds: [p.id], text: `小段译文${i}` }));
  for (const [translationBlockChars, expectedCalls] of [[undefined, 1], [500, 4], [1000, 4], [2000, 2], [3000, 1], [5000, 1], [6000, 1]]) {
    for (const translationMode of ["draft", "refine"]) {
      requests = [];
      const result = await translateChapter({ provider: { ...provider, translationBlockChars }, book: {}, chapter: { id: "sized" }, source: smallSource, mode: translationMode, draftSegments: smallDrafts });
      assert.equal(requests.length, expectedCalls, "configured size drives draft and refinement calls");
      assert.deepEqual(result.segments.flatMap((s) => s.sourceParagraphIds), smallParagraphs.map((p) => p.id), "smaller blocks preserve complete source coverage");
    }
  }
  await assert.rejects(translateChapter({ provider: { ...provider, translationBlockChars: 2000 }, book: {}, chapter: {}, source: smallSource, mode: "refine", existingDraft: "旧译文" }), /超过当前分块大小/);
  const source = ["A".repeat(4000), "B".repeat(4000), "C".repeat(4000)].join("\n\n");
  const paragraphs = sourceParagraphs(source, "alignment");
  const draftSegments = paragraphs.map((p, i) => ({ sourceParagraphIds: [p.id], text: ["译文甲", "译文乙", "译文丙"][i].repeat(250) }));
  requests = [];
  await translateChapter({ provider, book: {}, chapter: { id: "alignment" }, source, mode: "refine", existingDraft: draftSegments.map((s) => s.text).join("\n\n"), draftSegments });
  assert.equal(requests.length, 3);
  requests.forEach((text, i) => ["译文甲", "译文乙", "译文丙"].forEach((marker, j) => assert.equal(text.includes(marker), i === j, "F2 refine pairs exact source IDs despite length difference")));
  const ids = paragraphs.map((p) => p.id);
  assert.throws(() => validateSegments([{ sourceParagraphIds: [ids[0], ids[2]], text: "缺段" }], ids), /覆盖/);
  assert.throws(() => validateSegments([{ sourceParagraphIds: [ids[1], ids[0], ids[2]], text: "乱序" }], ids), /乱序/);
  assert.throws(() => validateSegments([{ sourceParagraphIds: [...ids, ids[0]], text: "重复" }], ids), /重复/);
  requests = [];
  await translateChapter({ provider, book: {}, chapter: { id: "alignment" }, source, mode: "refine", draftSegments: [{ sourceParagraphIds: ids.slice(0, 2), text: "合段甲乙" }, draftSegments[2]] });
  assert.equal(requests.length, 2); assert.match(requests[0], /合段甲乙/); assert.doesNotMatch(requests[1], /合段甲乙/);
  await assert.rejects(translateChapter({ provider, book: {}, chapter: {}, source, mode: "refine", existingDraft: "旧译文" }), /没有段落映射/);
  const completed = [];
  await assert.rejects(translateChapter({ provider, book: {}, chapter: { id: "alignment" }, source, onBlock: (b) => { if (b.status === "completed") { completed.push(b); mode = "truncated"; } } }), /未完整结束/);
  assert.equal(completed.length, 1);
  mode = "normal"; requests = [];
  const resumed = await translateChapter({ provider, book: {}, chapter: { id: "alignment" }, source, resumeBlocks: completed });
  assert.equal(requests.length, 2); assert.equal(resumed.blocks.length, 3);
  assert.match(requests[0], /本章前块译文.*新译文/, "resuming supplies the preceding translated block as context");
  const corrupt = structuredClone(completed); corrupt[0].segments = [{ sourceParagraphIds: [], text: "invalid saved block" }]; requests = [];
  await translateChapter({ provider, book: {}, chapter: { id: "alignment" }, source, resumeBlocks: corrupt });
  assert.equal(requests.length, 3, "invalid saved coverage is regenerated, never adopted");
  const translationPayloads = payloads.filter((p) => (p.messages?.[1]?.content || "").includes("原文段落"));
  assert.ok(translationPayloads.every((p) => p.messages[0].content.includes("忠实翻译用户提供的既有作品文本") && p.messages[0].content.includes('"refusal"')), "every translation block has the fidelity and refusal contract");
  const stable = sourceParagraphs(`intro\n\n${source}`, "alignment"); assert.deepEqual(stable.slice(1).map((p) => p.id), ids);

  for (const dir of ["data", "secrets", "library/book/state", "library/other-book/state"]) await mkdir(join(storage, dir), { recursive: true });
  await writeFile(join(storage, "secrets/provider.json"), JSON.stringify(provider));
  await writeFile(join(storage, "library/book/old.md"), "旧精校版");
  const chapters = ["version", "cancel", "reader", "progress", "restart", "sized", "queued-size", "failure", "blocked", "changed-source"].map((id) => ({ id, title: id, source: ["progress", "restart", "failure", "blocked", "changed-source"].includes(id) ? source : ["sized", "queued-size"].includes(id) ? smallSource : "Source paragraph.", status: "review", ...(id === "version" ? { polishedPath: "old.md" } : {}) }));
  await writeFile(join(storage, "data/library.json"), JSON.stringify({ books: [{ id: "book", title: "経済ヤクザ (角川文庫)", chapters, tasks: [], glossary: [], characters: [], uncertainties: [] }, { id: "other-book", title: "other", chapters: [], tasks: [] }], exports: [] }));
  const boot = async () => {
  child = spawn(process.execPath, ["server.mjs"], { cwd: new URL("../", import.meta.url), env: { ...process.env, PORT: "0", TRANSLATION_LIBRARY_DATA_DIR: storage }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", (d) => { stderr += d; });
  return await new Promise((resolve, reject) => { child.stdout.on("data", (d) => { const url = String(d).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; if (url) resolve(url); }); child.once("exit", () => reject(new Error(stderr))); });
  };
  let base = await boot();
  const api = async (path, method = "GET", body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const v = await r.json(); assert.ok(r.ok, JSON.stringify(v)); return v; };
  await Promise.all([api("/api/books/book", "PATCH", { author: "first-author" }), api("/api/books/other-book", "PATCH", { author: "second-author" })]);
  const concurrent = (await api("/api/library")).books;
  assert.equal(concurrent.find((b) => b.id === "book").author, "first-author");
  assert.equal(concurrent.find((b) => b.id === "other-book").author, "second-author", "cross-book writes cannot overwrite each other");
  const chapter = (id) => api(`/api/books/book/chapters/${id}`);
  const start = (id, body = {}) => api(`/api/books/book/chapters/${id}/translate`, "POST", body);
  const finish = async (id) => { for (let i = 0; i < 150; i++) { const task = (await api("/api/library")).books[0].tasks.find((t) => t.id === id); if (["completed", "failed", "cancelled"].includes(task.status)) return task; await sleep(40); } throw new Error("task timeout"); };
  assert.equal((await api("/api/provider")).translationBlockChars, 3000, "existing configurations inherit the new default");
  for (const invalid of [null, "", 0, 499, 6001, 10000, 1000.5, "invalid"]) {
    const response = await fetch(base + "/api/provider", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ translationBlockChars: invalid }) });
    assert.equal(response.ok, false); assert.match((await response.json()).error, /500 到 6000/);
    assert.equal((await api("/api/provider")).translationBlockChars, 3000, "invalid saves leave the prior value intact");
  }
  for (const backend of ["codex", "opencode", "antigravity", "http"]) {
    const saved = await api("/api/provider", "PUT", { backend, model: backend === "opencode" ? "vendor/mock" : "mock", noAuth: true, translationBlockChars: 1500 });
    assert.equal(saved.translationBlockChars, 1500);
    assert.equal((await api("/api/provider")).translationBlockChars, 1500, "all backends persist and return block size");
  }
  assert.equal((await api("/api/provider", "PUT", { noAuth: true })).translationBlockChars, 1500, "older clients can omit the setting");
  assert.equal((await api("/api/provider", "PUT", { noAuth: true, translationBlockChars: 6000 })).translationBlockChars, 6000, "the upper limit is accepted");
  await api("/api/provider", "PUT", { noAuth: true, translationBlockChars: 2000 });
  mode = "after-one"; generatedCount = 0;
  const sizedPending = new Promise((r) => { arrived = r; }); const sizedTask = await start("sized"); await sizedPending;
  const queuedSize = await start("queued-size"); assert.equal(queuedSize.status, "queued");
  await api("/api/provider", "PUT", { noAuth: true, translationBlockChars: 1000 });
  mode = "normal"; await api(`/api/tasks/${sizedTask.id}/cancel`, "POST"); release();
  assert.equal((await finish(queuedSize.id)).status, "completed");
  assert.equal((await chapter("queued-size")).translationRun.engine.translationBlockChars, 2000, "queued tasks freeze their block size");
  assert.equal((await chapter("queued-size")).translationRun.blocks.length, 2);
  requests = []; const sizedRetry = await start("sized", { retry: true });
  assert.equal((await finish(sizedRetry.id)).status, "completed");
  assert.equal(requests.filter((text) => text.includes("原文段落")).length, 1, "changed settings do not retranslate completed blocks on resume");
  assert.equal((await chapter("sized")).translationRun.engine.translationBlockChars, 2000);
  const newSizedTask = await start("sized"); assert.equal((await finish(newSizedTask.id)).status, "completed");
  assert.equal((await chapter("sized")).translationRun.blocks.length, 4, "new tasks use the changed setting");
  const version = await start("version"); assert.equal((await finish(version.id)).status, "completed");
  const current = await chapter("version"); assert.match(current.translation, /新译文/); assert.equal(current.revisionHistory.length, 2); assert.ok(current.activeRevisionId);
  const exported = await api("/api/books/book/export/epub", "POST", { includeDraft: true, chapterIds: ["version"] });
  const downloadName = decodeURIComponent(exported.downloadUrl.split("/").at(-1));
  assert.match(downloadName, /^[\x21-\x7e]+\.epub$/, "download filename stays ASCII for Apple Books import");
  const download = await fetch(base + exported.downloadUrl);
  assert.ok(download.headers.get("content-disposition")?.includes(downloadName), "the browser receives the ASCII download filename");
  const epub = Buffer.from(await download.arrayBuffer());
  const entries = [];
  for (let offset = 0; epub.readUInt32LE(offset) === 0x04034b50;) {
    const method = epub.readUInt16LE(offset + 8), size = epub.readUInt32LE(offset + 18);
    const start = offset + 30 + epub.readUInt16LE(offset + 26) + epub.readUInt16LE(offset + 28);
    entries.push(method === 8 ? inflateRawSync(epub.subarray(start, start + size)) : epub.subarray(start, start + size));
    offset = start + size;
  }
  const exportedContent = Buffer.concat(entries);
  assert.ok(exportedContent.includes(Buffer.from("経済ヤクザ (角川文庫)")), "EPUB metadata retains the original book title");
  assert.ok(exportedContent.includes(Buffer.from("新译文"))); assert.equal(exportedContent.includes(Buffer.from("旧精校版")), false);
  const secondExport = await api("/api/books/book/export/epub", "POST", { includeDraft: true, chapterIds: ["version"] }); assert.notEqual(secondExport.downloadUrl, exported.downloadUrl);

  mode = "slow"; let pending = new Promise((r) => { arrived = r; }); const cancel = await start("cancel"); await pending;
  await api(`/api/tasks/${cancel.id}/cancel`, "POST"); release(); await sleep(150);
  const cancelled = await chapter("cancel"); assert.equal((await finish(cancel.id)).status, "cancelled"); assert.equal(cancelled.translation, ""); assert.equal(cancelled.translationPath, undefined); assert.equal(cancelled.status, "review"); assert.equal(cancelled.translationRun.status, "cancelled");

  pending = new Promise((r) => { arrived = r; }); const reader = await start("reader"); await pending;
  await api("/api/books/book/chapters/reader", "PATCH", { translation: "读者编辑不可覆盖", status: "review" }); mode = "normal"; release();
  assert.equal((await finish(reader.id)).status, "completed"); const protectedChapter = await chapter("reader"); assert.equal(protectedChapter.translation.trim(), "读者编辑不可覆盖"); assert.equal(protectedChapter.translationRun.adopted, false); assert.equal(protectedChapter.revisionHistory.length, 2);
  mode = "after-one"; generatedCount = 0; pending = new Promise((r) => { arrived = r; }); const progressTask = await start("progress"); await pending;
  let progressChapter = await chapter("progress"); assert.equal(progressChapter.translationRun.blocks.filter((b) => b.status === "completed").length, 1); assert.equal(progressChapter.translation, "");
  const queued = await start("cancel"); assert.equal(queued.status, "queued");
  const duplicate = await start("cancel"); assert.equal(duplicate.id, queued.id, "queued requests deduplicate");
  await api(`/api/tasks/${queued.id}/cancel`, "POST");
  await api(`/api/tasks/${progressTask.id}/pause`, "POST");
  mode = "normal"; release(); await sleep(100);
  progressChapter = await chapter("progress"); assert.equal(progressChapter.translationRun.blocks.filter((b) => b.status === "completed").length, 1, "paused in-flight response waits before persistence");
  await api(`/api/tasks/${progressTask.id}/cancel`, "POST"); await sleep(100);
  assert.equal((await chapter("progress")).translationRun.blocks.filter((b) => b.status === "completed").length, 1, "cancellation retains only previously completed blocks");
  requests = []; const retry = await start("progress", { retry: true }); assert.equal((await finish(retry.id)).status, "completed");
  assert.equal(requests.filter((text) => text.includes("原文段落")).length, 2, "server retry skips completed persisted block");
  // Fail after one durable block, then switch model, API protocol, URL, price and output budget.
  await api("/api/provider", "PUT", { noAuth: true, model: "before-switch", inputPrice: 1, outputPrice: 2 });
  mode = "after-one"; generatedCount = 0; pending = new Promise((r) => { arrived = r; }); const failedTask = await start("failure"); await pending;
  mode = "truncated"; release(); assert.equal((await finish(failedTask.id)).errorCode, "INCOMPLETE_OUTPUT");
  const beforeSwitch = (await chapter("failure")).translationRun;
  assert.equal(beforeSwitch.blocks[0].status, "completed"); assert.equal(beforeSwitch.blocks[1].status, "failed");
  await api("/api/provider", "PUT", { noAuth: true, model: "after-switch", protocol: "openai-responses", baseUrl: provider.baseUrl + "/changed", maxOutputTokens: 16384, translationBlockChars: 6000, inputPrice: 3, outputPrice: 4 });
  mode = "normal"; requests = []; payloads = [];
  const switched = await start("failure", { retry: true }); assert.equal((await finish(switched.id)).status, "completed");
  const afterSwitch = await chapter("failure"); const mixed = afterSwitch.translationRun.blocks;
  assert.equal(requests.filter((text) => text.includes("原文段落")).length, 2);
  assert.deepEqual(mixed[0], beforeSwitch.blocks[0], "completed data and original engine attribution are unchanged");
  assert.deepEqual(mixed.map((b) => b.engine.model), ["before-switch", "after-switch", "after-switch"]);
  assert.ok(payloads.every((p) => p.model === "after-switch" && p.max_output_tokens === 16384));
  assert.equal(afterSwitch.translationRun.engine.translationBlockChars, 1000);
  assert.equal((await finish(switched.id)).engine.translationBlockChars, 1000, "task metadata matches the retained boundaries");
  assert.ok(Math.abs(afterSwitch.usage.estimatedCost - 0.00024) < 1e-12, "mixed model costs use each block's original prices");
  assert.deepEqual(afterSwitch.revisionHistory.at(-1).blockEngines.map((b) => b.engine.model), ["before-switch", "after-switch", "after-switch"]);
  // Refusal is a distinct failed block, and retry cannot cross a reader revision change.
  mode = "after-one"; generatedCount = 0; pending = new Promise((r) => { arrived = r; }); const blocked = await start("blocked"); await pending;
  mode = "refusal-json"; release(); assert.equal((await finish(blocked.id)).errorCode, "MODEL_REFUSAL");
  const blockedRun = (await chapter("blocked")).translationRun;
  assert.equal(blockedRun.blocks.filter((b) => b.status === "completed").length, 1);
  assert.equal(blockedRun.blocks.at(-1).errorCode, "MODEL_REFUSAL"); assert.equal((await chapter("blocked")).translation, "");
  await api("/api/books/book/chapters/blocked", "PATCH", { translation: "人工校订的新版本", status: "review" });
  mode = "normal"; requests = []; const invalidRetry = await start("blocked", { retry: true });
  assert.match((await finish(invalidRetry.id)).error, /当前译稿版本/); assert.equal(requests.length, 0);
  assert.equal((await chapter("blocked")).translationRun.id, blockedRun.id, "incompatible retries retain the old checkpoint");
  mode = "truncated"; const changedSource = await start("changed-source"); await finish(changedSource.id);
  await api("/api/provider", "PUT", { noAuth: true, translationBlockChars: 1000 });
  mode = "after-one"; generatedCount = 0; pending = new Promise((r) => { arrived = r; });
  const interrupted = await start("restart"); await pending;
  child.kill("SIGKILL"); await once(child, "exit"); release(); mode = "normal";
  // Emulate a pre-setting run, which did not record its fixed 6500-character size.
  const restartLibrary = JSON.parse(await readFile(join(storage, "data/library.json"), "utf8"));
  const oldChapter = restartLibrary.books[0].chapters.find((c) => c.id === "restart");
  const oldParagraphs = sourceParagraphs(oldChapter.source, "restart");
  assert.equal(translationBlocks(oldParagraphs, null, 6500).length, 3);
  delete oldChapter.translationRun.engine.translationBlockChars;
  oldChapter.translationRun.engine.backend = "codex"; oldChapter.translationRun.engine.model = "legacy-cli";
  oldChapter.translationRun.blocks.forEach((b) => { delete b.engine; });
  restartLibrary.books[0].chapters.find((c) => c.id === "changed-source").source += "\n\nChanged after interruption.";
  await writeFile(join(storage, "data/library.json"), JSON.stringify(restartLibrary));
  base = await boot();
  assert.equal((await api("/api/provider")).translationBlockChars, 1000, "block setting survives restart");
  const recovered = await chapter("restart");
  assert.equal((await finish(interrupted.id)).status, "failed");
  assert.equal(recovered.translationRun.status, "failed");
  assert.equal(recovered.translationRun.blocks.filter((b) => b.status === "completed").length, 1);
  requests = []; const continued = await start("restart", { retry: true });
  assert.equal((await finish(continued.id)).status, "completed");
  assert.equal((await chapter("restart")).translationRun.engine.translationBlockChars, 6500, "pre-setting runs retain their historical boundaries");
  assert.equal((await chapter("restart")).translationRun.blocks[0].engine.backend, "codex", "legacy checkpoints survive a backend switch");
  assert.equal((await chapter("restart")).usage.estimatedCost, null, "CLI block costs are not estimated using the new API prices");
  assert.equal(requests.filter((text) => text.includes("原文段落")).length, 2, "restart recovery reuses durable blocks");
  requests = []; const sourceRetry = await start("changed-source", { retry: true });
  assert.match((await finish(sourceRetry.id)).error, /原文/); assert.equal(requests.length, 0, "source changes still invalidate checkpoints");
  console.log("F1–F4, ID alignment, merged/missing/duplicate paragraphs, resumable blocks and restart recovery, immutable exports and reader protection passed");
} finally {
  globalThis.fetch = originalFetch;
  release?.(); if (child) { child.kill(); await once(child, "exit"); }
  mock.closeAllConnections(); await new Promise((r) => mock.close(r));
  await rm(storage, { recursive: true, force: true });
}
