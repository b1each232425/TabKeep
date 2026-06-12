/// <reference types="chrome" />
//
// background service worker —— 整个扩展的"中枢"。
//
// 按职能分 11 段:
//   1. imports + 常量
//   2. 标签数据:fetchAllTabs / saveTabsData / syncToBackend / IDB 持久化
//   3. Tab Group 建组:applyGrouping / createTabGroups
//   4. 消息监听 dispatch table
//   5. 全文提取:extractContentForPicker / trySendMessage
//   6. 摘录与自动保存:summarizeContent / summarizeAndSave
//   7. 通知:notifyUser
//   8. 收藏:saveTabToNote(仅链接)/ saveTabToNoteFull(全文旧版,已不再被 popup 触发)
//   9. LLM 分类:classifyCurrentWindowTabs / classifyAndGroupCurrentWindowTabs
//  10. 浏览器事件监听 + 定时任务
//  11. 启动恢复:restoreConfigToBackend + 初始保存

import { groupTabsByDomain } from "./utils/tabUtils"
import { saveToIDB } from "./utils/indexedDB"
import type { TabData, TabGroupColor, TabGroupStyleOptions } from "./types"
import { apiFetch, captureWithDesktop, ensureApiToken } from "./config/api"


// ─────────────────────────────────────────────────────────────
// 1. 常量
// ─────────────────────────────────────────────────────────────
const DEFAULT_STYLE: TabGroupStyleOptions = {
  colorMode: "random",
  uniformColor: "blue",
  useDomainAsTitle: true,
  collapsedByDefault: false
}
const SYNC_INTERVAL_MINUTES = 1
// 全文 / 摘录时前端能接受的最大字符数(超长截断)
const MAX_CONTENT_CHARS = 200_000

// 9 种 chrome tab group 颜色(从 types.TabGroupColor 复一份常量,方便在 background 引用)
const COLOR_PALETTE: TabGroupColor[] = [
  "grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"
]


// ─────────────────────────────────────────────────────────────
// 2. 标签数据:拉 / 存 / 同步
// ─────────────────────────────────────────────────────────────
//
// 拉所有 tab,转成 TabData 形状(只保留需要的字段,避免把 chrome.tabs 整个塞进 IDB)
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

// 把所有 tab 同步到后端(覆盖式;后端用 tabs_storage 内存存)
const syncToBackend = async () => {
  try {
    const tabs = await fetchAllTabs()
    const res = await apiFetch("/tabs", {
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

// 把所有 tab 存到本地 IndexedDB(给 popup 启动时读,避免 popup 打开时还是空)
const saveTabsData = async () => {
  try {
    const tabData = await fetchAllTabs()
    await saveToIDB(tabData)
    console.log(`已保存 ${tabData.length} 个标签页`)
  } catch (err) {
    console.error("保存失败:", err)
  }
}


// ─────────────────────────────────────────────────────────────
// 3. Tab Group 建组
// ─────────────────────────────────────────────────────────────
interface GroupingOptions {
  colorMode: "random" | "uniform"
  uniformColor: TabGroupColor
  collapsedByDefault: boolean
}

/**
 * 字符串 → 32 位 hash(FNV-1a)。stable,无依赖。
 * 给 group name 一个稳定数字 seed,驱动稳定的 Fisher-Yates 打乱。
 */
function fnv1aHash(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * 种子 PRNG(mulberry32)。给定同一 seed 产出同一序列。
 * 用于"按名字稳定随机"。
 */
function mulberry32(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 构造一个长度为 n 的颜色序列,满足:
 *   - n ≤ 9:9 色全 unique 不重复
 *   - 9 < n ≤ 27:尽量保证每种颜色最多出现 3 次(超出 n 时保不齐有颜色出现 4 次,不严格)
 *   - n > 27:不再严格保 3,顺序循环填
 * 之后用 seed 对序列做 Fisher-Yates 打乱 → 同名(经排序后)在序列同一槽位,得到同色。
 */
function buildColorSequence(n: number, seed: number): TabGroupColor[] {
  if (n <= 0) return []
  const counts: Record<string, number> = {}
  for (const c of COLOR_PALETTE) counts[c] = 0
  const seq: TabGroupColor[] = []

  // 第 1 步:贪心填,直到填满 n
  let cursor = 0
  let safety = 0
  while (seq.length < n && safety < n * 4) {
    const c = COLOR_PALETTE[cursor % COLOR_PALETTE.length]
    const canAdd =
      counts[c] < 3 || // 严格 ≤ 3
      seq.length >= COLOR_PALETTE.length * 3 // 已超过 27,放弃约束继续填
    if (canAdd) {
      seq.push(c)
      counts[c]++
    }
    cursor++
    safety++
  }
  // 兜底:极少数情况下因 cursor 漏过所有 < 3 的槽(理论上不会),用循环填
  while (seq.length < n) {
    seq.push(COLOR_PALETTE[seq.length % COLOR_PALETTE.length])
  }

  // 第 2 步:稳定打乱 → 同名稳定同色
  const rand = mulberry32(seed)
  for (let i = seq.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[seq[i], seq[j]] = [seq[j], seq[i]]
  }
  return seq
}

/**
 * 把 {tabId: groupName} 真正建到 chrome.tabGroups。
 * - 过滤掉 pinned / <2 个的组(Chrome 不让 <2 tab 的组)
 * - 单个 group 失败不影响其他
 * - 颜色分配:由 options.colorMode 决定
 *     - "uniform":所有组用 options.uniformColor
 *     - "random":按排序后的 groupNames 哈希出 seed,生成颜色序列,按数组顺序取
 * - 幂等:每次调用前,先把当前窗口里"title 出现在 expectedDomains 里"的 group 解散
 *   (TabKeep 自己建的),用户手动建的不动
 */
async function applyGrouping(
  classification: Record<number, string>,
  options: GroupingOptions,
  expectedDomains: Set<string> = new Set()
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

  // 1) 先过滤掉 <2 tab 的 group(Chrome 不让建),按 groupName 排序后定颜色序列
  const eligibleNames: string[] = []
  const eligibleIds: Map<string, number[]> = new Map()
  for (const [groupName, tabIds] of byCategory) {
    const valid = tabIds.filter(id => validTabIds.has(id))
    if (valid.length < 2) continue
    eligibleNames.push(groupName)
    eligibleIds.set(groupName, valid)
  }
  eligibleNames.sort() // 排序让"同名同色"在不同次建组时一致

  // 2) 幂等:解散当前窗口里 TabKeep 自己建的 group(title ∈ expectedDomains)
  if (expectedDomains.size > 0) {
    const existingGroups = await chrome.tabGroups.query({})
    for (const g of existingGroups) {
      if (g.title && expectedDomains.has(g.title)) {
        // 这个 group 是 TabKeep 上一次(或前几次)建的 → 解散
        const memberTabs = await chrome.tabs.query({ groupId: g.id })
        const memberIds = memberTabs
          .map(t => t.id)
          .filter((id): id is number => id !== undefined)
        if (memberIds.length > 0) {
          try {
            await chrome.tabs.ungroup(memberIds)
            console.log(`[TabKeep] 清理旧 group "${g.title}" (${memberIds.length} 个 tab)`)
          } catch (e) {
            console.warn(`[TabKeep] 清理旧 group "${g.title}" 失败:`, e)
          }
        }
      }
    }
  }

  // 3) 颜色序列(只在 random 模式算)
  const colorSeq =
    options.colorMode === "random"
      ? buildColorSequence(eligibleNames.length, fnv1aHash(eligibleNames.join("|")))
      : null

  for (let i = 0; i < eligibleNames.length; i++) {
    const groupName = eligibleNames[i]
    const valid = eligibleIds.get(groupName)!
    const color: TabGroupColor =
      options.colorMode === "random"
        ? colorSeq![i]
        : options.uniformColor
    try {
      const groupId = await chrome.tabs.group({ tabIds: valid })
      await chrome.tabGroups.update(groupId, {
        title: groupName,
        color,
        collapsed: options.collapsedByDefault
      })
      console.log(`[TabKeep] 已建组 "${groupName}" (${valid.length} 个 tab, 颜色 ${color})`)
    } catch (e) {
      console.warn(`[TabKeep] 建组 "${groupName}" 失败:`, e)
    }
  }
}

/**
 * 按域名建组(当前窗口)—— 薄壳:算分类后调 applyGrouping。
 * "其他"组不建(没意义)。
 */
async function createTabGroups(style: Partial<TabGroupStyleOptions> = {}) {
  const options = { ...DEFAULT_STYLE, ...style }

  try {
    const allTabs = await fetchAllTabs()
    const grouped = groupTabsByDomain(allTabs)

    const classification: Record<number, string> = {}
    // 收集所有"TabKeep 这次应该建的 domain"(给 applyGrouping 当清理依据)
    const expectedDomains = new Set<string>()
    for (const group of grouped) {
      if (group.isOther) continue
      expectedDomains.add(group.domain)
      for (const tab of group.tabs) {
        if (tab.id !== undefined) classification[tab.id] = group.domain
      }
    }

    await applyGrouping(
      classification,
      {
        colorMode: options.colorMode,
        uniformColor: options.uniformColor,
        collapsedByDefault: options.collapsedByDefault
      },
      expectedDomains
    )
    console.log("Tab Group 创建完成")
  } catch (err) {
    console.error("创建 Tab Group 失败:", err)
  }
}


// ─────────────────────────────────────────────────────────────
// 4. 消息 dispatch table
//    - sync handler → 直接 sendResponse({success})
//    - async handler → return true + .then(sendResponse)(保持通道)
// ─────────────────────────────────────────────────────────────
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
  } else if (msg.type === "SUMMARIZE_CONTENT") {
    summarizeContent(msg.tab, msg.content).then(sendResponse)
    return true
  } else if (msg.type === "SUMMARIZE_AND_SAVE") {
    summarizeAndSave(msg.tab, msg.content, msg.notebookId, msg.targetDoc).then(sendResponse)
    return true
  }
})


// ─────────────────────────────────────────────────────────────
// 5. 全文提取(给弹窗用)
// ─────────────────────────────────────────────────────────────
/**
 * 让 content script 提取 markdown,加 200K 截断。
 * 返回 {ok, content, error}。
 */
const extractContentForPicker = async (
  tab: TabData
): Promise<{ ok: boolean; content?: string; error?: string }> => {
  console.log(`[TabKeep] extract-for-picker 开始 tab=${tab.id} title=${tab.title}`)
  if (tab.id === undefined) {
    return { ok: false, error: "tab 没有 id" }
  }

  let extract: any = await trySendMessage(tab.id)
  if (!extract) {
    const err = "提取失败:无法访问页面 content script(请刷新该标签页后重试,或避开 chrome:// 内部页 / PDF)"
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

// 给 content script 发消息,失败返 null
const trySendMessage = async (tabId: number): Promise<any> => {
  try {
    const res: any = await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_CONTENT" })
    return res
  } catch (e) {
    return null
  }
}


// ─────────────────────────────────────────────────────────────
// 6. 摘录 + 自动保存(关键流程,pull-and-forget 不依赖 popup 是否还活着)
// ─────────────────────────────────────────────────────────────
/**
 * 仅调 LLM 拿 markdown 摘录(不写笔记)。给前端拿到后再决定保存目标。
 */
const summarizeContent = async (
  tab: TabData,
  content: string
): Promise<{ ok: boolean; summary_markdown?: string; error?: string }> => {
  console.log(
    `[TabKeep] summarize 开始 tab=${tab.id} title=${tab.title} content_len=${content.length}`
  )
  if (!content.trim()) {
    return { ok: false, error: "content 为空,无法摘录" }
  }
  try {
    const res = await apiFetch("/notes/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: tab.title ?? "",
        url: tab.url ?? "",
        content
      })
    })
    const data = await res.json()
    if (data.ok && data.summary_markdown) {
      console.log(
        `[TabKeep] summarize ok title=${tab.title} summary_chars=${data.summary_markdown.length}`
      )
      return { ok: true, summary_markdown: data.summary_markdown }
    }
    const err = data.error ?? "summarize 响应异常"
    console.warn(`[TabKeep] summarize fail: ${err}`)
    return { ok: false, error: err }
  } catch (e) {
    console.error("[TabKeep] summarize 异常:", e)
    return { ok: false, error: String(e) }
  }
}

/**
 * 端到端:LLM 摘录 + 立即写笔记。fire-and-forget,pupup 关闭也照常跑。
 * 完成后用 chrome.notifications 弹桌面通知告诉用户结果。
 */
type SaveBackendParams = {
  tab: TabData
  mode: "link" | "full" | "summary"
  content?: string
  excerpt?: string
  notebookId: string
  targetDoc: string | null
}

const saveThroughAvailableBackend = async ({
  tab,
  mode,
  content,
  excerpt,
  notebookId,
  targetDoc,
}: SaveBackendParams): Promise<{ ok: boolean; note_id?: string; error?: string }> => {
  const title = tab.title ?? ""
  const url = tab.url ?? ""
  const desktopSaved = await captureWithDesktop({
    source: "tabkeep",
    mode,
    title,
    url,
    contentMarkdown: content,
    excerpt,
    favIconUrl: tab.favIconUrl,
    capturedAt: new Date().toISOString(),
  })
  if (desktopSaved) {
    return { ok: true, note_id: "openwiki-desktop" }
  }

  const res = await apiFetch("/notes/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      url,
      content: content || undefined,
      excerpt,
      notebook_id: notebookId,
      target_doc: targetDoc,
      mode,
    })
  })
  return res.json()
}

const summarizeAndSave = async (
  tab: TabData,
  content: string,
  notebookId: string,
  targetDoc: string | null
): Promise<{ ok: boolean; note_id?: string; error?: string; stage?: string }> => {
  console.log(
    `[TabKeep] summarizeAndSave 开始 tab=${tab.id} title=${tab.title} ` +
      `content_len=${content.length} notebook=${notebookId} target_doc=${targetDoc}`
  )
  if (!notebookId) {
    return { ok: false, error: "未指定 notebook", stage: "save" }
  }

  const sum = await summarizeContent(tab, content)
  if (!sum.ok || !sum.summary_markdown) {
    const reason = sum.error ?? "LLM 摘录失败"
    console.warn(`[TabKeep] 摘录失败,尝试回退保存全文: ${reason}`)
    try {
      const fallback = await saveThroughAvailableBackend({
        tab,
        mode: "full",
        content,
        notebookId,
        targetDoc,
      })
      if (fallback.ok) {
        notifyUser("摘录失败,已保存全文", `${tab.title ?? "无标题"} → 全文已保存`)
        return { ok: true, note_id: fallback.note_id, stage: "fallback-full" }
      }
      notifyUser("摘录失败", `${reason}; 全文保存也失败:${fallback.error ?? "未知错误"}`)
      return { ok: false, error: fallback.error ?? reason, stage: "fallback-full" }
    } catch (e) {
      notifyUser("摘录失败", `${reason}; 全文保存也失败:${String(e)}`)
      return { ok: false, error: String(e), stage: "fallback-full" }
    }
  }

  console.log(
    `[TabKeep] summarizeAndSave 摘录完成 ${sum.summary_markdown.length} 字, 立即写笔记`
  )
  try {
    const data = await saveThroughAvailableBackend({
      tab,
      mode: "summary",
      content: sum.summary_markdown,
      notebookId,
      targetDoc,
    })
    if (data.ok) {
      console.log(`[TabKeep] summarizeAndSave ok tab=${tab.id} doc=${data.note_id}`)
      const target = data.note_id === "openwiki-desktop"
        ? "已保存到 OpenWiki 桌面端"
        : targetDoc
        ? "已追加到文档"
        : "已新建 doc"
      notifyUser(
        "摘录已保存",
        `${tab.title ?? "无标题"} → ${target} (${sum.summary_markdown.length} 字)`
      )
      return { ok: true, note_id: data.note_id }
    }
    const err = data.error ?? "保存失败"
    console.warn(`[TabKeep] summarizeAndSave save fail: ${err}`)
    notifyUser("收藏失败", err)
    return { ok: false, error: err, stage: "save" }
  } catch (e) {
    console.error("[TabKeep] summarizeAndSave save 异常:", e)
    notifyUser("收藏失败", String(e))
    return { ok: false, error: String(e), stage: "save" }
  }
}

// ─────────────────────────────────────────────────────────────
// 7. 桌面通知
// ─────────────────────────────────────────────────────────────
/**
 * 用 chrome.notifications 弹桌面通知(在 popup 关闭后也能看到结果)。
 * iconUrl 用 plasmo 产物的占位名(c11f39af 是当前 hash,build 后会变)。
 */
const notifyUser = (title: string, message: string) => {
  try {
    // plasmo 每次 build 都会改 icon hash,直接硬编码会失效。
    // 用占位 URL 喂给 TS 类型;Chrome 实际显示会用扩展 toolbar 图标。
    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon128.plasmo.c11f39af.png"),
      title,
      message,
      priority: 1
    })
  } catch (e) {
    console.warn(`[TabKeep] 通知失败: ${e}`)
  }
}


// ─────────────────────────────────────────────────────────────
// 8. 收藏(链接 / 全文旧版,目前 popup 走 SUMMARIZE_AND_SAVE,不走这两个)
// ─────────────────────────────────────────────────────────────
/**
 * 仅链接收藏。notebook/target_doc 都留空 → 后端用 config.default* 兜底。
 * 现在主要给 options 里"测试保存"或老路径用,popup 已经不用了。
 */
const saveTabToNote = async (tab: TabData) => {
  console.log(`[TabKeep] 收藏(链接) tab=${tab.id} title=${tab.title} url=${tab.url}`)
  try {
    const data = await saveThroughAvailableBackend({
      tab,
      mode: "link",
      notebookId: "",
      targetDoc: null,
    })
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

/**
 * 旧版"全文收藏"—— content script 拿 markdown → 保存。
 * 当前 popup 主要走 NotebookPickerModal,这里保留给消息路径和未来快捷键用。
 */
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
    const err = "提取失败:无法访问页面 content script(可能是 chrome:// 内部页或 PDF)"
    console.error(`[TabKeep] 收藏(全文) ${err}:`, e)
    return { ok: false, error: err }
  }
  if (!extract?.ok) {
    const err = `提取失败:${extract?.error ?? "未知错误"}`
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
    console.warn("[TabKeep] 收藏(全文) 提取为空,回退到仅链接模式")
  }

  try {
    const data = await saveThroughAvailableBackend({
      tab: {
        ...tab,
        title: tab.title ?? extract.data.title,
      },
      mode: content ? "full" : "link",
      content: content || undefined,
      excerpt: extract.data.description || extract.data.author || undefined,
      notebookId: "",
      targetDoc: null,
    })
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

// ─────────────────────────────────────────────────────────────
// 9. LLM 分类
// ─────────────────────────────────────────────────────────────
/**
 * 给当前窗口的 tab 用 LLM 分类。结果 console.log 出来,不做建组。
 */
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
    const res = await apiFetch("/classify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tabs: tabDataList })
    })
    const data = await res.json()
    if (data.error) {
      console.error("[TabKeep] 后端分类失败:", data.error)
      return data
    }
    console.log("[TabKeep] LLM 原始响应:", data.raw)
    console.log("[TabKeep] 分类结果:")
    for (const tab of tabDataList) {
      const cat = data.result?.[tab.id] ?? "未分类"
      console.log(`  [${tab.id}] ${tab.title || tab.url} → ${cat}`)
    }
    return data
  } catch (err) {
    console.error("[TabKeep] 请求后端失败:", err)
    return { error: String(err) }
  }
}

/**
 * LLM 分类 + 真的建组(过滤掉"未分类"标签,避免建空组)。
 */
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

  // AI 分类路径:category 是 LLM 自由文字,无法用 title 判定旧 group。
  // 走粗暴策略 —— 把当前窗口所有 group 全部解散,再由 applyGrouping 重建。
  const existingGroups = await chrome.tabGroups.query({})
  for (const g of existingGroups) {
    const memberTabs = await chrome.tabs.query({ groupId: g.id })
    const memberIds = memberTabs
      .map(t => t.id)
      .filter((id): id is number => id !== undefined)
    if (memberIds.length > 0) {
      try {
        await chrome.tabs.ungroup(memberIds)
      } catch (e) {
        console.warn(`[TabKeep] AI 分组: 清理 group "${g.title}" 失败:`, e)
      }
    }
  }

  await applyGrouping(filtered, {
    colorMode: options.colorMode,
    uniformColor: options.uniformColor,
    collapsedByDefault: options.collapsedByDefault
  })
  return result
}


// ─────────────────────────────────────────────────────────────
// 10. 浏览器事件 + 定时任务
// ─────────────────────────────────────────────────────────────
// tab 增删改都同步到后端 + 写 IDB
chrome.tabs.onCreated.addListener(() => { saveTabsData(); syncToBackend() })
chrome.tabs.onRemoved.addListener(() => { saveTabsData(); syncToBackend() })
chrome.tabs.onUpdated.addListener(() => { saveTabsData(); syncToBackend() })

// 定时同步(防止 popup 一直不开,事件触发有遗漏)
chrome.alarms.create("syncTabs", { periodInMinutes: SYNC_INTERVAL_MINUTES })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "syncTabs") syncToBackend()
})


// ─────────────────────────────────────────────────────────────
// 11. 启动恢复 + 初始保存
// ─────────────────────────────────────────────────────────────
/**
 * 启动时从 chrome.storage.local 把所有配置推给后端。
 * 防止后端 config.json 丢失 / 损坏 / 后端重启后内存为空时,后端没有这些配置。
 * 后端 sync_config 走合并模式,只覆盖前端发的字段,所以这里把所有键都发一遍是安全的。
 */
const restoreConfigToBackend = async () => {
  try {
    const stored = await chrome.storage.local.get([
      "modelConfig",
      "tabCategories",
      "noteAdapter"
    ])
    const token = await ensureApiToken()
    const body: Record<string, unknown> = { apiToken: token }
    if (stored.modelConfig) body.modelConfig = stored.modelConfig
    if (Array.isArray(stored.tabCategories)) body.tabCategories = stored.tabCategories
    if (stored.noteAdapter) body.noteAdapter = stored.noteAdapter
    const res = await apiFetch("/config/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
    const data = await res.json()
    if (data.ok) {
      console.log(
        `[TabKeep] 启动恢复: 已把本地配置推给后端 (${Object.keys(body).join(", ")})`
      )
    } else {
      console.warn(`[TabKeep] 启动恢复失败: ${data.error}`)
    }
  } catch (e) {
    console.warn(`[TabKeep] 启动恢复异常: ${e}`)
  }
}

// 入口
saveTabsData()
restoreConfigToBackend().then(syncToBackend)

console.log("TabKeep background loaded")
