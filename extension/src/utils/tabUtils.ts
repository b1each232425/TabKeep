// 标签页按域名分组的工具。
//
// 按职能:
//   1. extractBaseDomain(url):从 URL 抠 base 域(处理 .co.jp / .co.uk / .io / .gov 等特殊情况)
//   2. groupTabsByDomain(tabs):把 tab 列表按 base 域分组,只保留 ≥2 个 tab 的组,其他归"其他"

import type { TabData, GroupedTab } from "../types"

export type { TabData, GroupedTab }


// ─────────────────────────────────────────────────────────────
// 1. 域提取
// ─────────────────────────────────────────────────────────────
/**
 * 从 URL 抠 base 域。
 * - example.com → example.com
 * - a.example.com → example.com
 * - example.co.jp → example.co.jp(把 .co.jp 当成"注册后缀",往前多取一段)
 * - 解析失败 → 返回原 URL
 */
function extractBaseDomain(url: string): string {
  try {
    const urlObj = new URL(url)
    const hostname = urlObj.hostname
    const parts = hostname.split(".")
    if (parts.length >= 2) {
      // .co.jp / .co.uk / .com.au 等"二级注册后缀":倒数第二段是 co / com
      // 简单规则:如果倒数第二段是 "co" 或最后一段是 "io" / "gov",多取一段
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


// ─────────────────────────────────────────────────────────────
// 2. 分组
// ─────────────────────────────────────────────────────────────
/**
 * 把 tabs 按 base 域分组。
 * - 只返回 ≥2 个 tab 的组(单个的塞进"其他"组)
 * - 每组附带一个 favIconUrl(取该组里第一个有 favicon 的)
 * - "其他"组 isOther = true
 * - 结果按域名字典序排序
 */
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
      // 单独的 tab 不进自己的组,统一塞 singleTabs
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

  // 单独的归入"其他"组
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