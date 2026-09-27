import assert from "node:assert/strict";
import http from "node:http";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createEpub } from "../lib/epub.mjs";
import { analyzeChapterEntities, extractDocument, identifyHighRisk, readChapterText, researchTranslationIssue, testProviderConnection, translateChapter, writeTranslation } from "../lib/engine.mjs";
import { toolCandidates } from "../lib/tool-paths.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const book = { id: "test-book", title: "源氏物语（测试）", author: "紫式部", glossary: [{ japanese: "洛中", chinese: "洛中", definition: "此处指京都城内。" }], termCandidates: [{ japanese: "犬痴性", chinese: "犬痴性", note: "此处指某种旧时用语。", verification: "AI 建议，未联网核实" }], chapters: [{ id: "test-chapter", title: "第一帖　桐壶", status: "approved", source: "洛中の話。犬痴性。", translation: "不知是哪一代天皇在位之时。" }] };
const outputPath = join(root, "exports", "_test.epub");
await mkdir(dirname(outputPath), { recursive: true });
const result = await createEpub({ book, chapters: book.chapters, outputPath, includeDraft: false });
assert.equal(result.chapterCount, 1);
assert.deepEqual(result.chapterIds, ["test-chapter"]);
const archive = await readFile(outputPath);
assert.equal(archive.readUInt32LE(0), 0x04034b50, "ZIP local header missing");
const firstNameLength = archive.readUInt16LE(26);
const firstExtraLength = archive.readUInt16LE(28);
const firstName = archive.subarray(30, 30 + firstNameLength).toString("utf8");
assert.equal(firstName, "mimetype", "EPUB mimetype must be first entry");
const dataStart = 30 + firstNameLength + firstExtraLength;
const firstSize = archive.readUInt32LE(18);
assert.equal(archive.readUInt16LE(8), 0, "EPUB mimetype must remain uncompressed");
assert.equal(archive.subarray(dataStart, dataStart + firstSize).toString("utf8"), "application/epub+zip");
const secondHeader = dataStart + firstSize;
assert.equal(archive.readUInt32LE(secondHeader), 0x04034b50, "second ZIP entry must follow mimetype");
assert.equal(archive.readUInt16LE(secondHeader + 8), 8, "EPUB content must use deflate compression for Apple Books compatibility");
const entryContents = [];
for (let offset = 0; archive.readUInt32LE(offset) === 0x04034b50;) {
  const nameLength = archive.readUInt16LE(offset + 26), extraLength = archive.readUInt16LE(offset + 28);
  const method = archive.readUInt16LE(offset + 8), size = archive.readUInt32LE(offset + 18);
  const start = offset + 30 + nameLength + extraLength;
  entryContents.push(method === 8 ? inflateRawSync(archive.subarray(start, start + size)) : archive.subarray(start, start + size));
  offset = start + size;
}
const publication = Buffer.concat(entryContents);
assert.ok(archive.includes(Buffer.from("OEBPS/content.opf")));
assert.equal(publication.includes(Buffer.from('<meta name="generator"')), false, "EPUB 3 package metadata must not use the legacy EPUB 2 meta syntax");
assert.match(publication.toString("utf8"), /<dc:identifier id="book-id">urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}<\/dc:identifier>/i, "EPUB identifier must contain a valid UUID");
assert.ok(publication.includes(Buffer.from("zh-Hans")), "Simplified Chinese EPUBs declare their language and script");
assert.equal(publication.includes(Buffer.from("zh-CN")), false, "export uses the declared Simplified Chinese script tag consistently");
assert.ok(publication.includes(Buffer.from("第一帖　桐壶")));
assert.ok(publication.includes(Buffer.from("此处指京都城内。")), "Approved translator note should be included in EPUB");
assert.ok(publication.includes(Buffer.from("犬痴性")) && publication.includes(Buffer.from("尚未全部经过联网核实")), "initial AI notes remain readable with a single verification notice");
assert.ok(publication.includes(Buffer.from("瀟湘館")), "EPUB should use the current product name");
assert.equal(publication.includes(Buffer.from("日文翻译书库")), false, "EPUB should not use the old Japanese-only name");
await unlink(outputPath);
console.log("EPUB export checks passed");

const tempRoot = join(root, "work-test-runtime");
if (existsSync(tempRoot)) await rm(tempRoot, { recursive: true, force: true });
const sourceEpub = join(root, "exports", "_extract-source.epub");
await createEpub({ book: { title: "抽出試験", author: "测试" }, chapters: [{ id: "source-1", title: "第一章　始まり", status: "approved", translation: "これは第一段落です。\n\nこれは第二段落です。" }, { id: "source-2", title: "第二章　続き", status: "approved", translation: "これは第三段落です。\n\nこれは第四段落です。" }], outputPath: sourceEpub, includeDraft: false });
const python = toolCandidates("PYTHON_PATH", "python", [join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"), join(process.env.USERPROFILE || "", ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe")])[0] || (process.platform === "win32" ? "python" : "python3");
await new Promise((resolveRun, reject) => {
  const child = spawn(python, [join(root, "scripts", "test_ocr.py")], { windowsHide: true }); let error = "";
  child.stderr.on("data", (chunk) => { error += chunk; }); child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolveRun() : reject(new Error(error)));
});
console.log("OCR layout selection checks passed");
await new Promise((resolveRun, reject) => {
  const child = spawn(python, [join(root, "scripts", "extract_ebook.py"), sourceEpub, "--output", join(tempRoot, "extracted")], { windowsHide: true });
  let error = ""; child.stderr.on("data", (chunk) => { error += chunk; }); child.on("error", reject); child.on("close", (code) => code === 0 ? resolveRun() : reject(new Error(error)));
});
const manifest = JSON.parse(await readFile(join(tempRoot, "extracted", "manifest.json"), "utf8"));
assert.ok(manifest.extracted_chapter_count >= 1);
let extractedText = "";
for (const record of manifest.chapters) { const candidate = await readFile(join(tempRoot, "extracted", record.output_file), "utf8"); if (candidate.includes("第一段落")) extractedText = candidate; }
assert.match(extractedText, /第一段落/);
const structured = await extractDocument({ book: { id: "structured-book", title: "抽出試験", format: "EPUB", sourceFile: sourceEpub }, bookRoot: join(tempRoot, "structured-book") });
assert.deepEqual(structured.chapters.map((chapter) => chapter.title), ["第一章　始まり", "第二章　続き"]);
console.log("EPUB extraction checks passed");

const testPdf = join(tempRoot, "sample.pdf");
await new Promise((resolveRun, reject) => {
  const code = "from reportlab.pdfgen import canvas; import sys; c=canvas.Canvas(sys.argv[1]); c.drawString(72,760,'Chapter 1 - Japanese literature'); c.drawString(72,730,'Text extraction fixture with enough text.'); c.showPage(); c.drawString(72,760,'Chapter 2 - Notes and bibliography'); c.drawString(72,730,'Second page extraction fixture with enough text.'); c.save()";
  const child = spawn(python, ["-c", code, testPdf], { windowsHide: true }); let error = ""; child.stderr.on("data", (chunk) => { error += chunk; }); child.on("error", reject); child.on("close", (exitCode) => exitCode === 0 ? resolveRun() : reject(new Error(error)));
});
await new Promise((resolveRun, reject) => {
  const child = spawn(python, [join(root, "scripts", "extract_pdf.py"), testPdf, "--output", join(tempRoot, "pdf-extracted"), "--pages-per-unit", "1"], { windowsHide: true }); let error = ""; child.stderr.on("data", (chunk) => { error += chunk; }); child.on("error", reject); child.on("close", (exitCode) => exitCode === 0 ? resolveRun() : reject(new Error(error)));
});
const pdfManifest = JSON.parse(await readFile(join(tempRoot, "pdf-extracted", "manifest.json"), "utf8"));
assert.equal(pdfManifest.page_count, 2); assert.equal(pdfManifest.extracted_chapter_count, 2); assert.deepEqual(pdfManifest.pages_needing_ocr, []);
const frenchPdf = await extractDocument({ book: { id: "french-pdf", title: "French", sourceLanguage: "fr", sourceFile: testPdf }, bookRoot: join(tempRoot, "french-pdf") });
const frenchManifest = JSON.parse(await readFile(join(tempRoot, "french-pdf", frenchPdf.manifestPath), "utf8"));
assert.equal(frenchManifest.ocr_language, "fra", "French PDFs must select French OCR without requiring it for text-layer pages");
const resumeRoot = join(tempRoot, "pdf-resume");
const incompleteRun = join(resumeRoot, "extracted", "run-1");
await mkdir(incompleteRun, { recursive: true });
await cp(join(tempRoot, "pdf-extracted"), incompleteRun, { recursive: true });
await writeFile(join(incompleteRun, "manifest.json"), JSON.stringify({ ...pdfManifest, pages_needing_ocr: [1] }));
const fakeOcrRoot = join(tempRoot, "fake-ocr");
await mkdir(join(fakeOcrRoot, "tessdata"), { recursive: true });
await writeFile(join(fakeOcrRoot, "tesseract.exe"), "fixture");
await writeFile(join(fakeOcrRoot, "tessdata", "jpn.traineddata"), "fixture");
await writeFile(join(fakeOcrRoot, "tessdata", "eng.traineddata"), "fixture");
const priorTesseractPath = process.env.TESSERACT_PATH;
process.env.TESSERACT_PATH = join(fakeOcrRoot, "tesseract.exe");
try {
  const retried = await extractDocument({ book: { title: "扫描重试", sourceFile: testPdf }, bookRoot: resumeRoot });
  assert.notEqual(retried.manifestPath, relative(resumeRoot, join(incompleteRun, "manifest.json")), "installing OCR should re-extract a PDF with previously unreadable pages");
} finally {
  if (priorTesseractPath === undefined) delete process.env.TESSERACT_PATH;
  else process.env.TESSERACT_PATH = priorTesseractPath;
}
console.log("PDF extraction checks passed");

const providerRequests = [];
const mock = http.createServer(async (req, res) => {
  let requestBody = ""; for await (const chunk of req) requestBody += chunk;
  providerRequests.push(requestBody);
  res.writeHead(200, { "content-type": "application/json" });
  const payload = JSON.parse(requestBody);
  const content = payload.messages?.[1]?.content || payload.input?.[1]?.content?.[0]?.text || "";
  const paragraphMatch = content.match(/原文段落：\n(\[[^\n]+\])/);
  const aligned = (label) => JSON.stringify({ segments: JSON.parse(paragraphMatch[1]).map((p, i) => ({ sourceParagraphIds: [p.id], text: i === 0 ? label : "这是第二段译文。" })) });
  let text;
  if (req.url.endsWith("/responses")) text = paragraphMatch ? aligned("这是 Responses 接口译文。") : "这是 Responses 接口译文。";
  else if (requestBody.includes("remainingQuestion")) text = JSON.stringify({ suggestedChinese: "洛中", definition: "京都城内", translatorNote: "此处指京都城内。", reason: "来源说明了所指", remainingQuestion: "", verdict: "supported", confidence: "medium", sourceUrls: ["https://www.wikidata.org/wiki/Q1", "https://evil.example/"] });
  else if (requestBody.includes("术语、人名与疑难项")) text = JSON.stringify({ terms: [{ japanese: "山口組", reading: "やまぐちぐみ", chinese: "山口组", category: "组织", confidence: "high", note: "固定组织名" }], characters: [], uncertainties: [] });
  else text = paragraphMatch ? aligned("这是第一段译文。") : "连接成功";
  res.end(JSON.stringify(req.url.endsWith("/responses") ? { status: "completed", output_text: text, usage: { input_tokens: 80, output_tokens: 20 } } : { choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 40 } }));
});
await new Promise((resolveListen) => mock.listen(0, "127.0.0.1", resolveListen));
const address = mock.address();
const connection = await testProviderConnection({ baseUrl: `http://127.0.0.1:${address.port}/v1`, protocol: "openai-chat", model: "mock-model", apiKey: "test-key", maxOutputTokens: 128 });
assert.equal(connection.ok, true); assert.equal(connection.model, "mock-model");
const analysis = await analyzeChapterEntities({ provider: { baseUrl: `http://127.0.0.1:${address.port}/v1`, protocol: "openai-chat", model: "mock-model", apiKey: "test-key" }, book: { title: "测试书" }, chapter: { title: "第一章" }, source: "山口組についての本文。" });
assert.equal(analysis.terms[0].chinese, "山口组");
const risks = identifyHighRisk({ source: "吉野和利は壱州会の会長", draft: "吉野和利是一和会的会长", analysis: { terms: [{ japanese: "壱州会", chinese: "一和会", category: "制度/组织", confidence: "low" }] }, glossary: [], characters: [] });
assert.equal(risks[0].originalTerm, "壱州会");
assert.equal(risks[0].priority, "high");
assert.equal(identifyHighRisk({ source: "山口組", draft: "山口组", analysis: { terms: [{ japanese: "山口組", chinese: "山口组", category: "组织", confidence: "high" }] }, glossary: [], characters: [] }).length, 0, "a simple script conversion is not a historical-risk claim");
const research = await researchTranslationIssue({ provider: { baseUrl: `http://127.0.0.1:${address.port}/v1`, protocol: "openai-chat", model: "mock-model", apiKey: "test-key" }, book: { title: "测试书" }, item: { japanese: "洛中", chinese: "洛中" }, kind: "glossary", evidence: [{ title: "洛中", url: "https://www.wikidata.org/wiki/Q1", description: "历史地名", excerpt: "洛中指京都城内", readAt: "2026-09-24T00:00:00Z" }] });
assert.equal(research.definition, "京都城内");
assert.equal(research.verdict, "supported");
assert.equal(Object.hasOwn(research, "translatorNote"), false, "AI research should return one explanation, not a second translator note");
assert.deepEqual(research.sourceUrls, ["https://www.wikidata.org/wiki/Q1"]);
const summaryOnly = await researchTranslationIssue({ provider: { baseUrl: `http://127.0.0.1:${address.port}/v1`, protocol: "openai-chat", model: "mock-model", apiKey: "test-key" }, book: { title: "测试书" }, item: { japanese: "洛中", chinese: "洛中" }, kind: "glossary", evidence: [{ title: "洛中", url: "https://example.org/summary", excerpt: "搜索摘要" }] });
assert.equal(summaryOnly.verdict, "insufficient", "a search snippet alone is not verified evidence");
await analyzeChapterEntities({ provider: { baseUrl: `http://127.0.0.1:${address.port}/v1`, protocol: "openai-chat", model: "mock-model", apiKey: "test-key" }, book: { title: "Roman", sourceLanguage: "fr" }, chapter: { title: "Chapitre 1" }, source: "Une jeune femme est arrivée à Paris." });
assert.match(providerRequests.at(-1), /法语原文/);
assert.doesNotMatch(providerRequests.at(-1), /日文作品|日中文学/);
await researchTranslationIssue({ provider: { baseUrl: `http://127.0.0.1:${address.port}/v1`, protocol: "openai-chat", model: "mock-model", apiKey: "test-key" }, book: { title: "Roman", sourceLanguage: "fr" }, item: { japanese: "Paris", chinese: "巴黎" }, kind: "glossary", evidence: [{ title: "Paris", url: "https://fr.wikipedia.org/wiki/Paris", description: "ville", excerpt: "Paris, capitale de la France", readAt: "2026-09-24T00:00:00Z" }] });
assert.match(providerRequests.at(-1), /法语/);
assert.doesNotMatch(providerRequests.at(-1), /日中文学译者/);
const translated = await translateChapter({
  provider: { baseUrl: `http://127.0.0.1:${address.port}/v1`, protocol: "openai-chat", model: "mock-model", apiKey: "test-key", maxOutputTokens: 1024, inputPrice: 1, outputPrice: 2 },
  book: { title: "抽出試験", profile: "现代文学", glossary: [] }, chapter: { title: "第一章" }, source: extractedText,
  control: { paused: false, cancelled: false }
});
assert.match(translated.text, /第一段译文/); assert.equal(translated.inputTokens, 120); assert.equal(translated.outputTokens, 40); assert.equal(translated.estimatedCost, 0.0002);
await translateChapter({ provider: { baseUrl: `http://127.0.0.1:${address.port}/v1`, protocol: "openai-chat", model: "mock-model", apiKey: "test-key" }, book: { title: "Roman", sourceLanguage: "fr", profile: "现代文学" }, chapter: { title: "Chapitre 1" }, source: "Bonjour le monde.", control: { paused: false, cancelled: false } });
assert.match(providerRequests.at(-1), /法语.*简体中文/);
assert.doesNotMatch(providerRequests.at(-1), /日文到简体中文/);
await translateChapter({ provider: { baseUrl: `http://127.0.0.1:${address.port}/v1`, protocol: "openai-chat", model: "mock-model", apiKey: "test-key" }, book: { title: "Roman", sourceLanguage: "fr", profile: "现代文学" }, chapter: { title: "Chapitre 1" }, source: "Bonjour le monde.", existingDraft: "你好，世界。", mode: "refine", control: { paused: false, cancelled: false } });
assert.match(providerRequests.at(-1), /法语原文/);
assert.doesNotMatch(providerRequests.at(-1), /日文原文|敬语方向/);
await translateChapter({ provider: { baseUrl: `http://127.0.0.1:${address.port}/v1`, protocol: "openai-chat", model: "mock-model", apiKey: "test-key" }, book: { title: "测试书" }, chapter: { title: "第一章" }, source: "壱州会", existingDraft: "一和会", mode: "refine", correction: { originalTerm: "壱州会", currentChinese: "一和会", suggestedChinese: "壱州会", evidence: "两份独立资料均与原文一致" }, control: { paused: false, cancelled: false } });
assert.match(providerRequests.at(-1), /两份独立资料均与原文一致/);
const responsesTranslation = await translateChapter({ provider: { baseUrl: `http://127.0.0.1:${address.port}/v1`, protocol: "openai-responses", model: "mock-model", noAuth: true, maxOutputTokens: 1024 }, book: { title: "抽出試験", profile: "现代文学", glossary: [] }, chapter: { title: "第一章" }, source: "短い本文。", control: { paused: false, cancelled: false } });
assert.match(responsesTranslation.text, /Responses 接口译文/); assert.equal(responsesTranslation.inputTokens, 80);
const chapter = { id: "chapter-0001", translationPath: "" }; const projectRoot = join(tempRoot, "project");
chapter.translationPath = await writeTranslation(projectRoot, chapter, translated.text, false);
assert.match(await readChapterText(projectRoot, chapter, "translation"), /第二段译文/);
await new Promise((resolveClose) => mock.close(resolveClose));
await unlink(sourceEpub); await rm(tempRoot, { recursive: true, force: true });
console.log("Translation API and durable file checks passed");
