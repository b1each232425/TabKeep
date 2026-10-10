# TabKeep 浏览器扩展

TabKeep 扩展是 Chrome Manifest V3 扩展，负责整理标签页和采集网页内容。它是独立的浏览器扩展，不包含在桌面安装程序中。

## 功能

- 查看当前浏览器标签页，并按域名分组。
- 使用已配置的模型把当前窗口标签页归入自定义类别。
- 提取网页正文，收藏链接、全文或摘要。
- 将收藏保存到后端配置的本地 Markdown、Obsidian/Markdown 目录或思源笔记。
- 自动把 Chrome/Edge 116+ 普通窗口中的原生标签组同步到桌面端“标签归档”，可从桌面端恢复到当前窗口或新窗口，也可删除并关闭原组。归档只保存标签组信息和网页 URL，不保存网页正文；扩展自动创建的域名/AI 分组不会归档。浏览器重启后，仅在来源浏览器实例、组名、颜色和标签 URL 能唯一匹配时续接归档或离线删除命令；多个相同候选组会保留为独立记录。
- 桌面端运行时，可调用本机服务执行桌面捕获、翻译和 OCR 能力。

## 开发环境

需要 Node.js、pnpm 和 Chrome 或 Edge 116+。需要完整体验分类、笔记保存和标签归档时，还需运行 TabKeep FastAPI 后端；桌面端用于桌面专属功能。仓库根目录的一键开发脚本目前面向 Windows PowerShell，完整依赖说明见 [项目 README](../README.md)。

## 开发与构建

在本目录运行：

~~~bash
pnpm install
pnpm dev
~~~

然后在 Chrome 打开 chrome://extensions，启用“开发者模式”，选择“加载已解压的扩展程序”，并指向 build/chrome-mv3-dev。

生产构建与压缩包：

~~~bash
pnpm build
pnpm package
~~~

Plasmo 将构建产物放在 build/ 下。加载或提交时，选择本次命令生成的 Chrome MV3 产物；仓库没有自动发布到 Chrome Web Store 的配置。

## 本地服务与数据

扩展 API 地址定义在 src/config/api.ts：

- FastAPI：http://127.0.0.1:38471，负责配置、AI 分类、笔记保存、知识库集成和本地标签组归档桥接。
- 桌面服务：http://127.0.0.1:38472，只供桌面端运行时调用；桌面端缺席时，扩展保留后端收藏路径。

访问页面正文需要 Chrome 扩展的站点权限。Content script 由扩展用于响应页面正文提取请求；内部页面、PDF 和浏览器禁止注入的页面无法提取正文。浏览器标签快照保存在扩展 IndexedDB；后端 /tabs 当前只在内存保留标签列表。

## 相关代码

- src/popup.tsx：扩展弹窗界面。
- src/background.ts：标签同步、分类、收藏和扩展消息处理。
- src/services/tabGroupArchive.ts：原生标签组快照、恢复/删除命令和本地 WebSocket 桥接。
- src/contents/extract.ts：网页正文提取。
- src/config/api.ts：本机后端与桌面服务 API。
