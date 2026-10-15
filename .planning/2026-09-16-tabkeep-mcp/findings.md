# 发现记录

- 现有检索入口是 `services.knowledge.retrieval.hit_test_knowledge`，支持 `fts`、`vector`、`hybrid`、`min_score` 和现有 Rerank 降级逻辑。
- 检索结果 `KnowledgeHitTestItem` 已包含 `documentId`、`paragraphId`、`chunkId`、标题、来源路径、匹配片段和分数，可直接作为 MCP 搜索结果。
- 主题入口是 `services.knowledge.topics.list_topics`，可读取已有主题知识地图。
- `services.storage.init()` 从 `backend/data/config.json` 恢复状态，知识库索引位于同一数据目录下；MCP 直接加载该目录即可，不必启动 FastAPI。
- `backend/routers/knowledge.py` 的 HTTP 路由统一受 API token 保护，但本地 MCP 不经过 HTTP，因此不会读取或转发 token。
- 当前 `tabkeep` 环境没有 Python `mcp` 包；采用 JSON-RPC 2.0 换行分隔的最小 stdio 实现，支持 `initialize`、`notifications/initialized`、`tools/list`、`tools/call` 和 `ping`。
- 项目工作树已有多处用户修改；本次只新增 MCP 相关文件，并在知识库 DB 模块增加最小的只读来源查询函数。
