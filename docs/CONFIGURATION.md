# 配置说明

这份文档记录 TabKeep 发布和部署前需要了解的配置项。普通用户优先通过桌面端界面配置；环境变量主要用于开发、调试和独立评估台。

## 端口

| 服务 | 默认地址 | 说明 |
| --- | --- | --- |
| Backend API | `http://127.0.0.1:38471` | FastAPI 后端 |
| Desktop local service | `http://127.0.0.1:38472` | Tauri 桌面端本地 HTTP 服务 |
| Extension dev server | `http://localhost:3000` | Plasmo 开发服务 |
| Desktop Vite dev server | `http://localhost:5174` | Tauri devUrl |
| RAG Eval | `http://127.0.0.1:5175/eval.html` | 独立 RAG 评估台 |

## 桌面端环境变量

示例文件：`desktop/.env.example`

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `VITE_TABKEEP_API_BASE_URL` | `http://127.0.0.1:38471` | 浏览器环境下访问后端的默认地址，主要给独立评估台使用 |
| `VITE_TABKEEP_SHOW_OCR_DEBUG` | 开发环境自动开启 | 设为 `true` 时显示 OCR 调试入口 |

桌面端在 Tauri 运行时会通过 Rust command 代理访问后端；独立浏览器页面会直接请求 `VITE_TABKEEP_API_BASE_URL`。

## 后端环境变量

示例文件：`backend/.env.example`

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TABKEEP_DISABLE_AUTH` | 未设置 | 开发时可设为 `1` 跳过 `X-TabKeep-Token` 校验 |

注意：当前后端不会自动加载 `.env` 文件。使用时需要在 shell 中设置环境变量，或通过开发脚本设置。

## 模型与知识库配置

模型、embedding、rerank 和笔记来源优先在桌面端设置中配置。当前默认倾向：

- Embedding Base URL: `https://api.siliconflow.cn/v1`
- Embedding Model: `BAAI/bge-m3`
- Rerank: 复用同一套 SiliconFlow API Key

普通用户不需要手动选择 embedding/rerank 模型，只需要启用索引并填写 API Key。

## 运行时数据

| 路径 | 说明 | 是否提交 |
| --- | --- | --- |
| `backend/data/` | 配置、SQLite、LanceDB、同步记录等 | 否 |
| `backend/logs/` | 后端日志 | 否 |
| `desktop/dist/` | Vite 构建产物 | 否 |
| `desktop/src-tauri/target/` | Rust/Tauri 构建产物 | 否 |
| `extension/build/` | Plasmo 扩展构建产物 | 否 |
| `tmp/` | 本地测试数据和 mock vault | 否 |

提交前重点检查这些内容没有被误加入版本库。
