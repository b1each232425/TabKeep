# 本次运行发现

- 当前项目正式评估集和 Ragas 入口仍需从运行时配置确认。
- JSON 评估集 `backend/evaluation/rag/tabkeep_mysql_notes_20260906.json` 共 56 条，字段包含 `expectedAnswer`。
- 结果运行接口为 `POST /knowledge/eval/run`；当前代码检索结果返回内存，不会自动保存完整 run 历史，因此本次需要额外保存响应快照。
- 后端 `38471` 和评估台 `5175` 当前请求返回 502，尚未确认是服务未启动还是端口被其他进程占用。
- `backend/data/knowledge.db` 有 204 个文档、976 个 chunk，976 个 chunk 的 `embedding_status` 均为 `ready`；本次不需要重建索引。
- 当前模型配置已切到 `Qwen/Qwen3.5-4B` / SiliconFlow，thinking 已开启，模型 API 与 embedding API key 均存在但不会写入运行记录。
- 本机设置了 `HTTP_PROXY/HTTPS_PROXY=127.0.0.1:7890`；本地评估运行器必须显式绕过代理，否则 localhost 请求会收到 502，外部模型请求仍由后端按系统网络配置处理。
- 数据集结构盘点：56 条、14 个主题、每个主题 4 条；28 条 `natural`、28 条 `challenge`；无重复问题，所有用例都有预期答案和答案关键词。
- 评估标注存在明显弱点：56 条都有 `expectedDocumentId`，但没有 `expectedParagraphId` 或 `expectedPath`；`expectedText` 平均仅 16.3 个字符。当前评估代码在有 `documentId` 时直接按文档级命中判定，Recall@10 实际更接近“文档是否召回”，不是精确段落召回。
- 56 条中有 38 条至少一个 `answerKeywords` 不会原样出现在 `expectedAnswer` 中，例如“生成时机”“B+树”“范围查询”等；这会让严格的答案关键词覆盖率惩罚语义正确但措辞不同的答案。
- 当前 `answerLimit=10` 的选择不是随机抽样：`selected_answer_eval_case_ids` 按 `challenge` 优先、再按 ID 排序，因此截图中的 10 条偏向困难题，不能代表整个 56 条。
- 预期答案长度约 57–165 字，整体可作为 Ragas reference；因此 Ragas 的“指标失败/调用失败”不能简单归因于数据质量，数据问题主要影响 ground truth 严格程度和分数解释。
