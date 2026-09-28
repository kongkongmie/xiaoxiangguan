import { themeButton } from "./themes.js";
import { sourceLanguage } from "./languages.js";
import { statusIcon, statusBadge } from "./status-badge.js";
import { createCompare } from "./reader-compare.js";

export function readingState(bookId) {
  try { return JSON.parse(localStorage.getItem(`reader:${bookId}`) || "{}"); } catch { return {}; }
}
export function rememberReading(bookId, patch) {
  const value = { ...readingState(bookId), ...patch, openedAt: Date.now() };
  try { localStorage.setItem(`reader:${bookId}`, JSON.stringify(value)); } catch { /* private browsing */ }
  return value;
}
const escape = (text = "") => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function readerSourceParagraphs(chapter) {
  if (Array.isArray(chapter.sourceParagraphs) && chapter.sourceParagraphs.length) return chapter.sourceParagraphs;
  // Older running servers still return the original text. Read it without inventing alignment IDs.
  return String(chapter.source || "").split(/\n\s*\n/).map((text) => text.trim()).filter(Boolean).map((text) => ({ text }));
}

// A click reveals an off-screen counterpart, but leaves visible reading context in place.
export function paragraphRevealDelta(paragraph, viewport, inset = 16) {
  const height = viewport.bottom - viewport.top;
  if (height <= 0) return 0;
  const margin = Math.min(inset, height / 4), top = viewport.top + margin, bottom = viewport.bottom - margin;
  if (paragraph.bottom > top && paragraph.top < bottom) return 0;
  if (paragraph.top >= bottom && paragraph.bottom - paragraph.top <= bottom - top) return paragraph.bottom - bottom;
  return paragraph.top - top;
}

export function mountReader({ container, book, chapter, request, notify, navigate, back, configure, start, save, analyze, exportBook, onChapter, shutdown }) {
  let current = chapter, disposed = false, editing = false, approving = false, follow = false, syncLock = false, deferred = null;
  const prefs = { mode: "parallel", ratio: 50, fontSize: 18, sync: true, theme: "auto", ...readingState(book.id) };
  const narrow = matchMedia("(max-width: 760px)"); let mobileSide = "source";
  const sourceLang = sourceLanguage(book);
  const index = book.chapters.findIndex((c) => c.id === chapter.id);
  const paragraphs = chapter.sourceParagraphs || [];
  const visibleSource = readerSourceParagraphs(chapter);
  const legacyServer = !Array.isArray(chapter.sourceParagraphs);
  container.innerHTML = `<section class="reading-room" data-mode="${escape(prefs.mode)}" data-mobile-side="source" data-theme="${escape(prefs.theme)}">
    <header class="reading-toolbar">
      <button id="reader-back" aria-label="返回作品页">← 作品页</button>
      <button id="reader-toc" aria-haspopup="dialog" aria-controls="reader-catalog" aria-expanded="false">目录</button>
      <div class="reading-title" lang="${sourceLang}"><small>${escape(book.title)}</small><strong>${escape(chapter.title)}</strong></div>
      <button id="reader-previous" ${index < 1 ? "disabled" : ""} aria-label="上一章">上一章</button><button id="reader-next" ${index >= book.chapters.length - 1 ? "disabled" : ""} aria-label="下一章">下一章</button>
      <button id="reader-mode" class="desktop-control">只看译文</button><button id="reader-side" class="mobile-control">看译文</button>${themeButton()}<button id="reader-options">阅读设置</button><button id="reader-tools">注释与工具</button>
    </header>
    <div class="reading-progress"><span id="reader-progress" role="status" aria-live="polite"></span><span class="spacer"></span><button id="reader-follow" hidden>回到翻译位置</button><button id="reader-pause" hidden>暂停</button><button id="reader-cancel" hidden>取消</button><button id="reader-retry" hidden>从未完成块继续</button></div>
    <div class="parallel-pages">
      <section class="reading-page original-page" aria-label="原文"><div class="reading-page-head"><strong>原文</strong><small>${visibleSource.length} 段 · ${sourceLang}</small></div><div id="source-scroll" class="reading-scroll" lang="${sourceLang}" tabindex="0">${visibleSource.map((p, i) => `<p ${p.id ? `data-ids="${escape(p.id)}"` : ""} tabindex="0"><span class="paragraph-number" aria-hidden="true">${i + 1}</span>${escape(p.text)}</p>`).join("") || '<p>原文尚未提取，请返回目录整理章节。</p>'}</div></section>
      <div id="reader-divider" class="reader-divider desktop-control" role="separator" tabindex="0" aria-label="调整原译栏宽" aria-orientation="vertical" aria-valuemin="30" aria-valuemax="70" aria-valuenow="${prefs.ratio}"></div>
      <section class="reading-page translated-page" aria-label="中文译文"><div class="reading-page-head"><strong>中文译文</strong><div><button class="primary" id="translate-range">${chapter.translation ? "重新翻译" : "翻译本章"}</button><button id="edit-translation">${chapter.translation ? "编辑译文" : "手工写入译文"}</button><button id="approve">${statusIcon("approved")}<span id="approve-label">标记定稿</span></button><button id="cancel-edit" hidden>取消编辑</button><button id="save-draft" hidden>保存修改</button></div></div>
        <div id="version-strip" class="version-strip" hidden></div>
        <div id="translation-scroll" class="reading-scroll" lang="zh-CN" tabindex="0"><div id="alignment-notice" class="reading-notice"></div><div id="translation-read"></div><div id="compare-view" class="compare-view" hidden></div></div>
        <div id="compose-bar" class="compose-bar" hidden></div>
        <textarea id="translation" class="reading-editor" lang="zh-CN" aria-label="编辑中文译文" hidden>${escape(chapter.translation || "")}</textarea>
      </section>
    </div>
    <nav class="reader-chapter-nav mobile-control" aria-label="章节导航"><button id="mobile-previous" ${index < 1 ? "disabled" : ""}>← 上一章</button><span>${index + 1} / ${book.chapters.length}</span><button id="mobile-next" ${index >= book.chapters.length - 1 ? "disabled" : ""}>下一章 →</button></nav>
    <dialog id="reader-settings"><div class="dialog-head"><h2>阅读设置</h2><button data-close aria-label="关闭阅读设置">×</button></div><label>字号 <input id="reader-font" type="range" min="15" max="28" value="${prefs.fontSize}"/></label><label class="desktop-control">左侧栏宽 <input id="reader-ratio" type="range" min="30" max="70" value="${prefs.ratio}"/></label><label class="check-line"><input id="reader-sync" type="checkbox" ${prefs.sync ? "checked" : ""}/>按段落同步滚动</label><label>纸张<select id="reader-theme"><option value="auto">随工作台</option><option value="paper">纸白</option><option value="warm">暖纸</option><option value="night">夜读</option></select></label></dialog>
    <dialog id="reader-catalog" class="reader-catalog" aria-labelledby="reader-catalog-title">
      <div class="dialog-head"><div><h2 id="reader-catalog-title">章节目录</h2><p class="reader-catalog-book">${escape(book.title)}</p></div><button data-close aria-label="关闭章节目录">×</button></div>
      <nav class="reader-catalog-list" aria-label="本书章节">${book.chapters.map((c, i) => `<button class="reader-catalog-item" data-catalog-chapter="${escape(c.id)}" ${c.id === chapter.id ? 'aria-current="page"' : ""}><span class="reader-catalog-title"><small>${i + 1} / ${book.chapters.length}${c.id === chapter.id ? " · 正在阅读" : ""}</small><span>${escape(c.title)}</span></span><span class="reader-catalog-status">${statusBadge(c.id === chapter.id ? chapter.status : c.status)}</span></button>`).join("")}</nav>
    </dialog>
    <dialog id="reader-drawer"><div class="dialog-head"><h2>章节工具</h2><button data-close aria-label="关闭章节工具">×</button></div>
      <label>书内搜索<input id="reader-search" type="search" placeholder="查找原文或译文"/></label><div id="reader-search-results" aria-live="polite"></div>
      <details><summary>翻译段落或页码</summary><label>范围<select id="range-type"><option value="paragraphs">段落范围</option>${book.format === "PDF" ? '<option value="pages">PDF 页码</option>' : ""}</select></label><div class="form-grid"><label>起始<input id="range-start" type="number" min="1" value="1"/></label><label>结束<input id="range-end" type="number" min="1" value="1"/></label></div><button id="translate-selection">翻译此范围</button><p>节选单独保存，保留本章主译文。</p></details>
      <div class="reader-tool-actions"><button id="refine-translation" ${!chapter.translation ? "disabled" : ""}>精校本章</button><button id="analyze-chapter">分析注释</button><button id="reader-export" ${!chapter.translation ? "disabled" : ""}>导出本章</button><button id="reader-engine">选择翻译引擎</button></div>
      <details><summary>译名与注释</summary>${[...(book.glossary || []), ...(book.termCandidates || []), ...(book.characters || []), ...(book.characterCandidates || [])].filter((t) => chapter.source?.includes(t.japanese || t.japaneseName)).map((t) => `<p><strong>${escape(t.japanese || t.japaneseName)} → ${escape(t.chinese || t.chineseName)}</strong><br/>${escape(t.definition || t.note || t.identity || "尚无释义")}</p>`).join("") || '<p>本章暂无注释。</p>'}</details>
      <details><summary>版本历史</summary><div id="reader-revisions"></div></details><details><summary>章节信息与用量</summary><p>${escape(chapter.sourceLocator || "无来源位置")}</p><p id="reader-usage"></p><p id="reader-quality"></p></details><details><summary>节选译文</summary><div id="reader-segments"></div></details>
      <div class="reader-tool-actions"><button id="reader-shutdown">关闭后台</button><small>关闭网页后后台仍会继续运行。</small></div>
    </dialog>
  </section>`;
  const $ = (selector) => container.querySelector(selector);
  const room = $(".reading-room"), sourcePane = $("#source-scroll"), translatedPane = $("#translation-scroll"), read = $("#translation-read"), editor = $("#translation");
  const compare = createCompare({ room, strip: $("#version-strip"), view: $("#compare-view"), bar: $("#compose-bar"), read, book, request, notify, configure, isEditing: () => editing,
    retranslate: (profileId) => startTranslation("draft", { type: "whole" }, false, profileId),
    onComposed: async () => { try { update(await request(`/api/books/${book.id}/chapters/${chapter.id}`)); } catch (e) { notify(e.message); } } });
  compare.onViewChange = () => { const anchor = capture(translatedPane); update(current); if (anchor) locate(translatedPane, anchor); };
  const syncApproval = () => {
    $("#approve").hidden = editing;
    $("#approve").disabled = approving || !current.translation?.trim() || current.status === "approved";
    $("#approve").setAttribute("aria-busy", String(approving));
    $("#approve-label").textContent = approving ? "正在定稿…" : current.status === "approved" ? "已定稿" : "标记定稿";
  };
  let lastPane = prefs.anchor?.side === "translation" ? translatedPane : sourcePane;
  const remember = (patch) => { Object.assign(prefs, patch); rememberReading(book.id, { ...patch, chapterId: chapter.id }); };
  const applyPrefs = () => { room.dataset.mode = prefs.mode; room.dataset.mobileSide = mobileSide; room.dataset.theme = prefs.theme; room.style.setProperty("--reader-size", `${prefs.fontSize}px`); room.style.setProperty("--source-width", `${prefs.ratio}fr`); room.style.setProperty("--translation-width", `${100 - prefs.ratio}fr`); $("#reader-mode").textContent = prefs.mode === "parallel" ? "只看译文" : "原译对照"; $("#reader-side").textContent = mobileSide === "source" ? "看译文" : "看原文"; };
  const activePane = () => narrow.matches ? (mobileSide === "source" ? sourcePane : translatedPane) : prefs.mode === "translation" ? translatedPane : lastPane;
  const idsOf = (node) => (node?.dataset.ids || "").split(" ");
  // Comparison hides the normal paragraphs instead of removing them; only visible nodes are anchors.
  const visibleNodes = (pane) => [...pane.querySelectorAll("[data-ids]")].filter((node) => !node.closest("[hidden]"));
  const findNode = (pane, id) => visibleNodes(pane).find((node) => idsOf(node).includes(id));
  const highlightParagraph = (paragraphId) => {
    container.querySelectorAll(".paragraph-active").forEach((p) => p.classList.remove("paragraph-active"));
    for (const pane of [sourcePane, translatedPane]) findNode(pane, paragraphId)?.classList.add("paragraph-active");
  };
  const programmaticScrolls = new WeakMap();
  const scrollPaneBy = (pane, delta) => {
    if (Math.abs(delta) < 1) return;
    const previous = pane.scrollTop;
    pane.scrollTop += delta;
    // Programmatic movement must not bounce back or become the reader's saved position.
    if (pane.scrollTop !== previous) programmaticScrolls.set(pane, pane.scrollTop);
  };
  const revealCounterpart = (pane, paragraphId) => {
    const node = findNode(pane, paragraphId);
    if (!node || !pane.clientHeight || !pane.getClientRects().length) return;
    const delta = paragraphRevealDelta(node.getBoundingClientRect(), pane.getBoundingClientRect());
    scrollPaneBy(pane, delta);
  };
  const capture = (pane) => {
    const top = pane.getBoundingClientRect().top;
    const nodes = visibleNodes(pane);
    const node = nodes.find((p) => p.getBoundingClientRect().bottom > top + 8) || nodes.at(-1);
    if (!node) return null;
    const rect = node.getBoundingClientRect(); const ids = idsOf(node);
    const progress = Math.min(.9999, Math.max(0, (top - rect.top) / Math.max(1, rect.height))) * ids.length;
    return { paragraphId: ids[Math.floor(progress)], offset: progress % 1, side: pane === sourcePane ? "source" : "translation" };
  };
  const locate = (pane, anchor, highlight = false) => {
    if (!anchor) return;
    const node = findNode(pane, anchor.paragraphId); if (!node) return;
    const ids = idsOf(node); const fraction = (ids.indexOf(anchor.paragraphId) + (anchor.offset || 0)) / ids.length;
    scrollPaneBy(pane, node.getBoundingClientRect().top - pane.getBoundingClientRect().top + fraction * node.getBoundingClientRect().height);
    if (highlight) highlightParagraph(anchor.paragraphId);
  };
  let themeAnchors;
  const beforeThemeChange = () => { themeAnchors = [capture(sourcePane), capture(translatedPane)]; syncLock = true; };
  const afterThemeChange = () => requestAnimationFrame(() => {
    if (disposed) return;
    locate(sourcePane, themeAnchors?.[0]); locate(translatedPane, themeAnchors?.[1]);
    requestAnimationFrame(() => { syncLock = false; });
  });
  window.addEventListener("workbench-theme-beforechange", beforeThemeChange);
  window.addEventListener("workbench-themechange", afterThemeChange);
  const stopFollow = () => { follow = false; $("#reader-follow").hidden = !current.translationRun?.blocks?.some((b) => b.status === "completed"); };
  const jumpLatest = () => { const block = current.translationRun?.blocks?.filter((b) => b.status === "completed").at(-1); if (block) { const anchor = { paragraphId: block.sourceParagraphIds[0], offset: 0 }; locate(translatedPane, anchor, true); if (prefs.sync) locate(sourcePane, anchor); } };
  const saveAnchor = () => { const anchor = capture(activePane()); if (anchor) remember({ anchor }); };
  let anchorTimer, searchTimer;
  let revisionSignature, segmentSignature;
  const segmentDrafts = new Map();
  for (const pane of [sourcePane, translatedPane]) {
    const interact = () => { programmaticScrolls.delete(pane); stopFollow(); };
    pane.addEventListener("wheel", interact, { passive: true }); pane.addEventListener("touchstart", interact, { passive: true }); pane.addEventListener("pointerdown", interact);
    pane.addEventListener("keydown", (event) => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) interact(); if (event.key === "Enter" && event.target.dataset.ids) event.target.click(); });
    pane.addEventListener("scroll", () => {
      const programmaticPosition = programmaticScrolls.get(pane); programmaticScrolls.delete(pane);
      if (programmaticPosition !== undefined && Math.abs(pane.scrollTop - programmaticPosition) < 1) return;
      if (syncLock || disposed) return; lastPane = pane; const anchor = capture(pane);
      if (anchor) { clearTimeout(anchorTimer); anchorTimer = setTimeout(() => remember({ anchor }), 180); }
      if (prefs.sync && prefs.mode === "parallel" && !narrow.matches && current.alignmentStatus !== "legacy") { syncLock = true; locate(pane === sourcePane ? translatedPane : sourcePane, anchor); requestAnimationFrame(() => requestAnimationFrame(() => { syncLock = false; })); }
    }, { passive: true });
    pane.addEventListener("click", (event) => {
      const node = event.target.closest("[data-ids]"); if (!node || !getSelection().isCollapsed) return;
      stopFollow(); lastPane = pane;
      const paragraphId = idsOf(node)[0];
      highlightParagraph(paragraphId);
      revealCounterpart(pane === sourcePane ? translatedPane : sourcePane, paragraphId);
      clearTimeout(anchorTimer); saveAnchor();
    });
  }
  const selectionChanged = () => { if (!getSelection().isCollapsed && container.contains(getSelection().anchorNode)) stopFollow(); else if (deferred && !editing) { const next = deferred; deferred = null; update(next); } };
  document.addEventListener("selectionchange", selectionChanged);
  const openDialog = (id) => { stopFollow(); $(id).showModal(); };
  container.querySelectorAll("[data-close]").forEach((b) => b.onclick = () => b.closest("dialog").close());
  $("#reader-back").onclick = back;
  $("#reader-toc").onclick = () => {
    openDialog("#reader-catalog"); $("#reader-toc").setAttribute("aria-expanded", "true");
    const activeChapter = $("#reader-catalog [aria-current='page']");
    activeChapter?.scrollIntoView({ block: "center" }); activeChapter?.focus({ preventScroll: true });
  };
  $("#reader-catalog").addEventListener("close", () => $("#reader-toc").setAttribute("aria-expanded", "false"));
  $("#reader-catalog").addEventListener("click", (event) => {
    if (event.target !== $("#reader-catalog")) return;
    const bounds = event.target.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.target.close();
  });
  container.querySelectorAll("[data-catalog-chapter]").forEach((button) => button.onclick = () => {
    $("#reader-catalog").close();
    if (button.dataset.catalogChapter !== chapter.id) navigate(button.dataset.catalogChapter);
  });
  $("#reader-previous").onclick = () => navigate(book.chapters[index - 1].id);
  $("#reader-next").onclick = () => navigate(book.chapters[index + 1].id);
  $("#mobile-previous").onclick = $("#reader-previous").onclick; $("#mobile-next").onclick = $("#reader-next").onclick;
  $("#reader-mode").onclick = () => { const anchor = capture(activePane()); remember({ mode: prefs.mode === "parallel" ? "translation" : "parallel" }); applyPrefs(); locate(activePane(), anchor); };
  $("#reader-side").onclick = () => { const anchor = capture(activePane()); mobileSide = mobileSide === "source" ? "translation" : "source"; applyPrefs(); locate(activePane(), anchor); };
  $("#reader-options").onclick = () => openDialog("#reader-settings"); $("#reader-tools").onclick = () => openDialog("#reader-drawer");
  $("#reader-theme").value = prefs.theme;
  $("#reader-font").oninput = (e) => { const anchor = capture(activePane()); remember({ fontSize: Number(e.target.value) }); applyPrefs(); locate(activePane(), anchor); };
  const setRatio = (value) => {
    const anchors = [capture(sourcePane), capture(translatedPane)]; stopFollow();
    remember({ ratio: Math.max(30, Math.min(70, Math.round(value))) }); applyPrefs();
    $("#reader-ratio").value = prefs.ratio; $("#reader-divider").setAttribute("aria-valuenow", prefs.ratio);
    locate(sourcePane, anchors[0]); locate(translatedPane, anchors[1]);
  };
  $("#reader-ratio").oninput = (e) => setRatio(Number(e.target.value));
  const divider = $("#reader-divider"); let dragging = false;
  divider.onpointerdown = (event) => { dragging = true; divider.setPointerCapture(event.pointerId); event.preventDefault(); };
  divider.onpointermove = (event) => { if (!dragging) return; const bounds = $(".parallel-pages").getBoundingClientRect(); setRatio((event.clientX - bounds.left) / bounds.width * 100); };
  divider.onpointerup = divider.onlostpointercapture = () => { dragging = false; };
  divider.onkeydown = (event) => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); setRatio(event.key === "Home" ? 30 : event.key === "End" ? 70 : prefs.ratio + (event.key === "ArrowLeft" ? -2 : 2)); };
  $("#reader-theme").onchange = (e) => { remember({ theme: e.target.value }); applyPrefs(); };
  $("#reader-sync").onchange = (e) => remember({ sync: e.target.checked });
  const startTranslation = async (mode = "draft", range = { type: "whole" }, retry = false, profileId) => { if (legacyServer) return notify("请先重启工作台并刷新页面，以启用新版翻译功能"); if (editing) return notify("请先保存或取消编辑"); await start(mode, range, retry, profileId); follow = true; $("#reader-follow").hidden = true; };
  $("#translate-range").onclick = () => startTranslation();
  $("#refine-translation").onclick = () => { $("#reader-drawer").close(); startTranslation("refine"); };
  $("#translate-selection").onclick = () => { const range = { type: $("#range-type").value, start: Number($("#range-start").value), end: Number($("#range-end").value) }; $("#reader-drawer").close(); startTranslation("draft", range); };
  $("#reader-retry").onclick = () => startTranslation(current.translationRun.mode, current.translationRun.range, true);
  $("#reader-follow").onclick = () => { follow = true; jumpLatest(); $("#reader-follow").hidden = true; };
  $("#reader-engine").onclick = configure; $("#analyze-chapter").onclick = analyze; $("#reader-export").onclick = exportBook;
  $("#reader-shutdown").onclick = () => { $("#reader-drawer").close(); shutdown?.(); };
  const setEditing = (value) => { editing = value; if (value) compare.reset(); syncApproval(); stopFollow(); editor.hidden = !value; translatedPane.hidden = value; $("#edit-translation").hidden = value; $("#cancel-edit").hidden = !value; $("#save-draft").hidden = !value; if (value) { editor.value = current.translation || ""; mobileSide = "translation"; applyPrefs(); editor.focus(); } else if (deferred) { const next = deferred; deferred = null; update(next); } else update(current); };
  $("#edit-translation").onclick = () => setEditing(true);
  $("#cancel-edit").onclick = () => { if (editor.value !== (current.translation || "") && !confirm("放弃未保存的修改？")) return; setEditing(false); };
  $("#save-draft").onclick = async () => { if (await save(editor.value, "review")) { setEditing(false); } };
  $("#approve").onclick = async () => {
    if (editing || approving || !current.translation?.trim() || current.status === "approved") return;
    approving = true; syncApproval();
    try { await save(undefined, "approved"); } finally { approving = false; syncApproval(); }
  };
  $("#reader-search").oninput = () => { clearTimeout(searchTimer); const query = $("#reader-search").value.trim(); searchTimer = setTimeout(async () => { try { if (!query) { $("#reader-search-results").replaceChildren(); return; } const results = await request(`/api/books/${book.id}/search?q=${encodeURIComponent(query)}`); if (disposed || query !== $("#reader-search").value.trim()) return; $("#reader-search-results").innerHTML = results.map((r, i) => `<button data-search-result="${i}"><strong>${escape(r.title)}</strong><small>${escape(r.snippet)}</small></button>`).join("") || "未找到匹配内容"; container.querySelectorAll("[data-search-result]").forEach((b) => b.onclick = () => { const r = results[Number(b.dataset.searchResult)]; navigate(r.chapterId, { paragraphId: r.paragraphId, offset: 0 }); }); } catch (e) { notify(e.message); } }, 250); };
  const reconcile = (segments) => {
    const anchor = capture(translatedPane); const old = new Map([...read.children].map((p) => [p.dataset.key, p]));
    let previous = null, changed = false;
    for (const segment of segments) {
      const key = segment.sourceParagraphIds.join(" ") || "legacy"; let node = old.get(key);
      if (!node) { node = document.createElement("p"); node.dataset.key = key; node.tabIndex = 0; if (key !== "legacy") node.dataset.ids = key; }
      old.delete(key); if (node.textContent !== segment.text) { node.textContent = segment.text; changed = true; }
      if (node.classList.contains("paragraph-pending") !== Boolean(segment.pending)) changed = true;
      node.classList.toggle("paragraph-pending", Boolean(segment.pending));
      if (node.previousElementSibling !== previous || node.parentNode !== read) { read.insertBefore(node, previous ? previous.nextSibling : read.firstChild); changed = true; }
      previous = node;
    }
    if (old.size) changed = true;
    old.forEach((node) => node.remove()); if (changed && anchor) locate(translatedPane, anchor);
  };
  function update(next, task) {
    if (disposed) return;
    const run = next.translationRun; const active = task && ["queued", "running", "paused"].includes(task.status);
    $("#reader-progress").textContent = task ? `${task.status === "queued" ? "排队中" : task.status === "paused" ? "已暂停" : task.status === "running" ? "翻译中" : task.status === "failed" ? "未完成" : task.status === "cancelled" ? "已取消" : "已完成"} · ${task.detail || ""}` : next.translation ? "原处阅读 · 点击段落对照" : "原文已就绪 · 翻译后可在这里逐段阅读";
    $("#translate-range").disabled = Boolean(active);
    $("#reader-cancel").hidden = !active; $("#reader-pause").hidden = !active;
    $("#reader-pause").textContent = task?.status === "paused" ? "继续" : "暂停";
    $("#reader-pause").onclick = () => request(`/api/tasks/${task.id}/${task.status === "paused" ? "resume" : "pause"}`, { method: "POST" }).catch((e) => notify(e.message));
    $("#reader-cancel").onclick = () => request(`/api/tasks/${task.id}/cancel`, { method: "POST" }).catch((e) => notify(e.message));
    $("#reader-retry").hidden = active || !run || !["failed", "cancelled"].includes(run.status);
    if (editing || (!getSelection().isCollapsed && container.contains(getSelection().anchorNode))) { deferred = next; return; }
    current = next; onChapter(next); editor.value = next.translation || "";
    const catalogStatus = $("#reader-catalog [aria-current='page'] .reader-catalog-status");
    if (catalogStatus.dataset.status !== String(next.status)) { catalogStatus.innerHTML = statusBadge(next.status); catalogStatus.dataset.status = String(next.status); }
    $("#translate-range").textContent = next.translation ? "重新翻译" : "翻译本章";
    $("#edit-translation").textContent = next.translation ? "编辑译文" : "手工写入译文";
    const completed = (run?.blocks || []).filter((b) => b.status === "completed").flatMap((b) => b.segments);
    const preview = !next.translation && !run?.partial && completed.length;
    const mapped = preview ? completed : next.alignedSegments;
    const viewedVersion = compare.sync(next);
    if (viewedVersion) reconcile(viewedVersion);
    else if (mapped) {
      const covered = new Set(mapped.flatMap((s) => s.sourceParagraphIds)); const byId = new Map(mapped.map((s) => [s.sourceParagraphIds[0], s]));
      reconcile(paragraphs.flatMap((p, i) => byId.has(p.id) ? [byId.get(p.id)] : covered.has(p.id) ? [] : [{ sourceParagraphIds: [p.id], text: `第 ${i + 1} 段 · 等待译文`, pending: true }]));
    } else if (next.translation) reconcile([{ sourceParagraphIds: [], text: next.translation }]);
    else reconcile(paragraphs.map((p, i) => ({ sourceParagraphIds: [p.id], text: `第 ${i + 1} 段 · 等待译文`, pending: true })));
    compare.decorate();
    $("#alignment-notice").textContent = next.alignmentStatus === "legacy" ? "此版本保留章级对照，尚无可靠段落映射。重新初译可建立对齐，旧版会保留。" : next.translation && run && active ? "新译稿正在后台生成；当前版本保持可读。" : preview ? "已完成的段落已保存，余下内容继续翻译。" : "";
    $("#reader-usage").textContent = next.usage?.inputTokens == null ? "用量未知" : `输入 ${next.usage.inputTokens} / 输出 ${next.usage.outputTokens ?? "未知"} · ${next.lastModel || ""}`;
    $("#reader-quality").textContent = next.analysis ? `注释分析覆盖 ${next.analysis.analyzedCharacters}/${next.analysis.sourceCharacters} 字` : next.translation ? "尚未检查" : "尚未翻译";
    syncApproval();
    for (const id of ["refine-translation", "reader-export"]) $(`#${id}`).disabled = !next.translation;
    const revisionsKey = JSON.stringify([next.revisionHistory, next.activeRevisionId]);
    if (revisionsKey !== revisionSignature) {
    revisionSignature = revisionsKey;
    $("#reader-revisions").innerHTML = (next.revisionHistory || []).map((r) => `<button data-restore-revision="${escape(r.id)}">${escape(r.reason || r.origin)} · ${escape(r.createdAt || "已有版本")}${r.id === next.activeRevisionId ? " · 当前" : ""}</button>`).join("") || "暂无历史版本";
    container.querySelectorAll("[data-restore-revision]").forEach((button) => button.onclick = async () => {
      if (editing) return notify("请先保存或取消正在编辑的译文");
      if (!confirm("采用这个版本？当前译文仍保留在历史中。")) return;
      try { await request(`/api/books/${book.id}/chapters/${chapter.id}/revisions/${button.dataset.restoreRevision}/restore`, { method: "POST" }); notify("已采用所选版本"); } catch (e) { notify(e.message); }
    });
    }
    const segmentsKey = JSON.stringify(next.segments);
    if (segmentsKey !== segmentSignature && !$("#reader-segments").contains(document.activeElement)) {
      segmentSignature = segmentsKey;
      $("#reader-segments").innerHTML = (next.segments || []).map((s) => `<article><strong>${escape(s.label)}</strong><textarea data-segment-text="${escape(s.id)}" aria-label="编辑节选译文">${escape(segmentDrafts.get(s.id) ?? s.translation)}</textarea><button data-segment-save="${escape(s.id)}">保存节选</button></article>`).join("") || "暂无节选";
      container.querySelectorAll("[data-segment-text]").forEach((input) => input.oninput = () => segmentDrafts.set(input.dataset.segmentText, input.value));
      container.querySelectorAll("[data-segment-save]").forEach((b) => b.onclick = async () => { try { await request(`/api/books/${book.id}/chapters/${chapter.id}/segments/${b.dataset.segmentSave}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ translation: container.querySelector(`[data-segment-text="${b.dataset.segmentSave}"]`).value }) }); segmentDrafts.delete(b.dataset.segmentSave); notify("节选已保存"); } catch (e) { notify(e.message); } });
    }
    if (follow && active && completed.length) jumpLatest();
    if (run?.status === "completed" && run.adopted === false) $("#alignment-notice").textContent = "新译稿已完成。你的当前版本受到保护，可在版本历史中选择采用。";
    if (legacyServer) $("#alignment-notice").textContent = Array.isArray(next.sourceParagraphs) ? "服务已更新，请刷新页面以启用段落对齐和边译边读。" : "工作台后台仍是旧版，原文可正常阅读。请停止并重新启动工作台，再刷新页面以启用段落对齐和边译边读。";
  }
  applyPrefs(); update(chapter); remember({ chapterId: chapter.id });
  requestAnimationFrame(() => { if (disposed) return; const anchor = prefs.anchor; locate(sourcePane, anchor); locate(translatedPane, anchor); });
  const onResize = () => { const anchor = prefs.anchor; applyPrefs(); locate(activePane(), anchor); };
  narrow.addEventListener("change", onResize);
  return { update, isEditing: () => editing || segmentDrafts.size > 0, destroy: () => { saveAnchor(); disposed = true; clearTimeout(anchorTimer); clearTimeout(searchTimer); document.removeEventListener("selectionchange", selectionChanged); narrow.removeEventListener("change", onResize); window.removeEventListener("workbench-theme-beforechange", beforeThemeChange); window.removeEventListener("workbench-themechange", afterThemeChange); } };
}
