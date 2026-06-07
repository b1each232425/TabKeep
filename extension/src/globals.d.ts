// 让 TypeScript 接受 `import "./style.css"` 这种无类型副作用 import
// (Parc / Plasmo 处理 CSS 时只需要副作用,不需要类型)
declare module "*.css"
