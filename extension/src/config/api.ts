// Extension-side API constants and helpers.
//
// Keep backend URLs and auth header construction in one place so popup,
// options, and background use the same endpoints.

export const FASTAPI_URL = "http://127.0.0.1:38471"
export const TAURI_URL = "http://127.0.0.1:38472"
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

export async function captureWithDesktop(payload: DesktopCapturePayload): Promise<boolean> {
  try {
    const health = await fetch(`${TAURI_URL}/health`, { method: "GET" })
    if (!health.ok) return false
    const res = await fetch(`${TAURI_URL}/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    return res.ok
  } catch {
    return false
  }
}
