# TabKeep 知识图谱 2.0：主题知识地图工作台

## Summary

把现在“展示节点和边”的知识图谱，改成更实用的 **主题知识地图工作台**。核心目标不是画图，而是帮助用户看清：知识库里有哪些主题、每个主题包含哪些笔记、为什么这些内容被归在一起、可以继续问什么问题。

默认不再使用 React Flow 画布作为主视图。后端生成“主题”，前端用三栏工作台展示：左侧主题列表，中间主题概览，右侧证据、来源和操作。

## Key Changes

- 后端新增主题地图服务：
  - 基于现有文档、chunks、tags、heading、wikilink、路径和标题生成基础主题。
  - 如果 embedding / LanceDB 可用，则计算文档向量相似度，把相似文档聚成主题；不可用时自动降级为显式信号聚类。
  - 新增 SQLite 表保存主题、主题文档、主题关系、AI 增强结果，重建时可重复执行且不产生重复数据。
  - 保留现有 `/knowledge/graph`，但前端主入口改用新的主题地图接口。

- 新增手动 AI 增强：
  - 用户点击“AI 整理主题”时，复用现有「模型 API」配置调用 OpenAI-compatible LLM。
  - LLM 只负责主题命名、摘要、关键词、推荐问题，不负责凭空生成关系。
  - 没有模型配置时，主题地图仍可用，只显示基础聚类结果和证据。

- 新增接口与类型：
  - `GET /knowledge/topics`：返回主题列表、统计、筛选结果。
  - `GET /knowledge/topics/{topicId}`：返回主题详情、代表笔记、关键片段、关联主题、归类证据。
  - `POST /knowledge/topics/rebuild`：从已索引知识库重建主题地图。
  - `POST /knowledge/topics/enrich`：手动 AI 增强主题摘要和命名。
  - 新增类型：`KnowledgeTopic`、`KnowledgeTopicDocument`、`KnowledgeTopicEvidence`、`KnowledgeTopicRelation`、`KnowledgeTopicDetailResponse`。

- 桌面端改造为“知识地图”页面：
  - 左侧：搜索、来源筛选、主题列表、重建、AI 整理主题。
  - 中间：当前主题摘要、关键词、代表笔记、关键引用片段、相关主题。
  - 右侧：选中文档详情、打开来源、复制来源、复制引用、围绕该主题提问。
  - 每个主题必须展示“为什么归类”：共享标签、双链、标题/路径命中、embedding 相似度等。
  - 移除当前主视图中的大画布式节点展开体验；关系只作为列表或小型关联区展示。

## Test Plan

- 后端测试：
  - 无 embedding 时，能通过 tags / heading / wikilink / 标题生成主题。
  - embedding 可用时，相似文档能进入同一主题，并保留显式证据。
  - `/knowledge/topics/rebuild` 可重复执行，不产生重复主题文档关系。
  - `/knowledge/topics/enrich` 在模型配置缺失时返回明确错误，不影响基础主题地图。
  - 主题详情能返回代表笔记、关键片段、关联主题和归类证据。

- 前端验证：
  - 进入“知识地图”后不再看到聚成一团的画布，而是三栏主题工作台。
  - mock Obsidian 数据重建后，能看到多个有意义主题。
  - 点击主题能看到摘要、代表笔记和“为什么归类”。
  - 点击文档能打开/复制来源。
  - AI 整理主题成功后，主题标题和摘要更新；失败时保留基础结果。

- 验证命令：
  - `pnpm test:backend`
  - `cd desktop && pnpm build`
  - `cd extension && pnpm build`

## Assumptions

- 主题地图优先服务“浏览和理解知识库”，不是继续追求全量图谱视觉效果。
- AI 增强采用手动触发，避免每次重建都消耗模型额度。
- embedding / LanceDB 是增强能力，不是必需条件；没有 embedding 时必须可降级使用。
- 首版不做 LLM 自动实体抽取，不修改 Obsidian / SiYuan / Markdown 原文件。
- 现有 RAG 问答继续保留，主题地图新增“围绕主题提问”作为入口增强。
