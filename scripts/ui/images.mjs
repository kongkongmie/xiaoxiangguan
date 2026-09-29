import { fileURLToPath, pathToFileURL } from "node:url";
// Real book: import, extract, see illustrations in the reader, export with them.
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\\/]$/, "");
const EPUB = process.argv[2];
if (!EPUB) { console.log("用法：node scripts/ui/images.mjs <自己的 EPUB 路径>（需要带插图的书，仓库不附带受版权保护的样本）"); process.exit(0); }
const out = (await import("./paths.mjs")).shots;
const fail = (m) => { throw new Error(m); };
const folder = await mkdtemp(join(tmpdir(), "xxg-img-"));
for (const d of ["data", "secrets"]) await mkdir(join(folder, d), { recursive: true });
await writeFile(join(folder, "data/library.json"), JSON.stringify({ books: [], exports: [] }));
const child = spawn(process.execPath, [join(REPO, "server.mjs")], { env: { ...process.env, PORT: "0", TRANSLATION_LIBRARY_DATA_DIR: folder }, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; child.stderr.on("data", (d) => { log += d; });
const base = await new Promise((resolve, reject) => { child.stdout.on("data", (d) => { const u = String(d).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; if (u) resolve(u); }); child.once("exit", () => reject(new Error(log))); });
const call = async (method, path, body, raw) => { const r = await fetch(base + path, { method, headers: raw ? {} : { "content-type": "application/json" }, body: raw || (body && JSON.stringify(body)) }); const v = await r.json(); if (!r.ok) throw new Error(v.error); return v; };
try {
  const imported = await call("POST", `/api/import?filename=${encodeURIComponent("義兄.epub")}&sourceLanguage=ja`, null, await readFile(EPUB));
  const bookId = imported.id || imported.book?.id; if (!bookId) fail("import: " + JSON.stringify(imported).slice(0, 300));
  await call("POST", `/api/books/${bookId}/extract`);
  let book; for (let i = 0; i < 200; i++) { book = (await call("GET", "/api/library")).books.find((b) => b.id === bookId); if (book.chapters.length && !book.chapters.some((c) => c.id.endsWith("-pending")) && (book.tasks || []).every((t) => !["queued", "running"].includes(t.status))) break; await new Promise((r) => setTimeout(r, 200)); }
  const picture = book.chapters.find((c) => c.characterCount < 30 && c.sourceHref === "text/part0001.html"); if (!picture) fail("no picture chapter: " + book.chapters.map((c) => c.sourceHref).join(","));
  const found = await call("GET", `/api/books/${bookId}/chapters/${picture.id}/images`);
  if (found.images.length !== 1 || !found.cover) fail("images: " + JSON.stringify(found));
  const img = await fetch(base + found.images[0].url); if (img.headers.get("content-type") !== "image/jpeg" || (await img.arrayBuffer()).byteLength < 1000) fail("image file");
  if ((await fetch(base + `/api/books/${bookId}/images/file?path=${encodeURIComponent("../../data/library.json")}`)).status !== 404) fail("traversal must 404");
  // A text chapter with a translation, and an illustration page right after it.
  const textChapter = book.chapters.find((c) => c.characterCount > 2000);
  await call("PATCH", `/api/books/${bookId}/chapters/${textChapter.id}`, { translation: "一段译文。\n\n第二段译文。", status: "approved" });

  const browser = await chromium.launch({ ...(await import("./paths.mjs")).launch });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/#/books/${bookId}`); await page.waitForSelector(".book-hero .cover.has-image", { timeout: 15000 });
  await page.waitForTimeout(300); await page.screenshot({ path: `${out}50-book-cover.png` }); console.log(await page.evaluate(() => { const c = document.querySelector(".book-hero .cover"); const r = c.getBoundingClientRect(); return [r.width, r.height, getComputedStyle(document.querySelector(".book-hero")).gridTemplateColumns]; }));
  await page.goto(`${base}/#/books/${bookId}/chapters/${picture.id}`); await page.waitForSelector("#source-scroll img.reader-figure", { timeout: 15000 });
  await page.waitForFunction(() => [...document.querySelectorAll("img.reader-figure")].every((i) => i.complete && i.naturalWidth > 0));
  if (!(await page.locator("#translation-read img.reader-figure").count())) fail("translation side should show the picture too");
  await page.waitForTimeout(300); await page.screenshot({ path: `${out}51-reader-figure.png` });
  // Export the approved chapter: illustration pages in range and the cover travel with it.
  const exported = await call("POST", `/api/books/${bookId}/export/epub`, { includeDraft: false });
  const file = exported.outputPath;
  const listing = execFileSync("unzip", ["-l", file], { encoding: "utf8" });
  const pics = listing.split("\n").filter((l) => /OEBPS\/images\//.test(l)).length;
  const opf = execFileSync("unzip", ["-p", file, "OEBPS/content.opf"], { encoding: "utf8" });
  console.log("exported images:", pics, "cover-image:", opf.includes('properties="cover-image"'));
  if (pics < 2 || !opf.includes('properties="cover-image"')) fail("export lacks pictures");
  console.log("errors:", JSON.stringify(errors)); await browser.close();
} finally { child.kill(); }
