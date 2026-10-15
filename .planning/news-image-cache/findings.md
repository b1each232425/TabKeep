# 资讯图片与来源图标发现

- 现有 RSS/Atom 摘要在 `collector._entry_content()` 中被 `_plain_text()` 转成纯文本，因此 HTML `<img>` 会丢失。
- RSS 资讯 schema/SQLite 当前没有图片字段；`NewsSource` 也没有来源图标字段。
- 阅读页的订阅行固定显示 Lucide `Newspaper`，资讯卡片只显示文本。
- 新闻网页会话 Cookie 的 Path 是 `/news`，所以 `/news/assets/...` 可复用现有 `require_news_access` 鉴权。
- aiotieba 的 `Contents_p` 暴露 `imgs`，图片对象包含 `src`、`big_src` 和 `origin_src`；贴吧抓取可选小图作为缩略图。
- 本地数据目录由 `storage.DATA_DIR` 决定，测试可将其重定向到隔离临时目录。
- 外部图片内容应按 HTTP(S) 与实际图片格式校验，拒绝 SVG/非图片，限制字节数并手动逐跳校验重定向目标，避免图像 URL 变成不受控本地请求。
