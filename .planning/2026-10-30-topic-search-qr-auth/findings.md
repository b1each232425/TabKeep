# Findings

- 现有 TopicSearchBrowser 使用持久化 Playwright Edge profile 并截取登录页面截图；这不是平台 QR API 的可靠实现。
- auth provider 为 tieba、zhihu、weibo。小黑盒有独立资讯授权服务与 UI，应继续复用。
- 参考项目说明：Weibo QR 依赖非公开 Passport SSO 流程；Zhihu QR 接口可能返回 403；Tieba QR 方案需要谨慎核对，现有实现不应假定扫码页面一定含二维码。
- Cookie 与 QR token 均不得返回 API、写普通日志或持久化到资讯数据库。
- 知乎二维码 API 参考 `zly2006/zhurl` 的公开协议笔记：创建接口返回 `token` 与 `link`，轮询返回 `login_status` 和 `z_c0`；该笔记同时说明内容是从知乎++流程观察而来，不是官方 API。
- 微博二维码流程参考 `jackwener/weibo-cli` 的实现文档：Passport SSO 获取 CSRF、生成二维码、轮询并跟随跨域登录 URL；项目明确标注为逆向观察的非公开流程。
- 贴吧使用百度 Passport QR、channel/unicast 与 qrbdusslogin 流程。可参考的 `libsgh/tieba-api` 项目说明其登录接口较旧；此流程和参数仍需真实扫码验证，不能视为稳定官方接口。
- 知乎请求被 HTTP 403 拒绝时，当前实现显示受限提示并停止，不尝试规避平台限制。
