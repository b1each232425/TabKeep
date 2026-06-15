# TabKeep 下一阶段：笔记联动增强 + 混合 RAG 知识库

## Summary

- 可行性：高。TabKeep 已有笔记保存链路、LLM 配置和 Markdown/Obsidian/思源 adapter；OpenWiki 证明了本地 SQLite + FTS + LLM 重排的知识库路线可行。
- 推荐难度：L。首版做 TabKeep 独立知识库，不直接依赖 OpenWiki，只参考它的架构：本地索引、候选检索、问答、引用来源。
- 首版范围：优先支持 TabKeep 收藏内容 + Markdown/Obsidian 文件夹；embedding 可选，未配置时自动降级为 FTS + LLM 重排。
- 先置任务：先把当前未提交的桌面端划词翻译/启动脚本改动提交，再开始 RAG，避免两个大阶段混在一个 commit。

## Key Changes

- 新增后端知识库索引层：
  - 使用 `backend/data/knowledge.db` 存储文档、分块、FTS 索引、embedding、RAG 对话。
  - 文档来源包括：TabKeep 保存的网页/摘要/链接、本地 Markdown/Obsidian vault。
  - 保存笔记成功后自动把本次内容写入知识索引；外部 Markdown 通过手动“同步/重建索引”导入。
  - Markdown 扫描默认跳过隐藏目录、`.git`、`.obsidian`、`node_modules`、非 `.md` 文件和超大文件。

- 新增混合检索流程：
  - FTS5 做关键词召回，并加入中文 CJK 分词预处理，参考 OpenWiki 的做法。
  - embedding 配置存在且可用时，对文档 chunk 生成向量；未配置或失败时不阻断，自动退回 FTS。
  - 查询时执行：问题改写关键词 -> FTS topK + vector topK -> RRF 融合排序 -> 取 top chunks -> LLM 基于引用回答。
  - 首版不做 OpenWiki 那种“AI 自动编译概念 wiki 页/知识图谱”，先做稳定的 source-grounded RAG。

- 新增配置与 UI：
  - 桌面端新增「知识库」页面，包含索引状态、Markdown/Obsidian 路径、重建索引、搜索、问答入口。
  - 后端配置新增 `knowledgeConfig` 和 `embeddingConfig`。
  - `embeddingConfig` 默认关闭；可选填写 OpenAI-compatible embedding `baseURL/apiKey/model`。
  - 如果用户未配置 embedding，页面明确显示“当前使用全文检索 + LLM 重排”。

## Public Interfaces

- 新增后端接口：
  - `GET /knowledge/stats`
  - `GET /knowledge/config`
  - `POST /knowledge/config`
  - `POST /knowledge/reindex`
  - `POST /knowledge/search`
  - `POST /knowledge/ask`
  - `GET /knowledge/sessions`
  - `GET /knowledge/sessions/{session_id}/messages`

- 新增核心数据模型：
  - `KnowledgeDocument`：来源、标题、URL、文件路径、note_id、hash、更新时间。
  - `KnowledgeChunk`：document_id、chunk_index、content、token/字符长度、embedding 状态。
  - `KnowledgeAnswer`：answer、citations、source_mode、confidence。
  - `EmbeddingConfig`：enabled、baseURL、apiKey、model。

## Test Plan

- 后端：
  - 保存一条 TabKeep 笔记后，`knowledge.db` 中出现 document/chunk。
  - 扫描 Obsidian/Markdown 文件夹后能索引多个 `.md` 文件。
  - 修改文件后重新索引只更新 hash 变化的文档。
  - 中文关键词如“设计”“RAG”“笔记联动”能被 FTS 命中。
  - embedding 未配置时 `/knowledge/ask` 仍可回答或返回可理解错误。
  - embedding 配置错误时不破坏 FTS 检索。

- 桌面端：
  - 知识库页面能显示文档数、chunk 数、最近同步时间。
  - 点击“重建索引”能看到进度/结果。
  - 搜索能返回标题、来源、片段和打开路径/URL。
  - 问答结果包含引用来源，不编造来源。

- 验证命令：
  - `backend`：在 `conda activate tabkeep` 后启动并验证接口。
  - `desktop pnpm build`
  - `extension pnpm build`
  - 现有 `/notes/save`、`/notes/summarize`、桌面端启动命令不回归。

## Assumptions

- TabKeep 和 OpenWiki 没有运行时关系；OpenWiki 只作为架构参考。
- 首版外部笔记只支持 Markdown/Obsidian 文件夹；思源全量导入作为下一阶段。
- embedding 是增强项，不是必需项；没有 embedding 时也要可用。
- 首版不做知识图谱、自动 wiki 页面编译、自动定时扫描和跨设备同步。
- RAG 数据保存在本地，默认不上传；只有用户主动提问时才把检索出的片段发送给已配置的 LLM。
