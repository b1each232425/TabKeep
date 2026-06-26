// 工具函数集合 —— shadcn/ui 风格的项目标配
//  - clsx: 把多类名(条件 / 数组 / 对象)拼成一个 className 字符串
//  - twMerge: 处理 tailwind 类名冲突(后面的覆盖前面的)
//
// cn() 把两者结合:既能传条件类名,又能正确去重。
// popup 里所有动态 className 都用 cn(...)

import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
