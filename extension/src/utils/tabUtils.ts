import type { TabData, GroupedTab } from "../types"

export type { TabData, GroupedTab }

// 提取 base domain
function extractBaseDomain(url: string): string {
  try {
    const urlObj = new URL(url)
    const hostname = urlObj.hostname
    const parts = hostname.split(".")
    if (parts.length >= 2) {
      if (parts.length >= 3 && (parts[parts.length - 2] === "co" || parts[parts.length - 1] === "io" || parts[parts.length - 1] === "gov")) {
        return parts.slice(-3).join(".")
      }
      return parts.slice(-2).join(".")
    }
    return hostname
  } catch {
    return url
  }
}

// 按域名分组标签页（只保留有多个标签页的域名，单个的归入"其他"）
export function groupTabsByDomain(tabs: TabData[]): GroupedTab[] {
  const grouped = new Map<string, TabData[]>()
  const singleTabs: TabData[] = []

  for (const tab of tabs) {
    if (!tab.url) continue
    const domain = extractBaseDomain(tab.url)
    const existing = grouped.get(domain)
    if (existing) {
      existing.push(tab)
    } else {
      grouped.set(domain, [tab])
    }
  }

  const result: GroupedTab[] = []

  for (const [domain, domainTabs] of grouped) {
    if (domainTabs.length === 1) {
      singleTabs.push(...domainTabs)
    } else {
      const favIcon = domainTabs.find(t => t.favIconUrl)?.favIconUrl
      result.push({
        domain,
        count: domainTabs.length,
        tabs: domainTabs,
        favIconUrl: favIcon
      })
    }
  }

  // 单独的归入"其他"
  if (singleTabs.length > 0) {
    result.push({
      domain: "其他",
      count: singleTabs.length,
      tabs: singleTabs,
      favIconUrl: undefined,
      isOther: true
    })
  }

  result.sort((a, b) => a.domain.localeCompare(b.domain))
  return result
}