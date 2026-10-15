# TabKeep 按需 MCP 计划

## 目标

为 TabKeep 增加一个按需启动的本地 stdio MCP 服务，让外部 AI 客户端在用户主动调用时读取当前知识库；首版只提供只读检索、来源读取和主题列表，不启动常驻后端、不暴露 API Key。

## 阶段

- [completed] 复用现有 RAG 检索、来源和主题数据接口
- [completed] 实现 stdio MCP 协议与只读工具
- [completed] 增加 Windows 启动脚本、配置说明和协议测试
- [completed] 运行后端回归测试与 MCP 冒烟验证

## 约束

- MCP 进程按需启动，退出后不保留后台进程。
- 只读访问本地已建索引；不在 MCP 中实现任意文件访问、写入或 API 配置读取。
- stdio 的 stdout 只输出 JSON-RPC 响应，诊断信息走 stderr。
- 不新增外部依赖；当前环境未安装 Python `mcp` 包，因此首版使用项目内最小协议适配层。
