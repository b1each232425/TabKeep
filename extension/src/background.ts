/// <reference types="chrome" />
import { groupTabsByDomain } from "./utils/tabUtils"
import { saveToIDB } from "./utils/indexedDB"
import type { TabData, TabGroupStyleOptions } from "./types"

const DEFAULT_STYLE: TabGroupStyleOptions = {
  defaultColor: "blue",
  useDomainAsTitle: true,
  collapsedByDefault: false
}

const SYNC_INTERVAL_MINUTES = 1
const BACKEND_URL = "http://127.0.0.1:38471"

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

const syncToBackend = async () => {
  try {
    const tabs = await fetchAllTabs()
    const res = await fetch(`${BACKEND_URL}/tabs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tabs)
    })
    const data = await res.json()
    console.log("同步到后端:", data)
  } catch (err) {
    console.error("同步失败:", err)
  }
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
  } else if (msg.type === "CLASSIFY_TABS") {
    classifyCurrentWindowTabs().then(sendResponse)
    return true
  }
})

const classifyCurrentWindowTabs = async () => {
  const tabs = await chrome.tabs.query({ currentWindow: true })
  const tabDataList: TabData[] = tabs.map(tab => ({
    id: tab.id,
    title: tab.title,
    url: tab.url,
    favIconUrl: tab.favIconUrl,
    active: tab.active,
    pinned: tab.pinned
  }))
  if (tabDataList.length === 0) {
    console.log("[TabKeep] 当前窗口无标签页")
    return { error: "无标签页" }
  }
  try {
    const res = await fetch(`${BACKEND_URL}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tabs: tabDataList })
    })
    const data = await res.json()
    if (data.error) {
      console.error("[TabKeep] 后端分类失败：", data.error)
      return data
    }
    console.log("[TabKeep] LLM 原始响应：", data.raw)
    console.log("[TabKeep] 分类结果：")
    for (const tab of tabDataList) {
      const cat = data.result?.[tab.id] ?? "未分类"
      console.log(`  [${tab.id}] ${tab.title || tab.url} → ${cat}`)
    }
    return data
  } catch (err) {
    console.error("[TabKeep] 请求后端失败：", err)
    return { error: String(err) }
  }
}

// 监听标签变化事件
chrome.tabs.onCreated.addListener(() => { saveTabsData(); syncToBackend() })
chrome.tabs.onRemoved.addListener(() => { saveTabsData(); syncToBackend() })
chrome.tabs.onUpdated.addListener(() => { saveTabsData(); syncToBackend() })

// 定时同步到后端
chrome.alarms.create("syncTabs", { periodInMinutes: SYNC_INTERVAL_MINUTES })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "syncTabs") syncToBackend()
})

// 初始保存
saveTabsData()

console.log("TabKeep background loaded")