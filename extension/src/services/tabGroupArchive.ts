import { apiFetch, ensureApiToken, FASTAPI_URL } from "../config/api"

type BrowserName = "chrome" | "edge"
type GroupColor = chrome.tabGroups.Color
type RestoreTarget = "current" | "new"

interface ArchiveTab {
  url: string
  title: string
  favIconUrl?: string
  index: number
  active: boolean
}

interface ArchiveGroup {
  nativeGroupId: number
  archiveId?: string
  title: string
  color: GroupColor
  collapsed: boolean
  windowId: number
  tabs: ArchiveTab[]
}

interface ArchiveCommand {
  id: string
  kind: "restore" | "delete"
  archiveId: string
  target?: RestoreTarget
  payload: {
    archiveId?: string
    title: string
    color: GroupColor
    collapsed?: boolean
    tabs: ArchiveTab[]
    nativeGroupId?: number
    browserSessionId?: string
  }
}

interface RestoreProgress {
  archiveId: string
  browserSessionId: string
  target: RestoreTarget
  payload: ArchiveCommand["payload"]
  targetWindowId?: number
  blankTabId?: number
  existingGroupId?: number
  createdTabs: Array<{ index: number; id: number; active: boolean }>
}

const INSTANCE_KEY = "tabkeep.archive.browserInstanceId"
const SESSION_KEY = "tabkeep.archive.browserSessionId"
const ASSIGNMENTS_KEY = "tabkeep.archive.assignments"
const COMMAND_RESULTS_KEY = "tabkeep.archive.commandResults"
const RESTORE_PROGRESS_KEY = "tabkeep.archive.restoreProgress"
const READY_SESSION_KEY = "tabkeep.archive.readySessionId"
const MANAGED_GROUP_IDS_KEY = "tabkeep.archive.managedGroupIds"
const MANAGED_GROUP_FINGERPRINTS_KEY = "tabkeep.archive.managedGroupFingerprints"
const HEARTBEAT_MS = 20_000
const GROUP_SYNC_DELAY_MS = 650
const INITIAL_INVENTORY_TIMEOUT_MS = 20_000

let socket: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let heartbeatTimer: ReturnType<typeof setInterval> | undefined
let reconnectDelay = 1000
let connecting = false
let syncTimer: ReturnType<typeof setTimeout> | undefined
let snapshotAgain = false
let snapshotCompletionRequested = false
let snapshotTask: Promise<boolean> | null = null
let lastSnapshotSessionId = ""
let lastSnapshotComplete = false
let bridgeActive = false
let bridgeListenersRegistered = false
const runningCommands = new Map<string, Promise<void>>()
const runningArchives = new Map<string, Promise<void>>()
const inventoryRetryConnections = new WeakSet<WebSocket>()

const browserName: BrowserName = /Edg\//.test(navigator.userAgent) ? "edge" : "chrome"

async function stableId(key: string, area: "local" | "session"): Promise<string> {
  const store = area === "local" ? chrome.storage.local : chrome.storage.session
  const stored = await store.get(key)
  const value = stored[key]
  if (typeof value === "string" && value.length > 0) return value
  const created = crypto.randomUUID()
  await store.set({ [key]: created })
  return created
}

async function getBrowserIdentity(): Promise<{ instanceId: string; sessionId: string }> {
  const [instanceId, sessionId] = await Promise.all([
    stableId(INSTANCE_KEY, "local"),
    stableId(SESSION_KEY, "session"),
  ])
  return { instanceId, sessionId }
}

async function getAssignments(): Promise<Record<string, string>> {
  const stored = await chrome.storage.local.get(ASSIGNMENTS_KEY)
  const value = stored[ASSIGNMENTS_KEY]
  return value && typeof value === "object" ? value as Record<string, string> : {}
}

async function saveAssignment(sessionId: string, groupId: number, archiveId: string): Promise<void> {
  const assignments = await getAssignments()
  assignments[`${sessionId}:${groupId}`] = archiveId
  await chrome.storage.local.set({ [ASSIGNMENTS_KEY]: assignments })
}

async function clearAssignment(sessionId: string, groupId: number): Promise<void> {
  const assignments = await getAssignments()
  delete assignments[`${sessionId}:${groupId}`]
  await chrome.storage.local.set({ [ASSIGNMENTS_KEY]: assignments })
}

async function getCommandResults(): Promise<Record<string, { completedAt: number }>> {
  const stored = await chrome.storage.local.get(COMMAND_RESULTS_KEY)
  const value = stored[COMMAND_RESULTS_KEY]
  return value && typeof value === "object"
    ? value as Record<string, { completedAt: number }>
    : {}
}

async function hasCompletedCommand(commandId: string): Promise<boolean> {
  const results = await getCommandResults()
  return Boolean(results[commandId])
}

async function rememberCompletedCommand(commandId: string): Promise<void> {
  const results = await getCommandResults()
  results[commandId] = { completedAt: Date.now() }
  const recent = Object.entries(results)
    .sort((left, right) => right[1].completedAt - left[1].completedAt)
    .slice(0, 5000)
  await chrome.storage.local.set({ [COMMAND_RESULTS_KEY]: Object.fromEntries(recent) })
}

async function getRestoreProgress(): Promise<Record<string, RestoreProgress>> {
  const stored = await chrome.storage.local.get(RESTORE_PROGRESS_KEY)
  const value = stored[RESTORE_PROGRESS_KEY]
  return value && typeof value === "object" ? value as Record<string, RestoreProgress> : {}
}

async function saveRestoreProgress(commandId: string, progress: RestoreProgress): Promise<void> {
  const all = await getRestoreProgress()
  all[commandId] = progress
  const entries = Object.entries(all).slice(-50)
  await chrome.storage.local.set({ [RESTORE_PROGRESS_KEY]: Object.fromEntries(entries) })
}

async function removeRestoreProgress(commandId: string): Promise<void> {
  const all = await getRestoreProgress()
  delete all[commandId]
  await chrome.storage.local.set({ [RESTORE_PROGRESS_KEY]: all })
}

async function getManagedGroupIds(): Promise<Record<string, boolean>> {
  const stored = await chrome.storage.session.get(MANAGED_GROUP_IDS_KEY)
  const value = stored[MANAGED_GROUP_IDS_KEY]
  return value && typeof value === "object" ? value as Record<string, boolean> : {}
}

async function getManagedGroupFingerprints(): Promise<Record<string, string>> {
  const stored = await chrome.storage.local.get(MANAGED_GROUP_FINGERPRINTS_KEY)
  const value = stored[MANAGED_GROUP_FINGERPRINTS_KEY]
  return value && typeof value === "object" ? value as Record<string, string> : {}
}

async function groupSignature(groupId: number): Promise<string | null> {
  const group = await chrome.tabGroups.get(groupId)
  const tabs = await chrome.tabs.query({ groupId, windowId: group.windowId })
  const savedTabs = tabs
    .filter((tab) => typeof tab.url === "string" && /^https?:\/\//i.test(tab.url))
    .sort((left, right) => left.index - right.index)
    .map((tab) => ({
      url: tab.url!,
      title: tab.title ?? "",
      index: tab.index,
      active: Boolean(tab.active),
    }))
  return savedTabs.length > 0 ? groupFingerprint(group.title ?? "", group.color, savedTabs) : null
}

export async function markTabKeepManagedGroup(groupId: number): Promise<void> {
  const { sessionId } = await getBrowserIdentity()
  const managedIds = await getManagedGroupIds()
  managedIds[`${sessionId}:${groupId}`] = true
  await chrome.storage.session.set({ [MANAGED_GROUP_IDS_KEY]: managedIds })
  const signature = await groupSignature(groupId)
  if (!signature) return
  const fingerprints = await getManagedGroupFingerprints()
  for (const [key, value] of Object.entries(fingerprints)) {
    if (key !== `${sessionId}:${groupId}` && value === signature) delete fingerprints[key]
  }
  fingerprints[`${sessionId}:${groupId}`] = signature
  await chrome.storage.local.set({ [MANAGED_GROUP_FINGERPRINTS_KEY]: fingerprints })
}

async function forgetTabKeepManagedGroup(groupId: number): Promise<void> {
  const { sessionId } = await getBrowserIdentity()
  const markerKey = `${sessionId}:${groupId}`
  const managedIds = await getManagedGroupIds()
  delete managedIds[markerKey]
  await chrome.storage.session.set({ [MANAGED_GROUP_IDS_KEY]: managedIds })
  const fingerprints = await getManagedGroupFingerprints()
  delete fingerprints[markerKey]
  await chrome.storage.local.set({ [MANAGED_GROUP_FINGERPRINTS_KEY]: fingerprints })
}

async function findProgressGroup(progress: RestoreProgress): Promise<chrome.tabGroups.TabGroup | null> {
  if (typeof progress.existingGroupId === "number") {
    try {
      return await chrome.tabGroups.get(progress.existingGroupId)
    } catch {
      return null
    }
  }
  const groupIds = new Set<number>()
  const tabs: chrome.tabs.Tab[] = []
  for (const entry of progress.createdTabs) {
    try {
      const tab = await chrome.tabs.get(entry.id)
      tabs.push(tab)
      if (tab.groupId >= 0) groupIds.add(tab.groupId)
    } catch {
      // 已被用户关闭的恢复页不参与恢复。
    }
  }
  if (groupIds.size > 1 || tabs.length === 0) return null
  let groupId = [...groupIds][0]
  if (groupId === undefined) {
    groupId = await chrome.tabs.group({ tabIds: tabs.map((tab) => tab.id!) })
  } else {
    const ungroupedIds = tabs.filter((tab) => tab.groupId < 0).map((tab) => tab.id!)
    if (ungroupedIds.length > 0) {
      await chrome.tabs.group({ tabIds: ungroupedIds, groupId })
    }
  }
  try {
    return await chrome.tabGroups.get(groupId)
  } catch {
    return null
  }
}

async function recoverInterruptedRestores(sessionId: string): Promise<void> {
  const progressEntries = Object.entries(await getRestoreProgress())
  for (const [commandId, progress] of progressEntries) {
    if (await hasCompletedCommand(commandId)) {
      await removeRestoreProgress(commandId)
      continue
    }
    if (progress.browserSessionId !== sessionId) continue
    try {
      const group = await findProgressGroup(progress)
      if (!group) continue
      if (progress.existingGroupId !== undefined &&
        progress.createdTabs.length === 0 && progress.targetWindowId !== undefined) {
        await chrome.tabGroups.move(group.id, { windowId: progress.targetWindowId, index: -1 })
      }
      if (progress.createdTabs.length > 0) {
        await chrome.tabGroups.update(group.id, {
          title: progress.payload.title,
          color: progress.payload.color,
          collapsed: false,
        })
        const activeTab = progress.createdTabs.find((tab) => tab.active)
        if (activeTab) await chrome.tabs.update(activeTab.id, { active: true })
        await chrome.tabGroups.update(group.id, {
          collapsed: progress.payload.collapsed ?? false,
        })
      }
      await saveAssignment(sessionId, group.id, progress.archiveId)
      if (progress.blankTabId !== undefined) {
        await chrome.tabs.remove(progress.blankTabId).catch(() => undefined)
      }
      await rememberCompletedCommand(commandId)
      await removeRestoreProgress(commandId)
    } catch (error) {
      console.warn("[TabKeep] 恢复中断状态修复失败:", error)
    }
  }
}

async function getNormalWindowIds(): Promise<Set<number>> {
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] })
  return new Set(windows.filter((item) => !item.incognito).map((item) => item.id).filter(
    (id): id is number => typeof id === "number",
  ))
}

async function collectGroups(sessionId: string): Promise<ArchiveGroup[]> {
  const [groups, normalWindowIds, assignments, managedIds, knownFingerprints] = await Promise.all([
    chrome.tabGroups.query({}),
    getNormalWindowIds(),
    getAssignments(),
    getManagedGroupIds(),
    getManagedGroupFingerprints(),
  ])
  const collected: Array<{
    group: chrome.tabGroups.TabGroup
    tabs: ArchiveTab[]
    signature: string | null
  }> = []
  for (const group of groups) {
    if (!normalWindowIds.has(group.windowId)) continue
    const tabs = await chrome.tabs.query({ groupId: group.id, windowId: group.windowId })
    const savedTabs = tabs
      .filter((tab) => typeof tab.url === "string" && /^https?:\/\//i.test(tab.url))
      .sort((left, right) => left.index - right.index)
      .map((tab) => ({
        url: tab.url!,
        title: tab.title ?? "",
        favIconUrl: tab.favIconUrl,
        index: tab.index,
        active: Boolean(tab.active),
      }))
    collected.push({
      group,
      tabs: savedTabs,
      signature: savedTabs.length > 0
        ? groupFingerprint(group.title ?? "", group.color, savedTabs)
        : null,
    })
  }
  const currentSignatureCounts = new Map<string, number>()
  for (const item of collected) {
    if (item.signature) {
      currentSignatureCounts.set(
        item.signature,
        (currentSignatureCounts.get(item.signature) ?? 0) + 1,
      )
    }
  }
  const historySignatureCounts = new Map<string, number>()
  for (const signature of new Set(Object.values(knownFingerprints))) {
    historySignatureCounts.set(signature, 1)
  }
  const result: ArchiveGroup[] = []
  let managedChanged = false
  for (const { group, tabs, signature } of collected) {
    const markerKey = `${sessionId}:${group.id}`
    const wasManaged = managedIds[markerKey] === true || Boolean(signature && (
      currentSignatureCounts.get(signature) === 1 && historySignatureCounts.get(signature) === 1
    ))
    if (wasManaged) {
      managedIds[markerKey] = true
      if (signature) {
        for (const [key, value] of Object.entries(knownFingerprints)) {
          if (key !== markerKey && value === signature) delete knownFingerprints[key]
        }
        knownFingerprints[markerKey] = signature
      } else {
        delete knownFingerprints[markerKey]
      }
      managedChanged = true
      continue
    }
    result.push({
      nativeGroupId: group.id,
      archiveId: assignments[markerKey],
      title: group.title ?? "",
      color: group.color,
      collapsed: group.collapsed,
      windowId: group.windowId,
      tabs,
    })
  }
  if (managedChanged) {
    await Promise.all([
      chrome.storage.session.set({ [MANAGED_GROUP_IDS_KEY]: managedIds }),
      chrome.storage.local.set({ [MANAGED_GROUP_FINGERPRINTS_KEY]: knownFingerprints }),
    ])
  }
  return result
}

async function synchronizeSnapshot(completion?: boolean): Promise<boolean> {
  const { instanceId, sessionId } = await getBrowserIdentity()
  const ready = await chrome.storage.local.get(READY_SESSION_KEY)
  const complete = completion ?? (
    ready[READY_SESSION_KEY] === sessionId ||
    (lastSnapshotSessionId === sessionId && lastSnapshotComplete)
  )
  if (snapshotTask) {
    snapshotAgain = true
    snapshotCompletionRequested ||= complete
    const activeTask = snapshotTask
    const succeeded = await activeTask
    await Promise.resolve()
    if (!succeeded) return false
    if (snapshotAgain || snapshotCompletionRequested) {
      return synchronizeSnapshot(
        snapshotCompletionRequested ||
        (lastSnapshotSessionId === sessionId && lastSnapshotComplete),
      )
    }
    return true
  }
  snapshotCompletionRequested = complete
  const task = (async () => {
    let succeeded = true
    do {
      snapshotAgain = false
      const isComplete = snapshotCompletionRequested
      snapshotCompletionRequested = false
      try {
        const groups = await collectGroups(sessionId)
        const response = await apiFetch("/tab-groups/snapshot", {
          method: "POST",
          body: JSON.stringify({
            browserInstanceId: instanceId,
            browserSessionId: sessionId,
            browser: browserName,
            complete: isComplete,
            groups,
          }),
        })
        if (!response.ok) throw new Error(`同步标签组失败: HTTP ${response.status}`)
        const data = await response.json() as {
          assignments: Array<{ nativeGroupId: number; archiveId: string | null; suppressed: boolean }>
        }
        for (const assignment of data.assignments) {
          if (assignment.archiveId) {
            await saveAssignment(sessionId, assignment.nativeGroupId, assignment.archiveId)
          } else {
            await clearAssignment(sessionId, assignment.nativeGroupId)
          }
        }
        lastSnapshotSessionId = sessionId
        lastSnapshotComplete = isComplete
      } catch (error) {
        console.warn("[TabKeep] 标签归档同步失败:", error)
        succeeded = false
        break
      }
    } while (snapshotAgain)
    return succeeded
  })()
  snapshotTask = task
  try {
    return await task
  } finally {
    if (snapshotTask === task) snapshotTask = null
  }
}

function scheduleSnapshot(): void {
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    syncTimer = undefined
    void synchronizeSnapshot()
  }, GROUP_SYNC_DELAY_MS)
}

async function waitForInitialBrowserInventory(connection: WebSocket): Promise<boolean> {
  const startedAt = Date.now()
  let previousSignature = ""
  let stableChecks = 0
  while (Date.now() - startedAt < INITIAL_INVENTORY_TIMEOUT_MS) {
    if (socket !== connection || connection.readyState !== WebSocket.OPEN) return false
    const [normalWindowIds, tabs, groups] = await Promise.all([
      getNormalWindowIds(),
      chrome.tabs.query({}),
      chrome.tabGroups.query({}),
    ])
    const signature = JSON.stringify({
      groups: groups
        .filter((group) => normalWindowIds.has(group.windowId))
        .map((group) => [group.id, group.windowId, group.title, group.color, group.collapsed])
        .sort((left, right) => Number(left[0]) - Number(right[0])),
      tabs: tabs
        .filter((tab) => normalWindowIds.has(tab.windowId))
        .map((tab) => [tab.id, tab.windowId, tab.groupId, tab.url, tab.status])
        .sort((left, right) => Number(left[0]) - Number(right[0])),
    })
    stableChecks = signature === previousSignature ? stableChecks + 1 : 0
    previousSignature = signature
    const tabsSettled = tabs
      .filter((tab) => normalWindowIds.has(tab.windowId))
      .every((tab) => tab.status !== "loading")
    if (Date.now() - startedAt >= 5000 && stableChecks >= 10 && tabsSettled) return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

function groupFingerprint(title: string, color: GroupColor, tabs: ArchiveTab[]): string {
  return JSON.stringify({
    title: title || "未命名标签组",
    color,
    urls: [...tabs].sort((left, right) => left.index - right.index).map((tab) => tab.url),
  })
}

async function findLinkedGroup(
  command: ArchiveCommand,
  sessionId: string,
): Promise<chrome.tabGroups.TabGroup | null> {
  const groups = await chrome.tabGroups.query({})
  const normalWindows = await getNormalWindowIds()
  const assignments = await getAssignments()
  const assigned = groups.filter((group) =>
    normalWindows.has(group.windowId) &&
    assignments[`${sessionId}:${group.id}`] === command.archiveId,
  )
  if (assigned.length === 1) return assigned[0]
  if (assigned.length > 1) throw new Error("找到多个关联标签组，已停止操作")

  const sourceSessionId = command.payload.browserSessionId
  const sourceGroupId = command.payload.nativeGroupId
  if (sourceSessionId === sessionId && typeof sourceGroupId === "number") {
    const sourceGroup = groups.find((group) =>
      normalWindows.has(group.windowId) && group.id === sourceGroupId,
    )
    if (!sourceGroup) return null
    const linkedArchiveId = assignments[`${sessionId}:${sourceGroup.id}`]
    return linkedArchiveId && linkedArchiveId !== command.archiveId ? null : sourceGroup
  }
  if (command.kind !== "delete" || sourceSessionId === sessionId) return null

  const expectedFingerprint = groupFingerprint(
    command.payload.title,
    command.payload.color,
    command.payload.tabs,
  )
  const candidates: chrome.tabGroups.TabGroup[] = []
  for (const group of groups) {
    if (!normalWindows.has(group.windowId)) continue
    const assignedArchiveId = assignments[`${sessionId}:${group.id}`]
    if (assignedArchiveId && assignedArchiveId !== command.archiveId) continue
    if (await groupSignature(group.id) === expectedFingerprint) candidates.push(group)
  }
  if (candidates.length === 1) return candidates[0]
  return null
}

async function normalTargetWindow(): Promise<{
  window: chrome.windows.Window
  blankTabId?: number
}> {
  try {
    const focused = await chrome.windows.getLastFocused({ windowTypes: ["normal"] })
    if (typeof focused.id === "number" && !focused.incognito) return { window: focused }
  } catch {
    // 没有普通浏览器窗口时会在下面创建一个。
  }
  const created = await chrome.windows.create({ focused: true, type: "normal" })
  return { window: created, blankTabId: created.tabs?.[0]?.id }
}

async function restoreGroup(command: ArchiveCommand, sessionId: string): Promise<void> {
  const payload = command.payload
  const progressEntries = await getRestoreProgress()
  const progress = progressEntries[command.id] ?? {
    archiveId: command.archiveId,
    browserSessionId: sessionId,
    target: command.target ?? "current",
    payload,
    createdTabs: [],
  }
  const recoveredAcrossSession = progress.browserSessionId !== sessionId
  if (recoveredAcrossSession) {
    progress.browserSessionId = sessionId
    progress.targetWindowId = undefined
    progress.blankTabId = undefined
    progress.existingGroupId = undefined
    progress.createdTabs = []
  }
  await saveRestoreProgress(command.id, progress)
  let existing = await findLinkedGroup(command, sessionId)
  if (!existing && progress.createdTabs.length > 0) {
    existing = await findProgressGroup(progress)
  }
  let targetWindow: chrome.windows.Window
  let blankTabId: number | undefined

  if (progress.targetWindowId !== undefined) {
    try {
      targetWindow = await chrome.windows.get(progress.targetWindowId)
      blankTabId = progress.blankTabId
    } catch {
      progress.targetWindowId = undefined
      progress.blankTabId = undefined
      targetWindow = await createRestoreWindow(command.id, progress)
      blankTabId = progress.blankTabId
    }
  } else if (progress.target === "new") {
    targetWindow = await createRestoreWindow(command.id, progress)
    blankTabId = progress.blankTabId
  } else {
    const target = await normalTargetWindow()
    targetWindow = target.window
    blankTabId = target.blankTabId
    progress.targetWindowId = targetWindow.id
    progress.blankTabId = blankTabId
    await saveRestoreProgress(command.id, progress)
  }
  if (typeof targetWindow.id !== "number") throw new Error("无法创建目标浏览器窗口")

  if (existing) {
    progress.existingGroupId = existing.id
    progress.targetWindowId = targetWindow.id
    progress.blankTabId = blankTabId
    await saveRestoreProgress(command.id, progress)
    const moved = await chrome.tabGroups.move(existing.id, {
      windowId: targetWindow.id,
      index: -1,
    })
    const currentGroup = moved ?? await chrome.tabGroups.get(existing.id).catch(() => undefined)
    if (!currentGroup) throw new Error("浏览器未能移动现有标签组")
    if (progress.createdTabs.length > 0 || recoveredAcrossSession) {
      await chrome.tabGroups.update(currentGroup.id, {
        title: payload.title,
        color: payload.color,
        collapsed: false,
      })
      const activeTab = progress.createdTabs.find((tab) => tab.active)
      if (activeTab) await chrome.tabs.update(activeTab.id, { active: true })
      await chrome.tabGroups.update(currentGroup.id, { collapsed: payload.collapsed ?? false })
    }
    if (blankTabId !== undefined) await chrome.tabs.remove(blankTabId).catch(() => undefined)
    await saveAssignment(sessionId, currentGroup.id, command.archiveId)
    scheduleSnapshot()
    return
  }

  const createdIds: number[] = []
  let activeId: number | undefined
  for (const tab of [...payload.tabs].sort((left, right) => left.index - right.index)) {
    if (!/^https?:\/\//i.test(tab.url)) continue
    const savedTab = progress.createdTabs.find((entry) => entry.index === tab.index)
    if (savedTab) {
      try {
        const existingTab = await chrome.tabs.get(savedTab.id)
        if (existingTab.windowId !== targetWindow.id && existingTab.groupId < 0) {
          await chrome.tabs.move(existingTab.id, { windowId: targetWindow.id, index: -1 })
        }
        createdIds.push(existingTab.id!)
        if (tab.active) activeId = existingTab.id
        continue
      } catch {
        progress.createdTabs = progress.createdTabs.filter((entry) => entry.index !== tab.index)
      }
    }
    try {
      const created = await chrome.tabs.create({
        url: tab.url,
        windowId: targetWindow.id,
        active: false,
      })
      if (typeof created.id === "number") {
        createdIds.push(created.id)
        progress.createdTabs.push({ index: tab.index, id: created.id, active: tab.active })
        await saveRestoreProgress(command.id, progress)
        if (tab.active) activeId = created.id
      }
    } catch (error) {
      console.warn(`[TabKeep] 跳过无法恢复的网页 ${tab.url}:`, error)
    }
  }
  if (createdIds.length === 0) throw new Error("没有可恢复的网页")

  await saveRestoreProgress(command.id, progress)
  const groupId = await chrome.tabs.group({ tabIds: createdIds })
  progress.existingGroupId = groupId
  await saveAssignment(sessionId, groupId, command.archiveId)
  await saveRestoreProgress(command.id, progress)
  await chrome.tabGroups.update(groupId, {
    title: payload.title,
    color: payload.color,
    collapsed: false,
  })
  if (activeId !== undefined) await chrome.tabs.update(activeId, { active: true })
  await chrome.tabGroups.update(groupId, { collapsed: payload.collapsed ?? false })
  if (blankTabId !== undefined) await chrome.tabs.remove(blankTabId).catch(() => undefined)
  scheduleSnapshot()
}

async function createRestoreWindow(
  commandId: string,
  progress: RestoreProgress,
): Promise<chrome.windows.Window> {
  const created = await chrome.windows.create({ url: "about:blank", focused: true, type: "normal" })
  progress.targetWindowId = created.id
  progress.blankTabId = created.tabs?.[0]?.id
  await saveRestoreProgress(commandId, progress)
  return created
}

async function deleteGroup(command: ArchiveCommand, sessionId: string): Promise<void> {
  const group = await findLinkedGroup(command, sessionId)
  if (!group) return
  const tabs = await chrome.tabs.query({ groupId: group.id, windowId: group.windowId })
  const ids = tabs.map((tab) => tab.id).filter((id): id is number => typeof id === "number")
  if (ids.length > 0) await chrome.tabs.remove(ids)
  await clearAssignment(sessionId, group.id)
  scheduleSnapshot()
}

async function executeCommand(command: ArchiveCommand, sessionId: string): Promise<void> {
  if (command.kind === "restore") {
    await restoreGroup(command, sessionId)
  } else if (command.kind === "delete") {
    await deleteGroup(command, sessionId)
  } else {
    throw new Error("未知的标签归档命令")
  }
}

async function executeCommandOnce(command: ArchiveCommand, sessionId: string): Promise<void> {
  const running = runningCommands.get(command.id)
  if (running) return running
  if (await hasCompletedCommand(command.id)) return
  const previousArchiveCommand = runningArchives.get(command.archiveId)
  const task = (async () => {
    if (previousArchiveCommand) await previousArchiveCommand.catch(() => undefined)
    if (await hasCompletedCommand(command.id)) return
    await executeCommand(command, sessionId)
    await rememberCompletedCommand(command.id)
    await removeRestoreProgress(command.id)
  })()
  runningCommands.set(command.id, task)
  runningArchives.set(command.archiveId, task)
  try {
    await task
  } finally {
    runningCommands.delete(command.id)
    if (runningArchives.get(command.archiveId) === task) {
      runningArchives.delete(command.archiveId)
    }
  }
}

function closeBridge(): void {
  socket?.close()
  socket = null
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = undefined
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = undefined
}

function startHeartbeat(connection: WebSocket): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = setInterval(() => {
    if (connection.readyState === WebSocket.OPEN) {
      connection.send(JSON.stringify({ type: "heartbeat" }))
    }
  }, HEARTBEAT_MS)
}

function scheduleInventoryCompletion(connection: WebSocket, sessionId: string): void {
  if (inventoryRetryConnections.has(connection)) return
  inventoryRetryConnections.add(connection)
  setTimeout(async () => {
    let retry = false
    try {
      if (socket !== connection || connection.readyState !== WebSocket.OPEN) return
      const complete = await waitForInitialBrowserInventory(connection)
      if (!complete) {
        retry = socket === connection && connection.readyState === WebSocket.OPEN
        return
      }
      if (!await synchronizeSnapshot(true)) {
        retry = true
        return
      }
      await chrome.storage.local.set({ [READY_SESSION_KEY]: sessionId })
      if (socket === connection && connection.readyState === WebSocket.OPEN) {
        connection.send(JSON.stringify({ type: "ready", complete: true }))
      }
    } catch (error) {
      console.warn("[TabKeep] 标签组完整快照重试失败:", error)
      retry = true
    } finally {
      inventoryRetryConnections.delete(connection)
      if (retry && socket === connection && connection.readyState === WebSocket.OPEN) {
        scheduleInventoryCompletion(connection, sessionId)
      }
    }
  }, 5000)
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined
    void connectBridge()
  }, reconnectDelay)
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
}

async function connectBridge(): Promise<void> {
  if (connecting || (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING))) return
  connecting = true
  try {
    const [{ instanceId, sessionId }, token] = await Promise.all([
      getBrowserIdentity(),
      ensureApiToken(),
    ])
    const url = new URL(FASTAPI_URL)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    url.pathname = "/tab-groups/bridge"
    url.search = new URLSearchParams({ browserInstanceId: instanceId }).toString()
    const connection = new WebSocket(url)
    socket = connection

    connection.onopen = () => {
      reconnectDelay = 1000
      connection.send(JSON.stringify({
        type: "authenticate",
        token,
        browserInstanceId: instanceId,
        browser: browserName,
        browserSessionId: sessionId,
      }))
    }
    connection.onmessage = (event) => {
      void handleBridgeMessage(connection, event.data, sessionId)
    }
    connection.onerror = () => connection.close()
    connection.onclose = () => {
      if (socket === connection) socket = null
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
      scheduleReconnect()
    }
  } catch (error) {
    console.warn("[TabKeep] 标签归档连接失败:", error)
    scheduleReconnect()
  } finally {
    connecting = false
  }
}

async function handleBridgeMessage(
  connection: WebSocket,
  data: unknown,
  sessionId: string,
): Promise<void> {
  let message: Record<string, unknown>
  try {
    message = JSON.parse(String(data)) as Record<string, unknown>
  } catch {
    return
  }
  if (message.type === "connected") {
    startHeartbeat(connection)
    try {
      await recoverInterruptedRestores(sessionId)
      const ready = await chrome.storage.local.get(READY_SESSION_KEY)
      let complete = ready[READY_SESSION_KEY] === sessionId
      if (!complete) complete = await waitForInitialBrowserInventory(connection)
      const synchronized = await synchronizeSnapshot(complete)
      if (!synchronized) {
        connection.close()
        return
      }
      if (connection.readyState !== WebSocket.OPEN) return
      if (complete) await chrome.storage.local.set({ [READY_SESSION_KEY]: sessionId })
      connection.send(JSON.stringify({ type: "ready", complete }))
      if (!complete) scheduleInventoryCompletion(connection, sessionId)
    } catch (error) {
      console.warn("[TabKeep] 标签归档初始同步失败:", error)
      connection.close()
    }
    return
  }
  if (message.type === "command" && message.command && typeof message.command === "object") {
    const command = message.command as ArchiveCommand
    try {
      await executeCommandOnce(command, sessionId)
      if (connection.readyState === WebSocket.OPEN) {
        connection.send(JSON.stringify({ type: "command_result", commandId: command.id, ok: true }))
      }
    } catch (error) {
      if (connection.readyState === WebSocket.OPEN) {
        connection.send(JSON.stringify({
          type: "command_result",
          commandId: command.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }))
      }
    }
  }
}

export function registerTabGroupArchiveBridge(): void {
  if (bridgeListenersRegistered) return
  bridgeListenersRegistered = true
  const requestSnapshot = () => {
    if (bridgeActive) scheduleSnapshot()
  }
  chrome.tabs.onCreated.addListener(requestSnapshot)
  chrome.tabs.onRemoved.addListener(requestSnapshot)
  chrome.tabs.onUpdated.addListener(requestSnapshot)
  chrome.tabs.onMoved.addListener(requestSnapshot)
  chrome.tabs.onAttached.addListener(requestSnapshot)
  chrome.tabs.onDetached.addListener(requestSnapshot)
  chrome.tabGroups.onCreated.addListener(requestSnapshot)
  chrome.tabGroups.onUpdated.addListener(requestSnapshot)
  chrome.tabGroups.onMoved.addListener(requestSnapshot)
  chrome.tabGroups.onRemoved.addListener(requestSnapshot)
  chrome.tabGroups.onRemoved.addListener((group) => {
    void forgetTabKeepManagedGroup(group.id)
  })
  chrome.runtime.onStartup.addListener(() => {
    if (!bridgeActive) return
    void connectBridge()
    scheduleSnapshot()
  })
  chrome.runtime.onInstalled.addListener(() => {
    if (bridgeActive) void connectBridge()
  })
  chrome.alarms.create("tabGroupArchiveReconnect", { periodInMinutes: 0.5 })
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (bridgeActive && alarm.name === "tabGroupArchiveReconnect") void connectBridge()
  })
}

export function activateTabGroupArchiveBridge(): void {
  bridgeActive = true
  void connectBridge()
  scheduleSnapshot()
}
