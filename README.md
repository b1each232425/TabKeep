# TabKeep

TabKeep 是一个本地优先的浏览器与桌面知识工作流工具。它把标签页整理、网页收藏、桌面翻译、OCR、笔记集成、个人知识库、RAG 问答和知识图谱放到同一个工作台里。

当前项目还处在个人开发和验证阶段，适合用来学习和打磨本地 RAG 产品链路，也适合继续扩展成自己的桌面知识助手。

## 主要功能

- 浏览器标签页同步、分组和收藏。
- 网页正文提取，并保存到本地 Markdown、Obsidian 风格目录或 SiYuan。
- 桌面端文本翻译、截图 OCR、区域翻译和翻译调试。
- 知识库同步、索引健康检查、混合检索和 RAG 问答。
- 基于文档、标题、标签、概念和语义相似度的知识图谱。
- 独立 RAG 评估台，用 Recall@K、Top1、MRR 和答案样本检查效果。

## 项目组成

```text
TabKeep/
├── backend/    # FastAPI 后端，负责数据、同步、索引、检索、RAG 和图谱
├── desktop/    # Tauri 2 + React 桌面端，负责主要用户界面
├── extension/  # Plasmo Chrome 扩展，负责浏览器侧捕获和收藏
├── scripts/    # 开发启动脚本和辅助工具
└── docs/       # 配置、发布和使用相关说明
```

更细的代码入口说明见 [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md)。

## 快速启动

### 环境要求

- Windows + PowerShell
- Node.js + pnpm
- Python 3.10+
- Rust 和 Tauri 2 工具链
- 可选：SiYuan、Obsidian/Markdown 笔记目录
- 可选：SiliconFlow API Key，用于 embedding、rerank 和模型调用

### 安装依赖

```powershell
cd TabKeep

pip install -r backend/requirements.txt

cd desktop
pnpm install

cd ..\extension
pnpm install
```

### 开发启动

```powershell
cd TabKeep

# 同时启动 backend、extension、desktop
pnpm dev

# 只启动某一部分
pnpm dev:backend
pnpm dev:extension
pnpm dev:desktop
pnpm dev:eval
```

默认端口：

- Backend API: `http://127.0.0.1:38471`
- Desktop local service: `http://127.0.0.1:38472`
- RAG Eval: `http://127.0.0.1:5175/eval.html`

## 基础配置

普通使用优先在桌面端完成配置：

- 设置：模型 API、标签分组、笔记集成。
- 知识库：启用索引、填写 SiliconFlow API Key、配置同步来源。
- 知识图谱：查看文档关系、主题目录和相似笔记。

更多配置项见 [docs/CONFIGURATION.md](docs/CONFIGURATION.md)。

## 发布前检查

常用验证命令：

```powershell
cd TabKeep\desktop
pnpm build

cd ..\extension
pnpm build

cd ..
pnpm test:backend
```

完整发布检查清单见 [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md)。

## 数据与隐私

TabKeep 默认只绑定本机地址 `127.0.0.1`。网页正文、截图、OCR 文本、笔记内容和 API Key 都应视为敏感数据。

仓库已忽略 `backend/data/`、`backend/logs/`、`desktop/dist/`、`desktop/src-tauri/target/`、`extension/build/` 等运行时和构建产物。提交前请确认没有把本地知识库、密钥、截图或日志带入版本库。

## 当前状态

已具备较完整的本地 RAG 闭环：

1. 多来源同步。
2. paragraph/chunk 索引。
3. SQLite + FTS + LanceDB。
4. hybrid recall + rerank。
5. RAG 问答。
6. 检索与答案评估。
7. 知识图谱浏览。

接下来更适合继续补齐：首次使用引导、打包发布流程、错误状态文案、配置迁移和端到端测试。
