// Illustrations: pulled out of an EPUB by chapter, recognised as placeholders, and packed into the export.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE_PARAGRAPH, isIllustrationText } from "../public/illustrations.js";
import { createEpub } from "../lib/epub.mjs";

for (const text of ["[图片]", "[图片：扉页]", "［插图］", "【挿絵】", "[image]"]) assert.ok(IMAGE_PARAGRAPH.test(text), text);
for (const text of ["[图片]之后的正文", "图片", "他看着[图片]"]) assert.ok(!IMAGE_PARAGRAPH.test(text), text);
assert.ok(isIllustrationText("[图片]\n\n[插图]")); assert.ok(!isIllustrationText("[图片]\n\n正文")); assert.ok(!isIllustrationText(""));

const PY = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const zipList = (file) => execFileSync(PY, ["-c", "import zipfile,sys;print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))", file], { encoding: "utf8" });
const zipRead = (file, name) => execFileSync(PY, ["-c", "import zipfile,sys;sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))", file, name], { encoding: "utf8" });
const dir = await mkdtemp(join(tmpdir(), "xxg-illus-"));
const epub = join(dir, "book.epub"), png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a1ba4a2a0000000049454e44ae426082", "hex");
await writeFile(join(dir, "pic.png"), png);
execFileSync(PY, ["-c", `
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1],"w")
z.writestr("mimetype","application/epub+zip")
z.writestr("META-INF/container.xml",'<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
z.writestr("OEBPS/content.opf",'<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata><meta name="cover" content="cov"/></metadata><manifest><item id="cov" href="img/cover.png" media-type="image/png"/><item id="p1" href="text/p1.html" media-type="application/xhtml+xml"/><item id="p2" href="text/p2.html" media-type="application/xhtml+xml"/><item id="a" href="img/a.png" media-type="image/png"/></manifest><spine><itemref idref="p1"/><itemref idref="p2"/></spine></package>')
z.writestr("OEBPS/text/p1.html",'<html><body><p><img src="../img/a.png" alt="扉页"/></p></body></html>')
z.writestr("OEBPS/text/p2.html",'<html><body><svg xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="../img/cover.png"/></svg><img src="https://example.com/x.png"/><img src="../../../etc/passwd.png"/></body></html>')
z.write(sys.argv[2],"OEBPS/img/a.png"); z.write(sys.argv[2],"OEBPS/img/cover.png"); z.close()`, epub, join(dir, "pic.png")]);
const out = join(dir, "images");
execFileSync(PY, ["scripts/extract_ebook.py", epub, "--images", out]);
const index = JSON.parse(await readFile(join(out, "index.json"), "utf8"));
assert.deepEqual(index.chapters["text/p1.html"], [{ path: "OEBPS/img/a.png", alt: "扉页" }]);
assert.deepEqual(index.chapters["text/p2.html"], [{ path: "OEBPS/img/cover.png", alt: "" }], "svg images kept; remote and escaping paths ignored");
assert.equal(index.cover, "OEBPS/img/cover.png"); assert.ok(existsSync(join(out, "files", "OEBPS", "img", "a.png")));

const outputPath = join(dir, "export.epub");
const chapters = [{ id: "c1", title: "扉页", sourceHref: "text/p1.html", translation: "[图片]", status: "approved", illustration: true }, { id: "c2", title: "第一章", sourceHref: "text/p2.html", translation: "[插图]\n\n正文一段。", status: "approved" }];
const result = await createEpub({ book: { title: "书", author: "作者" }, chapters, outputPath, pictures: { dir: join(out, "files"), cover: index.cover, chapter: (c) => index.chapters[c.sourceHref] || [] } });
assert.equal(result.chapterCount, 2);
const list = zipList(outputPath);
assert.match(list, /OEBPS\/images\/OEBPS\/img\/a\.png/); assert.match(list, /OEBPS\/images\/OEBPS\/img\/cover\.png/);
const opf = zipRead(outputPath, "OEBPS/content.opf");
assert.match(opf, /properties="cover-image"/); assert.match(opf, /<meta name="cover" content="img-\d+"\/>/);
const nav = zipRead(outputPath, "OEBPS/nav.xhtml");
assert.ok(!nav.includes("扉页") && nav.includes("第一章"), "illustration pages stay out of the contents");
const c2 = zipRead(outputPath, "OEBPS/chapter-2.xhtml");
assert.match(c2, /<img src="images\/OEBPS\/img\/cover\.png"/); assert.match(c2, /正文一段/);
console.log("illustrations: extraction, placeholders, export passed");
