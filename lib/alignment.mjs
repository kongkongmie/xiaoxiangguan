import { createHash } from "node:crypto";
import { isPlainRefusal, modelRefusalError } from "./model-output.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 20);
export const DEFAULT_TRANSLATION_BLOCK_CHARS = 3000;
export function validateTranslationBlockChars(value = DEFAULT_TRANSLATION_BLOCK_CHARS, maxChars = 6000) {
  if (!Number.isInteger(value) || value < 500 || value > maxChars) throw new Error(`每块原文目标字符数必须是 500 到 ${maxChars} 的整数`);
  return value;
}
export function sourceParagraphs(source, chapterId = "chapter") {
  const occurrences = new Map();
  // IDs depend on content and occurrence, never on the translation's length or chunk size.
  return String(source).replace(/\r\n/g, "\n").split(/\n\s*\n/).map((text) => text.trim()).filter(Boolean).map((text, index) => {
    const digest = hash(`${chapterId}\n${text}`);
    const occurrence = (occurrences.get(digest) || 0) + 1; occurrences.set(digest, occurrence);
    return { id: `p-${digest}-${occurrence}`, order: index, text };
  });
}
export const sourceFingerprint = (paragraphs) => hash(JSON.stringify(paragraphs));
export const alignmentSchema = {
  type: "object", additionalProperties: false, required: ["segments", "refusal"], properties: {
    refusal: { type: ["string", "null"] },
    segments: { type: "array", items: { type: "object", additionalProperties: false, required: ["sourceParagraphIds", "text"], properties: {
      sourceParagraphIds: { type: "array", items: { type: "string" }, minItems: 1 }, text: { type: "string" }
    } } }
  }
};
function invalidStructure(message) { const error = new Error(message); error.code = "INVALID_TRANSLATION_STRUCTURE"; return error; }
export function validateSegments(value, expectedIds) {
  if (!Array.isArray(value) || !value.length) throw invalidStructure("模型未返回段落映射；请重试此块");
  const segments = value.map((segment) => {
    if (!Array.isArray(segment?.sourceParagraphIds) || !segment.sourceParagraphIds.length || typeof segment.text !== "string" || !segment.text.trim()) throw invalidStructure("译文存在空段或无效段落 ID");
    return { sourceParagraphIds: segment.sourceParagraphIds, text: segment.text.trim() };
  });
  const ids = segments.flatMap((segment) => segment.sourceParagraphIds);
  if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) throw invalidStructure("译文段落覆盖不完整，或存在重复、乱序 ID；此块未采用");
  return segments;
}
export function parseAlignedText(text, ids) {
  let value;
  try { value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }
  catch {
    if (isPlainRefusal(text)) throw modelRefusalError(text);
    const error = new Error("模型未返回有效的段落 JSON；此块未采用"); error.code = "INVALID_TRANSLATION_JSON"; throw error;
  }
  if (typeof value?.refusal === "string" && value.refusal.trim()) throw modelRefusalError(value.refusal);
  return validateSegments(value?.segments, ids);
}
export function translationBlocks(paragraphs, draftSegments, maxChars = DEFAULT_TRANSLATION_BLOCK_CHARS) {
  const groups = draftSegments ? validateSegments(draftSegments, paragraphs.map((p) => p.id)).map((segment) => ({
    paragraphs: segment.sourceParagraphIds.map((id) => paragraphs.find((p) => p.id === id)), draft: segment.text
  })) : paragraphs.map((p) => ({ paragraphs: [p], draft: "" }));
  const blocks = []; let pending = []; let size = 0;
  const flush = () => {
    if (!pending.length) return;
    const items = pending.flatMap((group) => group.paragraphs); const ids = items.map((p) => p.id);
    blocks.push({ id: `b-${hash(ids.join("|"))}`, order: blocks.length, sourceParagraphIds: ids, paragraphs: items, draft: pending.map((g) => g.draft).filter(Boolean).join("\n\n"), status: "queued" });
    pending = []; size = 0;
  };
  for (const group of groups) {
    const length = group.paragraphs.reduce((n, p) => n + p.text.length, 0);
    // A merged translation is indivisible. Never pair it to only part of its source.
    if (pending.length && size + length > maxChars) flush();
    pending.push(group); size += length;
  }
  flush(); return blocks;
}
export function revisionSegments(chapter) {
  const id = chapter.activeRevisionId || chapter.revisionId;
  return chapter.revisionHistory?.find((revision) => revision.id === id)?.segments || null;
}
