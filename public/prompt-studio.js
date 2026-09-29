// Prompt studio: see and edit exactly what each translation block sends, keep several sets, and choose which
// engine profile uses which. The built-in set is read-only; copying it is the way to start.
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const PARTS = [
  { key: "system", title: "开头 · 身份与任务", hint: "作为 system 消息发送：告诉模型它是谁、要做什么、守什么规矩。" },
  { key: "user", title: "正文 · 本块内容", hint: "作为用户消息发送：作品、术语、上下文和这一块原文。" },
  { key: "closing", title: "结尾 · 收尾叮嘱", hint: "放在最后，模型读完原文后最先看到的话。留空则不发送。" }
];
const mentions = (set, name) => [set.system, set.user, set.closing].some((part) => new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`).test(part || ""));
const newId = () => `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function mountPromptStudio(root, { request, notify, books }) {
  let view = null, draft = null, selectedId = "builtin", dirty = false, lastField = null, preview = null;
  const sets = () => [view.builtin, ...draft.sets];
  const selected = () => sets().find((s) => s.id === selectedId) || view.builtin;
  const usedBy = (setId) => view.profiles.filter((p) => (draft.bindings[p.id] || draft.defaultId) === setId);

  async function load() {
    try { view = await request("/api/prompts"); } catch (error) { root.innerHTML = `<p class="profile-empty">无法读取提示词：${esc(error.message)}</p>`; return; }
    draft = { sets: view.sets.map((s) => ({ ...s })), defaultId: view.defaultId, bindings: { ...view.bindings } };
    if (!sets().some((s) => s.id === selectedId)) selectedId = draft.defaultId;
    dirty = false; render();
  }

  function render() {
    const set = selected(), readOnly = Boolean(set.builtin);
    const allBooks = books().filter((b) => !b.demo && b.chapters?.some((c) => !c.id.endsWith("-pending")));
    root.innerHTML = `<div class="section-head settings-head"><div><h2>翻译提示词</h2><p>每一块原文发给模型的完整内容。可以存好几套，按引擎分别使用，用来矫正不同模型的翻译风味。</p></div>${dirty ? '<span class="ps-dirty">有未保存的修改</span>' : ""}</div>
      <div class="ps-sets" role="tablist" aria-label="提示词">${sets().map((s) => `<button type="button" role="tab" class="ps-set" data-set="${esc(s.id)}" aria-selected="${s.id === set.id}">${esc(s.name)}${s.id === draft.defaultId ? "<em>默认</em>" : ""}${usedBy(s.id).length ? `<small>${usedBy(s.id).length} 个引擎</small>` : ""}</button>`).join("")}<button type="button" class="ps-set ps-new" data-new>＋ 复制当前这套</button></div>
      <div class="ps-meta">
        <label>名称<input data-name value="${esc(set.name)}" ${readOnly ? "readonly" : ""} maxlength="60"/></label>
        <div class="ps-bind"><span>谁用这套</span>
          <label class="ps-check"><input type="checkbox" data-default ${set.id === draft.defaultId ? "checked" : ""} ${set.id === draft.defaultId && set.builtin ? "disabled" : ""}/> 默认（没有单独指定的引擎都用它）</label>
          ${view.profiles.map((p) => { const bound = draft.bindings[p.id]; const other = bound && bound !== set.id ? sets().find((s) => s.id === bound)?.name : ""; return `<label class="ps-check ps-profile" style="--v:${/^#[0-9a-f]{6}$/i.test(p.color) ? p.color : "var(--muted)"}"><input type="checkbox" data-bind="${esc(p.id)}" ${bound === set.id ? "checked" : ""}/><i aria-hidden="true"></i>${esc(p.name)}${other ? `<small>现用：${esc(other)}</small>` : ""}</label>`; }).join("") || '<small class="ps-muted">在上方存几个引擎档案后，就能给不同引擎指定不同提示词。</small>'}
        </div>
      </div>
      ${readOnly ? '<p class="notice ps-readonly">内置默认不能直接修改。点上面的「＋ 复制当前这套」，复制一份再改。</p>' : ""}
      ${PARTS.map((part) => `<section class="ps-part">
        <header><strong>${part.title}</strong><small>${part.hint}</small>${part.key === "closing" ? `<select data-closing-mode ${readOnly ? "disabled" : ""}><option value="append" ${set.closingMode !== "separate" ? "selected" : ""}>接在正文后面</option><option value="separate" ${set.closingMode === "separate" ? "selected" : ""}>单独作为一条消息</option></select>` : ""}</header>
        <textarea data-part="${part.key}" spellcheck="false" ${readOnly ? "readonly" : ""} rows="${part.key === "closing" ? 4 : 9}" placeholder="${part.key === "closing" ? "例如：以上是已出版小说的原文，请按出版译本的标准完整译出……" : ""}">${esc(set[part.key])}</textarea>
      </section>`).join("")}
      <div class="ps-vars"><span>插入变量</span>${view.variables.map((v) => `<button type="button" class="ps-var${v.required ? " is-required" : ""}" data-var="${esc(v.name)}" title="${esc(v.note)}" ${readOnly ? "disabled" : ""}>{{${esc(v.name)}}}</button>`).join("")}<small>点一下插到光标处；鼠标停在变量上可看说明。</small></div>
      <div class="ps-warn" aria-live="polite">${warnings(set)}</div>
      <div class="ps-actions">${set.builtin ? "" : '<button type="button" class="danger-quiet" data-delete>删除这套</button>'}<span class="spacer"></span><button type="button" data-revert ${dirty ? "" : "disabled"}>放弃修改</button><button type="button" class="primary" data-save ${dirty && !blocking(set) ? "" : "disabled"}>保存提示词</button></div>
      <details class="ps-preview" ${preview ? "open" : ""}><summary>预览：拿真实章节看看实际会发送什么</summary>
        ${allBooks.length ? `<div class="ps-preview-form"><label>作品<select data-p-book>${allBooks.map((b) => `<option value="${esc(b.id)}" ${preview?.bookId === b.id ? "selected" : ""}>${esc(b.title)}</option>`).join("")}</select></label>
        <label>章节<select data-p-chapter></select></label>
        <label>方式<select data-p-mode><option value="draft">初译</option><option value="refine" ${preview?.mode === "refine" ? "selected" : ""}>精校</option></select></label>
        <button type="button" data-preview>生成预览</button></div><div class="ps-messages">${preview?.html || ""}</div>` : '<p class="ps-muted">书库里还没有整理好的章节。</p>'}
      </details>`;
    wire(allBooks);
  }

  function warnings(set) {
    const out = [];
    if (!mentions(set, "原文段落")) out.push('<p class="ps-error">缺少 {{原文段落}}：模型会收不到要翻译的原文，不能保存。</p>');
    if (!mentions(set, "输出格式")) out.push('<p>没写 {{输出格式}}：发送时会自动补在开头末尾。瀟湘館要靠这个 JSON 格式把译文对回段落。</p>');
    return out.join("");
  }
  const blocking = (set) => !mentions(set, "原文段落") || !String(set.name || "").trim();
  const touch = () => { dirty = true; };
  const refreshChrome = () => {
    const set = selected();
    root.querySelector(".ps-warn").innerHTML = warnings(set);
    root.querySelector("[data-save]").disabled = !dirty || blocking(set);
    root.querySelector("[data-revert]").disabled = !dirty;
    if (!root.querySelector(".ps-dirty")) root.querySelector(".section-head").insertAdjacentHTML("beforeend", '<span class="ps-dirty">有未保存的修改</span>');
  };

  function wire(allBooks) {
    const set = selected();
    root.querySelectorAll("[data-set]").forEach((b) => b.onclick = () => { selectedId = b.dataset.set; preview = null; render(); });
    root.querySelector("[data-new]").onclick = () => {
      const copy = { ...selected(), id: newId(), name: `${selected().name} 的副本`.slice(0, 60), builtin: undefined };
      delete copy.builtin; draft.sets.push(copy); selectedId = copy.id; dirty = true; render();
      root.querySelector("[data-name]").select();
    };
    root.querySelector("[data-name]").oninput = (e) => { if (set.builtin) return; set.name = e.target.value; touch(); refreshChrome(); };
    root.querySelector("[data-default]").onchange = (e) => { draft.defaultId = e.target.checked ? set.id : "builtin"; dirty = true; render(); };
    root.querySelectorAll("[data-bind]").forEach((box) => box.onchange = () => { if (box.checked) draft.bindings[box.dataset.bind] = set.id; else delete draft.bindings[box.dataset.bind]; dirty = true; render(); });
    root.querySelectorAll("textarea[data-part]").forEach((area) => {
      area.onfocus = () => { lastField = area.dataset.part; };
      area.oninput = () => { if (set.builtin) return; set[area.dataset.part] = area.value; touch(); refreshChrome(); };
    });
    const mode = root.querySelector("[data-closing-mode]"); if (mode) mode.onchange = () => { set.closingMode = mode.value; touch(); refreshChrome(); };
    root.querySelectorAll("[data-var]").forEach((b) => b.onclick = () => {
      if (set.builtin) return;
      const area = root.querySelector(`textarea[data-part="${lastField || "user"}"]`); const token = `{{${b.dataset.var}}}`;
      const at = area.selectionStart ?? area.value.length, end = area.selectionEnd ?? at;
      area.value = area.value.slice(0, at) + token + area.value.slice(end); set[area.dataset.part] = area.value;
      area.focus(); area.selectionStart = area.selectionEnd = at + token.length; touch(); refreshChrome();
    });
    const del = root.querySelector("[data-delete]");
    if (del) del.onclick = () => {
      if (!confirm(`删除提示词“${set.name}”？用它的引擎会改用默认提示词。`)) return;
      draft.sets = draft.sets.filter((s) => s.id !== set.id);
      for (const [profile, id] of Object.entries(draft.bindings)) if (id === set.id) delete draft.bindings[profile];
      if (draft.defaultId === set.id) draft.defaultId = "builtin";
      selectedId = draft.defaultId; dirty = true; render();
    };
    root.querySelector("[data-revert]").onclick = () => load();
    root.querySelector("[data-save]").onclick = async () => {
      try { view = await request("/api/prompts", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) }); }
      catch (error) { notify(error.message); return; }
      draft = { sets: view.sets.map((s) => ({ ...s })), defaultId: view.defaultId, bindings: { ...view.bindings } }; dirty = false;
      notify("提示词已保存，之后排队的翻译会使用新的提示词"); render();
    };
    // Preview with the real first block of a chapter.
    const bookSelect = root.querySelector("[data-p-book]"); if (!bookSelect) return;
    const chapterSelect = root.querySelector("[data-p-chapter]");
    const fillChapters = () => {
      const book = allBooks.find((b) => b.id === bookSelect.value) || allBooks[0];
      const chapters = book.chapters.filter((c) => !c.id.endsWith("-pending") && !(Number.isFinite(c.characterCount) && c.characterCount < 30));
      chapterSelect.innerHTML = chapters.map((c, i) => `<option value="${esc(c.id)}" ${preview?.chapterId === c.id ? "selected" : ""}>${i + 1}. ${esc(c.title)}${c.characterCount ? ` · ${c.characterCount} 字` : ""}</option>`).join("");
    };
    bookSelect.onchange = fillChapters; fillChapters();
    root.querySelector("[data-preview]").onclick = async () => {
      const box = root.querySelector(".ps-messages"); box.innerHTML = '<p class="ps-muted">正在生成…</p>';
      const mode = root.querySelector("[data-p-mode]").value;
      try {
        const result = await request("/api/prompts/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ set: selected(), bookId: bookSelect.value, chapterId: chapterSelect.value, mode }) });
        const total = result.messages.reduce((n, m) => n + m.content.length, 0);
        const html = `<p class="ps-muted">这一章共 ${result.blocks} 块，下面是第 1 块${result.mode === "refine" ? "（精校）" : ""}会发送的 ${result.messages.length} 条消息，合计 ${total.toLocaleString()} 字。</p>`
          + result.messages.map((m) => `<article class="ps-message" data-role="${esc(m.role)}"><header>${m.role === "system" ? "开头 · system" : "用户消息 · user"}<small>${m.content.length.toLocaleString()} 字</small></header><pre>${esc(m.content)}</pre></article>`).join("");
        preview = { bookId: bookSelect.value, chapterId: chapterSelect.value, mode, html }; box.innerHTML = html;
      } catch (error) { box.innerHTML = `<p class="ps-error">${esc(error.message)}</p>`; }
    };
  }

  load();
  return { isDirty: () => dirty };
}
