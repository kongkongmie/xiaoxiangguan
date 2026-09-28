import { initThemes } from "./themes.js";
import { mountReader, readingState, rememberReading } from "./reader.js";
import { SOURCE_LANGUAGES, languageDetails, sourceLanguage } from "./languages.js";
import { searchStatus, summarizeLibraryQuality } from "./reader-quality.js";
import { readerMode } from "./reader-mode.js";
import { pageBooks } from "./library-index.js";
import { cleanReaderExplanation } from "./reader-notes.js";
import { statusBadge as status } from "./status-badge.js";

initThemes();

const content = document.querySelector("#content");
const pageTitle = document.querySelector("#page-title");
const eyebrow = document.querySelector("#eyebrow");
const searchInput = document.querySelector("#search");
const toast = document.querySelector("#toast");
let data = { books: [], exports: [] };
let currentView = "library";
let selectedBook = null;
let selectedChapter = null;
let providerSettings = null;
let searchSettings = null;
let taskPollTimer = null;
let reader = null;
let readerPollTimer = null;
let navigationId = 0;
function leaveReader() { reader?.destroy(); reader = null; clearTimeout(readerPollTimer); navigationId++; document.body.classList.remove("is-reading"); }
function route(path) { if (location.hash !== `#${path}`) history.pushState(null, "", `#${path}`); }
async function restoreRoute() {
  const parts = location.hash.slice(1).split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "books" && parts[1]) { await load(); if (parts[2] === "chapters" && parts[3]) return renderWorkspace(parts[1], parts[3]); return renderBook(parts[1]); }
  switchView(parts[0] || "library");
}
window.addEventListener("popstate", () => { if (confirmDiscardReaderEdit()) restoreRoute(); });
window.addEventListener("beforeunload", (event) => { const editor = document.querySelector("#translation"); if (editor && !editor.hidden && editor.value !== String(selectedChapter?.translation || "")) { event.preventDefault(); event.returnValue = ""; } });
const bookUiState = new Map();
let glossaryBookFilter = "";
let glossaryCategoryFilter = "";
let indexPage = 0;
for (const id of ["book-language", "edit-book-language"]) {
  document.querySelector(`#${id}`).innerHTML = SOURCE_LANGUAGES.map((entry) => `<option value="${entry.code}">${entry.label}</option>`).join("");
}

const providerPresets = {
  "openai-luna": { label: "OpenAI · GPT-6 Luna（默认）", providerName: "OpenAI · Luna", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1", model: "gpt-6-luna", maxOutputTokens: 8192, inputPrice: 0.1, outputPrice: 0.5, noAuth: false, note: "适合日常长篇翻译；需要 OpenAI Platform API Key，费用与 ChatGPT 订阅分开计算。" },
  "deepseek-flash": { label: "DeepSeek · Flash（推荐）", providerName: "DeepSeek · Flash", protocol: "openai-chat", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", maxOutputTokens: 8192, inputPrice: 0.3, outputPrice: 1.2, noAuth: false, note: "速度快、价格较低，适合批量初译。费用按官方峰值价格保守估算。" },
  "deepseek-pro": { label: "DeepSeek · V4 Pro", providerName: "DeepSeek · V4 Pro", protocol: "openai-chat", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro", maxOutputTokens: 16384, inputPrice: 1.32, outputPrice: 3.96, noAuth: false, note: "更适合文学精校和复杂文本。费用按官方峰值价格保守估算。" },
  "ollama-local": { label: "Ollama · 本机模型", providerName: "Ollama · 本机", protocol: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3:8b", maxOutputTokens: 8192, inputPrice: 0, outputPrice: 0, noAuth: true, note: "不产生 API 费用，但需要先安装 Ollama 并下载对应模型；模型名可按本机实际情况修改。" }
};

function originOf(value) {
  try { return new URL(value).origin; } catch { return ""; }
}

function matchingProviderPreset(settings) {
  return Object.entries(providerPresets).find(([, preset]) => preset.protocol === settings.protocol && preset.baseUrl === settings.baseUrl && preset.model === settings.model)?.[0] || "custom";
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "操作失败");
  return result;
}

function notify(message) {
  toast.textContent = message; toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2600);
}

async function shutdownWorkbench() {
  if (reader?.isEditing()) return notify("请先保存或取消正在编辑的译文，再关闭后台");
  if (document.querySelector("#shutdown-dialog")) return;
  const dialog = document.createElement("dialog"); dialog.id = "shutdown-dialog"; dialog.className = "shutdown-dialog";
  dialog.innerHTML = `<div class="dialog-head"><h2>关闭瀟湘館后台</h2><button id="dismiss-shutdown" aria-label="取消关闭">×</button></div><p id="shutdown-description">正在检查任务…</p><p>关闭浏览器页面时后台会继续运行；关闭后台后，再次双击启动程序即可回来。</p><p id="shutdown-error" role="alert"></p><div class="dialog-actions"><button id="keep-running">继续运行</button><button id="confirm-shutdown" class="primary" disabled>关闭后台</button></div>`;
  document.body.append(dialog); dialog.showModal();
  const close = () => { dialog.close(); dialog.remove(); };
  dialog.querySelector("#dismiss-shutdown").onclick = close; dialog.querySelector("#keep-running").onclick = close; dialog.oncancel = close;
  try {
    const state = await request("/api/lifecycle"); if (!dialog.isConnected) return;
    dialog.querySelector("#shutdown-description").textContent = state.activeTasks ? `有 ${state.activeTasks} 个任务尚未结束。关闭会停止这些任务并保留已完成的翻译块，下次可继续。` : "没有正在运行的任务，书籍与已保存内容会保留。";
    dialog.querySelector("#confirm-shutdown").disabled = false;
  } catch { dialog.querySelector("#shutdown-error").textContent = "当前后台尚不支持页面关闭。请先用 stop 停止，再启动更新后的工作台。"; }
  dialog.querySelector("#confirm-shutdown").onclick = async () => {
    const button = dialog.querySelector("#confirm-shutdown"); button.disabled = true; button.textContent = "正在保存并关闭…";
    try {
      await request("/api/shutdown", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) });
      clearTimeout(taskPollTimer); leaveReader(); currentView = "closed"; close();
      document.body.classList.add("server-closed");
      content.innerHTML = '<div class="empty"><strong>后台已关闭</strong><p>书籍与已完成进度已保存，可以关闭此页面。下次双击启动程序即可继续。</p></div>';
    } catch (error) { button.disabled = false; button.textContent = "关闭后台"; dialog.querySelector("#shutdown-error").textContent = `未能确认后台退出：${error.message}`; }
  };
}

function openImportDialog() {
  const form = document.querySelector("#import-form"); form.reset();
  document.querySelector("#book-title").value = ""; document.querySelector("#book-author").value = ""; document.querySelector("#book-profile").value = "自动判断";
  document.querySelector("#book-language").value = "ja";
  document.querySelector("#file-hint").textContent = "原文件会复制到本地书库，不会被修改";
  document.querySelector("#import-dialog").showModal();
}

function escapeHtml(value = "") {
  const div = document.createElement("div"); div.textContent = value; return div.innerHTML;
}
function escapeAttribute(value = "") { return escapeHtml(value).replaceAll('"', "&quot;"); }

function confirmDiscardReaderEdit() {
  const editor = document.querySelector("#translation");
  if (!editor || editor.hidden || editor.value === String(selectedChapter?.translation || "")) return true;
  if (!confirm("译文有尚未保存的修改。放弃修改并离开这一章？")) return false;
  editor.value = String(selectedChapter?.translation || "");
  return true;
}

function progress(book) {
  const total = Math.max(1, book.chapters.length);
  const approved = book.chapters.filter((item) => item.status === "approved").length;
  const worked = book.chapters.filter((item) => !["not_started", "extracting"].includes(item.status)).length;
  return { total: book.chapters.length, approved, worked, percent: Math.round((approved / total) * 100) };
}

function formatDate(value) { return value ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "—"; }
function friendlyTaskError(task) {
  const raw = String(task.error || "");
  if (/PermissionError[\s\S]*calibre|AppData[\\/]+Roaming[\\/]+calibre/i.test(raw)) return "旧版 Calibre 缓存目录没有写入权限；新版已修复，请重新识别章节。";
  const line = raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).at(-1) || raw;
  return line.length > 260 ? `${line.slice(0, 260)}…` : line;
}

function setHeader(kicker, title) { eyebrow.textContent = kicker; pageTitle.textContent = title; }

function renderLibrary() {
  leaveReader(); currentView = "library"; route("/library"); searchInput.disabled = false;
  setHeader("藏书 / LIBRARY", "有鳳來儀");
  if (!data.books.length) {
    content.innerHTML = `<section class="welcome panel panel-pad"><div class="welcome-copy"><p class="eyebrow">WELCOME / 开始使用</p><h2>从一本书开始</h2><p>文件、译文、进度和 API 配置都只保存在这台电脑。先配置翻译 API，再导入 PDF、EPUB 或无 DRM 的 AZW3；联网搜索是可选的。</p><div class="welcome-actions"><button class="primary" id="welcome-import">导入第一本书</button><button id="welcome-settings">配置翻译 API</button></div></div><ol class="welcome-steps"><li><span>一</span><div><strong>配置翻译 API</strong><small>填写所选服务商的 API Key；Luna 是默认模型。</small></div></li><li><span>二</span><div><strong>导入并识别</strong><small>保留章节、页码和来源位置。</small></div></li><li><span>三</span><div><strong>选择范围</strong><small>按卷册、章节、PDF 页码或段落翻译。</small></div></li><li><span>四</span><div><strong>阅读与导出</strong><small>直接生成可导入 Apple Books 的 EPUB，无需审校原文。</small></div></li></ol></section>`;
    document.querySelector("#welcome-import").onclick = openImportDialog;
    document.querySelector("#welcome-settings").onclick = () => switchView("settings");
    return;
  }
  const query = searchInput.value.trim().toLowerCase();
  const books = data.books.filter((book) => [book.title, book.author, book.format].join(" ").toLowerCase().includes(query));
  const pageCount = Math.max(1, Math.ceil(books.length / 10));
  indexPage = Math.min(indexPage, pageCount - 1);
  const totalChapters = data.books.reduce((sum, book) => sum + book.chapters.length, 0);
  const approved = data.books.flatMap((book) => book.chapters).filter((chapter) => chapter.status === "approved").length;
  const activeTasks = data.books.flatMap((book) => book.tasks || []).filter((task) => ["queued", "running", "paused"].includes(task.status)).length;
  const recent = [...data.books].sort((a, b) => (readingState(b.id).openedAt || 0) - (readingState(a.id).openedAt || 0))[0];
  const recentChapter = recent?.chapters.find((c) => c.id === readingState(recent.id).chapterId) || recent?.chapters.find((c) => !c.id.endsWith("-pending"));
  content.innerHTML = `
    <section class="continue-reading" aria-label="继续阅读"><div><p class="eyebrow">READING / 继续阅读</p><h2>${recent ? escapeHtml(recent.title) : "我的书库"}</h2><p>${recentChapter ? `阅读位置：${escapeHtml(recentChapter.title)}` : "章节正在整理，你可以先查看目录。"}</p></div><button class="primary" id="continue-action">${recentChapter ? "继续阅读" : "打开目录"}</button></section>
    <div class="section-head index-heading"><div><p class="eyebrow">INDEX / 作品索引</p><h2>全部作品</h2><p>依导入次序 · 共 ${books.length} 本</p></div><span class="index-count">${String(indexPage + 1).padStart(2, "0")} / ${String(pageCount).padStart(2, "0")}</span></div>
    <div class="book-grid book-index">${pageBooks(books, indexPage).map((book) => {
      const info = progress(book); return `<article class="book-card" data-book="${book.id}" role="button" tabindex="0" aria-label="打开作品：${escapeAttribute(book.title)}">
        <div class="cover ${book.format === "PDF" ? "paper" : ""}">${escapeHtml(book.title.slice(0, 6))}</div>
        <div class="book-meta"><h3>${escapeHtml(book.title)}</h3><p>${escapeHtml(book.author || "作者未填写")}</p>
        <div class="tags"><span class="tag">${book.format}</span><span class="tag">${languageDetails(book).label} → 简体中文</span><span class="tag">${escapeHtml(book.profile)}</span>${book.demo ? '<span class="tag">演示</span>' : ""}</div>
        <div class="progress"><i style="width:${info.percent}%"></i></div><div class="progress-label"><span>${info.approved}/${info.total} 章已批准</span><strong>${info.percent}%</strong></div></div>
      </article>`;
    }).join("") || '<div class="empty"><strong>没有匹配的作品</strong>请尝试其他搜索词，或清空搜索后浏览全部作品。<button id="clear-library-search">清空搜索</button></div>'}</div>
    ${pageCount > 1 ? `<nav class="index-pages" aria-label="作品索引分页"><button id="index-prev" ${indexPage === 0 ? "disabled" : ""}>上一页</button><span>第 ${indexPage + 1} / ${pageCount} 页</span><button id="index-next" ${indexPage === pageCount - 1 ? "disabled" : ""}>下一页</button></nav>` : ""}`;
  document.querySelector("#continue-action").onclick = () => recentChapter ? renderWorkspace(recent.id, recentChapter.id) : renderBook(recent.id);
  const clearSearch = document.querySelector("#clear-library-search"); if (clearSearch) clearSearch.onclick = () => { searchInput.value = ""; renderLibrary(); };
  const previousPage = document.querySelector("#index-prev"); if (previousPage) previousPage.onclick = () => { indexPage--; renderLibrary(); };
  const nextPage = document.querySelector("#index-next"); if (nextPage) nextPage.onclick = () => { indexPage++; renderLibrary(); };
  content.querySelectorAll("[data-book]").forEach((card) => card.addEventListener("click", () => renderBook(card.dataset.book)));
  content.querySelectorAll("[data-book]").forEach((card) => card.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); renderBook(card.dataset.book); } }));
}

function bookWorks(book) {
  if ((book.works || []).length) return book.works;
  const grouped = new Map();
  for (const chapter of book.chapters) { const name = chapter.workTitle || book.title; if (!grouped.has(name)) grouped.set(name, []); grouped.get(name).push(chapter.id); }
  return [...grouped.entries()].map(([title, chapterIds], index) => ({ id: `legacy-work-${index + 1}`, title, chapterIds, order: index + 1 }));
}

function getBookUiState(book, works) {
  if (!bookUiState.has(book.id)) bookUiState.set(book.id, { workId: works[0]?.id || "", selectedIds: new Set(), nameTouched: false, scopeName: "" });
  const state = bookUiState.get(book.id); if (!works.some((work) => work.id === state.workId)) state.workId = works[0]?.id || ""; return state;
}

function renderBook(bookId) {
  leaveReader(); currentView = "book"; route(`/books/${encodeURIComponent(bookId)}`); searchInput.disabled = true;
  const book = data.books.find((item) => item.id === bookId); if (!book) return;
  selectedBook = book; const info = progress(book); const works = bookWorks(book); const state = getBookUiState(book, works); setHeader(book.format, book.title);
  const activeWork = works.find((work) => work.id === state.workId) || works[0]; const activeIds = new Set(activeWork?.chapterIds || []);
  const visibleChapters = activeWork ? book.chapters.filter((chapter) => activeIds.has(chapter.id)) : book.chapters.slice(0, 300);
  const manualScopes = (book.scopes || []).filter((scope) => !scope.auto);
  const needsExtraction = !book.demo && book.chapters.some((chapter) => chapter.id.endsWith("-pending"));
  let lastSection = "";
  const chapterRows = visibleChapters.map((chapter) => {
    const section = (chapter.sectionPath || []).join(" › "); let heading = "";
    if (section && section !== lastSection) { lastSection = section; heading = `<tr class="section-divider"><td colspan="6">${escapeHtml(section)}</td></tr>`; }
    return `${heading}<tr><td class="check-cell"><input class="chapter-check" type="checkbox" value="${chapter.id}" ${chapter.id.endsWith("-pending") ? "disabled" : ""} ${state.selectedIds.has(chapter.id) ? "checked" : ""}/></td><td><strong>${escapeHtml(chapter.title)}</strong>${chapter.characterCount ? `<small class="subline">约 ${chapter.characterCount.toLocaleString()} 字</small>` : ""}${(chapter.segments || []).length ? `<small class="subline">${chapter.segments.length} 个节选</small>` : ""}</td><td>${escapeHtml(chapter.sourceLocator || "待识别")}</td><td>${chapter.paragraphCount || 0}</td><td>${status(chapter.status)}</td><td><button data-chapter="${chapter.id}">打开</button></td></tr>`;
  }).join("");
  content.innerHTML = `<button class="back" id="back-library">← 返回书库</button>
    <div class="panel book-hero"><div class="cover ${book.format === "PDF" ? "paper" : ""}">${escapeHtml(book.title.slice(0, 6))}</div>
      <div><h2>${escapeHtml(book.title)}</h2><p>${escapeHtml(book.author || "作者未填写")} · ${book.format} · ${languageDetails(book).label} → 简体中文 · ${escapeHtml(book.profile)}</p>
      <div class="tags"><span class="tag">${works.length} 部作品</span><span class="tag">${info.total} 个正文单元</span><span class="tag">${info.approved} 个已批准</span>${book.demo ? '<span class="tag">演示数据</span>' : ""}</div></div>
      <div class="hero-actions"><button id="edit-book">编辑资料</button><button class="danger-quiet" id="delete-book">删除作品</button><button data-nav="glossary">阅读质量</button>${needsExtraction ? '<button class="primary" id="extract-book">识别章节</button>' : '<button id="extract-book">重新整理目录</button><button class="primary" id="quick-export">导出可阅读 EPUB</button>'}</div></div>
    <div class="catalog-layout">
      <aside class="panel panel-pad work-browser" ${works.length === 1 ? "hidden" : ""}><p class="eyebrow">COLLECTION</p><h2>作品目录</h2><p>先选择小说，再处理其中的章节。</p><label>当前作品<select id="work-select">${works.map((work) => `<option value="${work.id}" ${work.id === activeWork?.id ? "selected" : ""}>${escapeHtml(work.title)}（${work.chapterIds.length}）</option>`).join("")}</select></label><div class="work-summary"><strong>${escapeHtml(activeWork?.title || book.title)}</strong><span>${visibleChapters.length} 个正文单元</span></div><small>标题页、目录页和无正文的结构节点已隐藏，不会进入翻译队列。</small></aside>
      <section class="panel panel-pad selection-panel"><div class="section-head compact"><div><p class="eyebrow">SELECTION</p><h2>已选择章节</h2><p>勾选结果会保留；切换作品后也可以继续追加。</p></div><div class="scope-count"><strong id="scope-count">${state.selectedIds.size}</strong><span>章已选</span></div></div><div class="selected-chapters" id="selected-chapters"></div><details class="scope-more"><summary>保存为选集</summary><label class="scope-name-label">给这组选中的章节命名<input id="scope-name" placeholder="例如：上杉谦信·第一卷"/></label><small>“选集名称”是你为这组章节取的名称；下方会同时列出真正选中的章节。</small><button id="save-scope">保存到“我的选集”</button></details><div class="scope-actions"><button id="clear-selection">清空选择</button><span class="spacer"></span><button id="export-selected">导出所选（含草稿）</button><button class="primary" id="translate-selected">翻译所选章节</button></div></section>
    </div>
    <details class="panel panel-pad saved-section"><summary>我的选集与更多操作</summary><div class="section-head compact"><div><p class="eyebrow">MY SETS</p><h2>我的选集</h2><p>保存后会固定显示在这里，可重新打开、继续选章或删除。</p></div></div>${manualScopes.length ? `<div class="saved-scope-grid">${manualScopes.map((scope) => `<article class="saved-scope-item"><div><strong>${escapeHtml(scope.name)}</strong><span>${scope.chapterIds.length} 个章节</span></div><div><button data-open-scope="${scope.id}">打开</button><button class="danger-quiet" data-delete-scope="${scope.id}">删除</button></div></article>`).join("")}</div>` : '<div class="empty slim">还没有保存的选集。先在下方勾选章节，再点击“保存到我的选集”。</div>'}</details>
    <div class="section-head"><div><h2>${escapeHtml(activeWork?.title || "章节进度")}</h2><p>当前显示这部作品中的 ${visibleChapters.length} 个正文单元</p></div><span>${info.percent}% 已批准</span></div>
    <div class="panel chapter-catalog"><table class="table chapter-table"><thead><tr><th class="check-cell"><input id="select-all-chapters" type="checkbox" aria-label="选择当前作品全部章节"/></th><th>章节</th><th>源位置</th><th>段落</th><th>状态</th><th></th></tr></thead><tbody>
    ${chapterRows || '<tr><td colspan="6" class="empty">这部作品没有可翻译的正文单元。</td></tr>'}
    </tbody></table></div>`;
  document.querySelector("#back-library").onclick = renderLibrary;
  const exportButton = document.querySelector("#quick-export"); if (exportButton) exportButton.disabled = !book.chapters.some((c) => c.translation || c.translationPath || c.polishedPath || c.activeRevisionId); if (exportButton) exportButton.onclick = () => exportEpub(book.id, true);
  const extractButton = document.querySelector("#extract-book"); if (extractButton) extractButton.onclick = () => extractBook(book.id);
  document.querySelector("#edit-book").onclick = () => openEditBook(book);
  document.querySelector("#delete-book").onclick = () => deleteBook(book);
  content.querySelectorAll("[data-chapter]").forEach((button) => button.onclick = () => renderWorkspace(book.id, button.dataset.chapter));
  content.querySelector("[data-nav='glossary']").onclick = () => switchView("glossary");
  const scopeName = document.querySelector("#scope-name"); const checks = [...content.querySelectorAll(".chapter-check")];
  const updateSelection = () => {
    document.querySelector(".selection-panel").hidden = !state.selectedIds.size;
    document.querySelector("#scope-count").textContent = state.selectedIds.size;
    const selected = book.chapters.filter((chapter) => state.selectedIds.has(chapter.id));
    document.querySelector("#selected-chapters").innerHTML = selected.length ? selected.slice(0, 12).map((chapter) => `<span>${escapeHtml(chapter.workTitle && chapter.workTitle !== activeWork?.title ? `${chapter.workTitle} · ${chapter.title}` : chapter.title)}</span>`).join("") + (selected.length > 12 ? `<em>另有 ${selected.length - 12} 章</em>` : "") : '<small>尚未选择章节</small>';
    if (state.nameTouched) scopeName.value = state.scopeName || "";
    else { scopeName.value = selected.length === 1 ? selected[0].title : selected.length ? `${activeWork?.title || book.title}选集（${selected.length}章）` : ""; state.scopeName = scopeName.value; }
    for (const id of ["save-scope", "translate-selected", "export-selected", "clear-selection"]) document.querySelector(`#${id}`).disabled = !selected.length;
  };
  scopeName.oninput = () => { state.nameTouched = true; state.scopeName = scopeName.value; };
  checks.forEach((item) => item.onchange = () => { item.checked ? state.selectedIds.add(item.value) : state.selectedIds.delete(item.value); updateSelection(); });
  document.querySelector("#select-all-chapters").onchange = (event) => { checks.forEach((item) => { if (!item.disabled) { item.checked = event.target.checked; item.checked ? state.selectedIds.add(item.value) : state.selectedIds.delete(item.value); } }); updateSelection(); };
  document.querySelector("#work-select").onchange = (event) => { state.workId = event.target.value; renderBook(book.id); };
  document.querySelector("#clear-selection").onclick = () => { state.selectedIds.clear(); state.nameTouched = false; state.scopeName = ""; renderBook(book.id); };
  content.querySelectorAll("[data-open-scope]").forEach((button) => button.onclick = () => { const scope = manualScopes.find((item) => item.id === button.dataset.openScope); state.selectedIds = new Set(scope.chapterIds); state.nameTouched = true; state.scopeName = scope.name; const first = book.chapters.find((chapter) => state.selectedIds.has(chapter.id)); if (first?.workId) state.workId = first.workId; renderBook(book.id); notify(`已打开选集“${scope.name}”`); });
  content.querySelectorAll("[data-delete-scope]").forEach((button) => button.onclick = () => deleteScope(book, button.dataset.deleteScope));
  document.querySelector("#save-scope").onclick = () => saveScope(book, [...state.selectedIds]);
  document.querySelector("#translate-selected").onclick = () => translateSelected(book, [...state.selectedIds]);
  document.querySelector("#export-selected").onclick = () => exportEpub(book.id, true, [...state.selectedIds]);
  updateSelection();
  const catalog = content.querySelector(".chapter-catalog"); const layout = content.querySelector(".catalog-layout");
  layout.before(catalog.previousElementSibling, catalog); // Chapters precede optional selection tools.
  const saved = content.querySelector(".saved-section"); if (saved) saved.open = false;
  if (needsExtraction) { clearTimeout(taskPollTimer); taskPollTimer = setTimeout(async () => { await load(); if (currentView === "book" && selectedBook?.id === bookId) renderBook(bookId); }, 1800); }
}

function openEditBook(book) {
  selectedBook = book; document.querySelector("#edit-book-title").value = book.title; document.querySelector("#edit-book-author").value = book.author || ""; document.querySelector("#edit-book-language").value = sourceLanguage(book); document.querySelector("#edit-book-profile").value = book.profile || "自动判断"; document.querySelector("#edit-book-dialog").showModal();
}

async function saveBookDetails(event) {
  event.preventDefault(); if (!selectedBook) return;
  const payload = { title: document.querySelector("#edit-book-title").value, author: document.querySelector("#edit-book-author").value, profile: document.querySelector("#edit-book-profile").value, sourceLanguage: document.querySelector("#edit-book-language").value };
  try { await request(`/api/books/${selectedBook.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }); document.querySelector("#edit-book-dialog").close(); await load(); renderBook(selectedBook.id); notify("作品资料已更新"); } catch (error) { notify(error.message); }
}

async function deleteBook(book) {
  if (!confirm(`从书库删除“${book.title}”？\n\n原文件、提取内容和译文会移入本地 library/.trash，不会立即永久擦除；已导出的 EPUB 会保留。`)) return;
  try { await request(`/api/books/${book.id}`, { method: "DELETE" }); await load(); renderLibrary(); notify("作品已从书库删除，项目数据已移入 .trash"); } catch (error) { notify(error.message); }
}

async function renderWorkspace(bookId, chapterId, anchor) {
  if (!confirmDiscardReaderEdit()) return;
  leaveReader(); currentView = "reader"; selectedBook = data.books.find((b) => b.id === bookId);
  if (!selectedBook) return renderLibrary();
  if (anchor) rememberReading(bookId, { chapterId, anchor });
  route(`/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(chapterId)}`);
  const token = navigationId;
  try {
    const chapter = await request(`/api/books/${bookId}/chapters/${chapterId}`);
    if (token !== navigationId) return;
    selectedChapter = chapter; document.body.classList.add("is-reading");
    const book = selectedBook;
    reader = mountReader({ container: content, book, chapter, request, notify,
      navigate: (id, target) => renderWorkspace(bookId, id, target), back: () => { if (confirmDiscardReaderEdit()) renderBook(bookId); }, configure: () => switchView("settings"),
      start: (mode, range, retry, profileId) => startTranslation(book, selectedChapter, mode, range, retry, profileId),
      save: async (translation, status) => { try { const payload = { status }; if (translation !== undefined) payload.translation = translation; const updated = await request(`/api/books/${bookId}/chapters/${chapterId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }); if (translation !== undefined) selectedChapter.translation = translation; reader?.update(await request(`/api/books/${bookId}/chapters/${chapterId}`)); notify("修改已保存"); return true; } catch (e) { notify(e.message); return false; } },
      analyze: () => startChapterAnalysis(book, selectedChapter), exportBook: () => exportEpub(bookId, true, [chapterId]), onChapter: (value) => { selectedChapter = value; }, shutdown: shutdownWorkbench
    });
    const poll = async () => {
      try { const [next, library] = await Promise.all([request(`/api/books/${bookId}/chapters/${chapterId}`), request("/api/library")]); if (token !== navigationId) return; data = library; const tasks = library.books.find((b) => b.id === bookId)?.tasks || []; const mine = tasks.filter((t) => t.chapterId === chapterId); const task = mine.find((t) => t.status === "running") || mine.find((t) => ["queued", "paused"].includes(t.status)) || mine[0]; reader?.update(next, task); }
      catch (e) { if (token === navigationId) notify(e.message); }
      if (token === navigationId) readerPollTimer = setTimeout(poll, 1200);
    };
    poll();
  } catch (e) { notify(e.message); renderBook(bookId); }
}

async function startChapterAnalysis(book, chapter) {
  if (!confirm(`分析“${chapter.title}”中的术语、人物和疑难项？本次操作会调用已配置的翻译引擎，结果先进入待确认区，不会直接改变固定译名。`)) return;
  try { await request(`/api/books/${book.id}/chapters/${chapter.id}/analyze`, { method: "POST" }); await load(); notify("分析任务已进入队列"); }
  catch (error) { notify(error.message); }
}

async function extractBook(bookId) {
  try { await request(`/api/books/${bookId}/extract`, { method: "POST" }); notify("章节识别任务已开始"); await load(); renderBook(bookId); }
  catch (error) { notify(error.message); }
}

async function startTranslation(book, chapter, mode, range = { type: "whole" }, retry = false, profileId) {
  try {
    // A saved profile carries its own credentials; only the active engine needs checking here.
    const settings = profileId ? null : await request("/api/provider");
    if (settings && (!settings.backend || settings.backend === "http") && !(settings.baseUrl && settings.model && (settings.hasApiKey || settings.noAuth))) { notify("请先选择翻译引擎"); switchView("settings"); return; }
    await request(`/api/books/${book.id}/chapters/${chapter.id}/translate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, range, retry, ...(profileId ? { profileId } : {}) }) });
    notify(retry ? "已从未完成块继续" : "翻译已加入队列，可以继续阅读"); await load();
  } catch (error) { notify(error.message); }
}

async function saveScope(book, chapterIds) {
  const name = document.querySelector("#scope-name").value.trim();
  try { await request(`/api/books/${book.id}/scopes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, chapterIds }) }); await load(); renderBook(book.id); notify("选集已保存"); } catch (error) { notify(error.message); }
}

async function deleteScope(book, scopeId) {
  const scope = (book.scopes || []).find((item) => item.id === scopeId); if (!scope) return;
  if (!confirm(`删除选集“${scope.name}”？只会删除这份章节选择，不会删除原书或译文。`)) return;
  try { await request(`/api/books/${book.id}/scopes/${scopeId}`, { method: "DELETE" }); await load(); renderBook(book.id); notify("选集已删除"); } catch (error) { notify(error.message); }
}

async function translateSelected(book, chapterIds) {
  if (!chapterIds.length) return notify("请先选择至少一个章节");
  if (!confirm(`将 ${chapterIds.length} 个章节依次加入本地翻译队列？任务会逐章调用 API。`)) return;
  try { for (const chapterId of chapterIds) await request(`/api/books/${book.id}/chapters/${chapterId}/translate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "draft", range: { type: "whole" } }) }); await load(); renderBook(book.id); notify(`${chapterIds.length} 个章节已加入队列`); } catch (error) { notify(error.message); }
}

async function saveSegment(book, chapter, segmentId, statusValue) {
  if (!confirmDiscardReaderEdit()) return;
  const translation = document.querySelector(`[data-segment-text="${segmentId}"]`).value;
  try { await request(`/api/books/${book.id}/chapters/${chapter.id}/segments/${segmentId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ translation, status: statusValue }) }); notify(statusValue === "approved" ? "节选已批准，可单独导出" : "节选修改已保存"); renderWorkspace(book.id, chapter.id); } catch (error) { notify(error.message); }
}

async function saveChapter(book, chapter, statusValue) {
  try {
    const translation = document.querySelector("#translation").value.trim();
    const payload = { status: statusValue };
    if (translation !== String(chapter.translation || "").trim()) payload.translation = translation;
    const updated = await request(`/api/books/${book.id}/chapters/${chapter.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    Object.assign(chapter, updated); notify(statusValue === "approved" ? "本章已标记定稿" : "修改已保存"); renderWorkspace(book.id, chapter.id);
  } catch (error) { notify(error.message); }
}

function renderTasks() {
  setHeader("本地队列", "任务中心");
  const rank = { queued: 0, running: 0, paused: 1, failed: 2, cancelled: 3, completed: 4 };
  const tasks = data.books.flatMap((book) => (book.tasks || []).map((task) => ({ ...task, bookTitle: book.title, bookId: book.id, demo: book.demo }))).sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
  const active = tasks.filter((task) => ["queued", "running", "paused"].includes(task.status)); const history = tasks.filter((task) => !["queued", "running", "paused"].includes(task.status));
  const rows = (items, activeRows = false) => items.map((task) => `<div class="task-row ${activeRows ? "active-task" : ""}"><div><strong>${escapeHtml(task.type)}</strong><small class="subline">${escapeHtml(task.bookTitle)}</small></div><div><span>${escapeHtml(task.detail || task.type)}</span>${task.error ? `<small class="task-error">${escapeHtml(friendlyTaskError(task))}</small>` : ""}<div class="progress"><i style="width:${task.progress || 0}%"></i></div><small>${formatDate(task.updatedAt || task.createdAt)}</small></div><span>${status(task.status)}</span><div class="task-actions"><button data-task-open="${task.id}">打开成果</button>${["failed", "cancelled"].includes(task.status) && task.chapterId ? `<button data-task-retry="${task.id}">继续翻译</button>` : ""}${!task.demo && ["queued", "running"].includes(task.status) ? `<button data-task-action="pause" data-task="${task.id}">暂停</button><button data-task-action="cancel" data-task="${task.id}">取消</button>` : !task.demo && task.status === "paused" ? `<button data-task-action="resume" data-task="${task.id}">继续</button><button data-task-action="cancel" data-task="${task.id}">取消</button>` : `<button data-task-delete="${task.id}">删除</button>`}</div></div>`).join("");
  content.innerHTML = `<div class="section-head"><div><p class="eyebrow">NOW / 当前状态</p><h2>正在运行</h2></div><span>${active.length} 个</span></div><div class="panel active-task-list">${rows(active, true) || '<div class="empty slim">当前没有运行中的任务。可以继续阅读或选择章节开始翻译。</div>'}</div><div class="section-head"><div><p class="eyebrow">HISTORY / 最近记录</p><h2>历史任务</h2></div>${history.length ? '<button id="clear-finished-tasks">清理全部历史</button>' : ""}</div><div class="panel">${rows(history) || '<div class="empty slim">暂无历史任务</div>'}</div>`;
  content.querySelectorAll("[data-task-action]").forEach((button) => button.onclick = () => taskAction(button.dataset.task, button.dataset.taskAction));
  content.querySelectorAll("[data-task-delete]").forEach((button) => button.onclick = () => deleteTask(button.dataset.taskDelete));
  content.querySelectorAll("[data-task-open]").forEach((button) => button.onclick = () => { const task = tasks.find((t) => t.id === button.dataset.taskOpen); task.chapterId ? renderWorkspace(task.bookId, task.chapterId) : renderBook(task.bookId); });
  content.querySelectorAll("[data-task-retry]").forEach((button) => button.onclick = async () => { const task = tasks.find((t) => t.id === button.dataset.taskRetry); const book = data.books.find((b) => b.id === task.bookId); await startTranslation(book, book.chapters.find((c) => c.id === task.chapterId), task.mode, task.range, true); renderWorkspace(book.id, task.chapterId); });
  const clearFinished = document.querySelector("#clear-finished-tasks"); if (clearFinished) clearFinished.onclick = clearFinishedTasks;
  if (tasks.some((task) => !task.demo && ["queued", "running", "paused"].includes(task.status))) taskPollTimer = setTimeout(async () => { await load(); if (currentView === "tasks") renderTasks(); }, 1500);
}

async function taskAction(taskId, action) { try { await request(`/api/tasks/${taskId}/${action}`, { method: "POST" }); await load(); renderTasks(); } catch (error) { notify(error.message); } }
async function deleteTask(taskId) { try { await request(`/api/tasks/${taskId}`, { method: "DELETE" }); await load(); renderTasks(); notify("任务记录已删除"); } catch (error) { notify(error.message); } }
async function clearFinishedTasks() { if (!confirm("清理全部已完成、失败和已取消任务记录？译文与章节不会被删除。")) return; try { const result = await request("/api/tasks?finished=1", { method: "DELETE" }); await load(); renderTasks(); notify(`已清理 ${result.deleted} 条历史任务`); } catch (error) { notify(error.message); } }

function renderGlossary() {
  setHeader("读者视角", "阅读质量");
  const quality = summarizeLibraryQuality(data.books);
  const analyzedChapters = data.books.flatMap((b) => b.chapters).filter((c) => c.analysis).length;
  const concerns = data.books.flatMap((book) => (book.chapters || []).flatMap((chapter) => (chapter.quality?.autoChecks || []).filter((check) => check.verdict !== "supported").map((check) => ({ ...check, bookId: book.id, bookTitle: book.title, chapterId: chapter.id, chapterTitle: chapter.title })))).slice(0, 8);
  const rows = data.books.flatMap((book) => [
    ...(book.glossary || []).map((item) => ({ ...item, book: book.title, bookId: book.id, kind: "glossary", kindLabel: "术语", categoryLabel: item.category || "未分类", japanese: item.japanese, chinese: item.chinese, detail: item.definition || item.translatorNote || item.notes || "" })),
    ...(book.characters || []).map((item) => ({ ...item, book: book.title, bookId: book.id, kind: "characters", kindLabel: "人物", categoryLabel: "人物", japanese: item.japanese || item.japaneseName, chinese: item.chinese || item.chineseName, detail: item.definition || item.translatorNote || item.identity || item.notes || "" }))
  ]);
  const candidates = data.books.flatMap((book) => [
    ...(book.termCandidates || []).map((item) => ({ ...item, book: book.title, bookId: book.id, kind: "term", kindLabel: "术语", categoryLabel: item.category || "未分类", detail: item.note || "" })),
    ...(book.characterCandidates || []).map((item) => ({ ...item, book: book.title, bookId: book.id, kind: "character", kindLabel: "人物", categoryLabel: "人物", detail: item.identity }))
  ]);
  const inBook = (item) => !glossaryBookFilter || item.bookId === glossaryBookFilter;
  const categories = [...new Set([...rows, ...candidates].filter(inBook).map((item) => item.categoryLabel).concat("章节疑难"))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  if (glossaryCategoryFilter && !categories.includes(glossaryCategoryFilter)) glossaryCategoryFilter = "";
  const visible = (item) => inBook(item) && (!glossaryCategoryFilter || item.categoryLabel === glossaryCategoryFilter);
  const visibleRows = rows.filter(visible); const visibleCandidates = candidates.filter(visible);
  const questions = data.books.flatMap((book) => (book.uncertainties || []).map((item) => ({ ...item, book: book.title, bookId: book.id, kind: "uncertainty" }))).filter((item) => inBook(item) && (!glossaryCategoryFilter || glossaryCategoryFilter === "章节疑难"));
  const bookOptions = data.books.map((book) => `<option value="${book.id}" ${glossaryBookFilter === book.id ? "selected" : ""}>${escapeHtml(book.title)}</option>`).join("");
  const categoryOptions = categories.map((category) => `<option value="${escapeHtml(category)}" ${glossaryCategoryFilter === category ? "selected" : ""}>${escapeHtml(category)}</option>`).join("");
  content.innerHTML = `<div class="quality-note" style="margin-bottom:16px">翻译和译者注由 AI 完成，你可以直接阅读。这里仅提示可能影响理解、尚缺公开资料支持的地方。</div>
  <div class="quality-summary"><div><strong>${quality.revised}</strong><span>已自动修正</span></div><div><strong>${quality.unresolved}</strong><span>仍待核实</span></div><div><strong>${quality.checked}</strong><span>高风险检查</span></div></div>
  <p class="notice" id="quality-search-status">正在读取联网搜索状态…</p>
  <section class="panel panel-pad"><div class="section-head compact"><div><h2>可能影响阅读的疑点</h2><p>没有可靠证据时，AI 会保持审慎，不把猜测写成定论。</p></div></div>${concerns.map((item) => `<div class="term"><strong>${escapeHtml(item.bookTitle)} · ${escapeHtml(item.chapterTitle)} · ${escapeHtml(item.originalTerm)}</strong><small>${escapeHtml(item.reason || "仍待核实")} · ${item.verdict === "unavailable" ? "搜索不可用" : "证据不足"}</small><button data-quality-chapter="${escapeHtml(item.bookId)}" data-quality-chapter-id="${escapeHtml(item.chapterId)}">打开章节</button></div>`).join("") || '<p>目前没有自动检查留下的阅读疑点。</p>'}</section>
  <details class="advanced-research"><summary>查看译名、人物与疑难项详情（高级）</summary><div class="advanced-research-body">
  <div class="panel panel-pad glossary-filters"><label>先选书名<select id="glossary-filter-book"><option value="">全部作品</option>${bookOptions}</select></label><label>再选分类<select id="glossary-filter-category"><option value="">全部分类</option>${categoryOptions}</select></label><span>${visibleRows.length} 条固定译名 · ${visibleCandidates.length} 条待确认</span></div>
  <details class="manual-term"><summary>＋ 手工添加固定译名 <small>只收录有复用或注释价值的条目</small></summary><form class="panel panel-pad glossary-add" id="glossary-form"><select id="glossary-book" aria-label="所属作品">${data.books.filter((book) => !book.demo).map((book) => `<option value="${book.id}" ${glossaryBookFilter === book.id ? "selected" : ""}>${escapeHtml(book.title)}</option>`).join("")}</select><input id="glossary-ja" aria-label="原文词条" placeholder="原文词条" required/><input id="glossary-reading" aria-label="读音" placeholder="读音（可选）"/><input id="glossary-zh" aria-label="中文译名" placeholder="中文译名" required/><select id="glossary-category" aria-label="分类"><option>术语</option><option>人物</option><option>人名以外的专名</option><option>地名</option><option>制度/组织</option><option>历史术语</option><option>其他</option></select><input id="glossary-definition" aria-label="含义、身份或译者注" placeholder="含义 / 身份（即译者注，如：此处指京都城内）"/><button class="primary" type="submit">添加并批准</button></form></details>
  <div class="section-head"><div><h2>待考证 · 译名候选</h2><p>有全书复用价值的名称；AI 先查证，你再定稿</p></div><span>${visibleCandidates.length} 条</span></div><div class="panel"><table class="table"><thead><tr><th>作品 / 章节</th><th>分类</th><th>原文 → 建议译名</th><th>含义 / 身份（译者注）</th><th>操作</th></tr></thead><tbody>${visibleCandidates.map((item) => `<tr><td>${escapeHtml(item.book)}<small class="subline">${escapeHtml(item.chapter)}</small></td><td>${escapeHtml(item.categoryLabel)}</td><td><strong>${escapeHtml(item.japanese)} → ${escapeHtml(item.chinese)}</strong><small class="subline">${escapeHtml(item.reading || "")}</small></td><td>${escapeHtml(cleanReaderExplanation(item.research?.definition || item.research?.translatorNote || item.detail || "") || "待补充释义")}<small class="subline">${item.research ? `AI 已检索 · ${escapeHtml(item.research.confidence)} 可信度` : "AI 尚未联网核实"}</small></td><td><button class="primary" data-candidate-verify="${item.id}">考证 / 定稿</button> <button data-candidate-action="reject" data-kind="${item.kind}" data-book="${item.bookId}" data-candidate="${item.id}">忽略</button></td></tr>`).join("") || '<tr><td colspan="5" class="empty">当前筛选下没有译名候选。</td></tr>'}</tbody></table></div>
  <div class="section-head"><div><h2>待考证 · 章节疑难</h2><p>只影响某一处原文，不进入全书固定译名</p></div><span>${questions.filter((item) => item.status !== "resolved").length} 条待处理</span></div><div class="panel"><table class="table"><thead><tr><th>作品 / 章节</th><th>类型</th><th>原文疑点</th><th>AI 查证与判断</th><th>操作</th></tr></thead><tbody>${questions.map((item) => `<tr><td>${escapeHtml(item.book)}<small class="subline">${escapeHtml(item.chapter)}</small></td><td>${escapeHtml(item.type)}</td><td><strong>${escapeHtml(item.text)}</strong><small class="subline">${escapeHtml(item.note || "")}</small></td><td>${escapeHtml(item.research?.definition || item.research?.translatorNote || item.resolution || "尚未判断")}${item.research ? `<small class="subline">AI 已检索 · ${escapeHtml(item.research.confidence)} 可信度</small>` : ""}</td><td><button class="primary" data-uncertainty-verify="${item.id}" data-book="${item.bookId}">AI 联网核实</button>${item.status === "resolved" ? ` <button data-uncertainty-reopen="${item.id}" data-book="${item.bookId}">重新打开</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="5" class="empty">当前筛选下没有章节疑难。</td></tr>'}</tbody></table></div>
  <div class="section-head"><div><h2>已定稿 · 固定译名与译者注</h2><p>“含义 / 身份”就是 AI 译者提供、供读者阅读的译者注</p></div></div><div class="panel"><table class="table"><thead><tr><th>作品 / 分类</th><th>固定译名</th><th>含义 / 身份（译者注）</th><th>操作</th></tr></thead><tbody>${visibleRows.map((item) => `<tr><td><strong>${escapeHtml(item.book)}</strong><small class="subline">${escapeHtml(item.categoryLabel)}</small></td><td><strong>${escapeHtml(item.japanese)} → ${escapeHtml(item.chinese)}</strong><small class="subline">${escapeHtml(item.reading || "")}</small></td><td>${escapeHtml(cleanReaderExplanation(item.detail || "") || "待补充含义")}</td><td>${item.id && !data.books.find((book) => book.id === item.bookId)?.demo ? `<button data-approved-verify="${item.id}" data-book="${item.bookId}" data-kind="${item.kind}">AI 查证 / 编辑</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="4" class="empty">当前筛选下没有已批准的固定译名。</td></tr>'}</tbody></table></div></div></details>`;
  request("/api/search-settings").then((settings) => { const target = document.querySelector("#quality-search-status"); if (target) target.textContent = searchStatus(settings); }).catch(() => {});
  content.querySelectorAll("[data-quality-chapter]").forEach((button) => button.onclick = () => renderWorkspace(button.dataset.qualityChapter, button.dataset.qualityChapterId));
  content.insertAdjacentHTML("afterbegin", `<p class="notice">${analyzedChapters ? `已分析 ${analyzedChapters} 章；具体覆盖范围可在章节工具中查看。` : "尚未检查。完成翻译后会分析注释，零条记录不代表没有问题。"}</p>`);
  const form = document.querySelector("#glossary-form"); if (!data.books.some((book) => !book.demo)) form.innerHTML = '<div class="notice">导入真实作品后，可以在这里建立该书的术语表。</div>'; else form.addEventListener("submit", addGlossaryTerm);
  document.querySelector("#glossary-filter-book").onchange = (event) => { glossaryBookFilter = event.target.value; glossaryCategoryFilter = ""; renderGlossary(); };
  document.querySelector("#glossary-filter-category").onchange = (event) => { glossaryCategoryFilter = event.target.value; renderGlossary(); };
  content.querySelectorAll("[data-candidate-action]").forEach((button) => button.onclick = () => reviewCandidate(button.dataset.book, button.dataset.kind, button.dataset.candidate, button.dataset.candidateAction));
  content.querySelectorAll("[data-candidate-verify]").forEach((button) => button.onclick = () => openVerification(candidates.find((item) => item.id === button.dataset.candidateVerify), "candidate"));
  content.querySelectorAll("[data-approved-verify]").forEach((button) => button.onclick = () => openVerification(rows.find((item) => item.id === button.dataset.approvedVerify && item.bookId === button.dataset.book && item.kind === button.dataset.kind), "approved"));
  content.querySelectorAll("[data-uncertainty-verify]").forEach((button) => button.onclick = () => openVerification(questions.find((item) => item.id === button.dataset.uncertaintyVerify && item.bookId === button.dataset.book), "uncertainty"));
  content.querySelectorAll("[data-uncertainty-reopen]").forEach((button) => button.onclick = async () => { try { await request(`/api/books/${button.dataset.book}/uncertainties/${button.dataset.uncertaintyReopen}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "open" }) }); await load(); renderGlossary(); notify("已重新打开疑难项"); } catch (error) { notify(error.message); } });
}

function verificationDialog() {
  let dialog = document.querySelector("#verification-dialog"); if (dialog) return dialog;
  dialog = document.createElement("dialog"); dialog.id = "verification-dialog";
  dialog.innerHTML = `<form method="dialog" class="dialog-form"><div class="dialog-title"><h2 id="verification-title">AI 查证此处</h2><button value="cancel" aria-label="关闭">×</button></div><p class="notice">AI 会尝试检索公开网页并阅读相关片段。找不到可信资料时会明确保留“未核实”；你无需审核原文。</p><div class="dialog-actions"><button type="button" id="verification-research" class="primary">查证此处</button></div><div id="verification-research-result" class="notice" aria-live="polite">尚未开始检索。</div><details class="advanced-research"><summary>高级编辑：手工调整译名或说明</summary><div class="dialog-actions"><button type="button" id="verification-apply" hidden>采用 AI 建议填入下方</button><button type="button" id="verification-clear" hidden>清除 AI 建议</button></div><label id="verify-translation-label">采用的中文译名<input id="verification-translation"/></label><label id="verify-definition-label">含义 / 身份（即译者注）<textarea id="verification-definition" rows="3"></textarea></label><label>采用的来源 URL<input id="verification-source" type="url" placeholder="仅填写实际阅读的来源"/></label><label>查证说明<textarea id="verification-note" rows="3"></textarea></label><label id="verify-resolution-label">本条疑难的最终判断<textarea id="verification-resolution" rows="3"></textarea></label><div class="dialog-actions"><button type="button" id="verification-save">保存编辑</button><button type="button" id="verification-resolve">保存并标记已解决</button></div></details></form>`;
  document.body.append(dialog);
  dialog.querySelector("#verification-save").onclick = () => saveVerification(false);
  dialog.querySelector("#verification-resolve").onclick = () => saveVerification(true);
  dialog.querySelector("#verification-research").onclick = runAiResearch;
  dialog.querySelector("#verification-apply").onclick = () => applyResearchSuggestion(dialog);
  dialog.querySelector("#verification-clear").onclick = clearAiResearch;
  return dialog;
}

function openVerification(item, mode) {
  if (!item) return;
  const dialog = verificationDialog(); dialog.dataset.mode = mode; dialog.dataset.book = item.bookId; dialog.dataset.kind = item.kind || ""; dialog.dataset.item = item.id;
  dialog.querySelector("#verification-title").textContent = mode === "uncertainty" ? `查证疑难：${item.text}` : `核实译名：${item.japanese}`;
  dialog.querySelector("#verification-translation").value = item.chinese || "";
  dialog.querySelector("#verification-definition").value = item.definition || item.translatorNote || item.detail || "";

  dialog.querySelector("#verification-source").value = item.sourceUrl || "";
  dialog.querySelector("#verification-note").value = item.verificationNote || "";
  dialog.querySelector("#verification-resolution").value = item.resolution || "";
  dialog.research = item.research || null;
  showResearchSuggestion(dialog);
  dialog.querySelector("#verify-translation-label").hidden = mode === "uncertainty";
  dialog.querySelector("#verify-definition-label").hidden = mode === "uncertainty";
  dialog.querySelector("#verify-resolution-label").hidden = mode !== "uncertainty";
  dialog.querySelector("#verification-resolve").hidden = mode !== "uncertainty";
  dialog.querySelector("#verification-save").textContent = mode === "candidate" ? "加入固定译名" : mode === "uncertainty" ? "保存编辑" : "保存编辑";
  dialog.showModal();
}

function showResearchSuggestion(dialog) {
  const result = dialog.research; const box = dialog.querySelector("#verification-research-result");
  dialog.querySelector("#verification-apply").hidden = !result?.suggestedChinese && !result?.definition;
  dialog.querySelector("#verification-clear").hidden = !result;
  if (!result) { box.textContent = "尚未开始检索。"; return; }
  const state = { supported: "资料支持", conflicted: "资料冲突", insufficient: "证据不足", unavailable: "搜索不可用" }[result.verdict] || "未核实";
  const links = (result.sources || []).map((source) => `<div><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title || source.url)}</a><small>网页片段：${escapeHtml(source.excerpt || "")}</small></div>`).join("");
  box.innerHTML = `<strong>${state}</strong><p>${escapeHtml(result.definition || result.reason || "没有找到可用的公开资料；现有译文可以继续阅读。")}</p>${result.definition && result.reason ? `<p>依据和局限：${escapeHtml(result.reason)}</p>` : ""}${result.remainingQuestion ? `<p>仍待确认：${escapeHtml(result.remainingQuestion)}</p>` : ""}<details><summary>查看依据与网页片段</summary><div class="verify-links">${links || "暂无可读取的来源"}</div></details>`;
}

async function clearAiResearch() {
  const dialog = verificationDialog(); const { book, kind, item, mode } = dialog.dataset;
  try {
    await request(`/api/books/${book}/research/${mode === "uncertainty" ? "uncertainty" : kind}/${item}`, { method: "DELETE" });
    dialog.research = null; showResearchSuggestion(dialog); await load(); notify("已清除 AI 考证建议；定稿内容未改动");
  } catch (error) { notify(error.message); }
}

function applyResearchSuggestion(dialog) {
  const result = dialog.research; if (!result) return;
  if (result.suggestedChinese && dialog.dataset.mode !== "uncertainty") dialog.querySelector("#verification-translation").value = result.suggestedChinese;
  if (dialog.dataset.mode === "uncertainty") dialog.querySelector("#verification-resolution").value = result.definition || result.translatorNote || "";
  else dialog.querySelector("#verification-definition").value = result.definition || result.translatorNote || "";

  dialog.querySelector("#verification-note").value = [result.reason, result.remainingQuestion ? `仍待确认：${result.remainingQuestion}` : ""].filter(Boolean).join("\n");
  dialog.querySelector("#verification-source").value = result.sourceUrls?.[0] || "";
}

async function runAiResearch() {
  const dialog = verificationDialog(); const { book, kind, item, mode } = dialog.dataset;
  const button = dialog.querySelector("#verification-research"); const resultBox = dialog.querySelector("#verification-research-result");
  let settings;
  try { settings = await request("/api/search-settings"); } catch (error) { resultBox.textContent = `无法读取搜索设置：${error.message}`; return; }
  if (!settings.hasApiKey) { resultBox.textContent = "尚未填写独立搜索 Key。初译与现有译者注不受影响；可在 API 设置中配置搜索服务。"; return; }
  const estimated = Math.min(settings.requestsPerItem, settings.remaining);
  if (!estimated) { resultBox.textContent = searchStatus(settings); return; }
  if (!confirm(`这次查证最多发起 ${estimated} 次联网搜索；今天剩余 ${settings.remaining} 次。继续吗？`)) return;
  button.disabled = true; button.textContent = "AI 正在检索与比对…"; resultBox.textContent = "正在检索公开资料并请当前配置的翻译模型分析，可能需要几十秒。";
  try {
    const result = await request(`/api/books/${book}/research/${mode === "uncertainty" ? "uncertainty" : kind}/${item}`, { method: "POST" });
    dialog.research = result; showResearchSuggestion(dialog);
    await load(); notify("AI 查证结果已保存；你可以继续阅读");
  } catch (error) { resultBox.textContent = `AI 联网核实失败：${error.message}`; }
  finally { button.disabled = false; button.textContent = "重新让 AI 联网核实"; }
}

async function saveVerification(resolveUncertainty) {
  const dialog = verificationDialog(); const { mode, book, kind, item } = dialog.dataset;
  const sourceUrl = dialog.querySelector("#verification-source").value.trim();
  const verificationNote = dialog.querySelector("#verification-note").value.trim();
  const chinese = dialog.querySelector("#verification-translation").value.trim();
  const definition = dialog.querySelector("#verification-definition").value.trim();

  const resolution = dialog.querySelector("#verification-resolution").value.trim();
  if (mode === "uncertainty" && !sourceUrl && !resolution) return notify("请填写查证来源或处理判断");
  if (resolveUncertainty && !resolution) return notify("请先写明最终判断，再标记已解决");
  try {
    if (mode === "candidate") await request(`/api/books/${book}/${kind}-candidates/${item}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceUrl, verificationNote, chinese, definition }) });
    else if (mode === "approved") await request(`/api/books/${book}/${kind}/${item}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceUrl, verificationNote, chinese, definition }) });
    else await request(`/api/books/${book}/uncertainties/${item}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceUrl, verificationNote, resolution, status: resolveUncertainty ? "resolved" : undefined }) });
    dialog.close(); await load(); renderGlossary(); notify(resolveUncertainty ? "疑难项已记录判断并解决" : "查证记录已保存");
  } catch (error) { notify(error.message); }
}

async function reviewCandidate(bookId, kind, candidateId, action, payload = {}) {
  try { await request(`/api/books/${bookId}/${kind}-candidates/${candidateId}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }); await load(); renderGlossary(); notify(action === "approve" ? (payload.sourceUrl ? "已核实并批准，将用于后续翻译" : "已按人工决定批准") : "已忽略建议"); return true; }
  catch (error) { notify(error.message); }
  return false;
}

async function addGlossaryTerm(event) {
  event.preventDefault(); const bookId = document.querySelector("#glossary-book").value;
  const payload = { japanese: document.querySelector("#glossary-ja").value, reading: document.querySelector("#glossary-reading").value, chinese: document.querySelector("#glossary-zh").value, category: document.querySelector("#glossary-category").value, definition: document.querySelector("#glossary-definition").value };
  try { await request(`/api/books/${bookId}/glossary`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }); await load(); renderGlossary(); notify("术语已加入后续翻译上下文"); } catch (error) { notify(error.message); }
}

function renderExports() {
  setHeader("Apple Books", "导出中心");
  content.innerHTML = `<div class="export-primary"><p class="eyebrow">EPUB / APPLE BOOKS</p><h2>把已翻译的章节带到 iPad 阅读</h2></div><div class="panel">${data.books.map((book) => { const info = progress(book); return `<div class="export-card"><div><strong>${escapeHtml(book.title)}</strong><p style="margin:5px 0 0;color:var(--muted)">${info.approved} 个已标记定稿章节 · EPUB 3 可重排版</p></div><div><button data-approved="${book.id}" ${info.approved ? "" : "disabled"}>仅定稿版</button> <button class="primary" data-draft="${book.id}" ${book.chapters.some((c) => c.translation || c.translationPath || c.polishedPath || c.activeRevisionId) ? "" : "disabled"}>导出可阅读版</button></div></div>`; }).join("") || '<div class="empty slim">书库为空。导入并翻译作品后，可以在这里导出 EPUB。</div>'}</div>
  <div class="section-head"><div><h2>最近导出</h2><p>文件保存在本地 exports 目录</p></div></div><div class="panel">${(data.exports || []).map((item) => `<div class="export-card"><div><strong>${escapeHtml(item.filename)}</strong><p style="margin:5px 0 0;color:var(--muted)">${escapeHtml(item.bookTitle)} · ${item.chapterCount} 章 · ${formatDate(item.createdAt)}</p></div><a href="/api/exports/${encodeURIComponent(item.filename)}"><button>下载</button></a></div>`).join("") || '<div class="empty">尚未生成 EPUB</div>'}</div>`;
  content.querySelectorAll("[data-approved]").forEach((button) => button.onclick = () => exportEpub(button.dataset.approved, false));
  content.querySelectorAll("[data-draft]").forEach((button) => button.onclick = () => exportEpub(button.dataset.draft, true));
}

async function exportEpub(bookId, includeDraft, chapterIds = [], selectionOnly = false) {
  try {
    await load(); const book = data.books.find((b) => b.id === bookId);
    const candidates = selectionOnly ? book.chapters.flatMap((c) => c.segments || []) : book.chapters.filter((c) => !chapterIds.length || chapterIds.includes(c.id));
    const ready = candidates.filter((c) => (c.translation || c.translationPath || c.polishedPath || c.activeRevisionId) && (includeDraft || c.status === "approved"));
    if (!ready.length) return notify("当前范围没有可导出的译文，请先翻译章节");
    const dialog = document.createElement("dialog"); dialog.className = "export-preview";
    dialog.innerHTML = `<div class="dialog-head"><h2>导出预览</h2><button id="cancel-export" aria-label="关闭导出预览">×</button></div><p>${escapeHtml(book.title)} · ${ready.length} 个章节${includeDraft ? "（含草稿）" : "（仅定稿）"}</p><p>将跳过 ${candidates.length - ready.length} 个无译文或不符合范围的章节。</p><ul>${ready.map((c) => `<li>${escapeHtml(c.title || c.label)}</li>`).join("")}</ul><div class="dialog-actions"><button id="confirm-export" class="primary">生成 EPUB</button></div>`;
    document.body.append(dialog); dialog.showModal();
    const accepted = await new Promise((resolve) => { dialog.querySelector("#cancel-export").onclick = () => { dialog.close(); resolve(false); }; dialog.querySelector("#confirm-export").onclick = () => { dialog.close(); resolve(true); }; dialog.oncancel = () => resolve(false); }); dialog.remove(); if (!accepted) return;
    notify("正在生成 EPUB…"); const result = await request(`/api/books/${bookId}/export/epub`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ includeDraft, chapterIds, selectionOnly }) });
    await load(); const anchor = document.createElement("a"); anchor.href = result.downloadUrl; anchor.click(); notify(`已生成 ${result.chapterCount} 章 EPUB`);
  } catch (error) { notify(error.message); }
}

async function renderSettings() {
  setHeader("本机引擎", "翻译设置");
  let capabilities;
  try { [providerSettings, searchSettings, capabilities] = await Promise.all([request("/api/provider"), request("/api/search-settings"), request("/api/capabilities")]); }
  catch (error) { content.innerHTML = `<div class="empty"><strong>无法读取 API 配置</strong>${escapeHtml(error.message)}</div>`; return; }
  const configured = providerSettings.backend && providerSettings.backend !== "http" || providerSettings.baseUrl && providerSettings.model && (providerSettings.hasApiKey || providerSettings.noAuth);
  const protectionText = providerSettings.keyProtection === "windows-dpapi" ? "密钥已使用 Windows 当前用户加密。" : providerSettings.hasApiKey ? "当前环境无法调用 Windows 加密，密钥以仅限本机配置文件方式保存。" : "尚未保存密钥。";
  const selectedPreset = matchingProviderPreset(providerSettings);
  const presetOptions = Object.entries(providerPresets).map(([id, preset]) => `<option value="${id}" ${selectedPreset === id ? "selected" : ""}>${escapeHtml(preset.label)}</option>`).join("");
  content.innerHTML = `<div class="settings-layout">
    <section class="panel panel-pad lifecycle-panel"><div class="section-head settings-head"><div><h2>后台运行</h2><p>运行窗口可以最小化。关闭网页后，后台和翻译任务仍会继续。</p></div><button id="settings-shutdown">关闭后台</button></div></section>
    <details class="panel panel-pad storage-panel"><summary>本机数据与迁移</summary><div class="section-head settings-head"><div><h2>本机数据</h2><p>书籍、译文、导出和 API 配置保存在此目录。</p></div></div><code>${escapeHtml(capabilities.dataDirectory || "")}</code><p>如需迁移，请先停止工作台，再复制整个数据目录；启动前可设置 <code>TRANSLATION_LIBRARY_DATA_DIR</code> 指向新位置。</p></details>
    <form class="panel panel-pad settings-form" id="provider-form">
      <div class="section-head settings-head"><div><h2>翻译引擎 <span class="default-badge">翻译与注释</span></h2><p>选择 API 或已安装的 CLI；翻译、精校与注释使用同一引擎。</p></div>${status(configured ? "approved" : "open", configured ? "已配置" : "待配置")}</div>
      <label>引擎<select id="provider-backend">${["http", "codex", "opencode", "antigravity", "claude"].map((id) => `<option value="${id}" ${id === (providerSettings.backend || "http") ? "selected" : ""}>${{ http: "翻译 API", codex: "Codex CLI", opencode: "OpenCode CLI", antigravity: "Antigravity CLI", claude: "Claude Code CLI" }[id]}</option>`).join("")}</select></label>
      <div id="cli-settings">
      <label id="opencode-mode-label">OpenCode 连接方式<select id="opencode-mode"><option value="cli" ${providerSettings.opencodeMode !== "server" ? "selected" : ""}>直接调用 CLI</option><option value="server" ${providerSettings.opencodeMode === "server" ? "selected" : ""} ${providerSettings.supportsOpenCodeServer ? "" : "disabled"}>连接本地服务 · 在桌面端查看会话</option></select></label>
      <p id="opencode-mode-notice">当前后台尚未加载本地服务接入，请关闭并重新启动瀟湘館后台后使用。</p>
      <div id="opencode-server-settings">
        <p>工作台与 OpenCode 桌面端请选择同一服务，并打开相同项目目录。生成的分段会话会保留在该目录下。</p>
        <label>本地服务地址<input id="opencode-server-url" value="${escapeAttribute(providerSettings.opencodeServerUrl || "http://127.0.0.1:4096")}" placeholder="http://127.0.0.1:4096"/></label>
        <label>固定项目目录<input id="opencode-directory" value="${escapeAttribute(providerSettings.opencodeDirectory || "")}" placeholder="桌面端打开的本机目录绝对路径"/></label>
        <label>服务用户名<input id="opencode-username" value="${escapeAttribute(providerSettings.opencodeUsername || "opencode")}" autocomplete="off"/></label>
        <label>服务密码（未设置认证时留空）<input id="opencode-password" type="password" autocomplete="new-password" placeholder="${providerSettings.hasOpenCodePassword ? "已保存；留空保持，更换服务或用户名后需重新填写" : "与 OpenCode 服务的密码一致"}"/></label>
        <label class="check-row"><input type="checkbox" id="clear-opencode-password"/>清除已保存的服务密码</label>
        <p>可在终端运行 <code>opencode serve --hostname 127.0.0.1 --port 4096</code> 启动服务。取消翻译只停止对应会话；关闭工作台后台后，共用服务仍可供桌面端使用。</p>
      </div>
      <label id="cli-path-label">可执行文件路径（留空自动检测）<input id="provider-cli-path" value="${escapeAttribute(providerSettings.cliPath || "")}" placeholder="原生 CLI 可执行文件的绝对路径"/></label><label>模型<select id="provider-cli-model-select"><option value="">引擎默认模型</option><option value="__manual">手动填写模型 ID</option></select></label><label id="manual-cli-model">模型 ID（OpenCode 使用 provider/model）<input id="provider-cli-model" value="${escapeAttribute(providerSettings.backend !== "http" ? providerSettings.model || "" : "")}"/></label><label>推理强度<select id="provider-effort"><option value="">默认强度</option></select></label><button type="button" id="load-cli-models">读取模型与强度</button><p id="cli-model-hint">读取本机模型目录后，可选择对应的强度。</p><button type="button" id="probe-cli">检测安装</button><p id="cli-probe-result" role="status">登录状态尚未验证；使用引擎已有登录，测试成功后确认可用。</p></div>
      <div id="http-settings"><label class="preset-picker">服务商与模型<select id="provider-preset">${presetOptions}<option value="custom" ${selectedPreset === "custom" ? "selected" : ""}>自定义 · OpenAI 兼容接口</option></select></label>
      <div class="preset-note" id="preset-note"></div>
      <label>翻译 API 密钥<input id="provider-key" type="password" autocomplete="new-password" placeholder="${providerSettings.hasApiKey ? `已保存 ${escapeHtml(providerSettings.keyHint)}；留空则保持不变` : "粘贴 API Key"}"/></label>
      <details class="settings-advanced"><summary>高级设置：接口地址、模型参数与费用估算</summary>
      <div class="form-grid"><label>服务名称<input id="provider-name" value="${escapeHtml(providerSettings.providerName || "")}" placeholder="例如：我的翻译 API"/></label>
      <label>接口协议<select id="provider-protocol"><option value="openai-chat" ${providerSettings.protocol === "openai-chat" ? "selected" : ""}>OpenAI-compatible Chat Completions</option><option value="openai-responses" ${providerSettings.protocol === "openai-responses" ? "selected" : ""}>OpenAI Responses API</option></select></label></div>
      <label>API 基础地址<input id="provider-url" type="url" value="${escapeHtml(providerSettings.baseUrl || "")}" placeholder="https://example.com/v1"/></label>
      <div class="form-grid"><label>模型名称<input id="provider-model" value="${escapeHtml(providerSettings.model || "")}" placeholder="填写供应商提供的模型 ID"/></label>
      <label>单次最大输出 Token<input id="provider-max-output" type="number" min="256" max="131072" value="${providerSettings.maxOutputTokens || 8192}"/></label></div>
      <div class="form-grid"><label>每百万输入 Token 价格<input id="provider-input-price" type="number" min="0" step="0.0001" value="${providerSettings.inputPrice || 0}"/></label><label>每百万输出 Token 价格<input id="provider-output-price" type="number" min="0" step="0.0001" value="${providerSettings.outputPrice || 0}"/></label></div>
      <label class="check-row"><input id="provider-no-auth" type="checkbox" ${providerSettings.noAuth ? "checked" : ""}/> 本机接口不需要 API 密钥</label>
      <label class="check-row"><input id="clear-provider-key" type="checkbox"/> 清除当前已保存的密钥</label>
      </details></div>
      <label>每块原文目标字符数<input id="provider-block-chars" type="number" min="500" max="6000" step="1" required value="${providerSettings.translationBlockChars ?? 3000}" aria-describedby="provider-block-hint"/></label>
      <p id="provider-block-hint">默认 3000，可设为 500–6000；CLI 较慢时可调小。初译与精校均适用，保留完整段落，超长单段或精校合并段可能超过此值。保存后用于新任务；继续未完成任务沿用原分块。</p>
      <div id="provider-key-notice" class="notice">密钥只发送给你填写的 API 地址，网页不会重新显示完整密钥。${protectionText} 配置位于本机 <code>secrets</code> 目录；不要把该目录发给他人。</div>
      <div id="provider-test-result" class="notice hidden"></div>
      <div class="dialog-actions"><button id="test-provider" type="button">测试并保存</button><button class="primary" type="submit">保存引擎配置</button></div>
    </form>
    <section class="panel panel-pad profiles-panel" id="profiles-panel" aria-live="polite"><p class="profile-empty">正在读取引擎档案…</p></section>
    <form class="panel panel-pad settings-form" id="search-settings-form">
      <div class="section-head settings-head"><div><h2>联网搜索 API <span class="default-badge">可选 · 独立配置</span></h2><p>只用于少量高风险说法的 AI 查证；不影响初译、译名释义和读者注释。</p></div>${status(searchSettings.hasApiKey ? "approved" : "not_started", searchSettings.hasApiKey ? "已配置" : "可选")}</div>
      <p class="notice" id="search-usage-status">${escapeHtml(searchStatus(searchSettings))}。只有实际搜索请求计入额度；翻译模型用量单独计算。</p>
      <label>Brave Search API Key<input id="search-key" type="password" autocomplete="new-password" placeholder="${searchSettings.hasApiKey ? `已保存 ${escapeHtml(searchSettings.keyHint)}；留空则保持不变` : "填写独立的搜索 Key，不是翻译 API Key"}"/></label>
      <details class="settings-advanced"><summary>高级设置：搜索额度与自动核实数量</summary>
      <div class="form-grid"><label>每日搜索请求上限<input id="search-daily-limit" type="number" min="0" max="30" value="${searchSettings.dailyLimit}"/></label><label>每章自动核实项目上限<input id="search-auto-items" type="number" min="0" max="3" value="${searchSettings.autoItemsPerChapter}"/></label></div>
      <label>每项最多搜索请求<input id="search-requests-per-item" type="number" min="0" max="2" value="${searchSettings.requestsPerItem}"/></label>
      <label class="check-row"><input id="clear-search-key" type="checkbox"/> 清除搜索 Key</label>
      </details>
      <div id="search-test-result" class="notice hidden" aria-live="polite"></div>
      <div class="dialog-actions"><button type="button" id="test-search-settings">测试搜索连接</button><button class="primary" type="submit">保存搜索设置</button></div>
      <small>连接测试会实际发起一次搜索，计入今日额度；网页不会显示完整 Key。</small>
    </form>
  </div>`;
  document.querySelector("#settings-shutdown").onclick = shutdownWorkbench;
  let modelCatalog = [];
  const backendSelect = document.querySelector("#provider-backend"), modelSelect = document.querySelector("#provider-cli-model-select"), modelInput = document.querySelector("#provider-cli-model"), effortSelect = document.querySelector("#provider-effort");
  const effortLabels = { none: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "更高", max: "最高", ultra: "超高" };
  const updateEffort = (saved = "") => {
    const model = modelCatalog.find((m) => m.id === modelInput.value);
    const options = model?.reasoningEfforts || [];
    effortSelect.innerHTML = '<option value="">默认强度</option>' + options.map((value) => `<option value="${escapeAttribute(value)}">${escapeHtml(effortLabels[value] || value)}</option>`).join("");
    effortSelect.value = options.includes(saved) ? saved : "";
    effortSelect.disabled = !options.length;
    document.querySelector("#manual-cli-model").hidden = modelSelect.value !== "__manual";
  };
  modelSelect.value = modelInput.value ? "__manual" : "";
  modelSelect.onchange = () => { if (modelSelect.value !== "__manual") modelInput.value = modelSelect.value; else modelInput.value = ""; updateEffort(); };
  modelInput.oninput = () => updateEffort();
  const updateBackend = () => {
    const cli = backendSelect.value !== "http", opencode = backendSelect.value === "opencode", server = opencode && document.querySelector("#opencode-mode").value === "server";
    document.querySelector("#cli-settings").hidden = !cli; document.querySelector("#http-settings").hidden = cli; document.querySelector("#provider-key-notice").hidden = cli;
    document.querySelector("#opencode-mode-label").hidden = !opencode; document.querySelector("#opencode-server-settings").hidden = !server; document.querySelector("#cli-path-label").hidden = server;
    document.querySelector("#opencode-mode-notice").hidden = !opencode || Boolean(providerSettings.supportsOpenCodeServer);
    document.querySelector("#probe-cli").textContent = server ? "检测服务与目录" : "检测安装";
  }; updateBackend(); updateEffort();
  backendSelect.onchange = () => { document.querySelector("#provider-cli-path").value = ""; document.querySelector("#cli-model-hint").textContent = "读取本机模型目录后，可选择对应的强度。"; document.querySelector("#cli-probe-result").textContent = "登录状态尚未验证；使用 CLI 已有登录，测试成功后确认可用。"; modelCatalog = []; modelInput.value = ""; modelSelect.innerHTML = '<option value="">CLI 默认模型</option><option value="__manual">手动填写模型 ID</option>'; updateBackend(); updateEffort(); };
  for (const id of ["opencode-mode", "opencode-server-url", "opencode-directory", "opencode-username", "opencode-password", "clear-opencode-password", "provider-cli-path"]) document.getElementById(id).addEventListener("change", () => {
    modelCatalog = []; modelSelect.innerHTML = '<option value="">引擎默认模型</option><option value="__manual">手动填写模型 ID</option>'; modelSelect.value = modelInput.value ? "__manual" : ""; updateEffort(); updateBackend();
    document.querySelector("#cli-model-hint").textContent = "连接配置已变化，请重新读取模型与强度。"; document.querySelector("#cli-probe-result").textContent = "连接配置尚未检测。";
  });
  document.querySelector("#load-cli-models").onclick = async () => {
    const button = document.querySelector("#load-cli-models"), hint = document.querySelector("#cli-model-hint"); const connection = JSON.stringify(cliConnectionPayload());
    button.disabled = true; hint.textContent = "正在读取本机模型目录…";
    try {
      const result = await request("/api/provider/models", { method: "POST", headers: { "content-type": "application/json" }, body: connection });
      if (connection !== JSON.stringify(cliConnectionPayload())) return;
      modelCatalog = result.models; const selected = modelInput.value;
      modelSelect.innerHTML = '<option value="">CLI 默认模型</option>' + modelCatalog.map((m) => `<option value="${escapeAttribute(m.id)}">${escapeHtml(m.name)}</option>`).join("") + '<option value="__manual">手动填写模型 ID</option>';
      modelSelect.value = modelCatalog.some((m) => m.id === selected) ? selected : selected ? "__manual" : "";
      updateEffort(backendSelect.value === providerSettings.backend && selected === providerSettings.model ? providerSettings.reasoningEffort : "");
      hint.textContent = `${modelCatalog.length} 个模型 · ${result.hint}`;
    } catch (e) { if (connection === JSON.stringify(cliConnectionPayload())) hint.textContent = e.message; } finally { button.disabled = false; }
  };
  if (providerSettings.backend && providerSettings.backend !== "http") document.querySelector("#load-cli-models").click();
  document.querySelector("#probe-cli").onclick = async () => { const box = document.querySelector("#cli-probe-result"), connection = JSON.stringify(cliConnectionPayload()); box.textContent = "正在检测…"; try { const result = await request("/api/provider/probe", { method: "POST", headers: { "content-type": "application/json" }, body: connection }); if (connection !== JSON.stringify(cliConnectionPayload())) return; box.textContent = result.error || (result.mode === "server" ? `OpenCode ${result.version} · 服务可连接，项目目录匹配；模型调用需测试确认` : `${result.version || "已安装"} · ${result.login === "logged-in" ? "已登录，模型调用需测试确认" : result.login === "logged-out" ? "未登录或登录已过期：请在终端运行 claude，输入 /login 登录" : "登录状态需测试确认"}`); } catch (e) { if (connection === JSON.stringify(cliConnectionPayload())) box.textContent = e.message; } };
  document.querySelector("#provider-preset").addEventListener("change", applyProviderPreset);
  document.querySelector("#provider-key").addEventListener("input", (event) => { if (event.target.value) document.querySelector("#clear-provider-key").checked = false; });
  document.querySelector("#test-provider").addEventListener("click", testProviderSettings);
  document.querySelector("#provider-form").addEventListener("submit", saveProviderSettings);
  document.querySelector("#search-settings-form").addEventListener("submit", saveSearchSettings);
  document.querySelector("#test-search-settings").addEventListener("click", testSearchSettings);
  updatePresetNote();
  renderProfiles();
}

const ENGINE_NAMES = { http: "翻译 API", codex: "Codex CLI", opencode: "OpenCode CLI", antigravity: "Antigravity CLI", claude: "Claude Code CLI" };
function engineSummary(p) {
  const who = !p.backend || p.backend === "http" ? p.providerName || p.host || "翻译 API" : ENGINE_NAMES[p.backend] || p.backend;
  return [who, p.model || "默认模型", p.reasoningEffort].filter(Boolean).join(" · ");
}
// Saved engines with a colour each; the reader uses the same names and colours for version comparison.
async function renderProfiles() {
  const box = document.querySelector("#profiles-panel"); if (!box) return;
  let state;
  try { state = await request("/api/engine-profiles"); } catch (error) { box.innerHTML = `<p class="profile-empty">无法读取引擎档案：${escapeHtml(error.message)}</p>`; return; }
  if (!document.body.contains(box)) return;
  const used = new Set(state.profiles.map((p) => p.color));
  const nextColor = (state.palette.find((c) => !used.has(c.hex)) || state.palette[0]).hex;
  const swatches = (name, selected) => `<div class="swatches" role="radiogroup" aria-label="颜色">${state.palette.map((c) => `<label class="swatch" style="--v:${c.hex}" title="${escapeAttribute(c.name)}"><input type="radio" name="${escapeAttribute(name)}" value="${c.hex}" ${c.hex === selected ? "checked" : ""}/><span aria-hidden="true"></span><small>${escapeHtml(c.name)}</small></label>`).join("")}</div>`;
  const configured = providerSettings && (providerSettings.backend && providerSettings.backend !== "http" || providerSettings.baseUrl && providerSettings.model && (providerSettings.hasApiKey || providerSettings.noAuth));
  box.innerHTML = `<div class="section-head settings-head"><div><h2>引擎档案 <span class="default-badge">多译本对照</span></h2><p>把常用的 API 或 CLI 各存一份，配一种颜色。阅读页“再译一版”可以直接选用档案，译本对照也用这里的名字和颜色区分。密钥仍按上方的方式加密保存在本机。</p></div></div>
    <div class="profile-list">${state.profiles.map((p) => `<article class="profile-card${p.active ? " is-active" : ""}" style="--v:${p.color}" data-profile="${escapeAttribute(p.id)}">
      <div class="profile-main"><i class="profile-dot" aria-hidden="true"></i><div class="profile-text"><strong>${escapeHtml(p.name)}</strong>${p.active ? '<span class="profile-badge">正在使用</span>' : ""}<small>${escapeHtml(engineSummary(p))}</small></div></div>
      <div class="profile-actions"><button type="button" data-activate ${p.active ? "disabled" : ""}>${p.active ? "使用中" : "启用"}</button><button type="button" data-edit>改名 · 换色</button><button type="button" data-overwrite title="用上方已保存的引擎配置覆盖这份档案">更新为当前配置</button><button type="button" data-delete>删除</button></div>
      <div class="profile-editor" hidden><label>名称<input maxlength="40" value="${escapeAttribute(p.name)}"/></label>${swatches(`color-${p.id}`, p.color)}<div class="dialog-actions"><button type="button" data-cancel>取消</button><button type="button" class="primary" data-save>保存</button></div></div>
    </article>`).join("") || '<p class="profile-empty">还没有档案。先在上方配置好一个引擎并点“保存引擎配置”，再在下面起个名字存起来；换一个引擎，重复一次。</p>'}</div>
    <form class="profile-new" id="profile-new" autocomplete="off"><h3>把当前引擎存为档案</h3>
      <p class="profile-current">${configured ? `当前已保存：${escapeHtml(engineSummary(providerSettings))}` : "上方还没有保存可用的引擎配置。"}</p>
      <label>名称<input id="profile-name" maxlength="40" placeholder="例如：阿青 Sonnet、DeepSeek、阿澈 Codex" required ${configured ? "" : "disabled"}/></label>
      ${swatches("new-profile-color", nextColor)}
      <div class="dialog-actions"><button class="primary" type="submit" ${configured ? "" : "disabled"}>存为档案</button></div></form>`;
  const act = async (promise, message) => { try { await promise; if (message) notify(message); await renderProfiles(); } catch (error) { notify(error.message); } };
  const json = (method, body) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  box.querySelectorAll(".profile-card").forEach((card) => {
    const id = card.dataset.profile; const profile = state.profiles.find((p) => p.id === id); const editor = card.querySelector(".profile-editor");
    card.querySelector("[data-activate]").onclick = async () => { try { providerSettings = await request(`/api/engine-profiles/${id}/activate`, { method: "POST" }); notify(`已启用：${profile.name}`); renderSettings(); } catch (error) { notify(error.message); } };
    card.querySelector("[data-edit]").onclick = () => { editor.hidden = !editor.hidden; if (!editor.hidden) editor.querySelector("input").focus(); };
    card.querySelector("[data-cancel]").onclick = () => { editor.hidden = true; };
    card.querySelector("[data-save]").onclick = () => act(request(`/api/engine-profiles/${id}`, json("PATCH", { name: editor.querySelector("input").value, color: editor.querySelector("input[type=radio]:checked")?.value })), "档案已更新");
    card.querySelector("[data-overwrite]").onclick = () => { if (confirm(`用上方当前保存的引擎（${engineSummary(providerSettings || {})}）覆盖“${profile.name}”？名称和颜色保持不变。`)) act(request("/api/engine-profiles", json("POST", { id, name: profile.name, color: profile.color })), "档案已更新为当前配置"); };
    card.querySelector("[data-delete]").onclick = () => { if (confirm(`删除档案“${profile.name}”？已经翻好的译本不受影响，仍保留原来的名字和颜色。`)) act(request(`/api/engine-profiles/${id}`, { method: "DELETE" }), "档案已删除"); };
  });
  box.querySelector("#profile-new").onsubmit = (event) => { event.preventDefault(); act(request("/api/engine-profiles", json("POST", { name: box.querySelector("#profile-name").value, color: box.querySelector("input[name='new-profile-color']:checked")?.value })), "已存为引擎档案"); };
}

async function saveSearchSettings(event) {
  event.preventDefault();
  const payload = { apiKey: document.querySelector("#search-key").value, clearKey: document.querySelector("#clear-search-key").checked, dailyLimit: Number(document.querySelector("#search-daily-limit").value), autoItemsPerChapter: Number(document.querySelector("#search-auto-items").value), requestsPerItem: Number(document.querySelector("#search-requests-per-item").value) };
  try { await request("/api/search-settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }); notify("独立搜索设置已保存"); renderSettings(); }
  catch (error) { const box = document.querySelector("#search-test-result"); box.classList.remove("hidden"); box.textContent = `保存搜索设置失败：${error.message}`; }
}

async function testSearchSettings() {
  if (!confirm("连接测试会发起 1 次真实搜索并计入今日额度。继续吗？")) return;
  const button = document.querySelector("#test-search-settings"); const box = document.querySelector("#search-test-result");
  button.disabled = true; box.classList.remove("hidden"); box.textContent = "正在测试搜索服务…";
  try { const result = await request("/api/search-settings/test", { method: "POST" }); box.textContent = `搜索连接正常 · 返回 ${result.resultCount} 条线索 · 今日剩余 ${result.usage.remaining} 次。搜索线索不等于事实证据。`; }
  catch (error) { box.textContent = `搜索测试失败：${error.message}`; }
  finally { button.disabled = false; }
}

async function testProviderSettings() {
  if (!document.querySelector("#provider-form").reportValidity()) return;
  const button = document.querySelector("#test-provider"); const resultBox = document.querySelector("#provider-test-result");
  button.disabled = true; button.textContent = "正在测试…"; resultBox.classList.add("hidden");
  try {
    const result = await request("/api/provider/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...providerPayload(), save: true }) });
    resultBox.textContent = `连接成功 · ${result.model} · ${result.latencyMs} ms · ${result.inputTokens ?? "未知"} 输入 / ${result.outputTokens ?? "未知"} 输出 Token`;
    resultBox.classList.remove("hidden"); notify("引擎连接成功，配置已保存"); updateApiStatus();
  } catch (error) { resultBox.textContent = `测试失败：${error.message}`; resultBox.classList.remove("hidden"); }
  finally { button.disabled = false; button.textContent = "测试并保存"; }
}

function updatePresetNote() {
  const id = document.querySelector("#provider-preset")?.value;
  const note = document.querySelector("#preset-note");
  if (!note) return;
  note.textContent = providerPresets[id]?.note || "高级选项：请按服务商文档填写协议、基础地址和模型 ID。";
}

function applyProviderPreset(event) {
  const preset = providerPresets[event.target.value];
  if (!preset) { updatePresetNote(); return; }
  const oldOrigin = originOf(document.querySelector("#provider-url").value);
  const newOrigin = originOf(preset.baseUrl);
  document.querySelector("#provider-name").value = preset.providerName;
  document.querySelector("#provider-protocol").value = preset.protocol;
  document.querySelector("#provider-url").value = preset.baseUrl;
  document.querySelector("#provider-model").value = preset.model;
  document.querySelector("#provider-max-output").value = preset.maxOutputTokens;
  document.querySelector("#provider-input-price").value = preset.inputPrice;
  document.querySelector("#provider-output-price").value = preset.outputPrice;
  document.querySelector("#provider-no-auth").checked = preset.noAuth;
  if (oldOrigin && newOrigin && oldOrigin !== newOrigin) {
    document.querySelector("#provider-key").value = "";
    document.querySelector("#provider-key").placeholder = preset.noAuth ? "本机接口无需密钥" : "请粘贴此服务商的 API Key";
    document.querySelector("#clear-provider-key").checked = true;
  }
  updatePresetNote();
}

function cliConnectionPayload() {
  return { backend: document.querySelector("#provider-backend").value, cliPath: document.querySelector("#provider-cli-path").value,
    opencodeMode: document.querySelector("#opencode-mode").value, opencodeServerUrl: document.querySelector("#opencode-server-url").value, opencodeDirectory: document.querySelector("#opencode-directory").value,
    opencodeUsername: document.querySelector("#opencode-username").value, opencodePassword: document.querySelector("#opencode-password").value, clearOpenCodePassword: document.querySelector("#clear-opencode-password").checked };
}
function providerPayload() {
  const payload = { providerName: document.querySelector("#provider-name").value, protocol: document.querySelector("#provider-protocol").value, baseUrl: document.querySelector("#provider-url").value, model: document.querySelector("#provider-model").value, maxOutputTokens: Number(document.querySelector("#provider-max-output").value), inputPrice: Number(document.querySelector("#provider-input-price").value), outputPrice: Number(document.querySelector("#provider-output-price").value), apiKey: document.querySelector("#provider-key").value, noAuth: document.querySelector("#provider-no-auth").checked, clearKey: document.querySelector("#clear-provider-key").checked };
  Object.assign(payload, cliConnectionPayload());
  payload.translationBlockChars = Number(document.querySelector("#provider-block-chars").value);
  payload.reasoningEffort = document.querySelector("#provider-effort").value;
  if (payload.backend !== "http") { payload.model = document.querySelector("#provider-cli-model").value.trim(); payload.providerName = payload.backend === "opencode" && payload.opencodeMode === "server" ? "OpenCode 本地服务" : `${payload.backend} CLI`; }
  return payload;
}
async function saveProviderSettings(event) {
  event.preventDefault();
  const payload = providerPayload();
  const providerChanged = originOf(providerSettings.baseUrl) && originOf(payload.baseUrl) && originOf(providerSettings.baseUrl) !== originOf(payload.baseUrl);
  if (payload.backend === "http" && providerChanged && !payload.noAuth && !payload.apiKey) { const box = document.querySelector("#provider-test-result"); box.classList.remove("hidden"); box.textContent = "切换服务商时，请填写新服务商的 API Key"; return; }
  try { providerSettings = await request("/api/provider", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }); notify("API 配置已保存在本机"); renderSettings(); updateApiStatus(); }
  catch (error) { const box = document.querySelector("#provider-test-result"); box.classList.remove("hidden"); box.textContent = `保存翻译 API 失败：${error.message}`; }
}

async function updateApiStatus() {
  try { const settings = await request("/api/provider"); const ready = settings.backend && settings.backend !== "http" || settings.baseUrl && settings.model && (settings.hasApiKey || settings.noAuth); document.querySelector("#api-status").textContent = ready ? `API：${settings.providerName || settings.model}` : "API：尚未配置"; }
  catch { document.querySelector("#api-status").textContent = "API：配置不可用"; }
}

function switchView(view) {
  if (currentView === "closed") return;
  if (!confirmDiscardReaderEdit()) return;
  if (taskPollTimer) { clearTimeout(taskPollTimer); taskPollTimer = null; }
  leaveReader(); route(`/${view}`); searchInput.disabled = view !== "library";
  currentView = view; document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  ({ library: renderLibrary, tasks: renderTasks, glossary: renderGlossary, uncertainties: renderGlossary, exports: renderExports, settings: renderSettings }[view] || renderLibrary)();
}

async function importBook(event) {
  event.preventDefault(); const file = document.querySelector("#book-file").files[0]; if (!file) return;
  const params = new URLSearchParams({ filename: file.name, title: document.querySelector("#book-title").value || file.name.replace(/\.[^.]+$/, ""), author: document.querySelector("#book-author").value, profile: document.querySelector("#book-profile").value, sourceLanguage: document.querySelector("#book-language").value });
  const button = document.querySelector("#confirm-import"); button.disabled = true; button.textContent = "正在导入…";
  try { const imported = await request(`/api/import?${params}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file }); document.querySelector("#import-dialog").close(); document.querySelector("#import-form").reset(); await load(); renderBook(imported.id); notify("书籍已保存，正在自动整理目录"); }
  catch (error) { notify(error.message); }
  finally { button.disabled = false; button.textContent = "导入到本地书库"; }
}

async function load() { data = await request("/api/library"); }

document.querySelectorAll(".nav-item").forEach((item) => item.addEventListener("click", () => switchView(item.dataset.view)));
document.querySelector("#import-button").onclick = openImportDialog;
document.querySelector("#shutdown-server").onclick = shutdownWorkbench;
document.querySelector("#import-form").addEventListener("submit", importBook);
document.querySelector("#edit-book-form").addEventListener("submit", saveBookDetails);
document.querySelectorAll("[data-close-dialog]").forEach((button) => button.onclick = () => document.querySelector(`#${button.dataset.closeDialog}`).close());
document.querySelector("#book-file").addEventListener("change", (event) => { const file = event.target.files[0]; if (!file) return; document.querySelector("#file-hint").textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`; document.querySelector("#book-title").value = file.name.replace(/\.[^.]+$/, ""); document.querySelector("#book-author").value = ""; });
document.querySelector("#dismiss-demo").onclick = () => document.querySelector("#demo-banner").remove();
let acceptedSearch = searchInput.value;
searchInput.addEventListener("input", () => { if (currentView !== "library") return; if (!confirmDiscardReaderEdit()) { searchInput.value = acceptedSearch; return; } acceptedSearch = searchInput.value; indexPage = 0; renderLibrary(); });

try {
  await load(); const capabilities = await request("/api/capabilities");
  if (!data.books.some((book) => book.demo)) document.querySelector("#demo-banner").remove();
  const calibreStatus = capabilities.calibre ? "Calibre 已就绪" : "AZW3 待安装 Calibre";
  const readyLanguages = SOURCE_LANGUAGES.filter((entry) => capabilities.ocrLanguages?.[entry.code]?.ready).map((entry) => entry.label);
  const ocrStatus = readyLanguages.length ? `OCR：${readyLanguages.join("、")}${readyLanguages.length < SOURCE_LANGUAGES.length ? "（部分语种待安装）" : " 已就绪"}` : "扫描 PDF 需 OCR";
  document.querySelector("#local-status").textContent = `EPUB · 已就绪\nCalibre · ${capabilities.calibre ? "已就绪" : "待安装"}\nOCR · ${readyLanguages.length}/${SOURCE_LANGUAGES.length} 语种`;
  document.querySelector("#local-status").title = `EPUB 已就绪 · ${calibreStatus} · ${ocrStatus}`;
  document.querySelector("#local-status").insertAdjacentHTML("afterend", '<div id="api-status" class="local-status">API：正在检查…</div>');
  await updateApiStatus();
  await restoreRoute();
} catch (error) { content.innerHTML = `<div class="empty"><strong>无法读取本地书库</strong>${escapeHtml(error.message)}</div>`; }
