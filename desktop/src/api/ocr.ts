import { invoke } from "@tauri-apps/api/core"

import type {
  OcrConfig,
  OcrDebugResult,
  OcrFlowResult,
  OcrRequest,
  RegionBoxConfig,
  ScreenSelection,
} from "../types"
import {
  BackendRequestError,
  desktopHttpRequest,
  formatUnknownError,
} from "./client"
import {
  DEFAULT_OCR_CONFIG,
  DEFAULT_REGION_BOX_CONFIG,
} from "./defaults"

export async function getOcrConfig(): Promise<OcrConfig> {
  const config = await invoke<OcrConfig>("get_ocr_config")
  return { ...DEFAULT_OCR_CONFIG, ...config }
}

export async function setOcrConfig(config: OcrConfig): Promise<void> {
  await invoke("set_ocr_config", { config })
}

export async function startOcrRecognize(payload: OcrRequest): Promise<OcrFlowResult> {
  return invoke<OcrFlowResult>("start_ocr_recognize", { payload })
}

export async function startOcrTranslate(payload: OcrRequest): Promise<OcrFlowResult> {
  return invoke<OcrFlowResult>("start_ocr_translate", { payload })
}

export async function finishScreenSelection(selection: ScreenSelection): Promise<void> {
  await invoke("finish_screen_selection", { selection })
}

export async function cancelScreenSelection(): Promise<void> {
  await invoke("cancel_screen_selection")
}

export async function getLatestOcrResult(): Promise<OcrFlowResult | null> {
  return invoke<OcrFlowResult | null>("get_latest_ocr_result")
}

export async function debugRegionOcr(): Promise<OcrDebugResult> {
  return invoke<OcrDebugResult>("debug_region_ocr")
}

export async function openRegionBox(): Promise<RegionBoxConfig> {
  try {
    const data = await desktopHttpRequest<RegionBoxConfig>("POST", "/region/open")
    return { ...DEFAULT_REGION_BOX_CONFIG, ...data }
  } catch (httpErr) {
    try {
      const config = await invoke<RegionBoxConfig>("open_region_box")
      return { ...DEFAULT_REGION_BOX_CONFIG, ...config }
    } catch (ipcErr) {
      throw mergeRegionError("打开固定翻译框失败", httpErr, ipcErr)
    }
  }
}

export async function closeRegionBox(): Promise<void> {
  try {
    await desktopHttpRequest<void>("POST", "/region/close")
  } catch (httpErr) {
    try {
      await invoke("close_region_box")
    } catch (ipcErr) {
      throw mergeRegionError("关闭固定翻译框失败", httpErr, ipcErr)
    }
  }
}

export async function getRegionBoxConfig(): Promise<RegionBoxConfig> {
  try {
    const config = await desktopHttpRequest<RegionBoxConfig>("GET", "/region/config")
    return { ...DEFAULT_REGION_BOX_CONFIG, ...config }
  } catch {
    const config = await invoke<RegionBoxConfig>("get_region_box_config")
    return { ...DEFAULT_REGION_BOX_CONFIG, ...config }
  }
}

export async function setRegionBoxConfig(config: RegionBoxConfig): Promise<RegionBoxConfig> {
  const saved = await invoke<RegionBoxConfig>("set_region_box_config", { config })
  return { ...DEFAULT_REGION_BOX_CONFIG, ...saved }
}

export async function setRegionBoxPassthrough(passThrough: boolean): Promise<RegionBoxConfig> {
  const config = await invoke<RegionBoxConfig>("set_region_box_passthrough", { passThrough })
  return { ...DEFAULT_REGION_BOX_CONFIG, ...config }
}

export async function runRegionOcr(): Promise<OcrFlowResult> {
  return invoke<OcrFlowResult>("run_region_ocr")
}

export async function runRegionTranslate(): Promise<OcrFlowResult> {
  return invoke<OcrFlowResult>("run_region_translate")
}

function mergeRegionError(prefix: string, httpErr: unknown, ipcErr: unknown): BackendRequestError {
  return new BackendRequestError(
    `${prefix}: HTTP ${formatUnknownError(httpErr)}; Tauri IPC ${formatUnknownError(ipcErr)}`,
  )
}
