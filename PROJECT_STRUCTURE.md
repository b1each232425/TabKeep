# TabKeep 项目结构说明

这份文档是给开发者看的目录索引，不是面向普通用户的 README。它的目标是说明 TabKeep 各目录负责什么、主要代码入口在哪里，以及做某类改动时应该先看哪些文件。

## 顶层目录

```text
TabKeep/
├── backend/       # FastAPI 后端：数据、同步、知识库、RAG、图谱、评估 API
├── desktop/       # Tauri 2 + React 桌面端：主要用户界面和开发调试台
├── extension/     # Plasmo Chrome 扩展：标签页捕获、收藏入口、浏览器侧集成
├── scripts/       # 开发启动脚本和辅助工具
├── design/        # 产品设计、参考材料和 UI 方向记录
├── tmp/           # 本地临时测试数据，例如 mock Obsidian vault
├── AGENTS.md      # Agent 工作指南和当前产品方向
├── claude.md      # 早期项目规范、后端约定和扩展说明
└── *.md           # RAG、图谱、评估等阶段性设计和复盘文档
```

## 后端 backend

后端入口是 `backend/main.py`，默认监听 `http://127.0.0.1:38471`。这个文件只负责 FastAPI app、CORS、路由注册和健康检查，业务逻辑不要塞进这里。

```text
backend/
├── main.py              # FastAPI 应用入口
├── requirements.txt     # 后端 Python 依赖
├── routers/             # API 路由层
├── schemas/             # 请求/响应模型
├── services/            # 业务逻辑层
├── models/              # 后端数据模型
├── tests/               # 后端单元测试
└── data/                # 运行时数据，通常不提交
```

### routers

```text
backend/routers/
├── tabs.py       # 标签页同步接口
├── classify.py   # 模型配置和标签分类接口
├── notes.py      # 笔记集成、保存和摘要接口
└── knowledge.py  # 知识库、RAG、图谱、评估、调试接口
```

### services/knowledge

知识库和 RAG 的核心逻辑集中在 `backend/services/knowledge/`：

```text
backend/services/knowledge/
├── chunking.py       # Markdown 清洗、paragraph/chunk 切分
├── cjk.py            # 中文/CJK FTS 预处理
├── db.py             # SQLite 文档、段落、chunk、同步记录等持久化
├── embeddings.py     # embedding 调用和配置
├── evaluation.py     # RAG 检索/答案评估逻辑
├── graph.py          # 知识图谱节点和边构建
├── index_health.py   # 索引健康检查和修复建议
├── indexing.py       # 文档入库和索引构建
├── qa.py             # RAG 问答消息构造和回答生成
├── rerank.py         # rerank 模型调用
├── retrieval.py      # FTS + vector + rerank 混合检索
├── service.py        # 知识库服务编排
├── siyuan_sync.py    # SiYuan 数据同步
├── sync_all.py       # 多来源统一同步入口
├── topics.py         # 主题目录生成
├── vector_debug.py   # 向量库调试查询
└── vector_store.py   # LanceDB 封装
```

常见改动入口：

- 调整切块策略：先看 `chunking.py`，再看 `indexing.py`。
- 调整检索排序：先看 `retrieval.py` 和 `rerank.py`。
- 调整 RAG 回答约束：先看 `qa.py`。
- 调整评估规则：先看 `evaluation.py`。
- 调整图谱关系：先看 `graph.py`。
- 调整同步流程：先看 `sync_all.py`、`siyuan_sync.py` 和 `db.py`。

## 桌面端 desktop

桌面端是主要用户界面，使用 Tauri 2 + React + Vite。Tauri 开发时默认占用 `http://127.0.0.1:38472`，独立 RAG 评估台默认占用 `http://127.0.0.1:5175/eval.html`。

```text
desktop/
├── src/             # React 前端源码
├── src-tauri/       # Tauri/Rust 桌面能力
├── eval.html        # 独立 RAG 评估台入口
├── package.json     # 桌面端脚本和依赖
└── vite.config.ts   # Vite 配置
```

### desktop/src

```text
desktop/src/
├── api.ts       # API barrel，统一 re-export
├── api/         # 按业务拆分的 API 调用
├── components/  # 可复用 UI 组件
├── eval/        # 独立 RAG 评估台组件和逻辑
├── lib/         # 前端工具函数
├── sections/    # 桌面端主功能区
├── types.ts     # 共享类型定义
├── App.tsx      # 桌面端主应用
└── index.css    # 全局样式、设计 token 和组件类
```

### api

```text
desktop/src/api/
├── client.ts     # fetch 封装和基础客户端
├── config.ts     # 配置类 API
├── defaults.ts   # 默认值和常量
├── eval.ts       # RAG 评估台 API
├── knowledge.ts  # 知识库、图谱、索引、调试 API
├── ocr.ts        # OCR 相关 API
└── translate.ts  # 翻译相关 API
```

### sections

```text
desktop/src/sections/
├── OverviewSection.tsx           # 概览
├── KnowledgeSection.tsx          # 知识库搜索、问答、同步主入口
├── KnowledgeGraphSection.tsx     # 知识图谱页面
├── KnowledgeGraphPanel.tsx       # 局部关系图谱交互面板
├── TopicMapPanel.tsx             # 主题目录生成和打开笔记
├── KnowledgeIndexHealthPanel.tsx # 索引健康状态
├── SettingsSections.tsx          # 分组、模型 API、笔记集成配置
├── TranslateSection.tsx          # 翻译主功能
├── NotesSection.tsx              # 笔记相关入口
├── VectorDebugSection.tsx        # 向量库调试
├── OcrDebugSection.tsx           # OCR 调试
└── OcrWindows.tsx                # OCR/区域翻译窗口
```

桌面端信息架构原则：

- 用户级能力放在主导航，例如知识库、知识图谱、翻译、设置。
- 开发诊断能力放在调试入口，例如向量库、OCR 调试、评估台。
- 设置类能力尽量集中，避免扩展端和桌面端重复配置。

## 扩展 extension

扩展负责浏览器侧入口，主要用于同步标签页、收藏网页和触发后端/桌面端能力。

```text
extension/
├── src/
│   ├── background.ts  # 后台脚本：标签监听、同步、收藏转发
│   ├── popup.tsx      # 扩展弹窗 UI
│   ├── style.css      # 扩展样式
│   └── globals.d.ts   # 全局类型声明
├── package.json
└── tailwind.config.js
```

扩展端现在尽量保持轻量：设置入口已收敛到桌面端，扩展侧主要保留浏览器上下文相关能力。

## scripts

```text
scripts/
├── dev.ps1                    # 统一开发启动脚本
├── mock_obsidian_vault.py      # 生成 mock Obsidian 测试库
└── plasmo-parcel-hmr-guard.cjs # Plasmo HMR 兼容处理
```

根目录 `package.json` 对 `scripts/dev.ps1` 做了一层封装：

```powershell
pnpm dev            # 同时启动 backend、extension、desktop
pnpm dev:backend    # 只启动后端
pnpm dev:extension  # 只启动扩展
pnpm dev:desktop    # 只启动桌面端
pnpm dev:eval       # 只启动 RAG 评估台
pnpm test:backend   # 后端单元测试
pnpm mock:obsidian  # 生成 mock Obsidian vault
```

## 运行时数据

常见运行时数据位置：

```text
backend/data/              # 后端配置、SQLite、LanceDB 等运行时数据
backend/data/notes/        # LocalFileAdapter 保存的 Markdown
tmp/mock-obsidian-vault/   # mock Obsidian 测试库
desktop/node_modules/      # 桌面端依赖
extension/node_modules/    # 扩展端依赖
```

这些数据通常不应该提交。修改索引、同步、评估或调试逻辑时，要注意不要把本地知识库内容、API Key、OCR 文本或截图产物带入 commit。

## 文档索引

```text
AGENTS.md                                # Agent 工作指南和产品边界
claude.md                                # 旧版项目规范
TABKEEP_RAG_CHAIN_STUDY.md               # RAG 链路学习记录
TABKEEP_RAG_INTEGRATION_PLAN.md          # RAG 集成计划
TABKEEP_RAG_TECH_SELECTION.md            # RAG 技术选型
TABKEEP_TOPIC_MAP_PLAN.md                # 主题目录/图谱计划
findings.md                              # 阶段发现
progress.md                              # 进度记录
task_plan.md                             # 任务计划
```

## 修改前速查

- UI 版面或导航：看 `desktop/src/App.tsx`、`desktop/src/sections/`、`desktop/src/index.css`。
- 桌面端 API 调用：看 `desktop/src/api.ts` 和 `desktop/src/api/`。
- 后端接口：看 `backend/routers/`。
- 后端业务逻辑：看 `backend/services/`。
- RAG 检索质量：看 `backend/services/knowledge/retrieval.py`、`rerank.py`、`evaluation.py`。
- 图谱关系：看 `backend/services/knowledge/graph.py` 和 `desktop/src/sections/KnowledgeGraphPanel.tsx`。
- 笔记来源同步：看 `backend/services/knowledge/sync_all.py`、`siyuan_sync.py`、`db.py`。
- 扩展收藏流程：看 `extension/src/background.ts` 和 `backend/routers/notes.py`。
