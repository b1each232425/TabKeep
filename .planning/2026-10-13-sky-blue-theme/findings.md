# 晴空蓝主题调研

- 桌面端为 Tauri 2 + React，主要界面由 `desktop/src/App.tsx` 和多个 sections 组成。
- 共用色彩及组件样式在 `desktop/src/index.css`；当前主色和工作区底色仍是青绿/薄荷色，导航深色，页面内有较多 emerald 强调类。
- 用户选择了 `02 · 晴空蓝`：主蓝 `#176eb1`，浅蓝工作区 `#f1f8ff`，选中态 `#e1f1ff`，卡片白色，深色文字。
- 绿色状态色（连接成功、测试成功等）和红/黄状态色要继续表达语义，避免将其误改成主题蓝。
- 用户现有未提交改动在 backend、desktop/src/eval、desktop/src/types.ts、根 package.json 等位置；本次不覆盖这些改动。
