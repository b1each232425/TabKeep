// Extension-side API constants and helpers.
//
// Keep backend URLs and auth header construction in one place so popup,
// options, and background use the same endpoints.

export const FASTAPI_URL = "http://127.0.0.1:38471"
export const DESKTOP_URL = "http://127.0.0.1:38472"
export const API_TOKEN_STORAGE_KEY = "tabkeepApiToken"

export type CaptureMode = "link" | "full" | "summary"

export interface DesktopCapturePayload {
  source: "tabkeep"
  mode: CaptureMode
  title: string
  url: string
  contentMarkdown?: string
  excerpt?: string
  favIconUrl?: string
  capturedAt: string
  notebookId?: string
  targetDoc?: string | null
}

export interface DesktopTranslatePayload {
  text: string
  sourceLang?: string
  targetLang?: string
  context?: string
}

export interface DesktopTranslateResponse {
  ok: boolean
  text?: string
  translatedText?: string
  sourceLang?: string
  targetLang?: string
  model?: string
  error?: string
  phase?: "ocr" | "translate" | "done" | "error" | null
  message?: string | null
  detail?: string
}

export type DesktopOcrProvider = "windows_ocr" | "paddleocr_json"

export interface DesktopOcrPayload {
  screenshot?: boolean
  provider?: DesktopOcrProvider
  sourceLang?: string
  targetLang?: string
}

export interface DesktopOcrResponse {
  ok: boolean
  text?: string
  provider?: DesktopOcrProvider
  imagePath?: string
  translatedText?: string
  model?: string
  error?: string
  detail?: string
}

function generateToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

export async function getApiToken(): Promise<string> {
  const stored = await chrome.storage.local.get(API_TOKEN_STORAGE_KEY)
  return typeof stored[API_TOKEN_STORAGE_KEY] === "string"
    ? stored[API_TOKEN_STORAGE_KEY]
    : ""
}

export async function setApiToken(token: string): Promise<void> {
  await chrome.storage.local.set({ [API_TOKEN_STORAGE_KEY]: token })
}

export async function ensureApiToken(): Promise<string> {
  const existing = await getApiToken()
  if (existing) return existing
  const token = generateToken()
  await setApiToken(token)
  return token
}

export async function apiHeaders(extra?: HeadersInit): Promise<HeadersInit> {
  const token = await ensureApiToken()
  return {
    "Content-Type": "application/json",
    "X-TabKeep-Token": token,
    ...(extra ?? {}),
  }
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = await apiHeaders(init.headers)
  return fetch(`${FASTAPI_URL}${path}`, { ...init, headers })
}

export async function checkBackendHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${FASTAPI_URL}/`, { method: "GET" })
    return res.ok
  } catch {
    return false
  }
}

export async function desktopFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = await apiHeaders(init.headers)
  return fetch(`${DESKTOP_URL}${path}`, { ...init, headers })
}

export async function checkDesktopHealth(): Promise<boolean> {
  try {
    const res = await desktopFetch("/health", { method: "GET" })
    return res.ok
  } catch {
    return false
  }
}

export async function captureWithDesktop(payload: DesktopCapturePayload): Promise<boolean> {
  try {
    const health = await desktopFetch("/health", { method: "GET" })
    if (!health.ok) return false
    const res = await desktopFetch("/capture", {
      method: "POST",
      body: JSON.stringify(payload),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function translateWithDesktop(
  payload: DesktopTranslatePayload,
  endpoint: "/translate" | "/input_translate" | "/selection_translate" = "/translate",
): Promise<DesktopTranslateResponse> {
  const res = await desktopFetch(endpoint, {
    method: "POST",
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as DesktopTranslateResponse
  if (!res.ok || !data.ok) {
    return {
      ...data,
      ok: false,
      error: data.error || data.detail || `桌面端翻译失败: HTTP ${res.status}`,
    }
  }
  return data
}

export async function ocrWithDesktop(
  payload: DesktopOcrPayload,
  endpoint: "/ocr_recognize" | "/ocr_translate",
): Promise<DesktopOcrResponse> {
  const res = await desktopFetch(endpoint, {
    method: "POST",
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as DesktopOcrResponse
  if (!res.ok || !data.ok) {
    return {
      ...data,
      ok: false,
      error: data.error || data.detail || `桌面端 OCR 失败: HTTP ${res.status}`,
    }
  }
  return data
}
