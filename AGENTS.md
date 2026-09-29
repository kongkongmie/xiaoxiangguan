# 给 agent 的说明

改代码前先读 [docs/DEVELOPING.md](docs/DEVELOPING.md)：里面有目录地图、数据落盘位置、一章翻译的数据流，以及“改什么 → 去哪个文件哪个函数”的对照表。按表只打开相关文件，不必通读全部代码。

几条硬性约定：

- 无构建、无第三方运行依赖：服务端是 `server.mjs` + `lib/`，前端是 `public/` 下的原生 ES 模块。不要引入打包工具或 npm 依赖。
- 改完运行 `npm test`；`scripts/test-research.mjs` 在无法解析 `localhost.` 的沙盒里失败属已知情况。改了界面再跑 `scripts/ui/` 里相关的场景（见文档第 2 节）。
- API Key、OpenCode 密码不得进入任务记录、译本快照、日志或提交；任务里的引擎信息只能来自 `providerSnapshot` 的白名单字段。
- 写 `library.json` 只能经 `saveLibrary`，修改某本书要包在 `withBookMutation` 里。
- 测试样本只用公版文本；不要把个人书库、受版权保护的原书或密钥提交进仓库。
