# TabKeep 正式 RAG 评估集切换与扩展计划

## 目标

将正式评估默认范围切换到 TabKeep 专属 MySQL 笔记数据集，并把现有 28 条扩展为 56 条；原有 260 条保留为历史回归集。

## 阶段

- [completed] 检查当前评估 API、桌面评估台和评估用例表的默认行为
- [completed] 设计 active/legacy 数据集边界，避免旧用例被误跑或丢失
- [completed] 为 14 个笔记主题补充 28 条 source-grounded 用例
- [completed] 实现默认评估范围切换并迁移当前 SQLite 数据
- [completed] 运行格式、来源、数据库、前端构建和后端测试校验

## 约束

- “正式评估”指不传 `caseIds` 时的默认评估范围，以及评估台默认展示的用例。
- 旧 260 条不删除，标记为 `legacy`；新的 56 条标记为 `tabkeep-mysql-notes`。
- 新题继续只使用 `E:\Notes\TabKeep评估集构建` 中的笔记内容，不引入网络答案。
- Ragas 默认回答评估样本数调整为 56，显式运行旧历史集时仍可通过 `caseIds` 指定。
