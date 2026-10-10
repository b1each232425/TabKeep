# TabKeep 专属 RAG 评估集调研记录

## 当前发现

- 用户提供的截图显示一组以 MySQL 学习笔记为主的知识内容，包含 B+ 树、索引、COUNT、表空间、InnoDB 行记录、溢出页、VARCHAR 等主题。
- 截图中的笔记已经存在“以后可复用点”内容，但本任务应以笔记正文中的事实和解释为答案依据。
- 本地来源目录为 `E:\Notes\TabKeep评估集构建`，共有 15 个 Markdown 文件，其中两个“图解MySQL介绍”是同一主题的 full/summary 版本。
- 当前开发库为 `backend/data/knowledge.db`，笔记已经以 `source_type=tabkeep_note` 入库；使用 `expectedDocumentId` 区分同名笔记，避免旧 Inbox 副本误匹配。
- 选择 14 个去重主题作为 canonical 来源，排除“图解MySQL介绍”的 full 重复版本；每个主题生成 2 条 source-grounded 候选用例，共 28 条。
- 每条用例保留问题、简洁标准答案、`caseType`、原文检索锚点、文档 ID、精确标题和相对笔记路径元数据；`expectedPath` 对这些笔记为空，因为索引记录使用 `note_id` 保存路径。
- 28 个原文锚点均能在目标文档的已索引 chunks 中找到，标题与文档 ID 全部匹配。

## 数据集设计

- 每条用例至少需要：问题、标准答案、参考文档/段落、难度、问题类型、来源元数据。
- 适合同时保留 `reference`（标准答案）和 `reference_contexts`（来源段落），以支持 Context Recall 与人工审阅。
- 当前评估链路对应字段为 `expectedAnswer`、`expectedText`、`expectedDocumentId`、`expectedTitle`、`answerKeywords`；以这套字段生成，兼容现有评估台。
- 题目暂分 `natural`（直接概念）和 `challenge`（机制、排查或优化）；全部 `shouldRefuse=false`，因为答案在本地笔记中有依据。
