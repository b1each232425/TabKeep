/// <reference types="chrome" />
import { groupTabsByDomain } from "./utils/tabUtils"
import { saveToIDB } from "./utils/indexedDB"
import type { TabData, TabGroupStyleOptions } from "./types"

const DEFAULT_STYLE: TabGroupStyleOptions = {
  defaultColor: "blue",
  useDomainAsTitle: true,
  collapsedByDefault: false
}

// 获取所有标签页
const fetchAllTabs = async (): Promise<TabData[]> => {
  const tabs = await chrome.tabs.query({})
  return tabs.map(tab => ({
    id: tab.id,
    title: tab.title,
    url: tab.url,
    favIconUrl: tab.favIconUrl,
    active: tab.active,
    pinned: tab.pinned
  }))
}

// 保存标签数据到 IndexedDB
const saveTabsData = async () => {
  try {
    const tabData = await fetchAllTabs()
    await saveToIDB(tabData)
    console.log(`已保存 ${tabData.length} 个标签页`)
  } catch (err) {
    console.error("保存失败:", err)
  }
}

// 按域名创建 Tab Group（当前窗口）
async function createTabGroups(style: Partial<TabGroupStyleOptions> = {}) {
  const options = { ...DEFAULT_STYLE, ...style }

  try {
    const allTabs = await fetchAllTabs()
    const grouped = groupTabsByDomain(allTabs)

    // 按域名创建 Tab Group（包括"其他"组）
    const groupPromises = grouped.map(async (group) => {
      if (group.tabs.length < 2) return null

      const tabIds = group.tabs.map(t => t.id).filter(id => id !== undefined) as number[]
      if (tabIds.length === 0) return null

      const groupId = await chrome.tabs.group({ tabIds })

      if (groupId) {
        try {
          if (chrome.tabGroups) {
            const updateResult = await chrome.tabGroups.update(groupId, {
              title: group.domain,
              color: options.defaultColor,
              collapsed: options.collapsedByDefault
            })
            console.log(`Update result for "${group.domain}":`, updateResult)
          } else {
            console.warn(`chrome.tabGroups not available, skipping title for ${group.domain}`)
          }
        } catch (e) {
          console.warn("更新 Tab Group 样式失败:", group.domain, e)
        }
      } else {
        console.warn("Failed to create group for:", group.domain)
      }

      return groupId
    })

    await Promise.all(groupPromises)
    console.log("Tab Group 创建完成")
  } catch (err) {
    console.error("创建 Tab Group 失败:", err)
  }
}

// 消息监听
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "CREATE_TAB_GROUPS") {
    createTabGroups(msg.style)
    sendResponse({ success: true })
  }
})

// 监听标签变化事件
chrome.tabs.onCreated.addListener(() => saveTabsData())
chrome.tabs.onRemoved.addListener(() => saveTabsData())
chrome.tabs.onUpdated.addListener(() => saveTabsData())

// 初始保存
saveTabsData()

console.log("TabKeep background loaded")