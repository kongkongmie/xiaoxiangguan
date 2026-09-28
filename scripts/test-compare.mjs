import assert from "node:assert/strict";
import { comparableVersions, partialVersions, compareUnits, composeRevision, engineColor, engineKey, engineLabel, sourceMarks, VERSION_PALETTE, MIX_COLOR, CUSTOM_COLOR } from "../public/compare-core.js";

const ids = ["p1", "p2", "p3", "p4"];
const seg = (idList, text) => ({ sourceParagraphIds: idList, text });
const sonnet = { backend: "claude", model: "sonnet" };
const deepseek = { backend: "http", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", providerName: "DeepSeek" };
const chapter = {
  activeRevisionId: "r-restore",
  revisionHistory: [
    { id: "r-sonnet", path: "translations/working/c-ai-1.md", origin: "ai", reason: "AI 初译", engine: sonnet, createdAt: "2026-09-28T01:00:00Z",
      segments: [seg(["p1"], "S1"), seg(["p2", "p3"], "S23"), seg(["p4"], "S4")] },
    { id: "r-deep", path: "translations/working/c-ai-2.md", origin: "ai", reason: "AI 初译", engine: deepseek, createdAt: "2026-09-28T02:00:00Z",
      segments: [seg(["p1"], "D1"), seg(["p2"], "D2"), seg(["p3"], "D3"), seg(["p4"], "D4")] },
    { id: "r-edit", path: "translations/working/c-reader-1.md", origin: "reader", reason: "读者修改", createdAt: "2026-09-28T03:00:00Z" },
    { id: "r-stale", path: "translations/working/c-ai-0.md", origin: "ai", engine: sonnet, segments: [seg(["old"], "x")] },
    // Restoring copies the path and segments but (in older builds) not the engine.
    { id: "r-restore", path: "translations/working/c-ai-1.md", origin: "reader", reason: "读者恢复版本 r-sonnet", createdAt: "2026-09-28T04:00:00Z",
      segments: [seg(["p1"], "S1"), seg(["p2", "p3"], "S23"), seg(["p4"], "S4")] },
    { id: "r-sonnet-2", path: "translations/working/c-ai-3.md", origin: "ai", reason: "AI 初译", engine: sonnet, createdAt: "2026-09-28T05:00:00Z",
      segments: [seg(["p1"], "T1"), seg(["p2"], "T2"), seg(["p3"], "T3"), seg(["p4"], "T4")] }
  ]
};

// Versions: unaligned edits and stale fingerprints are left out; the restored copy folds into its original.
const versions = comparableVersions(chapter, ids);
assert.deepEqual(versions.map((v) => v.id), ["r-sonnet", "r-deep", "r-sonnet-2"]);
assert.equal(versions[0].active, true, "restored copy marks the original as active");
assert.deepEqual(versions[0].memberIds, ["r-sonnet", "r-restore"]);
assert.equal(versions[0].label, "Claude Code · sonnet · 初译 1"); assert.equal(versions[2].label, "Claude Code · sonnet · 初译 2"); assert.equal(versions[2].tag, "初译 2");
assert.equal(versions[1].label, "DeepSeek · deepseek-chat · 初译");
assert.ok(VERSION_PALETTE.some((p) => p.hex === versions[1].color));

// Units: Sonnet merged p2+p3, so every version is compared on that pair as one unit.
const units = compareUnits(ids, versions);
assert.deepEqual(units.map((u) => u.key), ["p1", "p2 p3", "p4"]);
assert.equal(units[1].texts["r-sonnet"], "S23"); assert.equal(units[1].texts["r-deep"], "D2\n\nD3");

// Compose: mix engines, one hand edit, provenance kept per segment.
const composed = composeRevision(ids, versions, [{ ids: ["p1"], revisionId: "r-deep" }, { ids: ["p2", "p3"], revisionId: "r-restore" }, { ids: ["p4"], text: "  我改的  " }]);
assert.equal(composed.text, "D1\n\nS23\n\n我改的");
assert.deepEqual(composed.segments.map((s) => s.sourceParagraphIds), [["p1"], ["p2", "p3"], ["p4"]]);
assert.equal(composed.segmentSources[0].engine, deepseek); assert.equal(composed.segmentSources[1].engine, sonnet); assert.equal(composed.segmentSources[2].custom, true);
assert.match(composed.summary, /DeepSeek.*1 段.*sonnet.*2 段.*手改 1 段/);
// Picking a version whose segments are finer than the unit keeps its paragraph granularity.
const fine = composeRevision(ids, versions, [{ ids: ["p1"], revisionId: "r-sonnet" }, { ids: ["p2", "p3"], revisionId: "r-deep" }, { ids: ["p4"], revisionId: "r-deep" }]);
assert.deepEqual(fine.segments.map((s) => s.text), ["S1", "D2", "D3", "D4"]);

// Invalid choices are rejected, never silently patched.
assert.throws(() => composeRevision(ids, versions, [{ ids: ["p1"], revisionId: "r-deep" }]), /完整/);
assert.throws(() => composeRevision(ids, versions, [{ ids: ["p2", "p1"], revisionId: "r-deep" }, { ids: ["p3", "p4"], revisionId: "r-deep" }]), /完整/);
assert.throws(() => composeRevision(ids, versions, [{ ids: ["p1", "p2"], revisionId: "r-sonnet" }, { ids: ["p3", "p4"], revisionId: "r-sonnet" }]), /分段不同/);
assert.throws(() => composeRevision(ids, versions, [{ ids, revisionId: "r-edit" }]), /不存在/);
assert.throws(() => composeRevision(ids, versions, [{ ids: ["p1", "p2", "p3"], text: "  " }, { ids: ["p4"], revisionId: "r-deep" }]), /不能为空/);

// A composed revision re-enters comparison as its own neutral-coloured version and keeps inherited provenance.
const withMix = { ...chapter, activeRevisionId: "r-mix", revisionHistory: [...chapter.revisionHistory, { id: "r-mix", path: "m.md", origin: "mix", createdAt: "2026-09-28T06:00:00Z", segments: composed.segments, segmentSources: composed.segmentSources }] };
const mixVersions = comparableVersions(withMix, ids);
const mix = mixVersions.at(-1); assert.equal(mix.name, "合成稿"); assert.equal(mix.label, "合成稿"); assert.equal(mix.tag, ""); assert.equal(mix.color, MIX_COLOR); assert.equal(mix.active, true);
const again = composeRevision(ids, mixVersions, [{ ids: ["p1"], revisionId: "r-mix" }, { ids: ["p2", "p3"], revisionId: "r-mix" }, { ids: ["p4"], revisionId: "r-mix" }]);
assert.equal(again.segmentSources[0].engine, deepseek, "provenance survives re-composition");
const marks = sourceMarks(again.segmentSources);
assert.equal(marks.get("p4").color, CUSTOM_COLOR); assert.equal(marks.get("p4").name, "手改");

// Profiles decide colour and name, even after the profile is renamed; the snapshot colour survives deletion.
const profiles = [{ id: "prof-1", name: "阿青", color: "#b5485d", engineKey: engineKey(sonnet) }];
assert.equal(engineColor({ ...sonnet, profileId: "prof-1", profileColor: "#3f6e9a" }, profiles), "#b5485d");
assert.equal(engineColor({ ...sonnet, profileId: "gone", profileColor: "#3f6e9a" }, []), "#3f6e9a");
assert.equal(engineColor(sonnet, profiles), "#b5485d", "unlabelled runs match a profile by engine key");
assert.equal(comparableVersions(chapter, ids, profiles)[0].name, "阿青");
assert.equal(engineLabel({ backend: "codex" }), "Codex · 默认模型");
assert.equal(engineKey({ backend: "http", baseUrl: "https://api.x.com/v1?k=secret", model: "m" }).includes("secret"), false);
// Excerpts: a second opinion on p2–p3 from another engine joins those units only.
const withExcerpt = { ...chapter, segments: [
  { id: "seg-codex", createdAt: "2026-09-28T07:00:00Z", engine: { backend: "codex", model: "gpt" }, segments: [seg(["p2"], "C2"), seg(["p3"], "C3")] },
  { id: "seg-stale", segments: [seg(["gone"], "x")] },
  { id: "seg-gap", segments: [seg(["p1"], "x"), seg(["p3"], "y")] },
  { id: "seg-edited", alignedStale: true, segments: [seg(["p4"], "old")] }
] };
const partials = partialVersions(withExcerpt, ids);
assert.deepEqual(partials.map((v) => [v.id, v.label, v.partial]), [["seg-codex", "Codex · gpt · 节选", true]]);
const mixedUnits = compareUnits(ids, [...versions, ...partials]);
assert.deepEqual(mixedUnits.map((u) => u.key), ["p1", "p2 p3", "p4"], "excerpt boundaries do not split merged units");
assert.equal(mixedUnits[1].texts["seg-codex"], "C2\n\nC3"); assert.equal(mixedUnits[0].texts["seg-codex"], undefined);
const withPartial = composeRevision(ids, [...versions, ...partials], [{ ids: ["p1"], revisionId: "r-deep" }, { ids: ["p2", "p3"], revisionId: "seg-codex" }, { ids: ["p4"], revisionId: "r-deep" }]);
assert.deepEqual(withPartial.segments.map((s) => s.text), ["D1", "C2", "C3", "D4"]);
assert.equal(withPartial.segmentSources[1].engine.backend, "codex");
assert.throws(() => composeRevision(ids, [...versions, ...partials], [{ ids: ["p1"], revisionId: "seg-codex" }, { ids: ["p2", "p3"], revisionId: "r-deep" }, { ids: ["p4"], revisionId: "r-deep" }]), /分段不同/);
console.log("compare: versions, excerpts, units, compose, provenance and colours passed");
