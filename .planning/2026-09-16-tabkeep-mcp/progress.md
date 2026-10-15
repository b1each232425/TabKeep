# 进度记录

- 2026-09-16：确认用户选择按需本地 MCP 方案并开始实现。
- 2026-09-16：完成现有检索、主题接口、数据目录和启动方式盘点；`codex_research` 不可用，改用本地代码检索。
- 2026-09-16：新增 `tabkeep_search`、`tabkeep_get_source`、`tabkeep_list_topics` 三个只读 MCP 工具，并增加长段落 `offset` 分段读取。
- 2026-09-16：新增 Windows 按需启动脚本和 MCP 配置说明；修正 conda 环境在外部 PowerShell 中的启动兼容性。
- 2026-09-16：MCP 单测 5/5 通过；真实 `pnpm mcp` 握手、工具列表、当前本地索引搜索和来源读取验证通过；`pnpm test:backend` 全部 71 个测试通过。
