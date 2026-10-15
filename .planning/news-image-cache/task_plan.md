# 资讯图片与来源图标缓存计划

## 目标

资讯采集时提取文章缩略图和订阅源图标，下载到本地缓存，并通过受资讯会话保护的 API 提供给阅读页。阅读页在订阅列表和文章卡片展示图标/缩略图，图片加载失败时显示现有图标占位。

## 阶段

- [completed] 扩展 RSS/贴吧图片提取、SQLite 迁移、本地图片缓存与鉴权资源接口
- [completed] 扩展 API 与 TypeScript 类型，在订阅列表和资讯卡片显示图标/缩略图
- [completed] 增加解析、缓存、安全、迁移和 API 测试；运行后端单测与阅读页构建

## 决策

- 图片缓存存放在 `storage.DATA_DIR/news_assets`，SQLite 只存图片 URL 与缓存文件名。
- 只接受 HTTP(S) 图片，限制重定向、响应大小和图片格式；资源接口继续使用 `/news` 鉴权。
- 每条资讯最多显示一个缩略图；来源图标优先取 feed metadata，失败时尝试来源站点 favicon。
- 保持现有文字摘要清洗与安全展示方式；只把图片作为独立缩略图展示，不渲染来源 HTML。

## 验收

- 旧数据库启动迁移不丢失订阅或历史内容。
- RSS/Atom 常见媒体字段、HTML 图片和贴吧图片可提取；缓存资源写入临时资讯数据目录。
- `/news/assets/{filename}` 需要现有资讯授权并拒绝无效文件名。
- 阅读页能展示缩略图、来源图标，并对无图/坏图提供可访问的占位状态。
- 后端单测与 `pnpm build:news-reader` 通过。

## 验证与已知限制

- 后端 `python -m unittest discover -s tests`：144 项通过。
- `pnpm build:news-reader`：通过。
- API 集成测试验证未授权图片返回 401、授权后能读取 PNG 缓存。
- Playwright 浏览器检查未执行：当前 tabkeep Conda 环境没有安装 `playwright` 模块；开发服务器已由测试辅助脚本正常关闭。
