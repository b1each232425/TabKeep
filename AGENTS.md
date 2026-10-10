# TabKeep Agent 指南

本文件说明项目定位、架构边界和协作要求。开始工作前，先读 [claude.md](claude.md)；涉及界面、样式或视觉资产时，再读 [design.md](design.md)。

## 项目定位与现状

TabKeep 是一个本地优先的浏览器与桌面知识工作流工具，包含 Chrome 扩展、Tauri 桌面端和 FastAPI 后端。桌面端不是待建骨架：当前已有设置、便签、翻译、知识库和知识图谱界面，并集成截图 OCR 等系统功能。详细用户说明见 [README.md](README.md)。

项目仍处于个人开发和验证阶段。修改时以当前代码为准，不把规划中的能力描述成已交付功能，也不要因旧文档而重复搭建已有模块。

## 架构与边界

| 模块 | 技术 | 主要职责 |
| --- | --- | --- |
| <code>extension/</code> | Plasmo、React、TypeScript | 浏览器标签整理、LLM 分类、网页正文提取、收藏；可选调用桌面服务 |
| <code>backend/</code> | FastAPI、Python | 配置、标签 API、笔记适配器、知识同步与索引、搜索、RAG、OCR 模型 API |
| <code>desktop/</code> | Tauri 2、React、TypeScript、Rust | 桌面界面、本地桌面服务、翻译、截图/OCR、便签、托盘与系统快捷键 |
| <code>scripts/</code> | PowerShell、Python | Windows 开发启动、打包和验收辅助脚本 |

默认本机服务：

- FastAPI 后端：<code>http://127.0.0.1:38471</code>
- Tauri 桌面服务：<code>http://127.0.0.1:38472</code>
- RAG 评估页面：<code>http://127.0.0.1:5175/eval.html</code>

扩展直接使用 FastAPI；桌面端通过 API 和 Tauri 命令访问后端及操作系统能力。发布版桌面端会启动随应用打包的后端 sidecar。扩展的基本标签操作不应依赖桌面端；桌面端不可用时，扩展收藏流程应保留现有后端路径或明确失败。

Tauri 是当前桌面框架，不使用 Electron。可以参考 Pot Desktop 的交互和架构，但不得复制其 GPL-3.0 源码，也不要求用户安装 Pot。

## 数据与隐私

- 源码运行时，后端数据默认位于 <code>backend/data/</code>；<code>TABKEEP_DATA_DIR</code> 可更改目录。打包运行时，桌面端把后端数据放在 Tauri 的应用数据目录下。
- 知识库使用 SQLite/FTS 和 LanceDB。扩展的标签快照另存于浏览器 IndexedDB；后端 <code>/tabs</code> 当前只保存在内存，重启后清空，不应描述为持久化历史。
- 后端配置文件可能包含 API Key、笔记 Token 和本机 API Token；不得提交、打印或记录这些值。
- 默认只把本地服务绑定到 <code>127.0.0.1</code>。开发时可用 <code>TABKEEP_DISABLE_AUTH=1</code> 跳过 Token 检查；只允许用于本机开发或测试，不能作为发布默认值。
- 网页正文、笔记、截图、OCR 文本和剪贴板内容都视为敏感数据。只有在用户配置并触发相应模型功能时，才向模型服务发送所需文本或图像；不要新增隐式上传或完整内容日志。桌面端启动时会检查每日诗笺；没有有效缓存时，会向今日诗词服务获取公开诗句，该请求不得包含本地笔记或网页内容。

## 平台与发布

当前开发启动器和正式打包脚本使用 Windows PowerShell；桌面构建脚本还依赖 MSVC。正式发布脚本会生成 Windows 后端 .exe sidecar，再打包桌面安装程序。Tauri 配置中的通用 bundle target 不代表 macOS 安装包已构建或验证。需要增加 macOS 发布时，必须准备对应架构的后端 sidecar，并在 macOS 上验证 Tauri 系统能力与安装包。

浏览器扩展与桌面安装包是分开构建和分发的。不要把扩展已可运行等同于桌面安装包已支持该平台。

## 实现要求

- 先读相关代码和文档，再修改；保持改动范围紧贴用户需求。
- 优先扩展现有模块，避免无关重构或一次性重写。
- 新增或修改的代码注释使用中文；专有名词、函数名和变量名保留原文。
- 尊重现有 TypeScript、Python 和 Rust 风格；Python 函数必须有完整参数与返回类型注解，使用 Python 3.10+ 类型写法。
- API 请求/响应结构放在后端 <code>schemas/</code>；路由放在 <code>routers/</code>；可复用业务逻辑放在 <code>services/</code>。<code>backend/main.py</code> 只负责应用生命周期、路由注册和健康检查。
- 修改 UI、样式、布局、配色、动效或视觉资产前，先读 <code>design.md</code>。界面保持紧凑、任务优先；面向用户的桌面产品称为“桌面端”。
- 新增接口或持久化行为时，检查 Token 校验、错误路径、敏感日志和扩展/桌面端兼容性。

## 开发与验证

根目录 <code>pnpm dev:*</code> 命令调用 <code>scripts/dev.ps1</code>，由 Windows PowerShell 启动，并为后端激活名为 <code>tabkeep</code> 的 Conda 环境。可按需使用：

- <code>pnpm dev:app</code>：启动后端、扩展和桌面端，不启动评估页面。
- <code>pnpm dev</code>：启动以上服务并启动 RAG 评估页面。
- <code>pnpm dev:backend</code>、<code>pnpm dev:extension</code>、<code>pnpm dev:desktop</code>、<code>pnpm dev:eval</code>：单独启动相应部分。
- 后端单独启动：在 <code>backend/</code> 下运行 <code>python main.py</code>，或运行 <code>uvicorn main:app --host 127.0.0.1 --port 38471</code>。
- 前端构建：分别在 <code>desktop/</code> 和 <code>extension/</code> 下运行 <code>pnpm build</code>。
- 后端测试：在 <code>backend/</code> 下运行 <code>python -m unittest discover -s tests</code>。

根目录 <code>pnpm test:backend</code> 目前引用开发机上的绝对 Python 路径，跨机器使用时请运行上面的通用命令。Windows 安装包由 <code>pnpm release:windows</code> 构建；其验收脚本是 <code>pnpm accept:windows</code>。

## 文档维护

- <code>README.md</code> 是用户入口，描述当前功能、启动方式、数据和平台状态。
- 本文件描述 agent 工作边界；<code>claude.md</code> 描述代码规范；<code>design.md</code> 用于设计工作。
- 改动架构或启动/发布流程时，同步修订相关文档。只链接仓库内实际存在、且预期会一同发布的文档。
- 保留仍准确的专项说明；发现文档过时时，按代码更新它，不要把旧计划原样当成现状。
