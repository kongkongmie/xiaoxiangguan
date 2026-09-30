// Multi-version comparison: pure helpers shared by the server and the reader. No DOM, no I/O.

// Muted traditional pigments that sit well on all four workbench themes; night mode lightens them in CSS.
export const VERSION_PALETTE = [
  { id: "dailan", name: "黛蓝", hex: "#3f6e9a" },
  { id: "yanzhi", name: "胭脂", hex: "#b5485d" },
  { id: "zhuqing", name: "竹青", hex: "#4e8a6a" },
  { id: "hupo", name: "琥珀", hex: "#b7801f" },
  { id: "tengzi", name: "藤紫", hex: "#7a5ba6" },
  { id: "zheshi", name: "赭石", hex: "#a0613a" },
  { id: "songshi", name: "松石", hex: "#2e8686" },
  { id: "mohui", name: "墨灰", hex: "#5e6670" }
];
export const MIX_COLOR = "#8a7a5c";
export const CUSTOM_COLOR = "#9a8f80";
const HEX = /^#[0-9a-f]{6}$/i;
export const isVersionColor = (value) => typeof value === "string" && HEX.test(value);

const BACKEND_NAMES = { codex: "Codex", opencode: "OpenCode", antigravity: "Antigravity", claude: "Claude Code" };
const hostOf = (url) => { try { return new URL(url).host; } catch { return ""; } };

// Two runs are "the same engine" when backend, endpoint, model and effort agree. Keys never include secrets.
export function engineKey(engine = {}) {
  const backend = engine.backend || "http";
  return [backend, backend === "http" ? hostOf(engine.baseUrl) : "", engine.model || "", engine.reasoningEffort || ""].join("|");
}
export function engineLabel(engine = {}) {
  if (engine.profileName) return engine.profileName;
  const backend = engine.backend || "http";
  const model = engine.model || (backend === "http" ? "" : "默认模型");
  const who = backend === "http" ? (engine.providerName || hostOf(engine.baseUrl) || "翻译 API") : BACKEND_NAMES[backend] || backend;
  return [who, model, engine.reasoningEffort].filter(Boolean).join(" · ");
}
function hashIndex(text, size) { let h = 0; for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) >>> 0; return h % size; }
export function engineColor(engine, profiles = []) {
  if (!engine) return MIX_COLOR;
  const byId = engine.profileId && profiles.find((p) => p.id === engine.profileId);
  if (byId && isVersionColor(byId.color)) return byId.color;
  if (isVersionColor(engine.profileColor)) return engine.profileColor;
  const key = engineKey(engine); const byKey = profiles.find((p) => p.engineKey === key);
  if (byKey && isVersionColor(byKey.color)) return byKey.color;
  return VERSION_PALETTE[hashIndex(key, VERSION_PALETTE.length)].hex;
}
export function engineName(engine, profiles = []) {
  if (!engine) return "合成稿";
  const byId = engine.profileId && profiles.find((p) => p.id === engine.profileId);
  if (byId?.name) return byId.name;
  if (engine.profileName) return engine.profileName;
  const key = engineKey(engine);
  return profiles.find((p) => p.engineKey === key)?.name || engineLabel(engine);
}

const coversExactly = (segments, ids) => Array.isArray(segments) && segments.length > 0 && JSON.stringify(segments.flatMap((s) => s.sourceParagraphIds || [])) === JSON.stringify(ids);
function kindOf(revision) {
  if (revision.origin === "mix") return "合成";
  if (/精校/.test(revision.reason || "")) return "精校";
  if (/联网纠正/.test(revision.reason || "")) return "纠正";
  if (revision.origin === "ai") return "初译";
  return "读者";
}

// A run finished by more than one engine (one took over the unfinished blocks of another): which engine wrote
// each segment, and the engines in order of first appearance. Null when a single engine wrote everything.
export function relaySources(revision) {
  const blocks = Array.isArray(revision?.blockEngines) ? revision.blockEngines.filter((b) => b.engine && Array.isArray(b.sourceParagraphIds)) : [];
  const keys = [...new Set(blocks.map((b) => engineKey(b.engine)))];
  if (keys.length < 2 || !Array.isArray(revision.segments)) return null;
  const engines = keys.map((key) => blocks.find((b) => engineKey(b.engine) === key).engine);
  const sources = revision.segments.map((s) => { const block = blocks.find((b) => b.sourceParagraphIds.includes(s.sourceParagraphIds[0])); return { sourceParagraphIds: s.sourceParagraphIds, engine: block?.engine || null }; });
  return { engines, sources };
}

// Aligned whole-chapter versions, oldest first. Restoring a version copies its file path, so path identifies duplicates.
export function comparableVersions(chapter, paragraphIds, profiles = []) {
  const history = chapter?.revisionHistory || [];
  const activeId = chapter?.activeRevisionId || chapter?.revisionId;
  const byPath = new Map();
  for (const revision of history) {
    if (!coversExactly(revision.segments, paragraphIds)) continue;
    const key = revision.path || revision.id;
    const existing = byPath.get(key);
    if (!existing) { byPath.set(key, { revision, memberIds: [revision.id] }); continue; }
    existing.memberIds.push(revision.id);
    // Prefer the entry that still knows which engine produced the text.
    if (!existing.revision.engine && revision.engine) existing.revision = revision;
  }
  const versions = [...byPath.values()].map(({ revision, memberIds }) => {
    const relay = revision.origin === "mix" ? null : relaySources(revision);
    const engine = revision.origin === "mix" || relay ? null : revision.engine || null;
    const name = engine ? engineName(engine, profiles) : relay ? `接力：${relay.engines.map((e) => engineName(e, profiles)).join(" + ")}` : revision.origin === "mix" ? "合成稿" : "读者版本";
    return {
      id: revision.id, memberIds, kind: kindOf(revision), createdAt: revision.createdAt || "", active: memberIds.includes(activeId), relay: Boolean(relay),
      engine, name, color: engine ? engineColor(engine, profiles) : MIX_COLOR, segments: revision.segments, segmentSources: revision.segmentSources || relay?.sources || null
    };
  });
  versions.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  // Same engine translated twice: number them so chips stay distinguishable.
  const seen = new Map();
  for (const version of versions) { const key = `${version.name}|${version.kind}`; const n = (seen.get(key) || 0) + 1; seen.set(key, n); version.ordinal = n; }
  for (const version of versions) {
    const repeated = (seen.get(`${version.name}|${version.kind}`) || 0) > 1;
    // Composed and reader versions are named by what they are; engine versions add the kind of pass.
    const plain = version.kind === "合成" || version.kind === "读者";
    version.tag = plain ? (repeated ? String(version.ordinal) : "") : repeated ? `${version.kind} ${version.ordinal}` : version.kind;
    version.label = version.tag ? `${version.name}${plain ? " " : " · "}${version.tag}` : version.name;
  }
  return versions;
}

// Excerpt translations (a few paragraphs, often a quick second opinion from another engine) join the comparison
// wherever they cover a whole unit. They never become chips or a fallback for the whole chapter.
export function partialVersions(chapter, paragraphIds, profiles = []) {
  const position = new Map(paragraphIds.map((id, i) => [id, i]));
  const result = [];
  for (const entry of chapter?.segments || []) {
    if (entry.alignedStale) continue;
    const ids = Array.isArray(entry.segments) ? entry.segments.flatMap((s) => s.sourceParagraphIds || []) : [];
    const first = position.get(ids[0]);
    // Must still be a contiguous, ordered run of the current source paragraphs.
    if (!ids.length || first === undefined || ids.some((id, k) => position.get(id) !== first + k)) continue;
    const engine = entry.engine || null;
    result.push({ id: entry.id, memberIds: [entry.id], kind: "节选", partial: true, active: false, createdAt: entry.createdAt || "", engine,
      name: engine ? engineName(engine, profiles) : "节选译文", color: engine ? engineColor(engine, profiles) : MIX_COLOR,
      segments: entry.segments.map((s) => ({ sourceParagraphIds: s.sourceParagraphIds, text: entry.status === "failed" ? "" : s.text })), segmentSources: null });
  }
  result.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const seen = new Map();
  for (const v of result) { const n = (seen.get(v.name) || 0) + 1; seen.set(v.name, n); v.ordinal = n; }
  for (const v of result) { v.tag = (seen.get(v.name) || 0) > 1 ? `节选 ${v.ordinal}` : "节选"; v.label = `${v.name} · ${v.tag}`; }
  return result;
}

// Split the chapter where no version merges across the boundary, so every unit maps to whole segments in every version.
export function compareUnits(paragraphIds, versions) {
  const blocked = new Set();
  for (const version of versions) {
    for (const segment of version.segments) {
      const first = paragraphIds.indexOf(segment.sourceParagraphIds[0]);
      for (let k = 0; k < segment.sourceParagraphIds.length - 1; k++) blocked.add(first + k);
    }
  }
  const units = []; let start = 0;
  for (let i = 0; i < paragraphIds.length; i++) {
    if (blocked.has(i)) continue;
    const ids = paragraphIds.slice(start, i + 1);
    const texts = {};
    for (const version of versions) {
      const inside = segmentsWithin(version.segments, ids);
      // Excerpts only speak for units they cover completely.
      if (JSON.stringify(inside.flatMap((s) => s.sourceParagraphIds)) === JSON.stringify(ids)) texts[version.id] = inside.map((s) => s.text).join("\n\n");
    }
    units.push({ key: ids.join(" "), ids, texts });
    start = i + 1;
  }
  return units;
}
export function segmentsWithin(segments, ids) {
  const wanted = new Set(ids);
  return segments.filter((s) => s.sourceParagraphIds.every((id) => wanted.has(id)));
}

// Validates reader choices and builds the composed revision. Throws on any gap, overlap or unknown version.
export function composeRevision(paragraphIds, versions, choices) {
  if (!Array.isArray(choices) || !choices.length) throw new Error("没有可合成的段落选择");
  const flat = choices.flatMap((c) => Array.isArray(c?.ids) ? c.ids : []);
  if (JSON.stringify(flat) !== JSON.stringify(paragraphIds)) throw new Error("合成选择没有完整、按顺序覆盖本章原文；请刷新后重试");
  const segments = [], sources = [], counts = new Map();
  for (const choice of choices) {
    if (typeof choice.text === "string") {
      const text = choice.text.trim(); if (!text) throw new Error("手改段落不能为空");
      segments.push({ sourceParagraphIds: choice.ids, text }); sources.push({ sourceParagraphIds: choice.ids, custom: true });
      counts.set("手改", (counts.get("手改") || 0) + 1); continue;
    }
    const version = versions.find((v) => v.id === choice.revisionId || v.memberIds?.includes(choice.revisionId));
    if (!version) throw new Error("所选译本已不存在或与原文不再对齐");
    const picked = segmentsWithin(version.segments, choice.ids);
    if (JSON.stringify(picked.flatMap((s) => s.sourceParagraphIds)) !== JSON.stringify(choice.ids)) throw new Error("所选译本在这一处与其他译本的分段不同，请刷新后重新选择");
    segments.push(...picked.map((s) => ({ sourceParagraphIds: s.sourceParagraphIds, text: s.text })));
    // A composed version picked from another composed version keeps the original per-segment provenance.
    for (const s of picked) {
      const inherited = version.segmentSources?.find((src) => src.sourceParagraphIds.includes(s.sourceParagraphIds[0]));
      sources.push(inherited && !version.engine ? { ...inherited, sourceParagraphIds: s.sourceParagraphIds } : { sourceParagraphIds: s.sourceParagraphIds, revisionId: version.id, engine: version.engine, name: version.name });
    }
    counts.set(version.name, (counts.get(version.name) || 0) + choice.ids.length);
  }
  const summary = [...counts].map(([name, n]) => `${name} ${n} 段`).join("、");
  return { segments, segmentSources: sources, text: segments.map((s) => s.text).join("\n\n"), summary };
}

// Colour and name of the version each paragraph of a composed revision came from.
export function sourceMarks(segmentSources, profiles = []) {
  if (!Array.isArray(segmentSources)) return new Map();
  const marks = new Map();
  for (const src of segmentSources) {
    const mark = src.custom ? { color: CUSTOM_COLOR, name: "手改" } : { color: engineColor(src.engine, profiles), name: src.engine ? engineName(src.engine, profiles) : src.name || "合成稿" };
    marks.set(src.sourceParagraphIds.join(" "), mark);
  }
  return marks;
}
