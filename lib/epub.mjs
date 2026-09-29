import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanReaderExplanation } from "../public/reader-notes.js";
import { IMAGE_PARAGRAPH } from "../public/illustrations.js";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let k = 0; k < 8; k += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimestamp(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const stamp = dosTimestamp();

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replaceAll("\\", "/"), "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const method = entry.name === "mimetype" ? 0 : 8;
    const packed = method ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + packed.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function escapeXml(value = "") {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function paragraphs(value = "") {
  return value.split(/\n\s*\n|\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => `<p id="p-${index + 1}">${escapeXml(line)}</p>`).join("\n");
}

// Paragraphs, with "[图片]" placeholders turned into the chapter's own illustrations in order.
function paragraphsWithFigures(value = "", images = [], use) {
  let next = 0;
  return value.split(/\n\s*\n|\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    if (IMAGE_PARAGRAPH.test(line) && next < images.length) return `<div class="figure" id="p-${index + 1}"><img src="${escapeXml(use(images[next++]))}" alt="插图"/></div>`;
    return `<p id="p-${index + 1}">${escapeXml(line)}</p>`;
  }).join("\n");
}
const IMAGE_TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".avif": "image/avif" };

function translatorNotes(book, chapter) {
  const source = String(chapter.source || "");
  if (!source) return "";
  const approved = [...(book.glossary || []), ...(book.characters || [])];
  const approvedNames = new Set(approved.map((item) => item.japanese || item.japaneseName));
  const candidates = [...(book.termCandidates || []), ...(book.characterCandidates || [])].filter((item) => !approvedNames.has(item.japanese || item.japaneseName));
  const items = [...approved.map((item) => ({ ...item, readerExplanation: cleanReaderExplanation(item.definition || item.translatorNote || item.identity || "") })),
    ...candidates.map((item) => ({ ...item, readerExplanation: cleanReaderExplanation(item.research?.definition || item.identity || item.note || ""), unverified: item.research?.verdict !== "supported" }))].filter((item) => {
    const name = item.japanese || item.japaneseName;
    return name && item.readerExplanation && source.includes(name);
  });
  if (!items.length) return "";
  return `<section class="translator-notes"><h2>译者注</h2>${items.some((item) => item.unverified) ? '<p class="note">AI 初译释义尚未全部经过联网核实。</p>' : ""}<ol>${items.map((item) => `<li><strong>${escapeXml(item.chinese || item.chineseName || item.japanese || item.japaneseName)}</strong>：${escapeXml(item.readerExplanation)}${item.research?.verdict === "supported" ? "（资料支持）" : ""}</li>`).join("")}</ol></section>`;
}

function xhtml(title, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-Hans" lang="zh-Hans">
<head><meta charset="UTF-8"/><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="styles.css"/></head>
<body>${body}</body></html>`;
}

export async function createEpub({ book, chapters, outputPath, includeDraft = false, pictures = null }) {
  const selected = chapters.filter((chapter) => chapter.status === "approved" || (includeDraft && chapter.translation?.trim()));
  if (!selected.length) throw new Error("没有可导出的已批准章节");
  // Illustrations are copied from the original book under OEBPS/images/ with their original paths.
  const packed = new Map();
  const use = (image) => { const name = `images/${image.path}`; if (!packed.has(name)) packed.set(name, image.path); return name; };
  const coverImage = pictures?.cover ? use({ path: pictures.cover }) : "";
  const listed = selected.filter((chapter) => !chapter.illustration);
  const identifier = `urn:uuid:${randomUUID()}`;
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const manifestItems = selected.map((chapter, index) => `<item id="chapter-${index + 1}" href="chapter-${index + 1}.xhtml" media-type="application/xhtml+xml"/>`).join("\n");
  const spineItems = selected.map((_, index) => `<itemref idref="chapter-${index + 1}"/>`).join("\n");
  // Illustration pages stay in reading order but out of the table of contents.
  const navItems = selected.map((chapter, index) => chapter.illustration ? "" : `<li><a href="chapter-${index + 1}.xhtml">${escapeXml(chapter.title)}</a></li>`).join("\n");
  const ncxItems = selected.map((chapter, index) => ({ chapter, index })).filter(({ chapter }) => !chapter.illustration).map(({ chapter, index }, order) => `<navPoint id="nav-${index + 1}" playOrder="${order + 1}"><navLabel><text>${escapeXml(chapter.title)}</text></navLabel><content src="chapter-${index + 1}.xhtml"/></navPoint>`).join("\n");
  if (!listed.length) throw new Error("没有可导出的已批准章节");
  const chapterBodies = selected.map((chapter) => {
    const figures = paragraphsWithFigures(chapter.translation, pictures?.chapter(chapter) || [], use);
    return chapter.illustration ? figures : `<h1>${escapeXml(chapter.title)}</h1>${figures}${chapter.status !== "approved" ? `<p class="note">草稿章节，尚未批准。</p>` : ""}${translatorNotes(book, chapter)}`;
  });
  const imageEntries = [];
  for (const [name, path] of packed) { try { imageEntries.push({ name, data: await readFile(join(pictures.dir, ...path.split("/"))) }); } catch { /* a missing image is left out */ } }
  const present = new Set(imageEntries.map((e) => e.name));
  const imageItems = imageEntries.map((entry, i) => `<item id="img-${i + 1}" href="${escapeXml(entry.name)}" media-type="${IMAGE_TYPES[(entry.name.match(/\.[^.]+$/)?.[0] || "").toLowerCase()] || "image/jpeg"}"${entry.name === coverImage ? ' properties="cover-image"' : ""}/>`).join("");
  const coverId = coverImage && present.has(coverImage) ? `img-${imageEntries.findIndex((e) => e.name === coverImage) + 1}` : "";
  const statusNote = includeDraft ? "本文件包含尚未批准的草稿章节。" : "本文件仅包含已批准章节。";

  const entries = [
    { name: "mimetype", data: "application/epub+zip" },
    { name: "META-INF/container.xml", data: `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>` },
    { name: "OEBPS/styles.css", data: `body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Serif CJK SC",serif;line-height:1.85;margin:5%;color:#1e2930}h1{font-size:1.55em;margin:1.8em 0 1em}.figure{text-align:center;text-indent:0;margin:1em 0}.figure img{max-width:100%;max-height:95vh}p{text-indent:2em;margin:.35em 0}.note{font-size:.86em;color:#5f6b70;text-indent:0}.translator-notes{border-top:1px solid #aeb5b9;margin-top:2em;padding-top:.5em;font-size:.86em}.translator-notes h2{font-size:1.1em}.translator-notes li{margin:.4em 0}` },
    { name: "OEBPS/cover.xhtml", data: xhtml(book.title, `<section class="cover">${coverId ? `<div class="figure"><img src="${escapeXml(coverImage)}" alt="封面"/></div>` : ""}<h1>${escapeXml(book.title)}</h1><p>${escapeXml(book.author || "佚名")}</p><p class="note">瀟湘館导出</p></section>`) },
    { name: "OEBPS/nav.xhtml", data: `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-Hans" lang="zh-Hans"><head><title>目录</title></head><body><nav epub:type="toc" id="toc"><h1>目录</h1><ol>${navItems}</ol></nav></body></html>` },
    { name: "OEBPS/toc.ncx", data: `<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${escapeXml(identifier)}"/></head><docTitle><text>${escapeXml(book.title)}</text></docTitle><navMap>${ncxItems}</navMap></ncx>` },
    { name: "OEBPS/content.opf", data: `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">${escapeXml(identifier)}</dc:identifier><dc:title>${escapeXml(book.title)}</dc:title><dc:creator>${escapeXml(book.author || "佚名")}</dc:creator><dc:language>zh-Hans</dc:language><meta property="dcterms:modified">${modified}</meta>${coverId ? `<meta name="cover" content="${coverId}"/>` : ""}</metadata><manifest><item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css" href="styles.css" media-type="text/css"/>${imageItems}${manifestItems}</manifest><spine toc="ncx"><itemref idref="cover" linear="yes"/>${spineItems}</spine></package>` }
  ];

  selected.forEach((chapter, index) => {
    entries.push({ name: `OEBPS/chapter-${index + 1}.xhtml`, data: xhtml(chapter.illustration ? "插图" : chapter.title, chapterBodies[index]) });
  });
  for (const entry of imageEntries) entries.push({ name: `OEBPS/${entry.name}`, data: entry.data });
  const archive = createZip(entries);
  await writeFile(outputPath, archive);
  return { outputPath, chapterCount: selected.length, chapterIds: selected.map((chapter) => chapter.id), bytes: archive.length, note: statusNote };
}
