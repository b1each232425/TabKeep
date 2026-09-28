---
name: tailwind
description: "TabKeep 扩展的 Tailwind CSS 规范；本项目目前使用 Tailwind CSS 3。"
---

# 扩展端 Tailwind CSS 规范

本指南只适用于 extension/。扩展依赖 tailwindcss@3，配置文件为 tailwind.config.js，全局样式入口为 src/style.css。桌面端有自己的样式入口和构建配置。

## 当前配置

- Tailwind 扫描范围是 src/**/*.{ts,tsx}；运行时生成的类名不要拼接成 Tailwind 无法静态识别的字符串。
- 设计 Token 在 src/style.css 的 CSS 自定义属性中定义，并由 tailwind.config.js 映射到语义色。
- 基础样式与复用类放在 src/style.css；单个组件的布局优先使用 utility classes。
- 类名合并 helper 是 src/lib/utils.ts 中的 cn()。
- 当前按钮组件在 src/components/ui/button.tsx，需要相同交互样式时优先复用。

## 约定

- 沿用语义色，例如 bg-background、text-foreground、border-border，避免在新组件里复制一套颜色值。
- 重复出现且有产品含义的模式，可在 @layer components 中定义短小的 tk-* 类。
- 为响应式布局和交互状态提供明确的 Tailwind class；保持扩展弹窗紧凑，并检查窄窗口下的溢出。
- 不要在未升级依赖和配置前使用 Tailwind CSS v4 的 @theme 或 @import "tailwindcss" 语法。现有样式入口使用 v3 的 @tailwind base、@tailwind components 和 @tailwind utilities。
- 增加或更改 UI 时，遵循根目录 [设计参考](../design.md) 和当前扩展已有的视觉语言。

## 示例

~~~tsx
import { cn } from "../lib/utils"

function TagPill({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2 rounded-md border border-border bg-card p-3", className)}>
      <span className="text-sm text-muted-foreground">标签页</span>
    </span>
  )
}
~~~

修改后在 extension/ 运行 pnpm build，确认 Tailwind 扫描到新增组件所用的类。
