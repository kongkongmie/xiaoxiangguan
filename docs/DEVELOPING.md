# 开发与交接手册

给接手这个仓库的人和 agent：先读完本文，再按“改什么 → 去哪里”一节直接打开对应文件。**不需要通读全部代码**；每一条都给出了文件和可直接搜索的函数名（不写行号，行号会变）。

翻译管线本身（分块、输出 JSON、断点恢复）的设计说明在 [translation-pipeline.md](translation-pipeline.md)，本文不重复。

---

## 1. 一句话架构

一个 Node 进程（`server.mjs`，无第三方依赖）同时提供 HTTP API 和静态前端；前端是**不经构建**的原生 ES 模块（`public/`，hash 路由 `#/books/...`）；EPUB/PDF 提取和 OCR 调 Python 脚本（`scripts/*.py`）。数据全部是本机文件：一个 `library.json` 加每本书一个目录。翻译任务在进程内串行排队。

```
浏览器 public/app.js ──fetch──> server.mjs 路由 ──> lib/engine.mjs（翻译、分析、提取）
                                             └──> lib/providers.mjs（HTTP / Gemini）
                                             └──> lib/cli-provider.mjs（Codex / Claude Code / OpenCode…）
```

## 2. 运行与测试

| 做什么 | 命令 |
| --- | --- |
| 启动 | `npm start`（默认 http://127.0.0.1:4327；`PORT=0` 随机端口） |
| 指定数据目录 | `TRANSLATION_LIBRARY_DATA_DIR=<绝对路径> npm start` |
| 全部单元/集成测试 | `npm test`（依次跑 `scripts/test-*.mjs`，任何一个失败即停） |
| 只跑一个 | `node scripts/test-prompts.mjs` 等 |
| 浏览器界面场景（可选） | `cd scripts/ui && npm install`，然后在仓库根目录 `node scripts/ui/<场景>.mjs`；截图在 `scripts/ui/shots/` |

- `scripts/test-research.mjs` 在无法解析 `localhost.` 的沙盒里会失败（上游原样也失败），与代码无关。
- 测试都用 `127.0.0.1` 上的临时 mock 服务和临时数据目录，不联网、不碰真实书库。
- 界面场景：`reader`（对照/合成/单段现译/主题/手机）、`settings`（自动读模型/测试即保存/一键切换/任务详情）、`align`（两栏对齐/选词对应/紧凑对照）、`gemini-ui`（Gemini 反代预设，**占用 8890 端口**）、`batch`（翻译全书对话框）、`prompts`（提示词编辑器）、`live`（任务实时输出）、`relay`（续译时选择接手引擎）、`images <epub>`（插图，需要自备带插图的 EPUB）。`PLAYWRIGHT_CHROMIUM` 可指定浏览器路径。
- 改了 `public/` 下的文件：刷新页面即可（静态文件带 `cache-control: no-cache`）。改了 `server.mjs` 或 `lib/`：必须重启后台（设置页“关闭后台”，再用启动脚本启动）。

## 3. 目录地图

### 服务端

| 文件 | 负责什么 |
| --- | --- |
| `server.mjs` | 全部 HTTP 路由（在 `http.createServer` 回调里按 `url.pathname` 顺序匹配）、书库读写、任务队列、引擎档案、提示词存取、实时输出、导出入口 |
| `lib/engine.mjs` | 文档提取 `extractDocument`、插图索引 `bookImages`、**翻译一章** `translateChapter`、提示词变量 `translationPromptVars` / 预览 `previewTranslationMessages`、选词对应 `alignSelection`、注释分析、考证、连通测试 |
| `lib/providers.mjs` | 调模型的唯一入口 `generate`：OpenAI Chat/Responses、Gemini 原生（`generateGemini` / `geminiOnce`）、流式读取与空闲超时 `send`、错误解析 `parseReply`、网络错误诊断 `networkError`、模型列表 `listHttpModels`、引擎快照 `providerSnapshot` |
| `lib/cli-provider.mjs` | 各 CLI 的命令行参数 `cliInvocation`、事件解析 `cliEventParser`、实时事件 `liveFromCli`、子进程 `runCliProcess`、安装探测 `probeCli` |
| `lib/cli-models.mjs` | CLI 可选模型与推理强度目录 |
| `lib/opencode-server.mjs` | OpenCode 本地服务模式 |
| `lib/prompts.mjs` | 翻译提示词模板：内置默认 `BUILTIN_PROMPT_SET`、变量表 `PROMPT_VARIABLES`、`buildTranslationMessages`、校验 `normalizePromptSet`、按档案选择 `promptSetFor` |
| `lib/alignment.mjs` | 段落切分与稳定段落 ID、分块 `translationBlocks`、JSON 解析与覆盖校验 `parseAlignedText` / `validateSegments` |
| `lib/revisions.mjs` | 译稿版本路径 |
| `lib/epub.mjs` | 导出 EPUB：自带 zip 写入、插图与封面打包 |
| `lib/research.mjs`、`lib/search-budget.mjs` | 联网考证与搜索额度 |
| `lib/data-paths.mjs` | 数据根目录 `dataRoot`、原文件路径 `resolveSourceFile` |
| `lib/model-output.mjs` | 拒绝/审核拦截错误 `modelRefusalError` |
| `lib/source-reader.mjs`、`lib/tool-paths.mjs`、`lib/child-processes.mjs` | 原文读取、外部工具路径、子进程树管理 |
| `scripts/extract_ebook.py` | EPUB/AZW3 → 章节文本；`--images` 模式导出插图与索引 |
| `scripts/extract_pdf.py` | PDF 文本与 OCR |

### 前端（`public/`）

| 文件 | 负责什么 |
| --- | --- |
| `app.js` | 除阅读器外的所有页面：书库 `renderLibrary`、作品页 `renderBook`、任务 `renderTasks`、阅读质量、导出、设置 `renderSettings`，以及全书翻译对话框 `translateSelected` |
| `reader.js` | 阅读器 `mountReader`：两栏布局、同步滚动、段落点击、插图替换、轮询更新 |
| `reader-compare.js` | 多译本：译本条、逐段对照表、挑选合成、单段对照弹窗（`createCompare`） |
| `reader-align.js` | 选词对应（`createAlign`，用 CSS Highlight API 标注） |
| `compare-core.js` | 对照的纯逻辑（服务端也 import）：可比译本、对照单元切分、合成、引擎配色 |
| `prompt-studio.js` | 设置页“翻译提示词”编辑器（`mountPromptStudio`） |
| `illustrations.js` | 判断“[图片]”占位段（服务端也 import） |
| `languages.js`、`reader-notes.js`、`reader-quality.js`、`reader-mode.js`、`library-index.js`、`status-badge.js`、`themes.js` | 语种、读者注释清洗、质量汇总、阅读模式、书库分页、状态徽章、主题 |
| `styles.css` / `settings.css` / `reader.css` / `themes.css` | 通用与页面 / 设置页 / 阅读器 / 主题色 |

> 被服务端 import 的前端模块（`compare-core.js`、`illustrations.js`、`languages.js`、`reader-notes.js`）**不能使用 DOM**。

## 4. 数据落盘

数据根目录由 `dataRoot` 决定：环境变量 `TRANSLATION_LIBRARY_DATA_DIR` 优先；否则仓库里有 `data/library.json` 就用仓库本身；否则 Windows 用 `%LOCALAPPDATA%\Xiaoxiangguan`。

```
<数据根>/
  data/library.json         书库：books[]（章节、任务、术语、人物、疑难、选集…）与 exports[]
  data/prompts.json         翻译提示词：sets[]、defaultId、bindings{档案ID: 提示词ID}
  secrets/provider.json     当前引擎（Windows 下密钥经 DPAPI 加密）
  secrets/engine-profiles.json  引擎档案 [{id,name,color,stored}]
  library/<书ID>/
    source/                 导入的原文件
    extracted/run-*/        提取结果（chapters/*.txt、manifest.json；AZW3 另有 converted-source.epub）
    translations/working|polished/  译稿 Markdown
    assets/epub-images/     插图缓存：index.json + files/（首次访问时生成，可删除重建）
    state/                  术语、疑难等项目状态
  exports/                  导出的 EPUB
```

- `library.json` 只经 `saveLibrary` 原子写入；修改某本书时包在 `withBookMutation(bookId, …)` 里串行执行，避免并发覆盖。
- **密钥绝不进入任务、译本或日志**：任务里的 `engine` 字段来自 `providerSnapshot`（白名单字段）。
- 章节的历史译本在 `chapter.revisionHistory`（带 `segments` 段落映射和 `engine` 快照），正在进行的翻译在 `chapter.translationRun.blocks`。
- 实时输出只在内存（`server.mjs` 的 `liveOutput`），任务结束 10 分钟后丢弃。

## 5. 翻译一章的完整数据流

1. 前端 `POST /api/books/:书/chapters/:章/translate`（`mode`、`range`、`profileId`）。
2. `translateBookChapter`（server.mjs）：用 `providerForTranslation` 取引擎，用 `promptSetForProvider` 取提示词，**冻结**成 `engine` 快照，交给 `startTask` 排队（同一引擎的重复请求按 `requestKey` 去重）。
3. 轮到时执行 runner → `translateChapter`（engine.mjs）：切段、分块；每块由 `translationPromptVars` + `buildTranslationMessages` 生成消息 → `callProvider` → `generate`。
4. `generate` 按后端分流：CLI → `generateCli`；Gemini → `generateGemini`（被外审拦截时原样重发）；其余 → OpenAI 兼容（默认流式）。全程通过 `onLive` 报告实时内容，由 `recordLive` 存入内存。
5. 返回文本经 `parseAlignedText` 校验段落覆盖，得到 `segments`；`onBlock` 把完成块写进 `chapter.translationRun`，阅读页即可边译边读。
6. 全章完成：写 Markdown 译稿、追加 `revisionHistory`；失败则写 `task.error` 与 `task.errorDetail`（`taskErrorDetail` 负责截断与挑字段）。

## 6. 改什么 → 去哪里

| 想改的东西 | 位置 |
| --- | --- |
| 默认翻译提示词的措辞 | `lib/prompts.mjs` 的 `BUILTIN_PROMPT_SET`；`scripts/test-prompts.mjs` 断言它与旧文案逐字一致，改了要同步测试 |
| 新增提示词变量 | `PROMPT_VARIABLES`（lib/prompts.mjs）+ `translationPromptVars`（lib/engine.mjs） |
| 提示词编辑器界面 | `public/prompt-studio.js`，样式在 `settings.css` 的 “Prompt studio” 段 |
| 文体风格说明（古典/学术/现代） | `profileInstructions`（lib/engine.mjs） |
| 分块大小、段落 ID | `lib/alignment.mjs`；默认值 `DEFAULT_TRANSLATION_BLOCK_CHARS` |
| 新增 HTTP 协议或改请求体 | `generate`（lib/providers.mjs）；Gemini 在 `geminiOnce`；设置页协议下拉在 app.js 搜 `provider-protocol`；服务端白名单在 `saveProvider` 搜 `不支持的接口协议` |
| 新增服务商预设 | app.js 顶部 `providerPresets` |
| 自动读取模型列表 | 服务端 `listHttpModels`；前端 `loadHttpModels` / `syncHttpModelSelect` |
| 设置页新增一个引擎字段 | 表单 HTML 在 `renderSettings`；提交在 `providerPayload`；保存与校验在 server.mjs 的 `saveProvider`（`const next = {…}`）；想在任务详情显示，加进 `providerSnapshot` 的白名单并在 `taskDetails` 里 `row(…)` |
| 新增 CLI 引擎 | `cliInvocation` + `cliEventParser` + `liveFromCli`（lib/cli-provider.mjs）；模型目录在 `lib/cli-models.mjs` |
| 网络错误提示文案 | `NETWORK_REASONS` / `networkError`（lib/providers.mjs） |
| Gemini 拦截重发、思考预算 | `generateGemini` / `geminiRetries` / `geminiOnce` |
| 任务列表、失败详情 | app.js：`renderTasks`、`taskDetails`、`taskEngineLine`；服务端 `taskErrorDetail` |
| 任务实时输出 | 服务端 `recordLive` / `finishLive` / `GET /api/tasks/:id/live`；前端 `refreshLive` / `taskLive` / `readableOutput`；样式 `styles.css` “Live output” 段 |
| 全书/批量翻译对话框、用量粗估 | app.js：`translateSelected`、`batchEstimate` |
| 续译与换引擎接手 | 前端 `startTranslation`（`retry` 时弹 `chooseEngine`）；服务端 `translateBookChapter` 里 `retry && compatible` 保留已完成块；接力译本的识别与逐段来源 `relaySources`（compare-core.js），依据 revision 的 `blockEngines` |
| 阅读器两栏布局、同步滚动 | `public/reader.js`（`mountReader` 顶部的模板字符串是整个阅读器的 HTML） |
| 多译本对照、合成 | `public/reader-compare.js`；纯逻辑在 `compare-core.js`；服务端 `compose` / `compose-draft` 路由 |
| 选词对应 | 前端 `reader-align.js`；服务端 `alignSelection` 与 `/align` 路由 |
| 插图 | 提取 `extract_ebook.py --images`；索引与缓存 `bookImages`；阅读器里搜 `figuresFor`；导出 `paragraphsWithFigures`（lib/epub.mjs） |
| 导出 EPUB | `createEpub`（lib/epub.mjs）；入口在 server.mjs 的 `/export/epub` 路由 |
| 引擎档案与一键切换 | 服务端 `readProfiles` / `listProfiles` / `/api/engine-profiles` 路由；前端 `renderEngineSwitch` / `renderProfiles` |
| 配色 | 引擎色板 `VERSION_PALETTE` / `engineColor`（compare-core.js）；主题 `themes.css` |

## 7. 约定与踩过的坑

- **app.js 的 HTML 模板**：外层是反引号模板字符串，但有些分支写在**单引号**字符串里（例如作品页按钮区），那里写 `${…}` 不会被替换，会原样显示在页面上。要么拼接字符串，要么改用反引号。
- **设置页有多个区块共用 `data-save`、`data-name` 这类属性**；各模块都在自己的根元素内查询，写测试或新代码时也要限定容器。
- 任务页每 1.5 秒整体重绘；需要跨重绘保留的状态（展开的详情、实时面板滚动位置）放在模块级的 `Set`/`Map` 里（`openTaskDetails`、`liveScroll`、`liveClosed`）。
- 服务商返回千奇百怪：有的中转把 SSE 标成 `application/json`，所以 `send` 按内容开头判断是否流式；有的不支持 `stream_options`，会自动去掉重试一次。
- Gemini 要求多轮消息角色交替，`geminiOnce` 会把连续同角色的消息合并成一轮。
- `PROHIBITED_CONTENT` 等拦截走 `modelRefusalError`，错误码 `MODEL_REFUSAL`，不会被当成译文保存。
- Windows 路径：`book.sourceFile`、`chapter.sourcePath` 里是反斜杠；拼路径时按 `/[\\/]/` 切分。Python 一律通过 `pythonPath()`（优先仓库内 `.venv`）。
- 插图段落的判断统一用 `illustrations.js` 的 `IMAGE_PARAGRAPH`，阅读器和导出共用。
- 静态服务对 `.js/.css/.html` 发 `no-cache`；插图文件带沙箱 CSP，只允许访问索引里登记过的路径。
- 提交信息里不要放个人信息；测试样本只用公版文本（现在用的是夏目漱石《吾輩は猫である》）。

## 8. 分支记录（kongkongmie/xiaoxiangguan）

| 分支 | 内容 |
| --- | --- |
| `feat/claude-code-cli` | Claude Code 作为翻译引擎 |
| `feat/multi-model-compare` | 引擎档案与配色、多译本对照、挑选合成、单段对照与现译 |
| `feat/settings-and-task-details` | 一键切换引擎、自动读模型并测试保存、任务失败详情 |
| `feat/reader-align-and-fetch-diagnostics` | 两栏对齐、紧凑对照、选词对应、流式与网络诊断、Gemini 原生协议与反代、全书翻译、插图、Gemini 拦截重发与思考预算、可编辑提示词、任务实时输出、本文档与界面场景测试 |

每个分支都基于前一个，最新的包含全部改动。
