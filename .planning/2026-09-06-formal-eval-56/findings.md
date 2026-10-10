# 正式评估集切换记录

## 已确认

- 当前 `POST /knowledge/eval/run` 未传 `caseIds` 时会读取全部评估用例，`GET /knowledge/eval/cases` 也返回全部用例。
- 评估台当前显示全部用例，答案评估默认上限为 30；56 条正式集需要改为默认 56，避免只跑半数。
- 现有数据库有 260 条旧用例和 28 条 `dataset=tabkeep-mysql-notes-20260906` 用例。
- 采用显式 `dataset` 字段比依赖 note 前缀更适合长期维护；旧数据迁移为 `legacy`，新的正式集迁移为 `tabkeep-mysql-notes`。

## 已验证

- 评估 JSON 现在有 56 条唯一用例，按 14 个主题各扩展 2 条，分布为 28 条 natural、28 条 challenge。
- 56 条 expectedText 锚点全部存在于对应已索引文档的 chunks 中，没有引入网络答案。
- SQLite 中共有 316 条记录：56 条 `tabkeep-mysql-notes` 正式集、260 条 `legacy` 历史集。
- 默认列表和不传 `caseIds` 的默认运行只读取正式集；显式传入旧用例 ID 的路径仍保留。
- `answerLimit` 的后端和评估台默认值已从 30 调整为 56。
