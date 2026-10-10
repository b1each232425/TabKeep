# TabKeep 评估集优化计划

## 目标

把正式的 `tabkeep-mysql-notes` 56 条评估集改成可解释、可复查的来源标注，并保持历史 260 条 legacy 用例不变。

## 阶段

- [completed] 盘点现有 56 条用例的重复、来源、答案和关键词质量
- [completed] 为正式用例补齐段落级来源目标
- [completed] 修正答案关键词，使其均来自参考答案中的核心事实
- [completed] 同步 JSON 与 SQLite，并验证正式集/历史集边界
- [completed] 运行后端回归测试

## 结果

- 正式集仍为 56 条，28 条 natural、28 条 challenge。
- 56 条全部绑定 `expectedParagraphId`；3 条跨段落答案增加了补充来源目标。
- 每条答案有 4–6 个参考关键词，关键词均可在 `expectedAnswer` 中匹配。
- 旧的 260 条 legacy 记录未修改。

