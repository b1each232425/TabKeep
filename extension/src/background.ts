/// <reference types="chrome" />
import { groupTabsByDomain } from "./utils/tabUtils"
import { saveToIDB } from "./utils/indexedDB"
import type { TabData, TabGroupColor, TabGroupStyleOptions } from "./types"

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

// 通用建组核心：把 {tabId: groupName} 实际建到 chrome.tabGroups
interface GroupingOptions {
  defaultColor: TabGroupColor
  collapsedByDefault: boolean
}

async function applyGrouping(
  classification: Record<number, string>,
  options: GroupingOptions
) {
  const byCategory = new Map<string, number[]>()
  for (const [tabIdStr, groupName] of Object.entries(classification)) {
    const ids = byCategory.get(groupName) ?? []
    ids.push(Number(tabIdStr))
    byCategory.set(groupName, ids)
  }

  const allTabs = await chrome.tabs.query({ currentWindow: true })
  const validTabIds = new Set(
    allTabs.filter(t => !t.pinned).map(t => t.id).filter(Boolean)
  )

  for (const [groupName, tabIds] of byCategory) {
    const valid = tabIds.filter(id => validTabIds.has(id))
    if (valid.length < 2) continue
    try {
      const groupId = await chrome.tabs.group({ tabIds: valid })
      await chrome.tabGroups.update(groupId, {
        title: groupName,
        color: options.defaultColor,
        collapsed: options.collapsedByDefault
      })
      console.log(`[TabKeep] 已建组 "${groupName}" (${valid.length} 个 tab)`)
    } catch (e) {
      console.warn(`[TabKeep] 建组 "${groupName}" 失败:`, e)
    }
  }
}

// 按域名建组（当前窗口）—— 薄壳：算分类后调 applyGrouping
async function createTabGroups(style: Partial<TabGroupStyleOptions> = {}) {
  const options = { ...DEFAULT_STYLE, ...style }

  try {
    const allTabs = await fetchAllTabs()
    const grouped = groupTabsByDomain(allTabs)

    const classification: Record<number, string> = {}
    for (const group of grouped) {
      if (group.isOther) continue
      for (const tab of group.tabs) {
        if (tab.id !== undefined) classification[tab.id] = group.domain
      }
    }

    await applyGrouping(classification, {
      defaultColor: options.defaultColor,
      collapsedByDefault: options.collapsedByDefault
    })
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
  } else if (msg.type === "CLASSIFY_AND_GROUP_TABS") {
    classifyAndGroupCurrentWindowTabs(msg.style).then(sendResponse)
    return true
  } else if (msg.type === "SAVE_TAB_TO_NOTE") {
    saveTabToNote(msg.tab).then(sendResponse)
    return true
  } else if (msg.type === "SAVE_TAB_FULL") {
    saveTabToNoteFull(msg.tab).then(sendResponse)
    return true
  } else if (msg.type === "EXTRACT_CONTENT_FOR_PICKER") {
    extractContentForPicker(msg.tab).then(sendResponse)
    return true
  }
})

const MAX_CONTENT_CHARS = 200_000

const extractContentForPicker = async (
  tab: TabData
): Promise<{ ok: boolean; content?: string; error?: string }> => {
  console.log(`[TabKeep] extract-for-picker 开始 tab=${tab.id} title=${tab.title}`)
  if (tab.id === undefined) {
    return { ok: false, error: "tab 没有 id" }
  }

  let extract: any = await trySendMessage(tab.id)
  if (!extract) {
    const err = "提取失败：无法访问页面 content script（请刷新该标签页后重试，或避开 chrome:// 内部页 / PDF）"
    console.error(`[TabKeep] extract-for-picker ${err}`)
    return { ok: false, error: err }
  }
  if (!extract.ok) {
    return { ok: false, error: extract.error ?? "提取失败" }
  }
  const raw: string = extract.data.contentMarkdown || extract.data.content || ""
  const truncated = raw.length > MAX_CONTENT_CHARS
  const content = truncated ? raw.slice(0, MAX_CONTENT_CHARS) + "\n\n> _(内容已截断)_" : raw
  console.log(
    `[TabKeep] extract-for-picker ok raw_len=${raw.length} content_len=${content.length} truncated=${truncated}`
  )
  return { ok: true, content }
}

const trySendMessage = async (tabId: number): Promise<any> => {
  try {
    const res: any = await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_CONTENT" })
    return res
  } catch (e) {
    return null
  }
}

const saveTabToNote = async (tab: TabData) => {
  console.log(`[TabKeep] 收藏(链接) tab=${tab.id} title=${tab.title} url=${tab.url}`)
  try {
    const res = await fetch(`${BACKEND_URL}/notes/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: tab.title ?? "",
        url: tab.url ?? "",
        notebook_id: "",
        target_doc: null
      })
    })
    const data = await res.json()
    if (data.ok) {
      console.log(`[TabKeep] 收藏(链接) ok: ${tab.title}`)
    } else {
      console.warn(`[TabKeep] 收藏(链接) 失败: ${data.error}`)
    }
    return data
  } catch (err) {
    console.error("[TabKeep] 收藏请求失败:", err)
    return { ok: false, error: String(err) }
  }
}

const saveTabToNoteFull = async (tab: TabData) => {
  console.log(`[TabKeep] 收藏(全文) 开始 tab=${tab.id} title=${tab.title} url=${tab.url}`)
  if (tab.id === undefined) {
    const err = "tab 没有 id"
    console.error(`[TabKeep] 收藏(全文) 失败: ${err}`)
    return { ok: false, error: err }
  }

  console.log(`[TabKeep] 收藏(全文) 第 1 步: 向 tab ${tab.id} content script 发 EXTRACT_CONTENT`)
  let extract: any
  try {
    extract = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_CONTENT" })
    console.log(`[TabKeep] 收藏(全文) content script 响应:`, extract)
  } catch (e) {
    const err = "提取失败：无法访问页面 content script（可能是 chrome:// 内部页或 PDF）"
    console.error(`[TabKeep] 收藏(全文) ${err}:`, e)
    return { ok: false, error: err }
  }
  if (!extract?.ok) {
    const err = `提取失败：${extract?.error ?? "未知错误"}`
    console.warn(`[TabKeep] 收藏(全文) ${err}`)
    return { ok: false, error: err }
  }

  const raw = extract.data.contentMarkdown || extract.data.content || ""
  const truncated = raw.length > MAX_CONTENT_CHARS
  const content = truncated ? raw.slice(0, MAX_CONTENT_CHARS) + "\n\n> _(内容已截断)_" : raw
  console.log(
    `[TabKeep] 收藏(全文) 提取结果: title=${extract.data.title} ` +
      `raw_len=${raw.length} content_len=${content.length} truncated=${truncated} ` +
      `wordCount=${extract.data.wordCount}`
  )

  if (content.length === 0) {
    console.warn("[TabKeep] 收藏(全文) 提取为空，回退到仅链接模式")
  }

  const body = {
    title: tab.title ?? extract.data.title ?? "",
    url: tab.url ?? "",
    content: content || undefined,
    excerpt: extract.data.description || extract.data.author || undefined,
    notebook_id: "",
    target_doc: null
  }
  console.log(`[TabKeep] 收藏(全文) 第 2 步: POST /notes/save body=`, body)

  try {
    const res = await fetch(`${BACKEND_URL}/notes/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
    const data = await res.json()
    if (data.ok) {
      console.log(`[TabKeep] 收藏(全文) ok: ${tab.title} (${content.length} 字符${truncated ? " 已截断" : ""}) doc=${data.note_id}`)
    } else {
      console.warn(`[TabKeep] 收藏(全文) 后端失败: ${data.error}`)
    }
    return data
  } catch (err) {
    console.error("[TabKeep] 收藏(全文) 请求后端失败:", err)
    return { ok: false, error: String(err) }
  }
}

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

// 调 LLM 分类后真的建组
async function classifyAndGroupCurrentWindowTabs(
  style: Partial<TabGroupStyleOptions> = {}
) {
  const options = { ...DEFAULT_STYLE, ...style }
  const result = await classifyCurrentWindowTabs()
  if (result?.error || !result?.result) return result

  const classification = result.result as Record<number, string>
  const filtered: Record<number, string> = {}
  for (const [id, cat] of Object.entries(classification)) {
    if (cat !== "未分类") filtered[Number(id)] = cat
  }

  await applyGrouping(filtered, {
    defaultColor: options.defaultColor,
    collapsedByDefault: options.collapsedByDefault
  })
  return result
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