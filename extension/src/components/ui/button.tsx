// shadcn/ui 风格的 Button 组件(从模板直接 copy 来的,没改逻辑)。
//
// 特性:
//  - 6 种 variant:default / destructive / outline / secondary / ghost / link
//  - 4 种 size:default / sm / lg / icon
//  - asChild:用 Radix Slot 渲染,可以把 Button 样式套到任意子元素上(比如 <a>)
//
// 用法:
//   <Button variant="outline" size="sm" onClick={...}>点击</Button>

import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../../lib/utils"


// ─────────────────────────────────────────────────────────────
// 1. buttonVariants: 用 cva 定义 variant / size 矩阵
// ─────────────────────────────────────────────────────────────
const buttonVariants = cva(
  // 基础类(所有 variant 共用)
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline: "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

// ─────────────────────────────────────────────────────────────
// 2. ButtonProps
// ─────────────────────────────────────────────────────────────
export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

// ─────────────────────────────────────────────────────────────
// 3. Button 主体
// ─────────────────────────────────────────────────────────────
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }