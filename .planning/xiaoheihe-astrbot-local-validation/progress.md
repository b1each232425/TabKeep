# 验证进度

- 已确认 TabKeep 工作区存在用户未提交的资讯阅读器和小黑盒扫码改动，保持不动。
- 已确认本机 `python.exe` 是不可启动的 Windows Store 别名，`py -0p` 未列出安装的 Python。
- 已浏览 AstrBot 插件 API 契约与客户端实现；待确认可用运行时以及真实运行条件。
- 已将 AstrBot 主仓和小黑盒适配器插件浅克隆到 `E:\Applications\OpenWikii\tmp\astrbot-xiaoheihe-validation`。
- 克隆版本 AstrBot 4.29.0 / Python >=3.12；本机 Conda base 有 Python 3.13.12。插件 API 文档明确二维码接口使用匿名 GET 与专用 API 客户端。
- 首次用 Conda 新建环境失败：所有默认 Conda 包缓存路径均不可写。改用 `E:\anaconda\python.exe` 在工作区临时目录创建 venv，避免触碰现有 Conda 环境。
- pip 以默认镜像安装时 90 秒无进度，已取消；用 `uv pip install` 从相同 requirements 成功在临时 venv 安装 149 个 AstrBot/插件依赖。
- 安装环境位于 `E:\Applications\OpenWikii\tmp\astrbot-xiaoheihe-validation\env`，uv 缓存也限制在同一临时目录。
- AstrBot 在隔离实例中成功启动，Dashboard 下载完成并仅监听 `127.0.0.1:6255`；插件 v1.3.3 已被加载。
- 通过临时管理凭据登录 Dashboard 成功（HTTP 200）。真实插件二维码路由返回 HTTP 502：“获取二维码失败: 网络请求在重试后仍失败”；重复一次结果相同。
- 使用同一插件包在隔离 venv 中直接调用其 `XiaoheiheApiClient.request_qr()` 成功，返回 `waiting_scan` 且二维码内容存在；只输出了状态，不保存或显示二维码本体。完整路由与直接调用的网络行为差异仍未查明。
- 已停止任务启动的 AstrBot 父进程和 Hypercorn 子进程，确认 6255 端口无监听；日志内两次临时管理密码行均已脱敏。未读取或使用用户的小黑盒凭据，未扫码。
- 外部验证仅读 AstrBot/插件源码和发起匿名二维码请求；TabKeep 产品代码未改动。本验证计划与结果记录位于本目录。
- 只读排查阶段曾用未签名探针得到 `status=failed`；后续核对确认 TabKeep 实际请求使用了另一套 HKEY 签名，故此前“TabKeep 二维码路径没有签名”的结论已更正。
- 相同请求参数和 TabKeep 请求头的签名 A/B 证明 AstrBot 的签名实现可获取二维码，TabKeep 原 HKEY 返回失败。随后已在适配器中接入专用签名器，并保留新闻/折扣采集现有签名。
- 当前代码通过 TabKeep 服务实际发起二维码创建及轮询，均返回 `waiting_scan`；未扫码、未读取或使用用户小黑盒凭据。二维码没有输出或写入文件。
- 后端全量测试 156 项通过，语法编译检查通过。TabKeep 工作区中原有其他未提交改动保留。
