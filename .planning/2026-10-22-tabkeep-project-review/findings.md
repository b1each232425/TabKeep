# TabKeep 项目复盘更新发现

## 当前工作树

- TabKeep 仓库存在大量未提交更改，包含新闻采集、兴趣推荐与评估、扩展历史同步、桌面新闻阅读器等代码。必须把这些当前工作树内容作为复盘依据，并且不触碰它们。
- 现有复盘目录 `杂项/TabKeep项目复盘` 有 8 篇文档，覆盖总体架构、选型、RAG、知识图谱、摘要收藏、桌面便签和工程化，但需要检查哪些主题因近期代码更新而过时或缺失。
- 仓库内 `task_plan.md`、`findings.md`、`progress.md` 属于后端 sidecar 任务记录，不应改写；本次使用独立 `.planning/2026-10-22-tabkeep-project-review/`。

## 当前结构/已有证据

- 仓库 `AGENTS.md` 把 TabKeep 描述为 Chrome 扩展 + Tauri 桌面端 + FastAPI 后端的本地优先知识工作流工具。
- 已知技术职责：扩展使用 Plasmo/React/TypeScript；后端使用 FastAPI/Python；桌面使用 Tauri 2/React/TypeScript/Rust。
- 发布版桌面端会启动打包的 Python sidecar；源码运行默认数据位于 `backend/data`，发布版通过 `TABKEEP_DATA_DIR` 使用应用数据目录。
- 扩展标签快照在 IndexedDB；后端 `/tabs` 为内存态；知识库使用 SQLite/FTS 与 LanceDB。
- 新增/修改文件集中在 `backend/services/news/`、新闻路由和 schema、桌面 `news-reader`、扩展 `browserHistorySync.ts`，以及 RAG/新闻评估脚本和数据。需要逐项核查真实运行路径与成熟度。

## 已有复盘目录

当前 8 篇依次为：

1. `01-项目定位与总体架构.md`
2. `02-核心技术选型取舍.md`
3. `03-RAG链路设计.md`
4. `04-RAG评估与质量优化.md`
5. `05-知识图谱设计与问题复盘.md`
6. `06-摘要收藏与浏览器采集.md`
7. `07-桌面端能力与便签迭代.md`
8. `08-工程化整理与面试表达.md`

现有复盘已有较好的架构、RAG、图谱、采集、桌面和发布叙事；当前明显的新主题是新闻阅读/采集/兴趣推荐/离线评估，以及本地历史兴趣导入。需按已有 8 篇扩写并新增主题文档和目录索引，而不是推倒重建。

## 工作树边界

`git status --short` 显示产品代码及 README 存在用户未提交改动；文件涉及 backend、desktop、extension、scripts。复盘操作限定在 `杂项/TabKeep项目复盘/` 和本计划目录，不修改 `TabKeep/` 生产代码或其 README。

## 新闻阅读与推荐：初步源码结论

- `backend/main.py` 的 FastAPI lifespan 初始化配置和新闻 SQLite，启动 `news_collector.run_scheduler()`，退出时取消任务、清理 source locks 和 Web 会话并关闭小黑盒认证客户端。桌面资讯页在开发时单独 Vite 服务（README 写 5176），安装版静态挂载到 `/reader/`。
- 新闻数据在 `TABKEEP_DATA_DIR/news.sqlite3`；SQLite 表覆盖订阅源、条目、兴趣事件、历史导入批次、画像快照、话题建议等，图片缓存在数据目录。RSS/Atom、贴吧、小黑盒走适配器后归一化写入统一条目表。
- RSS 支持 ETag/Last-Modified 条件请求、发现站点声明的 feed、规范 URL、去重、图像本地缓存；后台每 60 分钟抓取到期源，并限制并发。单进程 source lock 只能防本进程并发；如果同一数据目录由多个后端进程共享，当前内存锁不构成跨进程互斥。
- 新闻阅读器通过限域浏览器会话 Cookie 调用 `/news`；桌面先申请短时一次性票据，新闻页在允许的本机来源下兑换 HttpOnly/SameSite Strict Cookie。新闻页面不应持有后端 API Token。
- 行为事件包括阅读页曝光、打开原文、点赞/不感兴趣、少看此类、订阅、话题建议处理和历史访问；用事件去重键写 SQLite。兴趣画像基于最近 90 天事件和时间衰减生成关键词正负权重，并持久化版本快照。
- 正式推荐使用关键词排序与可选正文向量语义排序，语义不可用时退回关键词；两榜按名次 RRF 融合，另外加来源亲和、短期新鲜度，并对首页前段做来源多样性调整。模型不参与在线新闻推荐排序；模型可用于话题建议，且是用户触发的可选路径。
- 浏览器历史是显式导入/同步：扩展新增的 Chrome History API 同步把用户配置时间窗内的访问事件通过本机新闻会话传给后端；后端也有读取 Chromium profile History SQLite 的手动导入 API。浏览器历史只用于本地兴趣事件，不持续后台监控；缺少授权或页面曝光不应描述为默认自动上传完整历史。
- 新的新闻推荐评估路由只在同时设置 `TABKEEP_ENABLE_NEWS_EVALUATION=1` 与关闭 API 鉴权的本机开发环境注册；评估样本、标注和指标不是面向生产用户的功能。

## 需要在复盘中纠正或明确的旧口径

- 旧 08 把 Windows sidecar、真实安装、迁移和进程回收列为后续；当前仓库已有 PyInstaller + Tauri 正式 sidecar、首次旧数据迁移、MSI/NSIS 安装和安装验收流程，必须更新。
- 旧 01/03/04 把 RAG 描述成固定的早期链路；需核查并补入 query normalization/rewrite、RAGAS 与独立评估/调试工具，但把未合并/规划中的内容排除。
- 旧文档没有区分个人开发项目中的生产用户功能、显式触发的实验能力、仅开发环境路由和外部服务依赖；新版统一标注成熟度与数据边界。

## RAG / 知识库更新发现

- 当前检索先用 `normalize_query` 做 Unicode/空白/标点归一与保守英文技术词纠错；若可用向量检索，搜索入口可并行执行本地 FTS 和可选 LLM query rewrite，改写只用于向量查询（RAG 问答还会维护自己的 follow-up 逻辑）。
- `retrieval.search_knowledge` 同时获取 FTS 与可选向量候选，以 `RRF K=60` 合并，再可选调用 rerank；服务失败会回退到已有结果。`hit_test_knowledge` 可按 FTS、vector、hybrid 和 notes/RGB 语料分别查看排名证据。
- 索引以 SQLite 文档/paragraph/chunk/FTS 作为可追踪事实层，以 LanceDB 存向量和必要元数据；对每份文档替换其向量记录，保留 embedding 状态/错误、同步日志、健康检查和 repair/migrate 操作。
- RAG 问答先检索带来源的 citation，再按追问需要格式化历史、构造证据上下文并请求模型；有答案不足信号与扩展上下文策略。回答生成、上下文召回和事实性需要不同评估，不能用单一检索指标替代。
- 代码已实现图谱显式关系（来源、标签、标题、文档链接、概念）与基于文档聚合向量的 semantic_similar；边数和每篇文档邻接数有上限。主题地图是另一套从文档证据聚合的主题/文档/关联存储，可通过 LLM 补摘要并导出到笔记适配器，不能与知识图谱混称。
- 评估能力包括检索评估样例、RAGAS 答案评估、独立 RGB zh_refine 检索基准，以及 MCP/Skill 导出等后续应用集成；需在文档中分清默认产品路径与需要显式触发/外部 API/评估语料的能力。

## 完成审计

- 已将旧复盘扩写并更新，新增 README 索引、项目口径、资讯/推荐、缺陷路线与面试题库。
- 已核对新闻采集 schema、站点适配器、抓取与 reader 鉴权、两种历史导入路径、画像和 RRF 推荐链路。
- 正式推荐当前使用 RRF；评估路由仅在明确本机开发环境开关下注册，评估样本和画像事件隔离。
- 已核实知识库召回/重排/上下文和评估入口；query rewrite 与追问上下文当前默认关闭。
- 已核实扩展、桌面、后端的 API/存储/生命周期关系，以及 Windows sidecar 和首次迁移 allowlist。
- 已把有源码依据的风险与建议写入缺陷路线；所有复盘文档相对链接已解析。未运行测试。

## 完成核对结论

- 杂项/TabKeep项目复盘/README.md 索引覆盖 00–12 文档；旧文件名 08 保留为兼容跳转页。
- 复盘按项目定位、架构、选型、RAG、评估、图谱、扩展、桌面、发布、资讯、推荐、缺陷、面试组织，包含目标要求的功能链路、实现方式、取舍、限制和改进方向。
- 资讯推荐的 100 篇标注指标来自 TabKeep/.planning/2026-10-19-news-recommendation-evaluation/findings.md，并在文档中说明单用户单批次及正例偏高的限制。
- 已检查 README 中的相对 Markdown 链接目标均存在；关键实现与配置已用当前工作树重新核对。
- 本任务未运行测试，也未修改 TabKeep 产品源码；仓库已有未提交代码保持原样。