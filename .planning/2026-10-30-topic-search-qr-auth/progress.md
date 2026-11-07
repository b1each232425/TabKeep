# Progress

## 2026-10-30
- 开始对接贴吧、知乎、微博扫码授权。用户授权实现；小黑盒维持现状。
- 新增 `backend/services/news/topic_search_auth.py`，实现贴吧百度 Passport QR、知乎二维码 API、微博 Passport QR 状态轮询；将通过验证的 Cookie 导入现有本机 Playwright Edge 配置。
- `TopicSearchBrowser` 复用新的平台扫码服务，继续沿用现有授权状态标记、搜索偏好和断开清理流程；Cookie 不进入 API 响应。
- 授权弹窗改成二维码提示，轮询间隔调整到 2 秒；扫码失败信息返回明确平台状态。
- 平台 URL 限定为允许主机和 HTTPS，重定向逐跳校验；只导出登录所需 Cookie，取消时等待正在进行的轮询退出。
- 静态审阅完成。按当前协作约束没有运行测试、构建或启动服务；尚未进行真实扫码验收。
