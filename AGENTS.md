# TabKeep Agent 指南

本文件是给 Codex、Claude Code 以及其他 AI coding agent 使用的项目工作指南。开始修改 TabKeep 前，先阅读 `claude.md` 了解项目结构和代码规范，再阅读本文件确认产品方向、架构边界和实现优先级。

## 项目使命

TabKeep 是一个以浏览器为起点的标签页整理、内容收藏和知识工作流工具。当前核心由三部分组成：

- `extension/`：Plasmo + React + TypeScript 的 Chrome 扩展。
- `backend/`：FastAPI 后端，负责标签同步、LLM 分类、笔记集成和摘录。
- 计划中的 `desktop/`：TabKeep 自己的桌面端，用于承接浏览器扩展无法安全提供的系统级能力。

近期方向：学习 Pot Desktop 的产品思路和架构模式，但不复制 Pot 的 GPL-3.0 源码；最终实现 TabKeep 自己的桌面端能力。

## 硬性边界

- 不要把 Pot Desktop 源码复制进 TabKeep。Pot 是 GPL-3.0，TabKeep 只学习架构和交互，不继承它的源码授权约束。
- 不要求用户安装 Pot Desktop。
- 不把 Pot 类功能塞进 OpenWiki；桌面端属于 TabKeep。
- 新增桌面能力时，不破坏现有扩展和后端流程。
- 优先小步迭代、可验证交付，避免一次性大重写。

## 架构默认选择

- 浏览器扩展继续使用 Plasmo + React + TypeScript。
- FastAPI 后端继续监听 `http://127.0.0.1:38471`。
- 桌面端使用 Tauri 2，不使用 Electron。
- 桌面端默认监听 `http://127.0.0.1:38472`。
- 本地服务默认只绑定 `127.0.0.1`，除非经过明确的安全评审。

选择 Tauri 的原因：

- 更适合托盘、全局快捷键、截图、剪贴板、OCR、本地 HTTP 服务等系统能力。
- 常驻后台时内存和包体更轻。
- Rust 比 Node native 模块更适合处理 Windows OCR 和系统 API。
- 当前工作区的 OpenWiki 已有 Tauri 2 参考实现。

## 桌面应用优先级

除非用户明确调整优先级，否则按下面顺序实现。

### P0：基础骨架

- 新建 `TabKeep/desktop` Tauri 2 应用。
- 启动本地 HTTP 服务：`127.0.0.1:38472`。
- 实现：
  - `GET /health`
  - `POST /capture`
- 将 `POST /capture` 接到扩展现有的 `captureWithDesktop()` 预留逻辑。
- 添加托盘、日志、单实例运行，以及端口不可用时的清晰失败处理。

验收目标：扩展能检测桌面端是否运行；桌面端未运行时，现有收藏和标签管理不受影响。

### P1：文本翻译

- 实现：
  - `POST /translate`
  - `POST /input_translate`
- 添加一个小型桌面翻译窗口。
- 先支持 OpenAI-compatible 翻译配置，并尽量复用 TabKeep 现有模型配置风格。
- 在扩展 popup 增加页面标题翻译、选中文本翻译、输入翻译入口。

验收目标：文本翻译能从扩展和桌面窗口两边触发并正常显示。

### P2：截图 OCR 与截图翻译

- 实现全屏截图选择层。
- 将框选区域裁剪为临时 PNG。
- Windows 优先使用 Windows.Media.OCR。
- 实现：
  - `POST /ocr_recognize`
  - `POST /ocr_translate`

验收目标：用户能框选屏幕区域，识别中英文，并完成翻译展示。

### P3：任意 App 划词翻译

- 添加全局快捷键，例如 `Ctrl+Shift+T`。
- 尽量读取当前前台应用的选中文本。
- 如果直接读取失败，使用复制回退方案：
  - 保存当前剪贴板
  - 模拟复制
  - 读取文本
  - 恢复剪贴板
- 翻译结果优先跟随鼠标展示；定位不可靠时居中展示。

验收目标：至少在 Chrome、VS Code、普通文本编辑器中可用。

### P4：Pot 类高级能力

- 多翻译服务并行：DeepL、Google、Bing、百度、有道等。
- 多 OCR 服务：Tesseract.js、Paddle/RapidOCR 风格的本地插件。
- TTS、历史记录、生词本、插件系统。

P4 作为后续增强，不阻塞第一个可用版本。

## 扩展集成规则

- 桌面集成正式启用时，将 `TAURI_URL` 重命名为 `DESKTOP_URL`。
- 在 `extension/src/config/api.ts` 中增加 `checkDesktopHealth()` 和 `desktopFetch()`。
- `captureWithDesktop()` 必须保持非阻塞、可失败、可回退。
- 扩展在桌面端未安装或未运行时仍必须可用。
- 用户界面需要区分：
  - 后端已连接
  - 桌面端已连接
  - 桌面端不可用

## 后端规则

- `backend/main.py` 保持轻量，只放路由注册、中间件和健康检查。
- 请求/响应模型放在 `backend/schemas/`。
- 路由逻辑放在 `backend/routers/`。
- 可复用业务逻辑放在 `backend/services/`。
- 所有 Python 函数必须有明确的参数和返回类型注解，遵循 `claude.md`。

## UI 规则

- 修改 UI、样式、布局、配色、动效或视觉资产前，必须先阅读仓库根目录的 `design.md`；实现时以该文件的设计流程和交付检查为准，再结合当前页面的既有视觉语言落地。
- TabKeep 是工具型产品，不做落地页式 UI。
- 优先紧凑、高效、任务优先。
- 扩展端沿用现有 React/Tailwind/shadcn 风格。
- 桌面翻译和 OCR 窗口应小巧、快速、不打扰。
- 面向用户的桌面应用文案统一称为“桌面端”，不要使用旧称或昵称；避免展示是否依赖后端、知识库配置、自动保存、支持某格式这类实现边界或开发目标说明。优先使用用户能直接行动的标签、按钮、状态和结果。
- 便签默认使用单一粉色发光羽毛主题，不提供多款式或多颜色选择，除非用户明确要求恢复主题选择。
- 能用清晰标签、图标或状态表达的地方，不写冗长说明文字。

## 安全与隐私

- 截图、OCR 文本、选中文本、网页正文都视为敏感数据。
- 除非用户已配置服务并主动触发功能，不要把内容发送到云端。
- 本地 HTTP 端点只绑定 `127.0.0.1`。
- 桌面端超过原型阶段后，写入类或返回数据类接口优先加 token 保护。
- 不记录完整网页正文、截图、API key、长 OCR 内容或长翻译内容。

## 命令执行权限约定

本节是项目级约定，不能覆盖 Codex 当前会话的系统沙箱、网络限制和审批规则。如果系统要求审批，仍必须请求用户批准。

- 默认允许执行非破坏性的读取、检查和验证命令，例如 `rg`、`Get-Content`、`git status`、`git diff`、`pnpm build`、`pnpm lint`、`pnpm test`、`npm run build`、`npm run lint`、`npm test`。
- 默认允许执行短时的 `npm` / `pnpm` 脚本来验证改动，只要它们不发布、不删除数据、不重写用户文件。
- 可以启动开发服务器验证前端或桌面端，但必须明确记录地址，并在不再需要时停止相关进程；不要把长时间后台进程留给用户收拾。
- 不要在未确认的情况下执行可能修改依赖树或锁文件的命令，例如 `npm install`、`pnpm install`、`npm update`、`pnpm update`、`pnpm add`、`pnpm remove`。
- 不要执行发布、上传、部署、删除、重置历史或清理数据类命令，除非用户明确要求并且当前系统权限允许。
- 如果命令可能访问网络、写入仓库外目录、修改大量生成文件，或影响用户本机环境，先说明原因并请求确认。

## 验证清单

完成改动前至少检查：

- 在 `extension/` 下执行 `pnpm build` 仍可通过。
- 在 `backend/` 下执行 `uvicorn main:app --host 127.0.0.1 --port 38471` 仍可启动。
- 现有标签分组和笔记保存流程仍可用。
- 桌面端缺席时，popup 和 background service worker 不崩溃。
- 新增本地端点有基本成功路径和失败路径。
- Windows OCR 或截图能力需要在 Windows 上手动验证。

## 工作方式

- 先读再改。
- 保留已有注释，除非相关代码被删除。
- 修改范围紧贴当前功能。
- 优先小型 helper 函数，避免巨大混合处理器。
- 构建桌面端基础能力时，不做无关大重构。
- 不确定时，保留现有 TabKeep 行为，把新桌面端行为作为可选路径加入。
