import { invoke } from "@tauri-apps/api/core"

import type {
  SelectionTranslateConfig,
  SelectionTranslateResult,
  TranslateProviderConfig,
  TranslateProviderTestResponse,
  TranslateRequest,
  TranslateResponse,
} from "../types"
import {
  BackendRequestError,
  DESKTOP_URL,
  extractErrorMessage,
  getCachedApiToken,
} from "./client"
import {
  DEFAULT_SELECTION_TRANSLATE_CONFIG,
  DEFAULT_TRANSLATE_PROVIDER_CONFIG,
} from "./defaults"

export async function translateText(
  payload: TranslateRequest,
  endpoint: "/translate" | "/input_translate" | "/selection_translate" = "/translate",
): Promise<TranslateResponse> {
  const token = await getCachedApiToken()
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (token) headers["X-TabKeep-Token"] = token

  const res = await fetch(`${DESKTOP_URL}${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as TranslateResponse
  if (!res.ok || !data.ok) {
    throw new BackendRequestError(extractErrorMessage(data) ?? `HTTP ${res.status}`, res.status, data)
  }
  return data
}

export async function getTranslateProviderConfig(): Promise<TranslateProviderConfig> {
  const config = await invoke<TranslateProviderConfig>("get_translate_provider_config")
  return { ...DEFAULT_TRANSLATE_PROVIDER_CONFIG, ...config }
}

export async function setTranslateProviderConfig(
  config: TranslateProviderConfig,
): Promise<TranslateProviderConfig> {
  const saved = await invoke<TranslateProviderConfig>("set_translate_provider_config", { config })
  return { ...DEFAULT_TRANSLATE_PROVIDER_CONFIG, ...saved }
}

export async function testTranslateProvider(
  config: TranslateProviderConfig,
): Promise<TranslateProviderTestResponse> {
  return invoke<TranslateProviderTestResponse>("test_translate_provider", { config })
}

export async function getSelectionTranslateConfig(): Promise<SelectionTranslateConfig> {
  const config = await invoke<SelectionTranslateConfig>("get_selection_translate_config")
  return { ...DEFAULT_SELECTION_TRANSLATE_CONFIG, ...config }
}

export async function setSelectionTranslateConfig(
  config: SelectionTranslateConfig,
): Promise<SelectionTranslateConfig> {
  const saved = await invoke<SelectionTranslateConfig>("set_selection_translate_config", { config })
  return { ...DEFAULT_SELECTION_TRANSLATE_CONFIG, ...saved }
}

export async function triggerSelectionTranslate(): Promise<SelectionTranslateResult> {
  return invoke<SelectionTranslateResult>("trigger_selection_translate")
}

export async function getLatestSelectionTranslateResult(): Promise<SelectionTranslateResult | null> {
  return invoke<SelectionTranslateResult | null>("get_latest_selection_translate_result")
}
