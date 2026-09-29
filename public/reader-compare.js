// Version strip, row-aligned comparison sheet, single-paragraph comparison and composing — all inside the reader.
import { comparableVersions, partialVersions, compareUnits, sourceMarks, CUSTOM_COLOR } from "./compare-core.js";

const esc = (text = "") => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const BACKENDS = { http: "翻译 API", codex: "Codex", opencode: "OpenCode", antigravity: "Antigravity", claude: "Claude Code" };
const shortTime = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const profileSummary = (p) => [p.backend === "http" ? p.providerName || p.host : BACKENDS[p.backend] || p.backend, p.model || "默认模型", p.reasoningEffort].filter(Boolean).join(" · ");
const PENDING_TTL = 10 * 60 * 1000;

export function createCompare({ figure = () => null, room, strip, view, bar, read, book, request, notify, translate, configure, isEditing, onComposed, sourceLang }) {
  let chapter = null, versions = [], partials = [], units = [], profiles = [], profilesLoaded = false;
  let compareOn = false, viewingId = null, picks = {}, custom = {}, draftLoadedFor = null, draftTimer = null;
  let stripSig = "", viewSig = "", dialogUnitKey = null, toolParagraphId = null;
  const pending = new Map(); // `${unitKey}|${profileId}` -> started at

  const all = () => [...versions, ...partials];
  const ids = () => (chapter?.sourceParagraphs || []).map((p) => p.id);
  const sourceText = (id) => chapter?.sourceParagraphs?.find((p) => p.id === id)?.text || "";
  const numberOf = (id) => ids().indexOf(id) + 1;
  const unitRange = (unit) => { const a = numberOf(unit.ids[0]), b = numberOf(unit.ids.at(-1)); return a === b ? `第 ${a} 段` : `第 ${a}–${b} 段`; };
  const unitNumber = (unit) => { const a = numberOf(unit.ids[0]), b = numberOf(unit.ids.at(-1)); return a === b ? `${a}` : `${a}–${b}`; };
  const activeVersion = () => versions.find((v) => v.active) || null;
  // Unpicked places keep the current text when it can be compared, otherwise the newest whole-chapter version.
  const fallback = () => activeVersion() || versions.at(-1) || null;
  const byId = (id) => all().find((v) => v.id === id || v.memberIds.includes(id));
  const pickFor = (unit) => {
    if (picks[unit.key] === "custom" && custom[unit.key] !== undefined) return "custom";
    const v = byId(picks[unit.key]); return v && unit.texts[v.id] !== undefined ? v.id : null;
  };
  const pickedCount = () => units.filter((u) => pickFor(u)).length;
  const unitOf = (paragraphId) => units.find((u) => u.ids.includes(paragraphId));
  // Identical text from several versions: the rule shows every colour in turn.
  const stripe = (versions) => `linear-gradient(to bottom, ${versions.map((v, i) => `${v.color} ${(i * 100) / versions.length}% ${((i + 1) * 100) / versions.length}%`).join(", ")})`;
  const sourceLabel = (v) => `<span class="v-name" style="--v:${v.color}"><i aria-hidden="true"></i>${esc(v.name)}${v.tag ? `<small>${esc(v.tag)}</small>` : ""}</span>`;
  // Identical wording from several engines is shown once, with every engine that produced it.
  const variantGroups = (unit) => {
    const groups = [];
    for (const v of all()) {
      const text = unit.texts[v.id]; if (text === undefined) continue;
      const same = groups.find((g) => g.text === text);
      if (same) same.versions.push(v); else groups.push({ text, versions: [v] });
    }
    return groups;
  };

  async function loadProfiles() {
    try { profiles = (await request("/api/engine-profiles")).profiles || []; } catch { profiles = []; }
    profilesLoaded = true; stripSig = viewSig = ""; if (chapter) render();
  }
  loadProfiles();
  function saveDraftSoon() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => request(`/api/books/${book.id}/chapters/${chapter.id}/compose-draft`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ picks, custom }) }).catch(() => {}), 600);
  }
  function engineMenu(attr) {
    return `${profiles.map((p) => `<button role="menuitem" ${attr}="${esc(p.id)}" style="--v:${p.color}"><i aria-hidden="true"></i><span><strong>${esc(p.name)}</strong><small>${esc(profileSummary(p))}</small></span></button>`).join("")}
      <button role="menuitem" ${attr}=""><i aria-hidden="true" class="plain"></i><span><strong>当前启用的引擎</strong><small>设置页里正在使用的那一个</small></span></button>`;
  }
  function wireMenu(toggle, menu) {
    const close = () => { menu.hidden = true; toggle.setAttribute("aria-expanded", "false"); document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", key, true); };
    const outside = (e) => { if (!menu.contains(e.target) && e.target !== toggle) close(); };
    const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); toggle.focus(); } };
    toggle.onclick = () => { if (!menu.hidden) return close(); menu.hidden = false; toggle.setAttribute("aria-expanded", "true"); document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", key, true); menu.querySelector("button")?.focus(); };
    return close;
  }

  // ---- strip -------------------------------------------------------------------------------------------------
  function renderStrip() {
    const shownId = viewingId || activeVersion()?.id;
    const sig = JSON.stringify([versions.map((v) => [v.id, v.label, v.color, v.active]), shownId, compareOn, profiles.map((p) => [p.id, p.name, p.color]), isEditing()]);
    if (sig === stripSig) return; stripSig = sig;
    strip.hidden = isEditing() || (!versions.length && !profiles.length);
    const viewing = viewingId && byId(viewingId);
    const shown = !compareOn && (viewing || activeVersion());
    const legend = shown?.segmentSources ? [...sourceMarks(shown.segmentSources, profiles).values()].reduce((map, m) => map.set(m.name, { ...m, n: (map.get(m.name)?.n || 0) + 1 }), new Map()) : null;
    strip.innerHTML = `<div class="version-row">
        <span class="version-strip-label">译本</span>
        <div class="version-chips" role="group" aria-label="本章译本">${versions.map((v) => `<button class="version-chip" style="--v:${v.color}" data-version="${esc(v.id)}" aria-pressed="${!compareOn && v.id === shownId}" title="${esc(v.label)}${v.createdAt ? ` · ${esc(shortTime(v.createdAt))}` : ""}"><i aria-hidden="true"></i><span>${esc(v.name)}</span>${v.tag ? `<small>${esc(v.tag)}</small>` : ""}${v.active ? "<em>当前</em>" : ""}</button>`).join("") || '<span class="version-empty">还没有带段落对齐的译本</span>'}</div>
        <button class="version-compare-toggle" aria-pressed="${compareOn}" ${versions.length < 2 ? 'disabled title="至少需要两个整章译本"' : ""}>逐段对照</button>
        <div class="version-add"><button class="version-add-button" aria-haspopup="true" aria-expanded="false">＋ 再译一版</button>
          <div class="version-menu" hidden role="menu">${engineMenu("data-retranslate")}
            <p class="version-menu-hint">${profiles.length ? "整章再译一版，新译本会加进上面的列表，不会覆盖你挑好的译稿。" : "在“设置 → 引擎档案”里把几个模型各存一份，这里就能一键换模型重译。"}</p>
            ${profiles.length ? "" : '<button data-open-settings>去设置引擎档案</button>'}</div></div>
      </div>
      ${viewing && !viewing.active && !compareOn ? `<div class="version-viewing" style="--v:${viewing.color}"><i aria-hidden="true"></i><span>正在查看 <b>${esc(viewing.label)}</b>，当前译稿没有改变</span><button data-adopt="${esc(viewing.id)}">采用这版</button><button data-back-current>回到当前</button></div>` : ""}
      ${legend && legend.size ? `<div class="version-legend"><span>这份合成稿出自：</span>${[...legend.values()].map((m) => `<span class="legend-item" style="--v:${m.color}"><i aria-hidden="true"></i>${esc(m.name)} ${m.n} 处</span>`).join("")}</div>` : ""}
      ${!compareOn && versions.length && !activeVersion() && chapter?.translation ? '<div class="version-note">当前译稿是手动编辑或旧版本，没有段落对齐，暂不参与对照；合成时未挑的地方会用最新译本。</div>' : ""}`;
    strip.querySelectorAll("[data-version]").forEach((b) => b.onclick = () => { const v = byId(b.dataset.version); compareOn = false; viewingId = v.active ? null : v.id; changed(); });
    strip.querySelector(".version-compare-toggle").onclick = () => { compareOn = !compareOn; viewingId = null; hideTool(); changed(); };
    const menu = strip.querySelector(".version-menu"); const close = wireMenu(strip.querySelector(".version-add-button"), menu);
    menu.querySelectorAll("[data-retranslate]").forEach((b) => b.onclick = async () => { close(); await translate(b.dataset.retranslate || undefined, { type: "whole" }); });
    menu.querySelector("[data-open-settings]")?.addEventListener("click", () => { close(); configure(); });
    strip.querySelector("[data-adopt]")?.addEventListener("click", async (e) => {
      if (!confirm("采用这个译本作为当前译稿？现在的译稿仍保留在版本历史里。")) return;
      try { await request(`/api/books/${book.id}/chapters/${chapter.id}/revisions/${e.target.dataset.adopt}/restore`, { method: "POST" }); viewingId = null; notify("已采用所选译本"); onComposed(); } catch (err) { notify(err.message); }
    });
    strip.querySelector("[data-back-current]")?.addEventListener("click", () => { viewingId = null; changed(); });
  }

  // ---- row-aligned comparison sheet: original on the left, every version of that passage on the right ----------
  function renderView() {
    if (!compareOn) { view.hidden = true; read.hidden = false; viewSig = ""; return; }
    view.hidden = false; read.hidden = true;
    const sig = JSON.stringify([all().map((v) => [v.id, v.color, v.label]), units.map((u) => [u.key, Object.keys(u.texts).length, u.ids.some((id) => figure(id))])]);
    if (sig !== viewSig && !view.contains(document.activeElement?.closest?.("textarea"))) {
      viewSig = sig;
      view.innerHTML = units.map((unit) => {
        const groups = variantGroups(unit);
        return `<section class="compare-row" data-ids="${esc(unit.key)}" data-unit="${esc(unit.key)}">
          <div class="compare-original" lang="${esc(sourceLang)}"><span class="compare-no" aria-label="${esc(unitRange(unit))}">${unitNumber(unit)}</span>${unit.ids.map((id) => { const art = figure(id); return art ? `<p class="compare-figure"><img class="reader-figure" src="${esc(art.url)}" alt="${esc(art.alt || "插图")}" loading="lazy"/></p>` : `<p>${esc(sourceText(id))}</p>`; }).join("")}
            <div class="compare-tools" lang="zh-CN"><button class="compare-link" data-toggle-custom>✎ 改写</button><button class="compare-link" data-open-paragraph>⇄ 现译这一段</button><span class="compare-state"></span></div></div>
          <div class="compare-variants" role="radiogroup" aria-label="${esc(unitRange(unit))}的译本">
            ${groups.map((g) => { const names = g.versions.map((v) => v.label).join("、"); return `<div class="compare-variant${g.versions.length > 1 ? " is-shared" : ""}" role="radio" tabindex="0" aria-checked="false" title="${esc(names)}${g.versions.length > 1 ? " · 译文相同" : ""}" aria-label="${esc(names)}" style="--v:${g.versions[0].color};${g.versions.length > 1 ? `--stripe:${stripe(g.versions)}` : ""}" data-pick="${esc(g.versions[0].id)}" data-group="${esc(g.versions.map((v) => v.id).join(" "))}">
              <p>${esc(g.text) || '<span class="compare-missing">（此处无译文）</span>'}</p></div>`; }).join("")}
            <div class="compare-custom" style="--v:${CUSTOM_COLOR}" hidden><textarea aria-label="改写${esc(unitRange(unit))}">${esc(custom[unit.key] ?? "")}</textarea><div class="compare-custom-actions"><button data-use-custom>用我的改写</button><button data-close-custom>收起</button></div></div>
          </div>
        </section>`;
      }).join("");
      view.querySelectorAll(".compare-row").forEach((row) => {
        const key = row.dataset.unit; const unit = units.find((u) => u.key === key);
        const choose = (id) => { if (picks[key] === id) delete picks[key]; else picks[key] = id; paint(); saveDraftSoon(); };
        row.querySelectorAll(".compare-variant").forEach((node) => {
          // Clicking selects; selecting text to copy does not.
          node.onclick = (e) => { if (getSelection().isCollapsed) { e.stopPropagation(); choose(node.dataset.pick); } };
          node.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(node.dataset.pick); } };
        });
        const box = row.querySelector(".compare-custom"), area = box.querySelector("textarea");
        row.querySelector("[data-toggle-custom]").onclick = () => { box.hidden = !box.hidden; if (!box.hidden) { if (!area.value) { const c = byId(pickFor(unit)) || fallback(); area.value = c ? unit.texts[c.id] ?? "" : ""; } area.focus(); } };
        row.querySelector("[data-close-custom]").onclick = () => { box.hidden = true; };
        area.oninput = () => { custom[key] = area.value; saveDraftSoon(); };
        row.querySelector("[data-use-custom]").onclick = () => { if (!area.value.trim()) return notify("改写内容不能为空"); custom[key] = area.value; picks[key] = "custom"; paint(); saveDraftSoon(); };
        row.querySelector("[data-open-paragraph]").onclick = () => openDialog(unit.ids[0]);
      });
    }
    paint();
  }
  // Selection is repainted in place so typing and scrolling are never disturbed.
  function paint() {
    const def = fallback();
    view.querySelectorAll(".compare-row").forEach((row) => {
      const unit = units.find((u) => u.key === row.dataset.unit); if (!unit) return;
      const pick = pickFor(unit); const effective = pick || def?.id;
      row.classList.toggle("is-picked", Boolean(pick)); row.classList.toggle("is-custom", pick === "custom");
      row.querySelectorAll(".compare-variant").forEach((node) => {
        const on = pick !== "custom" && node.dataset.group.split(" ").includes(effective);
        node.classList.toggle("is-chosen", on); node.classList.toggle("is-default", on && !pick);
        node.setAttribute("aria-checked", String(on));
      });
      const box = row.querySelector(".compare-custom"); box.classList.toggle("is-chosen", pick === "custom"); if (pick === "custom") box.hidden = false;
      row.querySelector(".compare-state").innerHTML = pick === "custom" ? `<i style="--v:${CUSTOM_COLOR}" aria-hidden="true"></i>用我的改写` : "";
    });
    renderBar();
  }
  function renderBar() {
    bar.hidden = !compareOn || isEditing();
    if (bar.hidden) return;
    const def = fallback(); const n = pickedCount();
    bar.innerHTML = `<div class="compose-summary"><strong>已挑 ${n} / ${units.length} 处</strong><span>${def ? `点一下译文即可选中；未挑的地方沿用 <i style="--v:${def.color}" aria-hidden="true"></i>${esc(def.label)}` : ""}</span></div>
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

  // ---- one paragraph: a quiet entry point beside the clicked paragraph, and a focused dialog --------------------
  const tool = document.createElement("button");
  tool.className = "paragraph-compare-button"; tool.type = "button"; tool.hidden = true; tool.textContent = "⇄ 对照这一段";
  read.parentElement.append(tool);
  tool.onclick = (e) => { e.stopPropagation(); if (toolParagraphId) openDialog(toolParagraphId); };
  function hideTool() { tool.hidden = true; toolParagraphId = null; }
  function placeTool() {
    if (!toolParagraphId || compareOn || isEditing() || read.hidden) { tool.hidden = true; return; }
    const node = [...read.children].find((p) => (p.dataset.ids || "").split(" ").includes(toolParagraphId));
    if (!node) { tool.hidden = true; return; }
    tool.hidden = false; tool.style.top = `${Math.max(0, node.offsetTop - 34)}px`;
  }
  const dialog = document.createElement("dialog");
  dialog.className = "paragraph-compare"; dialog.setAttribute("aria-labelledby", "paragraph-compare-title");
  room.append(dialog);
  dialog.addEventListener("close", () => { dialogUnitKey = null; });
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
  function openDialog(paragraphId) {
    const unit = unitOf(paragraphId);
    if (!unit) return notify(versions.length || partials.length ? "这一段暂时无法对照" : "还没有带段落对齐的译本；可以先整章翻译一次");
    dialogUnitKey = unit.key; renderDialog(true); if (!dialog.open) dialog.showModal();
  }
  function renderDialog(force = false) {
    const unit = units.find((u) => u.key === dialogUnitKey); if (!unit) { if (dialog.open) dialog.close(); return; }
    const area = dialog.querySelector(".pc-custom textarea"); const draft = area ? area.value : undefined;
    // Never rebuild under the reader's cursor or an open menu.
    if (!force && (dialog.querySelector(".pc-menu:not([hidden])") || (dialog.contains(document.activeElement) && document.activeElement.tagName === "TEXTAREA"))) return;
    const sig = JSON.stringify([unit.key, unit.texts, [...pending.keys()], activeVersion()?.id]);
    if (!force && sig === dialog.dataset.sig) return; dialog.dataset.sig = sig;
    const base = activeVersion(); const groups = variantGroups(unit);
    for (const [k, at] of pending) if (Date.now() - at > PENDING_TTL) pending.delete(k);
    const waiting = [...pending.keys()].filter((k) => k.startsWith(`${unit.key}|`)).map((k) => k.split("|")[1]);
    dialog.innerHTML = `<div class="dialog-head"><div><p class="eyebrow">单段对照</p><h2 id="paragraph-compare-title">${esc(unitRange(unit))}</h2></div><button data-close aria-label="关闭">×</button></div>
      <blockquote class="pc-original" lang="${esc(sourceLang)}">${unit.ids.map((id) => `<p>${esc(sourceText(id))}</p>`).join("")}</blockquote>
      <div class="pc-list">${groups.map((g) => {
        const current = base && g.versions.some((v) => v.id === base.id);
        return `<div class="pc-variant${current ? " is-current" : ""}" style="--v:${g.versions[0].color}"><div class="compare-sources">${g.versions.map(sourceLabel).join("")}${current ? '<span class="pc-current">当前译文</span>' : ""}</div><p>${esc(g.text)}</p>
          ${current ? "" : `<button class="pc-use" data-use="${esc(g.versions[0].id)}" ${base ? "" : "disabled"}>用这版替换</button>`}</div>`;
      }).join("")}
      ${waiting.map((pid) => { const p = profiles.find((x) => x.id === pid); return `<div class="pc-variant is-waiting" style="--v:${p?.color || "#8a8f98"}"><div class="compare-sources"><span class="v-name"><i aria-hidden="true"></i>${esc(p?.name || "当前启用的引擎")}</span></div><p class="pc-wait">正在翻译这一段，完成后会出现在这里…</p></div>`; }).join("")}</div>
      ${base ? "" : '<p class="pc-note">当前译稿没有段落对齐，暂时不能单段替换；可以先在“逐段对照”里合成一次。</p>'}
      <div class="pc-actions">
        <div class="version-add"><button class="pc-live" aria-haspopup="true" aria-expanded="false">⇄ 用别的模型现译这一段</button><div class="version-menu pc-menu" hidden role="menu">${engineMenu("data-live")}<p class="version-menu-hint">只翻这一段，结果单独存为节选，不影响整章译文。</p></div></div>
        <button class="pc-custom-toggle">✎ 自己改写</button>
      </div>
      <div class="pc-custom" hidden><textarea aria-label="改写这一段">${esc(draft ?? custom[unit.key] ?? (base ? unit.texts[base.id] : "") ?? "")}</textarea><button class="primary" data-use-custom ${base ? "" : "disabled"}>用我的改写替换</button></div>`;
    dialog.querySelector("[data-close]").onclick = () => dialog.close();
    dialog.querySelectorAll("[data-use]").forEach((b) => b.onclick = () => replaceUnit(unit, { revisionId: b.dataset.use }, byId(b.dataset.use)?.label));
    const menu = dialog.querySelector(".pc-menu"); const close = wireMenu(dialog.querySelector(".pc-live"), menu);
    menu.querySelectorAll("[data-live]").forEach((b) => b.onclick = async () => {
      close(); const pid = b.dataset.live;
      const range = { type: "paragraphs", start: numberOf(unit.ids[0]), end: numberOf(unit.ids.at(-1)) };
      pending.set(`${unit.key}|${pid}`, Date.now()); renderDialog(true);
      await translate(pid || undefined, range);
    });
    const box = dialog.querySelector(".pc-custom");
    dialog.querySelector(".pc-custom-toggle").onclick = () => { box.hidden = !box.hidden; if (!box.hidden) box.querySelector("textarea").focus(); };
    if (draft !== undefined && draft !== (custom[unit.key] ?? (base ? unit.texts[base.id] : ""))) box.hidden = false;
    box.querySelector("[data-use-custom]").onclick = () => { const text = box.querySelector("textarea").value; if (!text.trim()) return notify("改写内容不能为空"); replaceUnit(unit, { text }, "我的改写"); };
  }
  async function replaceUnit(unit, choice, label) {
    const base = activeVersion(); if (!base) return;
    const choices = units.map((u) => u.key === unit.key ? { ids: u.ids, ...choice } : { ids: u.ids, revisionId: base.id });
    try {
      await request(`/api/books/${book.id}/chapters/${chapter.id}/compose`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ choices, note: `${unitRange(unit)} → ${label}` }) });
      dialog.close(); notify(`${unitRange(unit)}已换成「${label}」，原来的译稿保留在版本历史里`); onComposed();
    } catch (e) { notify(e.message); }
  }

  function changed() { stripSig = ""; render(); onViewChange?.(); }
  let onViewChange = null;
  function render() { if (!chapter) return; room.dataset.compare = compareOn ? "on" : "off"; renderStrip(); renderView(); if (!compareOn) bar.hidden = true; if (dialog.open) renderDialog(); }

  return {
    // Called on every reader update. Returns the segments to show when a non-current version is being viewed.
    sync(next) {
      chapter = next;
      if (!profilesLoaded) return null;
      const paragraphIds = ids();
      versions = paragraphIds.length ? comparableVersions(next, paragraphIds, profiles) : [];
      partials = paragraphIds.length ? partialVersions(next, paragraphIds, profiles) : [];
      units = versions.length || partials.length ? compareUnits(paragraphIds, all()) : [];
      // A finished excerpt clears its "translating" placeholder.
      for (const [key, since] of [...pending]) {
        const [unitKey, pid] = key.split("|"); const unit = units.find((u) => u.key === unitKey);
        if (partials.some((v) => (v.engine?.profileId || "") === pid && Date.parse(v.createdAt || 0) >= since - 2000 && unit?.texts[v.id] !== undefined)) pending.delete(key);
      }
      // Restore saved picks once per chapter; later polls echo our own saves and must never overwrite newer local picks.
      if (draftLoadedFor !== next.id) { picks = { ...(next.composeDraft?.picks || {}) }; custom = { ...(next.composeDraft?.custom || {}) }; draftLoadedFor = next.id; }
      if (viewingId && !byId(viewingId)) viewingId = null;
      if (compareOn && versions.length < 2) compareOn = false;
      render();
      const viewing = viewingId && byId(viewingId);
      return viewing && !viewing.active ? viewing.segments : null;
    },
    // Composed texts show where each paragraph came from with a small coloured mark.
    decorate() {
      const viewing = viewingId && byId(viewingId);
      const marks = sourceMarks((viewing || activeVersion())?.segmentSources, profiles);
      read.classList.toggle("is-viewing-other", Boolean(viewing && !viewing.active));
      read.style.setProperty("--v", viewing ? viewing.color : "transparent");
      for (const p of read.children) {
        const mark = marks.get(p.dataset.key);
        p.classList.toggle("has-source", Boolean(mark));
        if (mark) { p.style.setProperty("--src", mark.color); p.dataset.sourceName = mark.name; p.title = `出自 ${mark.name}`; }
        else if (p.dataset.sourceName) { p.style.removeProperty("--src"); delete p.dataset.sourceName; p.removeAttribute("title"); }
      }
      placeTool();
    },
    // The reader reports paragraph clicks; the entry point appears beside the translated counterpart.
    paragraphClicked(paragraphId) { toolParagraphId = paragraphId; placeTool(); },
    reset() { viewingId = null; compareOn = false; hideTool(); if (dialog.open) dialog.close(); changed(); },
    set onViewChange(fn) { onViewChange = fn; },
    isComparing: () => compareOn
  };
}
