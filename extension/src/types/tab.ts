export interface TabData {
  id: number
  title: string
  url: string
  favIconUrl?: string
  active: boolean
  pinned: boolean
  index?: number
}

export interface GroupedTab {
  domain: string
  count: number
  tabs: TabData[]
  favIconUrl?: string
  isOther?: boolean
}

export type TabGroupColor = "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange"

export interface TabGroupConfig {
  title?: string
  color?: TabGroupColor
  collapsed?: boolean
}

export interface TabGroupStyleOptions {
  defaultColor: TabGroupColor
  useDomainAsTitle: boolean
  collapsedByDefault: boolean
}

export interface TabCategory {
  id: string
  name: string
  description?: string
}
