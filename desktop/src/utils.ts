import type { GroupedTab, TabData } from "./types"

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
      continue
    }
    result.push({
      domain,
      count: domainTabs.length,
      tabs: domainTabs,
      favIconUrl: domainTabs.find((tab) => tab.favIconUrl)?.favIconUrl,
    })
  }

  if (singleTabs.length > 0) {
    result.push({
      domain: "其他",
      count: singleTabs.length,
      tabs: singleTabs,
      isOther: true,
    })
  }

  return result.sort((a, b) => a.domain.localeCompare(b.domain))
}

export function generateToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function extractBaseDomain(url: string): string {
  try {
    const urlObj = new URL(url)
    const parts = urlObj.hostname.split(".")
    if (
      parts.length >= 3 &&
      (parts.at(-2) === "co" || parts.at(-1) === "io" || parts.at(-1) === "gov")
    ) {
      return parts.slice(-3).join(".")
    }
    if (parts.length >= 2) {
      return parts.slice(-2).join(".")
    }
    return urlObj.hostname
  } catch {
    return url
  }
}
