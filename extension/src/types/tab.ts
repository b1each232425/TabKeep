// 标签页 / 分组 / 颜色相关类型。

// ─────────────────────────────────────────────────────────────
// 1. TabData: 单个标签页元数据
// ─────────────────────────────────────────────────────────────
export interface TabData {
  id: number                          // Chrome tabs API 分配的 id
  title: string                       // 页面 title
  url: string                         // 完整 URL
  favIconUrl?: string                 // 站点 favicon
  active: boolean                     // 是否当前激活
  pinned: boolean                     // 是否固定在标签栏
  index?: number                      // 在标签栏中的位置(可选,有些 API 不返)
}

// ─────────────────────────────────────────────────────────────
// 2. GroupedTab: 按 base 域分组的标签
// ─────────────────────────────────────────────────────────────
export interface GroupedTab {
  domain: string                      // base 域(或 "其他")
  count: number                       // 该组 tab 数
  tabs: TabData[]                     // 该组所有 tab
  favIconUrl?: string                 // 该组的代表 favicon
  isOther?: boolean                   // 是否 "其他" 组(单独 tab 收集)
}

// ─────────────────────────────────────────────────────────────
// 3. TabGroup 相关
// ─────────────────────────────────────────────────────────────
// Chrome tabGroups.update 接受的 9 种颜色
export type TabGroupColor = "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange"

export interface TabGroupConfig {
  title?: string
  color?: TabGroupColor
  collapsed?: boolean
}

// 仪表盘"概览"页可配置的样式(存 chrome.storage.local)
export interface TabGroupStyleOptions {
  // 颜色分配模式:
  //   - "random":按域名哈希生成 9 色打乱序列,保证 ≤9 组不重复 / ≤18 组每色最多 3 次
  //   - "uniform":所有组用同一颜色(uniformColor 字段指定)
  colorMode: "random" | "uniform"
  uniformColor: TabGroupColor
  useDomainAsTitle: boolean
  collapsedByDefault: boolean
}

// ─────────────────────────────────────────────────────────────
// 4. TabCategory: 用户自定义的标签分类(给 LLM 分类用)
// ─────────────────────────────────────────────────────────────
export interface TabCategory {
  id: string
  name: string
  description?: string
}
