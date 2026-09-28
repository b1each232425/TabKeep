# TabKeep

TabKeep 是一个本地优先的浏览器与桌面知识工作流工具：从浏览器收集网页和标签页，把内容保存到笔记或本地知识库，再通过搜索、RAG 问答和知识图谱使用这些资料。

项目目前处于个人开发和验证阶段。下文按仓库当前代码说明功能、运行方式和发布状态。

## 功能

- **浏览器扩展**：按域名整理 Chrome/Edge 标签页；可用配置的 LLM 按自定义类别分组；提取网页正文并收藏链接、全文或摘要；自动同步 Chrome 和 Edge 116+ 的原生标签组到桌面端归档。
- **笔记集成**：将收藏保存到本地 Markdown、Obsidian/Markdown 目录或思源笔记。
- **桌面端**：集中管理模型、分组、笔记和知识库设置；提供翻译、截图 OCR、区域翻译、便签、提醒和知识图谱等功能。
- **知识库**：同步 Markdown/Obsidian 目录、思源笔记和 TabKeep 收藏；用 SQLite/FTS 与可选 LanceDB 向量索引进行检索，再以配置的模型生成带引用的回答。
- **评估工具**：独立页面用于检查知识检索效果和 RAG 样本。

## 架构

extension/ 是 Chrome MV3 扩展，支持 Chrome 和 Edge 116+，负责浏览器标签页和网页内容采集。它向本机 FastAPI 服务 38471 发送分类、配置、笔记和标签组归档请求；桌面能力可选地通过 38472 本机服务调用。

desktop/ 使用 Tauri 2、React 和 Rust。React 提供主要界面，Rust 负责桌面窗口、托盘、快捷键、截图等系统集成。发布版桌面端会启动单独打包的 FastAPI 后端 sidecar。

backend/ 保存配置和笔记，运行知识同步、索引、检索、RAG 与 OCR 模型 API。知识库数据默认存放在本机；模型调用由用户配置的 API 提供方执行。

主要目录：

~~~text
TabKeep/
├── backend/                  # FastAPI API、笔记适配器、知识库与 OCR 服务
├── desktop/                  # Tauri 2 + React + Rust 桌面应用
├── extension/                # Chrome MV3 扩展
├── scripts/                  # Windows 开发启动、打包和验收脚本
├── AGENTS.md                 # Agent 项目边界与工作说明
├── claude.md                 # 代码规范
├── design.md                 # 设计工作参考
└── README.md                 # 本文件
~~~

## 开发环境

根目录的一键启动和正式打包脚本针对 Windows 编写。建议准备：

- Windows 10/11、PowerShell 和 Conda；开发启动脚本会激活名为 tabkeep 的 Conda 环境。
- Python 3.10+、Node.js、pnpm。
- Rust 和 Tauri 2 工具链；Windows 桌面构建需要 Visual Studio C++ Build Tools。
- Chrome，用于加载和调试扩展。
- 可选：思源笔记、Obsidian/Markdown 目录，以及兼容 OpenAI API 的模型服务。语义检索默认使用 SiliconFlow API 地址和 BAAI/bge-m3 模型；API Key 在桌面端知识库设置中配置。

## 安装依赖

在 Windows PowerShell 中从仓库根目录运行：

~~~powershell
conda create -n tabkeep python=3.10
conda activate tabkeep
python -m pip install -r backend/requirements.txt

cd desktop
pnpm install

cd ..\extension
pnpm install

cd ..
~~~

如果 Conda 环境已存在，跳过创建步骤。第一次安装依赖需要网络连接。

## 启动开发环境

一键启动后端、扩展和桌面端：

~~~powershell
pnpm dev:app
~~~

启动上述服务并额外打开 RAG 评估页面：

~~~powershell
pnpm dev
~~~

仅启动一个部分：

~~~powershell
pnpm dev:backend
pnpm dev:extension
pnpm dev:desktop
pnpm dev:eval
~~~

开发启动器会为服务打开独立 PowerShell 窗口。它使用 Conda 环境 tabkeep 运行后端。手动启动后端时，可在 backend/ 目录运行 python main.py。桌面 Tauri 开发构建还需要 Windows MSVC 工具链。

| 服务 | 默认地址 | 说明 |
| --- | --- | --- |
| FastAPI 后端 | http://127.0.0.1:38471 | 配置、笔记、知识库、检索和问答 |
| Tauri 本机服务 | http://127.0.0.1:38472 | 桌面翻译、截图/OCR 和扩展桌面集成 |
| 扩展开发服务 | http://localhost:3000 | Plasmo 开发页面 |
| RAG 评估页面 | http://127.0.0.1:5175/eval.html | 独立的检索评估工作台 |

## 首次配置

在桌面端设置中配置：

1. **模型 API**：填写兼容 OpenAI Chat Completions 的模型名、Base URL 和 API Key，用于分类、摘要、问答和 OpenAI 兼容翻译。其他翻译供应商及凭据在翻译设置中单独配置。
2. **标签分类**：创建 AI 分组使用的类别名称和说明。
3. **笔记集成**：选择本地 Markdown、Obsidian/Markdown 文件夹或思源笔记，并设置默认保存位置；思源需要本机 API 地址和 Token。
4. **知识库**：配置 Markdown/Obsidian 路径；如需语义检索，再启用 embedding 并填写 API Key。没有 embedding 配置时仍可使用全文检索。启用 embedding 后，重排会沿用该 API 地址和 Key，并使用服务内置模型。

启用语义检索、重排或 RAG 问答时，相关文本会发送到对应的模型服务。请根据自己的数据要求选择服务并配置 API。

## 数据与限制

- 源码运行时，后端默认数据目录是 backend/data/；可用 TABKEEP_DATA_DIR 更改。安装版由桌面端放入操作系统的 TabKeep 应用数据目录。配置、知识库数据库、向量索引和本地 Markdown 笔记保存在该数据目录下。
- 配置文件可能含模型 API Key、思源 Token 和本机 API Token。请勿把运行数据、密钥、日志、网页内容或截图提交到仓库。
- 标签快照在扩展端缓存到 IndexedDB；后端 /tabs 接口当前仅使用内存，后端重启后数据会清空，它不是持久化的标签历史。
- 标签归档只记录 Chrome/Edge 普通窗口中的用户原生标签组，包括组名、颜色、折叠状态和网页 URL/标题/图标；扩展自动创建的域名/AI 分组不纳入归档。数据保存在本机 SQLite。关闭浏览器中的标签组不会删除归档；恢复会按 URL 重新加载页面，不保存网页正文、滚动位置或表单状态。浏览器重启后原生组 ID 会变化；TabKeep 仅在来源浏览器实例、组名、颜色和标签 URL 能唯一匹配时续接归档或离线删除命令。若有多个相同候选组，会保留为独立记录，不自动关闭。
- 标签展示和本地分组不依赖桌面端。AI 分类、后端笔记保存和知识库功能需要后端；翻译、截图和其他桌面能力需要桌面端运行。
- 本机服务默认仅监听 127.0.0.1。网页正文、笔记、截图、OCR 文本和剪贴板都按敏感数据处理；模型调用会把相应内容发送到用户配置的服务。桌面端启动时会检查每日诗笺；没有有效缓存时，会向今日诗词服务获取公开诗句，不会随请求上传本地笔记或网页内容。

## 构建与验证

桌面 Web UI 和扩展构建：

~~~powershell
cd desktop
pnpm build

cd ..\extension
pnpm build
~~~

后端单元测试：

~~~powershell
cd backend
python -m unittest discover -s tests
~~~

根目录 pnpm test:backend 目前固定使用开发机上的 Python 绝对路径，不适合作为通用测试命令。跨端发布前还要在目标操作系统检查桌面系统能力和扩展连接状态。

## 发布平台

当前仓库提供的正式安装包流程是 Windows：

~~~powershell
pnpm release:windows
~~~

该流程先用 PyInstaller 生成 Windows 后端 .exe sidecar，再用 Tauri 和 MSVC 打包 Windows 安装程序；pnpm accept:windows 用于 Windows 安装验收。

Tauri 配置允许通用 bundle target，但仓库的开发启动器、sidecar 构建和正式发布脚本仍是 Windows 专用流程。当前没有已配置并验证的 macOS 安装包流程。要发布 macOS，需要在 macOS 环境构建对应架构的后端 sidecar、处理平台专属能力并完成安装验证。

浏览器扩展单独构建和分发，不包含在桌面安装程序里。扩展构建和加载步骤见 extension/README.md。
