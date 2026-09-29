// Select a word or phrase on either side, ask the engine which words on the other side render it, and highlight both.
// Highlights use the CSS Custom Highlight API, so the text itself is never rewritten.
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function createAlign({ room, sourcePane, translatedPane, read, findNode, idsOf, request, book, chapter, notify, isActive }) {
  const button = Object.assign(document.createElement("button"), { type: "button", className: "align-button", hidden: true, textContent: "⇄ 对应" });
  button.title = "让当前引擎找出另一侧对应的文字";
  const pop = Object.assign(document.createElement("div"), { className: "align-pop", hidden: true }); pop.setAttribute("role", "status");
  room.append(button, pop);
  const highlights = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight === "function" ? CSS.highlights : null;
  const cache = new Map(); let pending = null, run = 0;

  // Plain text of a paragraph (without the paragraph number) with a map back to its text nodes.
  const textModel = (node) => {
    const pieces = []; let text = "";
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, { acceptNode: (t) => t.parentElement?.closest(".paragraph-number") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    for (let t = walker.nextNode(); t; t = walker.nextNode()) { pieces.push({ node: t, start: text.length }); text += t.data; }
    return { text, pieces };
  };
  const point = (model, offset, end) => {
    for (const p of model.pieces) { const len = p.node.data.length; if (end ? offset > p.start && offset <= p.start + len : offset >= p.start && offset < p.start + len) return [p.node, offset - p.start]; }
    return null;
  };
  const rangesOf = (model, needle) => {
    const out = []; for (let at = model.text.indexOf(needle); needle && at >= 0; at = model.text.indexOf(needle, at + needle.length)) {
      const a = point(model, at, false), b = point(model, at + needle.length, true); if (!a || !b) continue;
      const range = document.createRange(); range.setStart(...a); range.setEnd(...b); out.push(range);
    }
    return out;
  };
  const elementOf = (n) => (n?.nodeType === 1 ? n : n?.parentElement);
  const paneOf = (node) => (sourcePane.contains(node) ? sourcePane : read.contains(node) ? translatedPane : null);

  function clear() { run++; highlights?.delete("align-self"); highlights?.delete("align-match"); pop.hidden = true; button.hidden = true; pending = null; }
  function hideButton() { button.hidden = true; }

  function check() {
    const sel = getSelection();
    if (!isActive() || !sel.rangeCount || sel.isCollapsed) return hideButton();
    const range = sel.getRangeAt(0);
    const node = elementOf(range.startContainer)?.closest("[data-ids]");
    if (!node || node !== elementOf(range.endContainer)?.closest("[data-ids]") || !paneOf(node) || node.classList.contains("paragraph-pending")) return hideButton();
    const selection = sel.toString().trim();
    if (!selection || selection.length > 300) return hideButton();
    pending = { side: paneOf(node) === sourcePane ? "source" : "translation", node, selection, range: range.cloneRange() };
    const rect = range.getBoundingClientRect();
    button.hidden = false; button.disabled = false; button.textContent = "⇄ 对应";
    const width = button.offsetWidth || 72;
    button.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, rect.right - width / 2))}px`;
    button.style.top = `${Math.min(innerHeight - 44, rect.bottom + 8)}px`;
  }

  async function align() {
    const job = pending; if (!job) return;
    const ids = idsOf(job.node);
    const translationNodes = job.side === "source" ? [findNode(translatedPane, ids[0])].filter((n) => n && read.contains(n) && !n.classList.contains("paragraph-pending")) : [job.node];
    const sourceIds = job.side === "source" ? (translationNodes[0] ? idsOf(translationNodes[0]) : ids) : ids;
    const sourceNodes = sourceIds.map((id) => findNode(sourcePane, id)).filter(Boolean);
    if (!translationNodes.length || !sourceNodes.length) { hideButton(); return notify("这一段还没有对齐的译文"); }
    const sourceModels = sourceNodes.map(textModel), translationModels = translationNodes.map(textModel);
    const body = { side: job.side, selection: job.selection, sourceText: sourceModels.map((m) => m.text.trim()).join("\n\n"), translationText: translationModels.map((m) => m.text.trim()).join("\n\n") };
    const key = JSON.stringify(body); const mine = ++run;
    button.disabled = true; button.textContent = "对应中…";
    let result = cache.get(key);
    try { result ||= await request(`/api/books/${book.id}/chapters/${chapter.id}/align`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
    catch (error) { if (mine === run) { button.disabled = false; button.textContent = "⇄ 对应"; notify(error.message); } return; }
    cache.set(key, result);
    if (mine !== run) return;
    button.hidden = true;
    show(job, result, job.side === "source" ? translationModels : sourceModels, job.side === "source" ? translatedPane : sourcePane);
  }

  function show(job, result, targets, targetPane) {
    const ranges = result.matches.flatMap((m) => targets.flatMap((model) => rangesOf(model, m)));
    if (highlights) { highlights.set("align-self", new Highlight(job.range)); highlights.set("align-match", new Highlight(...ranges)); }
    const first = ranges[0];
    if (first) {
      const box = first.getBoundingClientRect(), view = targetPane.getBoundingClientRect();
      if (box.top < view.top + 24 || box.bottom > view.bottom - 24) targetPane.scrollBy({ top: box.top - view.top - view.height / 3 });
    }
    const other = job.side === "source" ? "译文" : "原文";
    pop.innerHTML = `<button class="align-close" aria-label="关闭对应">×</button>
      <p class="align-pair"><span class="align-self">${escape(job.selection)}</span><b aria-hidden="true">⇄</b>${result.matches.length ? result.matches.map((m) => `<span class="align-match">${escape(m)}</span>`).join("<i>·</i>") : `<em>${other}里没有逐字对应的文字</em>`}</p>
      ${result.note ? `<p class="align-note">${escape(result.note)}</p>` : ""}
      <small>${escape([result.engine, result.model].filter(Boolean).join(" · "))}${result.dropped ? ` · 另有 ${result.dropped} 处对应不是原样文字，未标出` : ""}${!highlights ? " · 此浏览器不支持文字高亮" : ""}</small>`;
    pop.hidden = false;
    pop.querySelector(".align-close").onclick = clear;
  }

  const onPointerUp = (event) => { if (!button.contains(event.target) && !pop.contains(event.target)) setTimeout(check, 0); };
  // Starting a new selection or clicking elsewhere puts the previous correspondence away.
  const onPointerDown = (event) => { if (button.contains(event.target) || pop.contains(event.target)) return; if (pop.hidden) hideButton(); else clear(); };
  const onKey = (event) => { if (event.key === "Escape") clear(); };
  const onScroll = () => hideButton();
  button.addEventListener("pointerdown", (e) => e.preventDefault()); // keep the selection alive while clicking
  button.onclick = align;
  room.addEventListener("pointerup", onPointerUp); room.addEventListener("pointerdown", onPointerDown); document.addEventListener("keydown", onKey);
  sourcePane.addEventListener("scroll", onScroll, { passive: true }); translatedPane.addEventListener("scroll", onScroll, { passive: true });
  return { clear, destroy: () => { clear(); document.removeEventListener("keydown", onKey); button.remove(); pop.remove(); } };
}
