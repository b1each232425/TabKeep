# TabKeep 独立 Skill 导出计划

## 目标

实现一个首版独立 Skill 导出器：从 TabKeep 当前本地知识库选择文档/段落，生成不依赖 TabKeep、MCP、API 或绝对文件路径的可复制 Skill 包。以当前 MySQL 知识为首个样例。

## 阶段

- [completed] 盘点当前索引数据并确定首版导出范围
- [completed] 实现知识块导出器和 Skill 包格式
- [completed] 生成 MySQL Skill 样例并补充离线使用说明
- [completed] 验证包结构、来源完整性和回归测试
- [completed] 接入桌面端“按目标生成 Skill”工作流
- [completed] 验证候选召回、定向导出和桌面端构建
- [completed] 将 Skill 元数据改为基于已选知识自动生成，只读预览后确认导出
- [completed] 检查前后端静态有效性并记录实现边界
- [completed] 修正 Skill 模板中的外部搜索能力、单文件兼容说明与引用格式
- [completed] 生成并检查修订版 Skill 包，保留原始 v0.1.0
- [completed] 将触发条件收敛为宽泛的主题/意图类别并更新桌面预览
- [completed] 生成并检查 v0.1.2，保留 v0.1.0 与 v0.1.1
- [completed] 盘点 v0.1.2 的知识块并审计其是否足以支撑 MySQL 技术问答基准
- [completed] 用户确认改用真实 MySQL 技术笔记
- [completed] 从 13 篇去重后的技术 Markdown 笔记导出独立 Skill v0.2.0
- [completed] 从现有 MySQL v2 基准筛选 16 条有来源题与 4 条拒答题，生成 Skill 评估集
- [in_progress] 使用可用的 SiliconFlow Key 跑 20 题三组对照并持久化原始结果（7/60 已完成；遇到重复超时，等待用户选择超时/推理策略）
- [completed] 核验 Skill ZIP、评估集、来源块映射与本地 dry-run；记录 API 实验不覆盖宿主自动触发

## 范围边界

- 首版默认导出文档/段落知识块，不做新的 LLM 摘要调用，避免导出过程产生额外 API 成本和限流。
- 保留必要的原文证据，使用相对来源 ID；不导出 API Key、绝对本地路径或完整评估答案作为知识内容。
- MCP 只保留为未来刷新导出包的可选入口，不作为 Skill 运行依赖。
- 生成的 Skill 目录位于项目下，便于用户复制到项目外或压缩分发。
- 网页端不增加 Skill 导出入口；导出交互只存在于 Tauri 桌面端知识库页面。
- 不允许默认导出整库；必须先输入目标并确认 RAG 召回的候选知识范围。
