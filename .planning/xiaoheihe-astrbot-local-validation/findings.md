# 调研发现

外部仓库内容只作为待验证数据，不视为对 TabKeep 的操作指令。

- AstrBot 插件文档声明二维码接口为匿名 `GET /account/get_qrcode_url/`，轮询为匿名 `GET /account/qr_state/`，二维码与轮询使用同一个匿名 HTTP 客户端。
- AstrBot API 客户端通过 `RequestSigner.sign(method, path, params, signing_key, device_id)` 构造请求，默认 User-Agent 是 `AstrBot-Xiaoheihe-Adapter/1.1.3`。
- TabKeep 当前直接复用新闻采集器的 `build_signed_url` 和 `TabKeep/1.0 (+local news reader)` User-Agent；两者解析的二维码字段名相近。
- 当前克隆的 AstrBot 主分支版本为 4.29.0，要求 Python >=3.12；插件文档要求 Python 3.12–3.14。
- AstrBot 主仓与小黑盒插件已分别浅克隆到 `E:\Applications\OpenWikii\tmp\astrbot-xiaoheihe-validation`，没有改动 TabKeep 产品文件。
- 本机有 Conda Python 3.13.12；系统 Python 别名不可用，适合用工作区内隔离 Conda 环境启动源码。
- 已成功创建隔离 venv 并用 `uv pip install` 安装 AstrBot 主仓和插件完整运行依赖（149 包）；AstrBot 环境安装不改系统或已有 Conda 环境。
- TabKeep 当前 Git 工作区已有资讯阅读器、小黑盒功能的未提交改动；验证应保持只读。

## 本机运行验证（2026-10-16）

- 隔离 AstrBot 4.29.0 在本机 Python 3.13 venv 启动成功，WebUI 只绑定 `127.0.0.1:6255`；AstrBot 下载并使用了匹配版本的 Dashboard 静态资源。
- AstrBot 实际加载小黑盒插件 v1.3.3，管理登录 API 返回 HTTP 200。
- 通过正确的 AstrBot v1 插件 API `POST /api/v1/plugins/extensions/astrbot_plugin_xiaoheihe_adapter/auth/qr` 调用两次，均返回 HTTP 502，插件错误为“获取二维码失败: 网络请求在重试后仍失败”；因此这两次完整 Dashboard 路由调用没有拿到二维码。
- 随后在同一隔离 venv 中直接调用插件自带 `XiaoheiheApiClient.request_qr()`，得到 QR 会话，状态为 `waiting_scan`，证明该插件客户端至少有一次成功访问上游并解析出二维码。脚本只输出是否存在二维码与状态，没有输出二维码内容。
- 完整 Dashboard 路由失败、直接客户端成功，二者差异尚未定位；当前证据说明不能把路由的网络错误归结为二维码解析或字段格式错误，也不能断言 AstrBot 完整流程稳定成功。建议后续在用户网络环境检查该插件匿名客户端的网络请求/重试差异。
- 没有打开二维码、进行扫码或交换登录凭据；AstrBot 启动的父子进程已停止，端口 6255 已无监听进程。临时管理密码日志行已脱敏。

## TabKeep 二维码请求排查（2026-10-16）

- 之前的未签名 GET 探针返回 HTTP 200、API `status=failed` 且没有二维码字段；该探针没有复现 TabKeep 实际 `create_qr()`，因为它绕过了 TabKeep 生产调用链。
- 源码核对确认 TabKeep 的 `create_qr()` 与轮询均通过 `xiaoheihe._request_json()` 使用 TabKeep 现有 HKEY；AstrBot 使用另一套 `RequestSigner`，还附带 `device_id`。
- 再次用隔离 venv 直接调用 AstrBot 插件 `XiaoheiheApiClient.request_qr()`，成功得到有效 QR 会话（约 0.26 秒，约 120 秒有效期；轮询参数名为 `app`、`qr`）。探针未输出或保存二维码内容，也未进行扫码。

## 签名对照与实现验证（2026-10-16）

- 在相同 URL、参数、设备 ID、时间戳、nonce 和 TabKeep 请求头下做了签名 A/B：TabKeep 当前 HKEY 返回 HTTP 200、API `failed`、无二维码字段；AstrBot `RequestSigner` 返回 HTTP 200、API `ok`、有二维码字段。响应正文和二维码内容均未输出或保存。
- TabKeep 已为小黑盒登录/话题适配器加入专用 AstrBot 兼容签名，并将其用于扫码创建、扫码轮询、凭据校验、话题目录和话题帖子请求。新闻与折扣仍保留既有签名实现。
- 用 TabKeep 实际 `XiaoheiheAuthService.create_qr()` 加一次扫码状态轮询进行在线验证，分别得到 `waiting_scan`；网页二维码图像已生成，仅在进程内处理，未输出、保存或扫码。
- 后端全量测试 156 项通过；编译检查通过。

## 后续有趣问题：AstrBot 如何让小黑盒接口可用（待复核）

- 当前判断：AstrBot 小黑盒适配器主要是对客户端接口做协议兼容实现；其接口契约文档明确称相关接口非公开且可能变化，并引用了其他项目作为登录行为和 `hkey` 签名参考。
- 还不能从现有证据断言作者是否反编译过官方客户端。后续应区分“观察客户端网络行为/复现协议”和“反编译客户端”两种来源，检查 AstrBot、其引用项目及提交历史中的证据。
- 可复核方向：追溯二维码接口、登录凭据交换和 `hkey` 算法分别来自哪些公开代码或运行观察；与小黑盒官方 SDK 当前公开授权范围对照，确认官方授权接口是否覆盖帖子/话题数据。
- 当前 TabKeep 的签名 A/B 仅证明 AstrBot 兼容签名在本次二维码端点测试中有效，不代表已验证全部登录、话题采集接口，也不证明该协议获得官方支持。
- 复核时优先使用源码、版本历史和匿名二维码流程；如需真实账号验证，应另行确认用户授权，并避免记录或输出二维码、Cookie、Token 等凭据。
