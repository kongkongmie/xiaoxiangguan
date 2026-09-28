// Version strip, paragraph-by-paragraph comparison and composing, mounted inside the reader's translation page.
import { comparableVersions, compareUnits, sourceMarks, CUSTOM_COLOR } from "./compare-core.js";

const esc = (text = "") => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const BACKENDS = { http: "翻译 API", codex: "Codex", opencode: "OpenCode", antigravity: "Antigravity", claude: "Claude Code" };
const shortTime = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const profileSummary = (p) => [p.backend === "http" ? p.providerName || p.host : BACKENDS[p.backend] || p.backend, p.model || "默认模型", p.reasoningEffort].filter(Boolean).join(" · ");

export function createCompare({ room, strip, view, bar, read, book, request, notify, retranslate, configure, isEditing, onComposed }) {
  let chapter = null, versions = [], units = [], profiles = [], profilesLoaded = false;
  let compareOn = false, viewingId = null, picks = {}, custom = {}, draftLoadedFor = null, draftTimer = null;
  let stripSig = "", viewSig = "";

  const ids = () => (chapter?.sourceParagraphs || []).map((p) => p.id);
  const activeVersion = () => versions.find((v) => v.active) || null;
  // Unpicked places keep the current text when it can be compared, otherwise the newest version.
  const fallback = () => activeVersion() || versions.at(-1) || null;
  const byId = (id) => versions.find((v) => v.id === id || v.memberIds.includes(id));
  const pickFor = (unit) => custom[unit.key] !== undefined && picks[unit.key] === "custom" ? "custom" : byId(picks[unit.key]) ? byId(picks[unit.key]).id : null;
  const pickedCount = () => units.filter((u) => pickFor(u)).length;

  async function loadProfiles() {
    try { profiles = (await request("/api/engine-profiles")).profiles || []; } catch { profiles = []; }
    profilesLoaded = true; stripSig = viewSig = ""; if (chapter) render();
  }
  loadProfiles();

  function saveDraftSoon() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      request(`/api/books/${book.id}/chapters/${chapter.id}/compose-draft`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ picks, custom }) }).catch(() => {});
    }, 600);
  }

  // ---- strip -------------------------------------------------------------------------------------------------
  function renderStrip() {
    const shownId = viewingId || activeVersion()?.id;
    const sig = JSON.stringify([versions.map((v) => [v.id, v.label, v.color, v.active]), shownId, compareOn, profiles.map((p) => [p.id, p.name, p.color]), isEditing()]);
    if (sig === stripSig) return; stripSig = sig;
    strip.hidden = isEditing() || (!versions.length && !profiles.length);
    const viewing = viewingId && byId(viewingId);
    const mixed = !compareOn && (viewing || activeVersion());
    const legend = mixed?.segmentSources ? [...sourceMarks(mixed.segmentSources, profiles).values()].reduce((map, m) => map.set(m.name, { ...m, n: (map.get(m.name)?.n || 0) + 1 }), new Map()) : null;
    strip.innerHTML = `<div class="version-row">
        <span class="version-strip-label">译本</span>
        <div class="version-chips" role="group" aria-label="本章译本">${versions.map((v) => `<button class="version-chip" style="--v:${v.color}" data-version="${esc(v.id)}" aria-pressed="${!compareOn && v.id === shownId}" title="${esc(v.label)}${v.createdAt ? ` · ${esc(shortTime(v.createdAt))}` : ""}"><i aria-hidden="true"></i><span>${esc(v.name)}</span>${v.tag ? `<small>${esc(v.tag)}</small>` : ""}${v.active ? '<em>当前</em>' : ""}</button>`).join("") || '<span class="version-empty">还没有带段落对齐的译本</span>'}</div>
        <button class="version-compare-toggle" aria-pressed="${compareOn}" ${versions.length < 2 ? 'disabled title="至少需要两个译本"' : ""}>逐段对照</button>
        <div class="version-add"><button class="version-add-button" aria-haspopup="true" aria-expanded="false">＋ 再译一版</button>
          <div class="version-menu" hidden role="menu">${profiles.length ? profiles.map((p) => `<button role="menuitem" data-retranslate="${esc(p.id)}" style="--v:${p.color}"><i aria-hidden="true"></i><span><strong>${esc(p.name)}</strong><small>${esc(profileSummary(p))}</small></span></button>`).join("") : ""}
            <button role="menuitem" data-retranslate=""><i aria-hidden="true" class="plain"></i><span><strong>当前启用的引擎</strong><small>设置页里正在使用的那一个</small></span></button>
            <p class="version-menu-hint">${profiles.length ? "新译本会加进上面的译本列表，不会覆盖你挑好的译稿。" : "在“设置 → 引擎档案”里把几个模型各存一份，这里就能一键换模型重译。"}</p>
            ${profiles.length ? "" : '<button data-open-settings>去设置引擎档案</button>'}</div></div>
      </div>
      ${viewing && !viewing.active && !compareOn ? `<div class="version-viewing" style="--v:${viewing.color}"><i aria-hidden="true"></i><span>正在查看 <b>${esc(viewing.label)}</b>，当前译稿没有改变</span><button data-adopt="${esc(viewing.id)}">采用这版</button><button data-back-current>回到当前</button></div>` : ""}
      ${legend && legend.size ? `<div class="version-legend"><span>这份合成稿出自：</span>${[...legend.values()].map((m) => `<span class="legend-item" style="--v:${m.color}"><i aria-hidden="true"></i>${esc(m.name)} ${m.n} 处</span>`).join("")}</div>` : ""}
      ${!compareOn && versions.length && !activeVersion() && chapter?.translation ? '<div class="version-note">当前译稿是手动编辑或旧版本，没有段落对齐，暂不参与对照；合成时未挑的地方会用最新译本。</div>' : ""}`;
    strip.querySelectorAll("[data-version]").forEach((b) => b.onclick = () => {
      const v = byId(b.dataset.version); compareOn = false;
      viewingId = v.active ? null : v.id; changed();
    });
    strip.querySelector(".version-compare-toggle").onclick = () => { compareOn = !compareOn; viewingId = null; changed(); };
    const addButton = strip.querySelector(".version-add-button"), menu = strip.querySelector(".version-menu");
    const closeMenu = () => { menu.hidden = true; addButton.setAttribute("aria-expanded", "false"); document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape, true); };
    const outside = (e) => { if (!menu.parentElement.contains(e.target)) closeMenu(); };
    const escape = (e) => { if (e.key === "Escape") { closeMenu(); addButton.focus(); } };
    addButton.onclick = () => { if (!menu.hidden) return closeMenu(); menu.hidden = false; addButton.setAttribute("aria-expanded", "true"); document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", escape, true); menu.querySelector("button")?.focus(); };
    menu.querySelectorAll("[data-retranslate]").forEach((b) => b.onclick = async () => { closeMenu(); await retranslate(b.dataset.retranslate || undefined); });
    menu.querySelector("[data-open-settings]")?.addEventListener("click", () => { closeMenu(); configure(); });
    strip.querySelector("[data-adopt]")?.addEventListener("click", async (e) => {
      if (!confirm("采用这个译本作为当前译稿？现在的译稿仍保留在版本历史里。")) return;
      try { await request(`/api/books/${book.id}/chapters/${chapter.id}/revisions/${e.target.dataset.adopt}/restore`, { method: "POST" }); viewingId = null; notify("已采用所选译本"); onComposed(); } catch (err) { notify(err.message); }
    });
    strip.querySelector("[data-back-current]")?.addEventListener("click", () => { viewingId = null; changed(); });
  }

  // ---- comparison --------------------------------------------------------------------------------------------
  function variantGroups(unit) {
    // Identical wording from several engines is shown once, with every engine that produced it.
    const groups = [];
    for (const v of versions) {
      const text = unit.texts[v.id] ?? "";
      const same = groups.find((g) => g.text === text);
      if (same) same.versions.push(v); else groups.push({ text, versions: [v] });
    }
    return groups;
  }
  function renderView() {
    const sig = JSON.stringify([compareOn, versions.map((v) => [v.id, v.color, v.label]), units.map((u) => u.key)]);
    if (!compareOn) { view.hidden = true; read.hidden = false; viewSig = ""; return; }
    view.hidden = false; read.hidden = true;
    if (sig !== viewSig && !view.contains(document.activeElement?.closest?.("textarea"))) {
      viewSig = sig;
      const numbers = new Map(ids().map((id, i) => [id, i + 1]));
      view.innerHTML = units.map((unit) => {
        const first = numbers.get(unit.ids[0]), last = numbers.get(unit.ids.at(-1));
        const groups = variantGroups(unit);
        return `<section class="compare-unit" data-ids="${esc(unit.key)}" data-unit="${esc(unit.key)}" tabindex="0">
          <header class="compare-unit-head"><span class="compare-no">${first === last ? `第 ${first} 段` : `第 ${first}–${last} 段`}</span>${groups.length === 1 && versions.length > 1 ? '<span class="compare-agree">各译本一致</span>' : ""}<span class="compare-state"></span></header>
          ${groups.map((g) => `<article class="compare-variant" style="--v:${g.versions[0].color}" data-group="${esc(g.versions.map((v) => v.id).join(" "))}">
            <div class="compare-variant-head"><span class="compare-sources">${g.versions.map((v) => `<span class="compare-source" style="--v:${v.color}"><i aria-hidden="true"></i>${esc(v.name)}${v.tag ? `<small>${esc(v.tag)}</small>` : ""}</span>`).join("")}</span><button class="compare-pick" data-pick="${esc(g.versions[0].id)}" aria-pressed="false">选这版</button></div>
            <p>${esc(g.text) || '<span class="compare-missing">（此处无译文）</span>'}</p></article>`).join("")}
          <details class="compare-custom" style="--v:${CUSTOM_COLOR}"><summary>自己改写这一处</summary><textarea aria-label="改写第 ${first} 段">${esc(custom[unit.key] ?? "")}</textarea><div class="compare-custom-actions"><button data-use-custom>用我的改写</button><small>改写的文字会作为这一处的定稿。</small></div></details>
        </section>`;
      }).join("");
      view.querySelectorAll(".compare-unit").forEach((node) => {
        const key = node.dataset.unit; const unit = units.find((u) => u.key === key);
        node.querySelectorAll("[data-pick]").forEach((b) => b.onclick = (e) => { e.stopPropagation(); const already = picks[key] === b.dataset.pick; if (already) delete picks[key]; else picks[key] = b.dataset.pick; paint(); saveDraftSoon(); });
        const area = node.querySelector("textarea"); const details = node.querySelector("details");
        details.addEventListener("toggle", () => { if (details.open && !area.value) { const chosen = byId(pickFor(unit)) || fallback(); area.value = chosen ? unit.texts[chosen.id] : ""; } });
        area.oninput = () => { custom[key] = area.value; if (picks[key] === "custom") { paint(); } saveDraftSoon(); };
        node.querySelector("[data-use-custom]").onclick = () => { if (!area.value.trim()) return notify("改写内容不能为空"); custom[key] = area.value; picks[key] = "custom"; paint(); saveDraftSoon(); };
      });
    }
    paint();
  }
  // Selection state is repainted in place so typing and scrolling are never disturbed.
  function paint() {
    const def = fallback();
    view.querySelectorAll(".compare-unit").forEach((node) => {
      const unit = units.find((u) => u.key === node.dataset.unit); if (!unit) return;
      const pick = pickFor(unit); const effective = pick || def?.id;
      node.classList.toggle("is-picked", Boolean(pick)); node.classList.toggle("is-custom", pick === "custom");
      node.querySelectorAll(".compare-variant").forEach((a) => {
        const members = a.dataset.group.split(" "); const on = pick !== "custom" && members.includes(effective);
        a.classList.toggle("is-chosen", on); a.classList.toggle("is-default", on && !pick);
        const b = a.querySelector("[data-pick]"); b.setAttribute("aria-pressed", String(Boolean(pick) && on)); b.textContent = pick && on ? "✓ 已选" : on ? "默认" : "选这版";
      });
      const state = node.querySelector(".compare-state");
      const chosen = pick === "custom" ? { name: "我的改写", color: CUSTOM_COLOR } : byId(effective);
      state.innerHTML = chosen ? `<i style="--v:${chosen.color}" aria-hidden="true"></i>${pick ? "" : "未挑 · "}${esc(pick === "custom" ? "我的改写" : chosen.label)}` : "";
      node.querySelector(".compare-custom").classList.toggle("is-chosen", pick === "custom");
      node.querySelector(".compare-custom summary").textContent = pick === "custom" ? "已用我的改写（点开可继续修改）" : "自己改写这一处";
    });
    renderBar();
  }
  function renderBar() {
    bar.hidden = !compareOn || isEditing();
    if (bar.hidden) return;
    const def = fallback(); const n = pickedCount();
    bar.innerHTML = `<div class="compose-summary"><strong>已挑 ${n} / ${units.length} 处</strong><span>${def ? `未挑的地方沿用 <i style="--v:${def.color}" aria-hidden="true"></i>${esc(def.label)}` : ""}</span></div>
      <div class="compose-actions"><button data-clear ${n ? "" : "disabled"}>清空选择</button><button class="primary" data-compose>合成为新译稿</button></div>`;
    bar.querySelector("[data-clear]").onclick = () => { if (!confirm("清空这一章的所有挑选？")) return; picks = {}; custom = {}; viewSig = ""; renderView(); saveDraftSoon(); };
    bar.querySelector("[data-compose]").onclick = compose;
  }
  async function compose() {
    const def = fallback(); if (!def) return;
    const choices = units.map((u) => pickFor(u) === "custom" ? { ids: u.ids, text: custom[u.key] } : { ids: u.ids, revisionId: pickFor(u) || def.id });
    if (!confirm(`用 ${pickedCount()} 处挑选合成新译稿？\n未挑的 ${units.length - pickedCount()} 处沿用「${def.label}」。\n新译稿会成为当前版本，其他译本都保留。`)) return;
    try {
      const result = await request(`/api/books/${book.id}/chapters/${chapter.id}/compose`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ choices }) });
      clearTimeout(draftTimer); picks = {}; custom = {}; compareOn = false; viewingId = null; draftLoadedFor = null;
      notify(`已合成新译稿：${result.summary}`); onComposed();
    } catch (e) { notify(e.message); }
  }

  function changed() { stripSig = ""; render(); room.dataset.compare = compareOn ? "on" : "off"; onViewChange?.(); }
  let onViewChange = null;
  function render() { if (!chapter) return; renderStrip(); renderView(); if (!compareOn) bar.hidden = true; }

  return {
    // Called on every reader update. Returns the segments to show when a non-current version is being viewed.
    sync(next) {
      chapter = next;
      if (!profilesLoaded) return null;
      const paragraphIds = ids();
      versions = paragraphIds.length ? comparableVersions(next, paragraphIds, profiles) : [];
      units = versions.length ? compareUnits(paragraphIds, versions) : [];
      // Restore saved picks once per chapter; later polls echo our own saves and must never overwrite newer local picks.
      if (draftLoadedFor !== next.id) { picks = { ...(next.composeDraft?.picks || {}) }; custom = { ...(next.composeDraft?.custom || {}) }; draftLoadedFor = next.id; }
      if (viewingId && !byId(viewingId)) viewingId = null;
      if (compareOn && versions.length < 2) compareOn = false;
      room.dataset.compare = compareOn ? "on" : "off";
      render();
      const viewing = viewingId && byId(viewingId);
      return viewing && !viewing.active ? viewing.segments : null;
    },
    // Composed texts show where each paragraph came from with a small coloured mark.
    decorate() {
      const viewing = viewingId && byId(viewingId);
      const shown = viewing || activeVersion();
      const marks = sourceMarks(shown?.segmentSources, profiles);
      read.classList.toggle("is-viewing-other", Boolean(viewing && !viewing.active));
      read.style.setProperty("--v", viewing ? viewing.color : "transparent");
      for (const p of read.children) {
        const mark = marks.get(p.dataset.key);
        p.classList.toggle("has-source", Boolean(mark));
        if (mark) { p.style.setProperty("--src", mark.color); p.dataset.sourceName = mark.name; p.title = `出自 ${mark.name}`; }
        else if (p.dataset.sourceName) { p.style.removeProperty("--src"); delete p.dataset.sourceName; p.removeAttribute("title"); }
      }
    },
    reset() { viewingId = null; compareOn = false; changed(); },
    refreshProfiles: loadProfiles,
    set onViewChange(fn) { onViewChange = fn; },
    isComparing: () => compareOn
  };
}
