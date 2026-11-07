import { apiFetch } from "../config/api"

const STATE_KEY = "tabkeepBrowserHistorySync"
const CLIENT_ID_KEY = "tabkeepBrowserHistoryClientId"
const ALARM_NAME = "syncBrowserHistory"
const INITIAL_DAYS = 90
const BACKFILL_WINDOW_DAYS = 7
const QUERY_RESULT_LIMIT = 50_000
const VISIT_BATCH_SIZE = 100
const URL_CONCURRENCY = 6
const ALARM_PERIOD_MINUTES = 5

export interface BrowserHistorySyncState {
  enabled: boolean
  syncing: boolean
  initialImportCompleted: boolean
  lastSyncedAt: string | null
  lastImportedCount: number
  progressVisits: number
  lastError: string | null
}

export interface BrowserHistorySyncStatus extends BrowserHistorySyncState {
  permissionGranted: boolean
}

interface BrowserHistoryVisitPayload {
  clientId: string
  visitId: string
  url: string
  title: string
  visitedAt: string
  transition: string
}

const DEFAULT_STATE: BrowserHistorySyncState = {
  enabled: false,
  syncing: false,
  initialImportCompleted: false,
  lastSyncedAt: null,
  lastImportedCount: 0,
  progressVisits: 0,
  lastError: null,
}

let syncRunning = false
let syncGeneration = 0
let activeAbortController: AbortController | null = null

async function readState(): Promise<BrowserHistorySyncState> {
  const stored = await chrome.storage.local.get(STATE_KEY)
  const value = stored[STATE_KEY]
  return value && typeof value === "object"
    ? { ...DEFAULT_STATE, ...(value as Partial<BrowserHistorySyncState>) }
    : { ...DEFAULT_STATE }
}

async function writeState(state: BrowserHistorySyncState): Promise<void> {
  await chrome.storage.local.set({ [STATE_KEY]: state })
}

async function getClientId(): Promise<string> {
  const stored = await chrome.storage.local.get(CLIENT_ID_KEY)
  const existing = stored[CLIENT_ID_KEY]
  if (typeof existing === "string" && /^[a-f0-9]{32}$/.test(existing)) return existing
  const clientId = crypto.randomUUID().replaceAll("-", "").toLowerCase()
  await chrome.storage.local.set({ [CLIENT_ID_KEY]: clientId })
  return clientId
}

export async function getBrowserHistorySyncStatus(): Promise<BrowserHistorySyncStatus> {
  const [state, permissionGranted] = await Promise.all([
    readState(),
    chrome.permissions.contains({ permissions: ["history"] }),
  ])
  return { ...state, permissionGranted }
}

export async function enableBrowserHistorySync(): Promise<BrowserHistorySyncStatus> {
  const permissionGranted = await chrome.permissions.contains({ permissions: ["history"] })
  if (!permissionGranted) {
    throw new Error("尚未授予浏览历史读取权限")
  }
  const state = await readState()
  await getClientId()
  await writeState({ ...state, enabled: true, syncing: false, lastError: null })
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 1,
    periodInMinutes: ALARM_PERIOD_MINUTES,
  })
  return getBrowserHistorySyncStatus()
}

export async function disableBrowserHistorySync(): Promise<BrowserHistorySyncStatus> {
  syncGeneration += 1
  activeAbortController?.abort()
  const state = await readState()
  await writeState({ ...state, enabled: false, syncing: false, lastError: null })
  await chrome.alarms.clear(ALARM_NAME)
  await chrome.permissions.remove({ permissions: ["history"] })
  return getBrowserHistorySyncStatus()
}

export async function restoreBrowserHistorySyncAlarm(): Promise<void> {
  const [state, permissionGranted] = await Promise.all([
    readState(),
    chrome.permissions.contains({ permissions: ["history"] }),
  ])
  if (state.enabled && permissionGranted) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES })
  }
}

async function postVisitBatch(visits: BrowserHistoryVisitPayload[]): Promise<number> {
  if (visits.length === 0) return 0
  const response = await apiFetch("/news/interests/history-visits", {
    method: "POST",
    body: JSON.stringify({ visits }),
    signal: activeAbortController?.signal,
  })
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("TabKeep 本机服务拒绝了请求，请重新打开 TabKeep 后重试")
    }
    if (response.status >= 500) {
      throw new Error("TabKeep 本机服务暂时不可用，稍后会自动重试")
    }
    throw new Error(`浏览历史同步失败（HTTP ${response.status}）`)
  }
  const result = (await response.json()) as { accepted?: number }
  return typeof result.accepted === "number" ? result.accepted : 0
}

async function collectRange(
  rangeStart: number,
  rangeEnd: number,
  clientId: string,
  seenVisitIds: Set<string>,
  enqueue: (visit: BrowserHistoryVisitPayload) => Promise<void>,
  shouldCancel: () => boolean,
): Promise<void> {
  if (shouldCancel()) return
  const pages = await chrome.history.search({
    text: "",
    startTime: rangeStart,
    endTime: rangeEnd,
    maxResults: QUERY_RESULT_LIMIT,
  })
  if (pages.length >= QUERY_RESULT_LIMIT) {
    const midpoint = Math.floor((rangeStart + rangeEnd) / 2)
    if (midpoint <= rangeStart || rangeEnd - rangeStart < 60_000) {
      throw new Error("浏览历史范围过大，当前时间段无法完整读取")
    }
    await collectRange(rangeStart, midpoint, clientId, seenVisitIds, enqueue, shouldCancel)
    await collectRange(midpoint, rangeEnd, clientId, seenVisitIds, enqueue, shouldCancel)
    return
  }

  let pageIndex = 0
  while (pageIndex < pages.length && !shouldCancel()) {
    const batch = pages.slice(pageIndex, pageIndex + URL_CONCURRENCY)
    pageIndex += batch.length
    await Promise.all(batch.map(async (page) => {
      if (shouldCancel()) return
      const url = page.url
      if (!url || url.length > 4096 || !/^https?:\/\//i.test(url)) return
      const visits = await chrome.history.getVisits({ url })
      if (shouldCancel()) return
      for (const visit of visits) {
        const visitedAt = visit.visitTime
        if (visitedAt === undefined || visitedAt < rangeStart || visitedAt > rangeEnd) continue
        if (visit.transition === "auto_subframe" || visit.transition === "manual_subframe") continue
        if (seenVisitIds.has(visit.visitId)) continue
        seenVisitIds.add(visit.visitId)
        await enqueue({
          clientId,
          visitId: visit.visitId,
          url,
          title: (page.title ?? "").slice(0, 500),
          visitedAt: new Date(visitedAt).toISOString(),
          transition: visit.transition || "unknown",
        })
      }
    }))
  }
}

export async function runBrowserHistorySync(): Promise<void> {
  if (syncRunning) return
  syncRunning = true
  const generation = syncGeneration
  const abortController = new AbortController()
  activeAbortController = abortController
  let state = { ...DEFAULT_STATE }
  try {
    state = await readState()
    if (!state.enabled) return
    const permissionGranted = await chrome.permissions.contains({ permissions: ["history"] })
    if (!permissionGranted) {
      state = { ...state, enabled: false, syncing: false, lastError: "浏览历史权限已撤销，请重新授权" }
      await writeState(state)
      await chrome.alarms.clear(ALARM_NAME)
      return
    }

    const endTime = Date.now()
    const initialImport = state.lastSyncedAt === null
    const rangeStart = initialImport
      ? endTime - INITIAL_DAYS * 24 * 60 * 60 * 1000
      : Math.max(0, Date.parse(state.lastSyncedAt!) - 60_000)
    const clientId = await getClientId()
    const seenVisitIds = new Set<string>()
    let queuedVisits = 0
    let acceptedVisits = 0
    let pending: BrowserHistoryVisitPayload[] = []
    let flushChain = Promise.resolve()

    const flush = () => {
      if (pending.length === 0) return flushChain
      const batch = pending
      pending = []
      flushChain = flushChain.then(async () => {
        acceptedVisits += await postVisitBatch(batch)
      })
      return flushChain
    }

    const enqueue = async (visit: BrowserHistoryVisitPayload) => {
      if (generation !== syncGeneration) return
      pending.push(visit)
      queuedVisits += 1
      if (pending.length >= VISIT_BATCH_SIZE) await flush()
    }

    state = { ...state, syncing: true, progressVisits: 0, lastError: null }
    await writeState(state)

    const backfillWindowMs = BACKFILL_WINDOW_DAYS * 24 * 60 * 60 * 1000
    for (let cursor = rangeStart; cursor < endTime; cursor += backfillWindowMs) {
      if (generation !== syncGeneration) return
      await collectRange(
        cursor,
        Math.min(cursor + backfillWindowMs, endTime),
        clientId,
        seenVisitIds,
        enqueue,
        () => generation !== syncGeneration,
      )
      await flush()
      if (generation !== syncGeneration) return
      state = { ...state, progressVisits: queuedVisits }
      await writeState(state)
    }
    await flushChain
    state = {
      ...state,
      syncing: false,
      initialImportCompleted: true,
      lastSyncedAt: new Date(endTime).toISOString(),
      lastImportedCount: acceptedVisits,
      progressVisits: queuedVisits,
      lastError: null,
    }
    await writeState(state)
  } catch (error) {
    if (generation === syncGeneration) {
      state = {
        ...state,
        syncing: false,
        lastError: error instanceof Error ? error.message : "浏览历史同步失败，稍后会自动重试",
      }
      await writeState(state)
    }
  } finally {
    if (activeAbortController === abortController) activeAbortController = null
    syncRunning = false
  }
}
