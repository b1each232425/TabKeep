# TabKeep Ragas 评估调查发现

## 初步发现

- TabKeep 已存在 Ragas 评估实现：`backend/services/knowledge/ragas_evaluation.py`。
- 评估依赖独立于生产依赖：`backend/requirements-eval.txt`，目前锁定 `ragas==0.4.3`。
- 已有 Ragas 单元测试：`backend/tests/test_ragas_evaluation.py`。
- 现有评估体系同时包含检索指标（Recall@K、MRR、Top1、Precision@K）和基于规则/LLM 的答案评估。
- 已有 RAG 评估台和历史路线文档；本次计划应优先补齐 Ragas 的实验数据、指标解释和回归闭环。

## 代码核对

- `run_eval()` 先执行检索，再按 `answerLimit` 选择答案型用例，调用同一套 `build_rag_messages()` 重新生成答案，之后才触发 Ragas；Ragas 没有独立的样本上限或运行入口。
- 当前 Ragas 指标为 `Faithfulness`、`FactualCorrectness`、`ContextPrecision`、可选的 `AnswerRelevancy`；没有 `ContextRecall`，也没有非 LLM 的检索指标映射。
- `ragasEligible` 统计所有填写 `expectedAnswer` 的用例，但 `ragasEvaluated` 受 `answerLimit` 和答案评估抽样共同限制，UI 上容易把“符合条件”误解为“本次会评估”。
- Ragas 结果仅写入 `KnowledgeEvalRunResponse`，没有保存运行记录、版本/配置快照、单 case 结果或指标趋势。
- Ragas 使用 `DiskCacheBackend` 写入 `storage.DATA_DIR / "ragas_cache"`，但没有显式缓存键策略、成本/调用量统计或并发/重试策略；每条用例的多个指标在用例内并发，整个用例循环仍是串行。
- 现有 `rag_eval_cases` 表已具备用例与预期答案字段，但没有 difficulty、数据集 split、标注状态、参考上下文或运行历史字段。
- Ragas 评估用例上下文来自 `rag_contexts(hits[:limit])`，与生成答案的 14,000 字上下文预算一致，这一点已有单测保护。

## 官方资料核对（Ragas 0.4）

- 新项目推荐使用 `ragas.metrics.collections` 和异步 `ascore()`；当前实现的调用形态符合该方向。
- collections API 的单轮样本字段可组织为 `user_input`、`retrieved_contexts`、`response`、`reference`，适合将现有 `KnowledgeEvalCase` 与运行结果转换为 Ragas 数据集。
- `Faithfulness` 主要检查答案是否被上下文支持；`ContextPrecision` 需要问题、检索上下文和参考答案；`AnswerRelevancy` 需要 LLM 与 embeddings；`FactualCorrectness` 对照生成答案和参考答案。
- Ragas 0.4 的文档指出传统批量 `evaluate()` 正转向 experiment 工作流，后续应保留本地可控 runner，同时为数据集/运行版本化预留结构，不要把 Ragas 原生实验 API 强绑定到在线请求。

## 环境问题

- 当前 PowerShell 中 `python` 命令解析到 `C:\Users\yeweixuan\AppData\Local\Microsoft\WindowsApps\python.exe`，启动失败；未确认实际评估虚拟环境和 Ragas 安装状态。
- 项目配置的 `C:\Users\yeweixuan\.conda\envs\tabkeep\python.exe` 可用，Python 3.12.13，且 `ragas`、`openai` 均已安装。
- 使用该环境完整导入 Ragas、collections metrics 和 dataset schema 的探针在 10 秒内超时；这不是功能结论，但提示需要在真实环境测量首次导入/初始化耗时，必要时采用评估 worker 或预热。

## Context Recall 成本核算

- 本机 Ragas 0.4.3 的 collections `ContextRecall.ascore()` 会把 `retrieved_contexts` 拼成一个 context，对 reference answer 做一次结构化 LLM judge；不需要 embedding。
- 当前 TabKeep 每个样本的 Ragas judge 调用大致为：Faithfulness 2 次、Factual Correctness 2 次、Context Precision 1 次、Answer Relevancy 1 次（启用 embedding 时另有 embedding 请求）。增加 Context Recall 后变为约 7 次 judge 请求/样本，Ragas judge 请求数增加约 16.7%；未启用 Answer Relevancy 时约从 5 次增加到 6 次，增加约 20%。
- 由于 TabKeep 还会先为每个答案调用 1 次生成模型，按“生成 + Ragas judge”总 LLM 请求数估算，启用 Answer Relevancy 时约从 7 次增加到 8 次/样本，增加约 14.3%。
- Context Recall 的新增 token 成本近似为：`样本数 ×（Ragas prompt 固定开销 + 14,000 字上下文上限对应的实际输入 token + 参考答案 token + 结构化理由输出 token）`；实际平均成本取决于真实上下文长度、参考答案长度、judge 模型和供应商单价。
- 适合先只对 10～20 条 challenge/natural/changed case 开启 Context Recall，并复用现有 DiskCache；不建议第一版默认对全部 260 条答案样本运行。
