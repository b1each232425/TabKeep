import { invoke } from "@tauri-apps/api/core"

import type { DesktopStatus } from "../types"
import { generateToken } from "../utils"

export const DESKTOP_URL = "http://127.0.0.1:38472"

const BROWSER_API_BASE_URL_KEY = "tabkeep.eval.apiBaseUrl"
const BROWSER_API_TOKEN_KEY = "tabkeep.eval.apiToken"
const importMetaEnv = (import.meta as ImportMeta & {
  env?: Record<string, string | boolean | undefined>
}).env
const DEFAULT_BROWSER_API_BASE_URL =
  typeof importMetaEnv?.VITE_TABKEEP_API_BASE_URL === "string"
    ? importMetaEnv.VITE_TABKEEP_API_BASE_URL
    : "http://127.0.0.1:38471"

interface BackendResponse<T> {
  status: number
  ok: boolean
  data: T
}

interface DesktopHttpResponse<T> {
  ok: boolean
  error?: string
  config?: T
}

export class BackendRequestError extends Error {
  status?: number
  data?: unknown

  constructor(message: string, status?: number, data?: unknown) {
    super(message)
    this.name = "BackendRequestError"
    this.status = status
    this.data = data
  }
}

export async function getDesktopStatus(): Promise<DesktopStatus> {
  return invoke<DesktopStatus>("get_desktop_status")
}

export async function getCachedApiToken(): Promise<string | null> {
  return invoke<string | null>("get_cached_api_token")
}

export async function setCachedApiToken(token: string): Promise<void> {
  await invoke("set_cached_api_token", { token })
}

export async function clearCachedApiToken(): Promise<void> {
  await invoke("clear_cached_api_token")
}

export async function ensureDesktopApiToken(): Promise<string> {
  const cached = await getCachedApiToken()
  if (cached) return cached
  const token = generateToken()
  await setCachedApiToken(token)
  return token
}

export async function backendRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  if (!isTauriRuntime()) {
    return browserBackendRequest<T>(method, path, body)
  }
  const res = await invoke<BackendResponse<T>>("backend_request", {
    method,
    path,
    body: body ?? null,
  })
  if (!res.ok) {
    const detail = extractErrorMessage(res.data) ?? `HTTP ${res.status}`
    throw new BackendRequestError(detail, res.status, res.data)
  }
  return res.data
}

export function getBrowserApiBaseUrl(): string {
  if (typeof localStorage === "undefined") return DEFAULT_BROWSER_API_BASE_URL
  return localStorage.getItem(BROWSER_API_BASE_URL_KEY)?.trim() || DEFAULT_BROWSER_API_BASE_URL
}

export function setBrowserApiBaseUrl(value: string): void {
  if (typeof localStorage === "undefined") return
  const clean = value.trim().replace(/\/+$/, "")
  if (clean) {
    localStorage.setItem(BROWSER_API_BASE_URL_KEY, clean)
  } else {
    localStorage.removeItem(BROWSER_API_BASE_URL_KEY)
  }
}

export function getBrowserApiToken(): string {
  if (typeof localStorage === "undefined") return ""
  return localStorage.getItem(BROWSER_API_TOKEN_KEY) ?? ""
}

export function setBrowserApiToken(value: string): void {
  if (typeof localStorage === "undefined") return
  const clean = value.trim()
  if (clean) {
    localStorage.setItem(BROWSER_API_TOKEN_KEY, clean)
  } else {
    localStorage.removeItem(BROWSER_API_TOKEN_KEY)
  }
}

export async function checkBackendHealth(): Promise<boolean> {
  try {
    await backendRequest("GET", "/")
    return true
  } catch {
    return false
  }
}

export async function openExternalTarget(target: string): Promise<void> {
  await invoke("open_external_target", { target })
}

export function extractErrorMessage(data: unknown): string | null {
  if (!data || typeof data !== "object") return null
  const record = data as Record<string, unknown>
  const detail = record.detail ?? record.error
  if (typeof detail === "string") return detail
  return null
}

export async function desktopHttpRequest<T>(
  method: "GET" | "POST",
  path: "/region/open" | "/region/close" | "/region/config",
): Promise<T> {
  const res = await fetch(`${DESKTOP_URL}${path}`, { method })
  const data = (await res.json()) as DesktopHttpResponse<T>
  if (!res.ok || !data.ok) {
    throw new BackendRequestError(data.error ?? `HTTP ${res.status}`, res.status, data)
  }
  return data.config as T
}

export function formatUnknownError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

async function browserBackendRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  if (!path.startsWith("/") || path.includes("://")) {
    throw new BackendRequestError("非法后端路径")
  }
  const headers: Record<string, string> = {}
  if (body !== undefined && body !== null) headers["Content-Type"] = "application/json"
  const token = getBrowserApiToken()
  if (token && path !== "/") headers["X-TabKeep-Token"] = token
  const res = await fetch(`${getBrowserApiBaseUrl()}${path}`, {
    method,
    headers,
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
  })
  const data = await readJsonResponse<T>(res)
  if (!res.ok) {
    const detail = extractErrorMessage(data) ?? `HTTP ${res.status}`
    throw new BackendRequestError(detail, res.status, data)
  }
  return data
}

async function readJsonResponse<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T
  } catch (err) {
    return { detail: `后端返回非 JSON: ${err instanceof Error ? err.message : String(err)}` } as T
  }
}
