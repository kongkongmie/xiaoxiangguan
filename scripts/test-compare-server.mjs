import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comparableVersions, partialVersions, compareUnits } from "../public/compare-core.js";

const folder = await mkdtemp(join(tmpdir(), "xxg-compare-"));
// Each mock model signs its translation with its own name so versions are distinguishable.
const received = [];
const mock = http.createServer(async (req, res) => {
  let body = ""; for await (const part of req) body += part;
  const request = JSON.parse(body); received.push(request); const prompt = request.messages.find((m) => /原文段落|选中了/.test(m.content) && m.role === "user")?.content || request.messages[1].content;
  if (request.model === "broken") { res.writeHead(500, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { type: "server_error", message: "upstream exploded" } })); }
  const match = prompt.match(/原文段落：\n(\[[^\n]+\])/);
  // Word correspondence: one real match and one paraphrase that must be dropped.
  if (/选中了：「/.test(prompt)) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: `好的：{"matches":["译第1段","并不存在的改写"],"note":"逐字对应"}` } }] })); }
  res.writeHead(200, { "content-type": "application/json" });
  // Post-translation annotation analysis: nothing to report.
  if (!match) return res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ terms: [], characters: [], uncertainties: [], risks: [] }) } }] }));
  const paragraphs = JSON.parse(match[1]);
  res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ segments: paragraphs.map((p, i) => ({ sourceParagraphIds: [p.id], text: `${request.model} 译第${i + 1}段。` })) }) } }] }));
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const providerFor = (model) => JSON.stringify({ backend: "http", protocol: "openai-chat", providerName: "Mock", baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, model, noAuth: true });
let child;
try {
  for (const dir of ["data", "secrets", "library/book/state"]) await mkdir(join(folder, dir), { recursive: true });
  const source = ["吾輩は猫である。", "名前はまだ無い。", "どこで生れたかとんと見当がつかぬ。"].join("\n\n");
  await writeFile(join(folder, "data/library.json"), JSON.stringify({ books: [{ id: "book", title: "Compare fixture", chapters: [{ id: "c1", title: "一", source, status: "extracted" }], tasks: [], glossary: [], characters: [], uncertainties: [] }], exports: [] }));
  await writeFile(join(folder, "secrets/provider.json"), providerFor("model-a"));
  const entry = new URL("../server.mjs", import.meta.url).href;
  child = spawn(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(entry)});`], { env: { ...process.env, PORT: "0", TRANSLATION_LIBRARY_DATA_DIR: folder }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", (d) => { stderr += d; });
  const base = await new Promise((resolve, reject) => { child.stdout.on("data", (d) => { const url = String(d).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; if (url) resolve(url); }); child.once("exit", () => reject(new Error(stderr || "server exited"))); });
  const call = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const value = await r.json(); if (!r.ok) throw Object.assign(new Error(value.error), { status: r.status }); return value; };
  const idle = async () => { for (let i = 0; i < 200; i++) { const lib = await call("GET", "/api/library"); const tasks = lib.books[0].tasks || []; if (tasks.length && tasks.every((t) => !["queued", "running", "paused"].includes(t.status))) return tasks; await new Promise((r) => setTimeout(r, 100)); } throw new Error("tasks did not finish"); };

  // Profiles: save two engines under names and colours; the active one is flagged.
  await assert.rejects(call("POST", "/api/engine-profiles", { name: "", color: "#3f6e9a" }), /名字/);
  await assert.rejects(call("POST", "/api/engine-profiles", { name: "甲", color: "red" }), /颜色/);
  const a = (await call("POST", "/api/engine-profiles", { name: "模型甲", color: "#3f6e9a" })).profiles[0];
  await writeFile(join(folder, "secrets/provider.json"), providerFor("model-b"));
  const listed = await call("POST", "/api/engine-profiles", { name: "模型乙", color: "#b5485d" });
  const b = listed.profiles[1];
  assert.deepEqual(listed.profiles.map((p) => [p.name, p.active]), [["模型甲", false], ["模型乙", true]]);
  assert.equal(JSON.stringify(listed).includes("noAuth"), false, "profile listing exposes only summaries");

  // Same chapter, two engines: both are queued, neither is swallowed as a duplicate.
  const t1 = await call("POST", "/api/books/book/chapters/c1/translate", { mode: "draft", profileId: a.id });
  const t2 = await call("POST", "/api/books/book/chapters/c1/translate", { mode: "draft", profileId: b.id });
  assert.notEqual(t1.id, t2.id);
  const again = await call("POST", "/api/books/book/chapters/c1/translate", { mode: "draft", profileId: b.id });
  assert.equal(again.id, t2.id, "the same engine twice is still deduplicated while queued");
  const tasks = await idle(); assert.ok(tasks.every((t) => t.status === "completed"), JSON.stringify(tasks));

  let chapter = await call("GET", "/api/books/book/chapters/c1");
  const ids = chapter.sourceParagraphs.map((p) => p.id);
  const profiles = (await call("GET", "/api/engine-profiles")).profiles;
  let versions = comparableVersions(chapter, ids, profiles);
  assert.deepEqual(versions.map((v) => [v.name, v.color]), [["模型甲", "#3f6e9a"], ["模型乙", "#b5485d"]]);
  assert.equal(versions[1].active, true, "the later AI draft is adopted while nothing is protected");
  const units = compareUnits(ids, versions);
  assert.equal(units[0].texts[versions[0].id], "model-a 译第1段。");

  // Unfinished picks persist; composing mixes engines plus one hand edit and becomes the protected active text.
  await call("PUT", "/api/books/book/chapters/c1/compose-draft", { picks: { [ids[0]]: versions[0].id }, custom: {} });
  assert.equal((await call("GET", "/api/books/book/chapters/c1")).composeDraft.picks[ids[0]], versions[0].id);
  await assert.rejects(call("POST", "/api/books/book/chapters/c1/compose", { choices: [{ ids: [ids[0]], revisionId: versions[0].id }] }), /完整/);
  const composed = await call("POST", "/api/books/book/chapters/c1/compose", { choices: [{ ids: [ids[0]], revisionId: versions[0].id }, { ids: [ids[1]], revisionId: versions[1].id }, { ids: [ids[2]], text: "我不知道自己生在哪里。" }] });
  assert.match(composed.summary, /模型甲 1 段.*模型乙 1 段.*手改 1 段/);
  chapter = await call("GET", "/api/books/book/chapters/c1");
  assert.equal(chapter.translation.trimEnd(), "model-a 译第1段。\n\nmodel-b 译第2段。\n\n我不知道自己生在哪里。");
  assert.equal(chapter.alignmentStatus, "aligned"); assert.equal(chapter.draftOrigin, "reader"); assert.equal(chapter.composeDraft, undefined);
  const mix = chapter.revisionHistory.find((r) => r.id === chapter.activeRevisionId);
  assert.equal(mix.origin, "mix"); assert.equal(mix.segmentSources[0].engine.profileName, "模型甲"); assert.equal(mix.segmentSources[2].custom, true);

  // A later run is kept as a new version but never replaces the composed text.
  await call("POST", "/api/books/book/chapters/c1/translate", { mode: "draft", profileId: a.id }); await idle();
  chapter = await call("GET", "/api/books/book/chapters/c1");
  assert.equal(chapter.activeRevisionId, mix.id);
  versions = comparableVersions(chapter, ids, profiles);
  assert.deepEqual(versions.map((v) => v.label), ["模型甲 · 初译 1", "模型乙 · 初译", "合成稿", "模型甲 · 初译 2"]);

  // Restoring a version keeps who translated it.
  await call("POST", `/api/books/book/chapters/c1/revisions/${versions[1].id}/restore`);
  chapter = await call("GET", "/api/books/book/chapters/c1");
  assert.equal(chapter.revisionHistory.find((r) => r.id === chapter.activeRevisionId).engine.profileName, "模型乙");
  assert.equal(comparableVersions(chapter, ids, profiles).length, 4, "the restored copy folds into its original");

  // A second opinion on one paragraph from another engine, then used to replace just that paragraph.
  await call("POST", "/api/books/book/chapters/c1/translate", { mode: "draft", range: { type: "paragraphs", start: 2, end: 2 }, profileId: a.id }); await idle();
  chapter = await call("GET", "/api/books/book/chapters/c1");
  const excerpt = chapter.segments[0]; assert.equal(excerpt.engine.profileName, "模型甲");
  assert.deepEqual(partialVersions(chapter, ids, profiles).map((v) => v.label), ["模型甲 · 节选"]);
  const current = comparableVersions(chapter, ids, profiles).find((v) => v.active);
  const before = chapter.translation.trimEnd().split("\n\n");
  await call("POST", "/api/books/book/chapters/c1/compose", { note: "第 2 段 → 模型甲", choices: [{ ids: [ids[0]], revisionId: current.id }, { ids: [ids[1]], revisionId: excerpt.id }, { ids: [ids[2]], revisionId: current.id }] });
  chapter = await call("GET", "/api/books/book/chapters/c1");
  assert.deepEqual(chapter.translation.trimEnd().split("\n\n"), [before[0], "model-a 译第1段。", before[2]], "only the chosen paragraph changed");
  assert.match(chapter.revisionHistory.at(-1).reason, /读者替换：第 2 段/);
  // Editing the excerpt into a different shape retires it from comparison instead of showing stale text.
  await call("PATCH", `/api/books/book/chapters/c1/segments/${excerpt.id}`, { translation: "一\n\n二" });
  assert.equal(partialVersions(await call("GET", "/api/books/book/chapters/c1"), ids, profiles).length, 0);

  // A failing engine leaves a task record that says what happened and with which settings.
  const saved = await readFile(join(folder, "secrets/provider.json"), "utf8");
  await writeFile(join(folder, "secrets/provider.json"), providerFor("broken"));
  await call("POST", "/api/books/book/chapters/c1/translate", { mode: "draft" }); const finished = await idle();
  const failed = finished.find((t) => t.status === "failed");
  assert.ok(failed, "a failed task is recorded");
  assert.match(failed.error, /HTTP 500 · server_error.*upstream exploded/);
  assert.equal(failed.errorDetail.status, 500); assert.match(failed.errorDetail.response, /upstream exploded/); assert.equal(failed.errorDetail.model, "broken");
  assert.equal(failed.engine.model, "broken"); assert.ok(failed.startedAt && failed.finishedAt && failed.finishedAt >= failed.startedAt);
  await writeFile(join(folder, "secrets/provider.json"), saved);

  // Word correspondence keeps only text that exists on the other side.
  const aligned = await call("POST", "/api/books/book/chapters/c1/align", { side: "source", selection: "第一", sourceText: "第一段原文", translationText: "model-a 译第1段。" });
  assert.deepEqual(aligned.matches, ["译第1段"]); assert.equal(aligned.dropped, 1); assert.equal(aligned.note, "逐字对应");
  await assert.rejects(call("POST", "/api/books/book/chapters/c1/align", { side: "source", selection: "", sourceText: "a", translationText: "b" }), /选中/);
  await assert.rejects(call("POST", "/api/books/book/chapters/missing/align", { side: "source", selection: "a", sourceText: "a", translationText: "b" }), /不存在/);

  // Prompt sets: one bound to engine B only; its opening, closing and name reach the model and the task record.
  const prompts = await call("GET", "/api/prompts");
  assert.equal(prompts.defaultId, "builtin"); assert.ok(prompts.variables.some((v) => v.name === "原文段落" && v.required));
  await assert.rejects(call("PUT", "/api/prompts", { sets: [{ id: "p-bad", name: "坏的", user: "请翻译" }] }), /原文段落/);
  const literary = { id: "p-literary", name: "出版译本", system: "你是出版社的文学译者。{{风格要求}}", user: "{{作品}}·{{章节}}\n{{源语言}}原文段落：\n{{原文段落}}", closing: "请按已出版译本的标准完整译出。", closingMode: "separate" };
  const promptState = await call("PUT", "/api/prompts", { sets: [literary], defaultId: "builtin", bindings: { [b.id]: "p-literary", "no-such-profile": "p-literary" } });
  assert.deepEqual(promptState.bindings, { [b.id]: "p-literary" }, "bindings to unknown profiles are dropped");
  const preview = await call("POST", "/api/prompts/preview", { set: literary, bookId: "book", chapterId: "c1", mode: "draft" });
  assert.deepEqual(preview.messages.map((m) => m.role), ["system", "user", "user"]); assert.match(preview.messages[0].content, /文学译者[\s\S]*成功时只输出 JSON/);
  received.length = 0;
  const boundTask = await call("POST", "/api/books/book/chapters/c1/translate", { mode: "draft", profileId: b.id }); const bound = (await idle()).find((t) => t.id === boundTask.id);
  const sentB = received.find((r) => r.model === "model-b"); assert.ok(sentB, "engine B was called");
  assert.match(sentB.messages[0].content, /^你是出版社的文学译者。/); assert.equal(sentB.messages.at(-1).content, "请按已出版译本的标准完整译出。");
  assert.equal(bound.engine.promptSetName, "出版译本"); assert.equal(bound.status, "completed", bound.error);
  // The live view keeps what happened to the last block, in memory, after the task ends.
  const live = await call("GET", `/api/tasks/${boundTask.id}/live`);
  assert.equal(live.phase, "done"); assert.equal(live.outcome, "completed"); assert.ok(live.textChars > 0);
  assert.ok(live.log.some((l) => /开始第 1\/1 块/.test(l.note)) && live.log.some((l) => /块完成/.test(l.note)), JSON.stringify(live.log));
  assert.equal((await call("GET", "/api/tasks/no-such-task/live")).phase, "none");
  received.length = 0;
  const plainTask = await call("POST", "/api/books/book/chapters/c1/translate", { mode: "draft", profileId: a.id }); const plain = (await idle()).find((t) => t.id === plainTask.id);
  const sentA = received.find((r) => r.model === "model-a"); assert.match(sentA.messages[0].content, /^你是严谨的/, "engine A keeps the built-in prompt");
  assert.equal(plain.engine.promptSetId, "builtin");
  await call("PUT", "/api/prompts", { sets: [], defaultId: "builtin", bindings: {} });

  // Switching and housekeeping.
  assert.equal((await call("POST", `/api/engine-profiles/${a.id}/activate`)).model, "model-a");
  assert.equal((await call("PATCH", `/api/engine-profiles/${a.id}`, { color: "#4e8a6a" })).profiles[0].color, "#4e8a6a");
  assert.equal((await call("DELETE", `/api/engine-profiles/${b.id}`)).profiles.length, 1);
  await assert.rejects(call("POST", "/api/books/book/chapters/c1/translate", { profileId: b.id }), /不存在/);
  // Deleted profile: the snapshot keeps its name and colour on old versions.
  const after = comparableVersions(chapter, ids, (await call("GET", "/api/engine-profiles")).profiles);
  assert.deepEqual([after[1].name, after[1].color], ["模型乙", "#b5485d"]);
  console.log("compare server: profiles, per-engine queueing, compose, protection, restore provenance passed");
} finally {
  child?.kill(); mock.close(); await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
