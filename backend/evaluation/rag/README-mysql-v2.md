# MySQL 笔记评估集 v2

`tabkeep_mysql_notes_v2.json` 是独立于 v1 的正式集，包含 56 条用例：52 条可回答、4 条拒答；其中 20 条标有 `isCore=true`。题目仅从原有 14 篇笔记修订；金标可包含索引中同内容副本及已核实的同主题原文段落。

修改数据后，在项目根目录运行：

```powershell
python scripts/build_mysql_eval_v2.py
python scripts/sync_mysql_eval_v2.py --validate
python scripts/sync_mysql_eval_v2.py --import
python scripts/sync_mysql_eval_v2.py --check
```

`--validate` 只读检查数量、核心覆盖、金标段落、关键词证据与整个当前索引中可能回答拒答题的事实；`--import` 先备份 `backend/data/knowledge.db` 到 `.tmp`，再事务写入 v2；`--check` 核对 JSON 与数据库逐字段一致。任何潜在拒答答案命中都会中止，需要人工复核。v1、legacy 及历史运行记录不会删除。

桌面评估台的「笔记集」默认选择核心 20 条，可切换全量 56 条。运行记录保留每题快照、用例指纹和索引统计；历史 v1 记录不会被改写。已有后端进程需重启才能加载新代码。可用以下命令在空闲本地端口单独验证，不影响已有服务：

```powershell
python scripts/run_full_ragas_eval.py --base-url http://127.0.0.1:38473 --retrieval-only
python scripts/run_full_ragas_eval.py --base-url http://127.0.0.1:38473 --core
python scripts/run_full_ragas_eval.py --base-url http://127.0.0.1:38473
```

脚本会核验后端用例与 JSON 相同，再检查索引，并把结果存入 `runs/`。检索指标只对 52 条可回答题计算，4 条拒答另算；Ragas 不评拒答，评委失败独立计数。核心集对应 18 条检索、20 条答案、至多 18 条 Ragas。完整 Ragas 很慢且会产生模型调用费用，适合在核心集确认后再运行。

`tabkeep_mysql_notes_v2_review.md` 记录每题的修订理由、来源摘录和金标 ID。段落、索引或资料发生变化后须重新核对金标与拒答边界；高分本身不代表用例质量已验收。
