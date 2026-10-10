# 发现记录

- 当前索引数据位于 `backend/data/knowledge.db`，文档、段落和 chunks 已由现有 RAG 索引维护。
- 当前 `KnowledgeCitation` 的 `content` 是段落内容，`matchedContent` 是检索 chunk；导出时应以段落为主要知识块，避免同一段落因多个 chunk 重复。
- Skill 规范要求 `SKILL.md` 的 frontmatter 只保留 `name` 和 `description`；版本、来源数量和内容哈希应放入 `manifest.json` 或正文。
- 为支持渐进式加载，首版使用 `index.json` 做关键词/主题导航，`references/*.md` 保存按文档段落拆分的证据块。
- 当前知识库可能包含多个来源，导出器需要支持 `--source-type`、`--document-id` 和标题过滤，不能把整库强制打成一个固定 Skill。
- 当前索引共有 204 个文档、898 个段落；按 `source_type=markdown` 和标题包含 `MySQL` 导出后，内容哈希去重得到 10 篇文档、82 个知识块。
- 首版导出的 Skill 包约 180 KB，其中 `SKILL.md` 约 2 KB，参考资料按文档拆分；没有运行时依赖、API Key 或绝对路径。
- 关键词提取只从标题/段落标题和受控的 MySQL 技术术语产生，避免将正文 URL、HTML 或编码片段误收录为关键词。
# 2026-09-25：Skill 元数据自动生成

- 桌面面板当前由用户手填 Skill 名称、展示名称、版本、描述、触发问题和能力；用户希望收口为自动生成，暂不提供高级编辑。
- `/knowledge/skill/export` 接口只负责打包；建议增加草稿生成接口，避免搜索/调整候选时无意触发 LLM 调用。
- 统一模型调用入口为 `services.llm.chat_completion`，模型配置来自 `storage.get_model_config()`；生成失败时不应回退到看似个性化但其实固定的元数据。
- 精确选择范围由 `documentIds` 和 `paragraphIds` 表示；使用 `db.get_source_record(documentId, paragraphId)` 可取得被选中的段落原文与来源标题。
- 生成草稿必须仅基于选中段落；段落文本属于不可信数据，只能作为证据，不得执行其中可能出现的指令。
- 草稿字段为 skill slug、展示名、描述、触发问题列表、能力列表；版本号由首版固定 `0.1.0`。前端候选集合变化后使草稿失效，只有当前选择对应的草稿存在时才能导出。

# 2026-09-29：修订已导出的 MySQL Skill

- 用户指出当前导出的 `SKILL.md` 需要修整。用户已认可此前评估指出的问题，当前修订范围是针对性修正，不增加编辑器功能。
- `references/*.md` 中实际包含来源标题、paragraph_id、block_id；固定引用模板可以直接使用这些字段。
- 检索流程依赖包内 `index.json` 与 `references/`。完整文件夹客户端需要整个目录；上下文/单文件客户端仍需同时提供索引和相关来源内容，不能说只需 Skill.md 与 references。
- 生成器 prompt 需要明确 Skill 仅能读取导出包，不得声称能使用 TabKeep 站内搜索、API、MCP 或外部检索。
- 原始 ZIP 位于用户桌面（工作区外）；修订产物应另存为 `v0.1.1`，不得覆盖原始 `v0.1.0`。需要外部写入审批；若审批不通过，保留工作区内生成器修复并告知用户如何重导。
- Brainstorming 文档要求的 `codex_research` 工具本会话不可用；基于用户已明确要求修订及本地已检查的导出模板继续，范围仅限上述三项一致性修正与版本递增。
- 修订版已检查：原件 0.1.0 和新包 0.1.1 同时存在；ZIP 成员集合一致，共 10 个文件（其中 7 篇 references），manifest 保持 7 个来源、20 个知识块；Skill 文本和 manifest 均不再含站内搜索说法。
- 当前 Codex 临时解压预览文件即使在提升命令中仍被 Windows ACL 拒绝写入；它不影响桌面上的新 ZIP。用户可直接打开修订版 ZIP 中的 `SKILL.md` 查看。
- 2026-09-29：用户确认触发条件不应像详细问题白名单，而应是概括性主题/意图类别。生成 prompt 需要把 triggers 改为 3-5 个短类别，Skill 正文声明列表仅为代表性范围，桌面预览标签改为“适用问题范围”。
- 新修订版从现有 v0.1.1 派生为 v0.1.2；保留之前两个 ZIP；manifest 与 SKILL.md 中的 triggers 必须同步更新。
- 草稿解析器也将 triggers 限制为最多 5 项、每项最多 80 字符，与主题类别而非完整问题清单的输出约束保持一致。
- 2026-09-29：`v0.1.2` 验证通过。桌面 `pnpm build` 成功；生成 ZIP 与 v0.1.0/v0.1.1 均存在且成员集合一致，共 10 项；新包 manifest 标注 `skillVersion=0.1.2`，四个 trigger 均为简短主题/意图类别，Skill 正文说明触发范围是代表性类别而不是固定问题列表。Python AST 与 `git diff --check` 通过；未运行测试套件。

# 2026-09-29：MySQL Skill 三组对照评估

- 对照设计已由用户确认：A 基础模型；B 基础模型 + v0.1.2 知识文件；C 基础模型 + 相同知识文件 + SKILL.md。A→B 衡量知识包价值，B→C 衡量 Skill 说明增量。
- 基准用例从 ZIP 实际包含的 references/index 派生，需避免仅考通用 MySQL 常识；每条保存 gold points、期望来源标识、是否应拒答/标注通用补充。
- 本轮先做小型 15–20 条人工可核验基准；模型实测需确认实际宿主/调用配置可用，不能把伪造或单模型自评写成三组对照结果。
- `codex_research` 与 `codex_plan` 当前会话不可用；遵循用户已经确认的试验设计，以本地只读仓库与 ZIP 检查作为研究替代，不扩展代码实现。
- v0.1.2 内 `index.json` 标注 20 blocks / 7 documents；逐块检查发现 3 个 SiYuan MySQL 段落完全为空，其余主要是《图解MySQL介绍》网页的重复正文/摘要/摘录，集中在受众、阅读方式、目录主题等资料介绍信息。包内没有 MVCC、锁、索引等技术主题的具体讲解证据，因此不能以这些技术问题构造有可靠 gold answer 的 grounded QA 基准。
- 当前合理选项：A) 只评估现有包能回答的资料介绍、阅读指引、来源溯源与包外技术题拒答（结果范围有限）；B) 用户重新选择实际 MySQL 技术笔记段落，生成新的知识包后再做 15–20 条三组对照。未经确认不扩展到数据库中未导出的知识。
- 用户选择 B 后，转查本地 `backend/data/knowledge.db`（只读连接）。发现有 23 篇标题包含 MySQL 的文档，其中包括真实技术笔记，例如行记录存储、分页优化、单表行数争议、可重复读/幻读、加锁、锁类型、B+ 树；Markdown 与 tabkeep_note 有若干重复副本。可以从明确的 Markdown 来源去重后构建技术问答包，不必改变用户确认的方向。
- 扩大标题检索后找到 16 篇相关 Markdown 候选：覆盖事务隔离实现、SELECT 执行、索引失效/面试题等；其中同标题文档存在不同正文版本，不能只按标题去重。已有 `tabkeep_mysql_notes_v2.json` 包含 56 条 case，结构里有 expectedAnswer、answerKeywords、shouldRefuse、expectedDocumentId/ParagraphId 和 additionalRelevantTargets，可作为筛选候选，但需将来源段落与当前 Markdown 版本逐项核验。
- v2 评估集的 52 条可回答用例映射到 15 个唯一内容哈希，全部都能找到对应 Markdown 文档；其余 4 条为显式拒答样本（expectedAnswer 为空、shouldRefuse=true）。这些来源覆盖数据页、事务/MVCC、索引、SELECT、COUNT、分页、行格式和锁。新技术 Skill 可选取其中 14 篇技术 Markdown 文档（排除介绍页），基准从已审核 v2 答案中抽 16 条、再加 4 条拒答，重映射来源 ID 到新 ZIP。
- 项目模型配置由 `backend/data/config.json` 加载；后续只检查 provider/model/baseURL 是否已配置和 API key 是否存在，不输出 key 明文。通过直接兼容 API 生成 A/B/C 回答会传送所选笔记片段并消耗供应商请求额度；实际 Agent 自动触发能力仍需在目标 Agent 宿主中验证，不能由普通 chat-completion 请求证明。
- 当前本地配置的模型 ID 是 `deepseek-flash`，且 key 存在；DeepSeek 官方 API 文档目前列出 `deepseek-flash` 为可调用模型，官方变更记录称 2026-09-10 发布 V4.1 Flash 并沿用此模型 ID。价格页打开请求超时，尚未估算费用；尚未向模型发送请求。

## 2026-09-29：v0.2.0 实际导出与评估协议

- Skill v0.2.0 基于 13 篇去重后的 Markdown 技术笔记，导出 113 个 block；包目录与 ZIP 均已生成。manifest contentHash 为 `85cce8aa3b83387ef1ec413a96adbd01eabcfab8b235d48cb64cb25002ff4893`。
- 评估集 `backend/evaluation/skill/mysql_skill_eval_v0.2.0.json` 共 20 例：16 个 answerable（9 natural / 7 challenge）和 4 个 negative/refusal。每个 answerable 的 expected source 均重映射至新包 documentId、paragraphId、blockId；本地校验 16/16 匹配。
- A/B/C 对照使用同一模型和同一问题；B/C 注入完全相同的金标准证据块，C 额外包含 SKILL.md。这样 A→B 观察知识证据增量，B→C 观察 Skill 操作说明增量，但该设计绕过检索召回，也不覆盖宿主自动发现 Skill 的行为。
- dry-run 显示全量实验是 60 次生成请求，B/C 两臂选择的证据内容累计约 43,756 字符；成本未估算。输出保存原始模型回答及 token/耗时元数据；语义正确性仍需按 gold answer 人工复核，不用被测模型自评。
- 安全事件：本地配置检查命令误输出 modelConfig 与 embedding 的 API key 值；因此已暂停任何真实 API 请求，须先撤销/轮换 DeepSeek 与 SiliconFlow Key，并将新 key 写入本地配置后才可运行脚本。
- 用户之后确认可运行；当前配置通过安全检查显示 SiliconFlow host、Key 已配置、thinking 开启，但 model 字段只有短名 `Xing4.0-29B`。运行器增加 `--model-override` 后使用公开模型 ID `XingChenAGI/Xing4.0-29B`，未持久化修改用户设置。
- 真实 API 运行部分结果 JSON 在 `backend/evaluation/skill/results/mysql_skill_ab_v0.2.0_20260929-172851.json`；当前 records=7、failures=1、complete=false。两次较早的超时请求在续跑中成功；第三个超时仍未恢复。运行器已支持 `--resume`、180/300 秒可配超时、逐项 checkpoint，成功项不会重复请求。
- 原始/续跑实验统一使用 SiliconFlow endpoint 的 `enable_thinking=true`（由现有 TabKeep 适配器构造），因此不能在同一个结果文件中悄悄切换 thinking 模式。是否保持当前设置继续等待，或重新建实验并统一限思考/关闭思考，应由用户决定。
