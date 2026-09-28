# 瀟湘館

瀟湘館是本机运行的单人翻译与阅读工作台。导入无 DRM 的 EPUB、PDF 或 AZW3，自动整理章节，用自己的模型 API 或已安装的 Codex、OpenCode、Antigravity、Claude Code CLI 翻译为简体中文，边译边读，校订后导出 EPUB。支持日语、英语、法语、德语、西班牙语原文。界面和书库仅在本机 127.0.0.1 提供服务；项目不提供账号或云同步。

## 使用流程

![瀟湘館五步使用流程](docs/images/workflow.svg)

从配置翻译引擎到导出 EPUB，完整流程只需五步。下面的演示书库使用虚构书籍与虚构译文，不包含真实作品、个人数据或 API 密钥。

![瀟湘館演示书库](docs/images/guide-library.jpg)

**[查看完整图解操作教程](docs/getting-started.md)**，其中包含翻译引擎设置、导入、章节选择、双栏校订与 Apple“图书”兼容导出的逐步说明。

## 安装与启动

需要 Node.js 20 或更新版本，以及 Python 3。先安装 Python 依赖：

~~~sh
python -m pip install -r requirements.txt
npm start
~~~

Windows 可双击 start-library.cmd 启动，会打开网页和一个“瀟湘館后台 · 运行中”窗口。后台窗口可最小化，任务开始、完成或停止时会显示状态。关闭浏览器页面不会停止后台。

退出可选工作台侧栏或“设置 → 后台运行”里的“关闭后台”，阅读时也可在“注释与工具”中关闭；或直接关闭后台运行窗口、按 Ctrl+C。关闭前会停止任务并保留已经完成的翻译块，下次可继续。stop-library.cmd 仍可用，也优先通过同一正常退出流程停止。需要隐藏运行窗口时，可用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start.ps1` 启动。

网页地址是 http://127.0.0.1:4327/ 。如有多个 Python，可设置 PYTHON_PATH 为安装了依赖的 Python 可执行文件绝对路径；项目内 .venv 也会被自动识别。更改端口可在启动前设置 PORT。

首次启动会创建空书库。导入后自动提取章节，在“设置 → 翻译引擎”选择模型服务。API 支持 OpenAI、DeepSeek、本机 Ollama 或兼容接口；CLI 使用其已有的登录与配置。翻译请求会发送给选定引擎；联网查证使用单独配置的 Brave Search API。连接测试会实际发起请求，可能产生费用。

## 边译边读

顶栏的主题按钮可切换「青花」「竹影」「宋笺」「灯下」，书库、设置和阅读页即时生效，并记住本浏览器的选择。阅读页默认随工作台主题；若想单独设置纸张，在“阅读设置 → 纸张”中选择纸白、暖纸或夜读。切换视觉主题会保留阅读位置、选区和未保存的译文。

桌面打开章节默认左原文、右译文。点击“翻译本章”后留在阅读页，每个完成并通过段落校验的块会陆续出现；可暂停、取消，失败后从未完成块继续。服务重启后的任务标为未完成，已经保存的块仍可恢复。

未完成任务可在“设置 → 翻译引擎”保存新的模型、API 地址或输出上限，再回到章节点击“从未完成块继续”。已完成块保留，剩余块使用当前保存的引擎；断点沿用原来的分块大小，每块记录实际使用的模型。若原文、翻译范围或当前译稿版本已改变，需要重新开始。暂停任务的“继续”仍沿用本次任务的引擎；要切换引擎，先取消任务，再从未完成块继续。

每块请求都会说明任务是翻译既有作品，要求忠实保留原文含义和描写程度，不新增或强化敏感细节。模型拒绝、内容审核拦截、输出截断和 JSON 格式错误会作为失败记录，拒绝说明不会作为成功译文保存。任务说明不能保证服务商接受所有内容。输入、输出和恢复机制详见 [翻译流程说明](docs/translation-pipeline.md)。

点击段落会高亮原译对应内容，保持当前栏位置；另一栏的对应段落在屏幕外时才按需滚动。主动滚动仍按段落锚点同步。分隔线可拖动，也可聚焦后用方向键调整；阅读设置可调字号、纸张、栏宽和同步。每本书记住模式、偏好与阅读位置。手机显示原文/译文切换，底部可切换章节。回看、选字或编辑时停止跟随，可点击“回到翻译位置”。

在“设置 → 翻译引擎”可调整“每块原文目标字符数”，默认 3000，范围 500–6000，适用于 API、CLI 和 OpenCode 本地服务的初译与精校。CLI 较慢时可调小以减少单次等待。分块保持段落完整，超长单段或精校合并段可能超过目标值。保存后用于新任务；已排队、运行中及断点续译的任务沿用原分块，旧版未完成任务仍按 6500 字符分块。旧译文没有段落映射且超过当前目标值时，需重新初译建立对齐后再精校。

章节和任务状态同时显示图标与文字：文档表示已提取、铅笔表示待校订、圆圈勾表示已批准。阅读页可直接在译文栏顶部点击“标记定稿”，完成后显示“已定稿”；编辑时先保存修改，再定稿。顶部“目录”打开左侧章节抽屉，显示当前章节与翻译状态；“← 作品页”独立返回外层作品页面。

“注释与工具”中有目录、书内搜索、节选翻译、精校和版本历史。人工修改、定稿及已导出版本受到保护，新生成的译稿保留在历史中供选择。旧译文没有可靠映射时显示章级对照提示；重新初译建立对齐并保留旧版。整章手工改写会保留文字，但需要重新建立段落映射。

## CLI 引擎

只需安装你准备使用的 CLI；使用翻译 API 时无需安装 CLI。完整的 Windows、macOS/Linux 安装命令、首次登录、路径查找和故障处理见 [CLI 安装与接入指南](docs/cli-setup.md)。

| CLI | Windows 安装入口 | 安装后先在终端完成 |
| --- | --- | --- |
| Codex | [官方独立安装器](https://learn.chatgpt.com/docs/config-file/environment-variables#installer-variables) | `codex --version`，再运行 `codex` 登录 |
| OpenCode | [官方 1.18.30 发布包](https://github.com/anomalyco/opencode/releases/tag/v1.18.30)，解压原生 CLI | `opencode --version`，再运行 `opencode auth login` 配置服务商 |
| Antigravity | [官方独立 CLI 安装器](https://antigravity.google/docs/cli/install) | `agy --version`，再运行 `agy` 完成授权 |
| Claude Code | [官方安装说明](https://code.claude.com/docs/en/setup) | `claude --version`，再运行 `claude` 登录 |

安装并登录后，在设置中选择引擎、点击“检测安装”和“读取模型与强度”。模型列表来自本机 CLI，使用账号实际可用的模型；可保留 CLI 默认模型，也可手动填写模型 ID。OpenCode 模型 ID 使用 `provider/model` 格式，本轮验证的是 1.x CLI。

要在 OpenCode 桌面端查看翻译过程，可把 OpenCode 连接方式改为“连接本地服务”。先运行 `opencode serve --hostname 127.0.0.1 --port 4096`，工作台和桌面端连接同一个地址，并打开同一个固定项目目录。分段会话按书名、章节命名；取消只中止对应会话，关闭工作台不会停止共用服务。模型与强度从服务读取，不需要 MCP。完整步骤见 [桌面端查看会话](docs/cli-setup.md#在-opencode-桌面端查看翻译会话)。

| 引擎 | 模型与强度来源 |
| --- | --- |
| Codex | `app-server` 的 `model/list`；每个模型的 `supportedReasoningEfforts` |
| OpenCode | `models --verbose`；各模型启用的 `variants` |
| Antigravity | `agy models`；`low`、`medium`、`high` |
| Claude Code | 无模型列表命令；内置 `sonnet`、`opus`、`fable`、`haiku` 别名，自动指向账号可用的最新版本；强度 `low` 至 `max`（`haiku` 仅默认强度） |

强度选项随模型变化。选择后“保存引擎配置”，或“测试并保存”进行一次真实调用；保存配置本身不验证模型调用权限。排队任务使用入队时的引擎快照，修改设置只影响新任务。

自动检测不到时填写原生可执行文件路径；Windows 需选择 `.exe`，不使用 `.cmd` / `.bat` 包装脚本。也可设置 `CODEX_PATH`、`OPENCODE_PATH`、`ANTIGRAVITY_PATH`、`CLAUDE_PATH`。CLI 正文经 stdin 传入，任务使用临时目录；取消和超时会终止本次子进程。默认每块超时 5 分钟，用量未知时显示未知，CLI 不按 API 单价估算费用。

## 本机数据与迁移

书籍、译文、导出文件及密钥保存在用户数据目录，界面“设置 → 本机数据与迁移”会显示实际路径。默认位置：

| 系统 | 数据目录 |
| --- | --- |
| Windows | %LOCALAPPDATA%\Xiaoxiangguan |
| macOS | ~/Library/Application Support/Xiaoxiangguan |
| Linux | $XDG_DATA_HOME/xiaoxiangguan，未设置时为 ~/.local/share/xiaoxiangguan |

数据目录下的 data/ 存放书库索引，library/ 存放原书和工作文件，exports/ 存放 EPUB，secrets/ 存放 API 配置。可在启动前设置 TRANSLATION_LIBRARY_DATA_DIR 为**绝对路径**来指定整个数据目录。迁移时先停止程序，再复制整个数据目录到新位置，并设置该变量。旧版本若已在项目目录的 data/library.json 存有书库，程序会继续使用原项目目录；可以按上述方式迁移。不要将数据目录、密钥或导入的书籍提交到公开仓库。

Windows 上密钥优先使用当前用户的 DPAPI 保护。其他环境或 DPAPI 不可用时，程序将配置文件限制为当前用户可读写，并在设置页提示。请保护本机账户和备份；本项目没有远程账户隔离。

## PDF OCR 与外部工具

可选安装 Tesseract OCR、Poppler（pdftoppm）及 Calibre（AZW3 转换）。文本型 PDF 不要求 OCR；扫描 PDF 需要对应的 Tesseract 语言模型。日语、英语、法语、德语、西班牙语分别使用 jpn、eng、fra、deu、spa，日语竖排建议另装 jpn_vert。设置页会显示各语种 OCR 是否就绪。

程序先检查显式配置，再检查常见安装位置和 PATH。可用这些环境变量指定自定义安装：

| 变量 | 值 |
| --- | --- |
| PYTHON_PATH | Python 可执行文件绝对路径 |
| TESSERACT_PATH | Tesseract 可执行文件绝对路径 |
| TESSDATA_PREFIX | 包含 .traineddata 文件的目录，或其上级目录 |
| PDFTOPPM_PATH | pdftoppm 可执行文件绝对路径 |
| CALIBRE_PATH | ebook-convert 可执行文件绝对路径 |

例如 Windows PowerShell：

~~~powershell
$env:TESSERACT_PATH = 'C:\Program Files\Tesseract-OCR\tesseract.exe'
$env:TESSDATA_PREFIX = 'C:\Program Files\Tesseract-OCR\tessdata'
npm start
~~~

## 开发

~~~sh
python -m pip install -r requirements.txt
npm test
~~~

测试使用临时样本，不需要 API Key。项目源代码使用 [GNU GPL v3.0](LICENSE)；贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。作品原文及生成译文的使用权由各自权利人与使用者决定，仓库不附带用户书籍或密钥。
