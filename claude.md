# TabKeep 代码规范

本文件只维护编码约定。项目定位、模块边界和安全要求见 [AGENTS.md](AGENTS.md)；用户功能与启动说明见 [README.md](README.md)。修改界面前阅读 [design.md](design.md)。

## 通用约定

- 修改前完整阅读相关文件及调用方；改动聚焦，沿用附近代码风格。
- 命名清晰，函数职责单一；避免为单次用途增加抽象。
- 注释说明原因和约束，不重复代码表面行为；保留仍有效的已有注释。
- 新增或修改的代码注释使用中文；专有名词、函数名和变量名保留原文。
- 不把密钥、Token、网页正文、截图、OCR 文本或完整模型输入写入日志或提交到版本库。

## TypeScript 与 React

- 函数和普通变量使用 camelCase，组件、类型和接口使用 PascalCase，常量使用 UPPER_SNAKE_CASE。
- 为 API 请求和响应定义明确类型；避免把业务数据扩散为无约束的 any。
- 按职责拆分界面、API 客户端和业务逻辑；扩展端与桌面端是独立构建目标。
- UI 使用项目已有的 React、Tailwind CSS 和组件模式。不要在未迁移依赖前使用 Tailwind CSS v4 语法；扩展目前使用 Tailwind CSS v3。
- 更改接口时同时检查扩展、桌面端和后端的调用约定。

## Python 后端

- 所有 def 和 async def（包括私有函数）都必须带完整参数与返回类型注解。
- 使用 Python 3.10+ 写法：list[str]、dict[str, int]、X | None；异步迭代器等从 collections.abc 导入。
- Pydantic 请求/响应模型放在 backend/schemas/；路由放在 backend/routers/；可复用业务逻辑放在 backend/services/。
- 保持 backend/main.py 精简，只负责生命周期、路由注册、中间件和健康检查。
- 需要阻塞调用的异步路由应将工作放到线程，避免阻塞事件循环。

## Rust 桌面端

- Rust 代码遵循已有模块划分和命名习惯；桌面命令、HTTP 服务、OCR、翻译、便签等逻辑放在对应模块。
- 系统能力要有明确失败返回和日志；日志不能包含用户内容或凭据。
- Windows 专用 API 放在平台条件编译分支中；不要把仅 Windows 验证过的行为描述为 macOS 已支持。

## 修改后的检查

按改动范围选择验证：

- 扩展：在 extension/ 下运行 pnpm build。
- 桌面 UI：在 desktop/ 下运行 pnpm build；涉及 Tauri/Rust 时，再使用目标平台的 Tauri 构建。
- 后端：在 backend/ 下运行 python -m unittest discover -s tests；启动服务可运行 python main.py。
- 跨端 API：检查请求头 Token、字段命名、错误处理和桌面端缺席时的扩展行为。

不要把尚未运行的检查描述为已通过。
