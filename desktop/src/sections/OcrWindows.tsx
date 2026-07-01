import { useEffect, useMemo, useRef, useState } from "react"
import type { MouseEvent } from "react"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { Clipboard, Copy, Keyboard, Languages, MousePointer2, Move, X } from "lucide-react"

import {
  DEFAULT_REGION_BOX_CONFIG,
  cancelScreenSelection,
  closeRegionBox,
  finishScreenSelection,
  getLatestOcrResult,
  getLatestSelectionTranslateResult,
  getRegionBoxConfig,
  runRegionTranslate,
  setRegionBoxConfig,
  setRegionBoxPassthrough,
} from "../api"
import type { OcrFlowResult, RegionBoxConfig, SelectionTranslateResult } from "../types"
import { Button, Notice } from "../components/primitives"
import { errorMessage } from "../lib/errors"
import { formatTranslationForPanel } from "../lib/ocr"
import tabkeepIcon from "../assets/tabkeep-icon.png"

type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West"

export function CaptureOverlay() {
  const [drag, setDrag] = useState<{
    startX: number
    startY: number
    currentX: number
    currentY: number
  } | null>(null)
  const [notice, setNotice] = useState("拖拽框选区域，Esc 取消")
  const finishingRef = useRef(false)

  useEffect(() => {
    const previousHtmlBg = document.documentElement.style.background
    const previousBodyBg = document.body.style.background
    document.documentElement.style.background = "transparent"
    document.body.style.background = "transparent"

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        finishingRef.current = true
        cancelScreenSelection().catch(() => undefined)
      }
    }
    window.addEventListener("keydown", handleKey)
    return () => {
      window.removeEventListener("keydown", handleKey)
      document.documentElement.style.background = previousHtmlBg
      document.body.style.background = previousBodyBg
    }
  }, [])

  const selection = useMemo(() => {
    if (!drag) return null
    const x = Math.min(drag.startX, drag.currentX)
    const y = Math.min(drag.startY, drag.currentY)
    const width = Math.abs(drag.currentX - drag.startX)
    const height = Math.abs(drag.currentY - drag.startY)
    return { x, y, width, height }
  }, [drag])

  const finish = async () => {
    if (!selection || finishingRef.current) return
    if (selection.width < 8 || selection.height < 8) {
      setNotice("选区太小，请重新框选")
      setDrag(null)
      return
    }
    finishingRef.current = true
    setNotice("正在识别...")
    try {
      await finishScreenSelection({
        ...selection,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      })
    } catch (err) {
      finishingRef.current = false
      setNotice(errorMessage(err))
    }
  }

  return (
    <div
      className="tk-capture-root"
      onMouseDown={(event) => {
        if (event.button !== 0 || finishingRef.current) return
        setDrag({
          startX: event.clientX,
          startY: event.clientY,
          currentX: event.clientX,
          currentY: event.clientY,
        })
      }}
      onMouseMove={(event) => {
        if (!drag || finishingRef.current) return
        setDrag({
          ...drag,
          currentX: event.clientX,
          currentY: event.clientY,
        })
      }}
      onMouseUp={finish}>
      <div className="tk-capture-hint">{notice}</div>
      {selection && (
        <div
          className="tk-capture-selection"
          style={{
            left: selection.x,
            top: selection.y,
            width: selection.width,
            height: selection.height,
          }}
        />
      )}
    </div>
  )
}

export function OcrResultWindow() {
  const [result, setResult] = useState<OcrFlowResult | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let unlisten: (() => void) | undefined
    getLatestOcrResult()
      .then(setResult)
      .catch((err) => setNotice(errorMessage(err)))
    listen<OcrFlowResult>("ocr-result-updated", (event) => {
      setResult(event.payload)
      setNotice(event.payload.message ?? null)
    }).then((value) => {
      unlisten = value
    })
    return () => {
      unlisten?.()
    }
  }, [])

  const copy = async (value?: string | null) => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setNotice("已复制")
    } catch (err) {
      setNotice(`复制失败: ${errorMessage(err)}`)
    }
  }

  const providerLabel = result?.provider === "paddleocr_json" ? "PaddleOCR-json" : "Windows OCR"

  return (
    <div className="tk-result-shell">
      <header className="tk-result-header">
        <div>
          <h1 className="tk-page-title">OCR 结果</h1>
          <p className="tk-page-subtitle">{result ? providerLabel : "等待截图结果"}</p>
        </div>
        {result && (
          <span className={`tk-badge ${result.ok ? "tk-badge-success" : "tk-badge-warning"}`}>
            {result.phase === "translate" ? "翻译中" : result.ok ? "完成" : "需处理"}
          </span>
        )}
      </header>

      {notice && <Notice tone="neutral">{notice}</Notice>}
      {result?.error && <Notice tone="warning">{result.error}</Notice>}

      {result?.imageDataUrl && (
        <section className="tk-result-image-wrap">
          <img className="tk-result-image" src={result.imageDataUrl} alt="OCR selection" />
        </section>
      )}

      <section className="tk-panel">
        <div className="tk-panel-header">
          <h2 className="tk-panel-title">识别文本</h2>
          <button className="tk-icon-button" onClick={() => copy(result?.text)} title="复制识别文本">
            <Copy className="h-4 w-4" />
          </button>
        </div>
        <div className="tk-panel-body">
          <pre className="tk-result-text">{result?.text || "暂无识别文本"}</pre>
        </div>
      </section>

      {(result?.translatedText || result?.model || result?.phase === "translate" || (result?.error && result?.text)) && (
        <section className="tk-panel">
          <div className="tk-panel-header">
            <h2 className="tk-panel-title">译文{result.model ? ` · ${result.model}` : ""}</h2>
            <button
              className="tk-icon-button"
              onClick={() => copy(result.translatedText)}
              title="复制译文">
              <Copy className="h-4 w-4" />
            </button>
          </div>
          <div className="tk-panel-body">
            <pre
              className={`tk-result-text tk-result-translation ${
                result.error && !result.translatedText ? "tk-region-result-error" : ""
              }`}>
              {result.translatedText ||
                (result.phase === "translate"
                  ? "正在翻译..."
                  : result.error
                    ? `翻译失败: ${result.error}`
                    : "暂无译文")}
            </pre>
          </div>
        </section>
      )}
    </div>
  )
}

export function RegionBoxWindow() {
  const [config, setConfig] = useState<RegionBoxConfig>(DEFAULT_REGION_BOX_CONFIG)
  const configRef = useRef(config)

  useEffect(() => {
    configRef.current = config
  }, [config])

  useEffect(() => {
    const previousHtmlBg = document.documentElement.style.background
    const previousBodyBg = document.body.style.background
    const root = document.getElementById("root")
    document.documentElement.style.background = "transparent"
    document.body.style.background = "transparent"
    document.documentElement.classList.add("tk-region-window-root")
    document.body.classList.add("tk-region-window-root")
    root?.classList.add("tk-region-window-root")

    const currentWindow = getCurrentWindow()
    let timer: number | undefined
    let unlistenMoved: (() => void) | undefined
    let unlistenResized: (() => void) | undefined
    let unlistenConfig: (() => void) | undefined

    const syncGeometry = () => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(async () => {
        try {
          const [position, size] = await Promise.all([
            currentWindow.outerPosition(),
            currentWindow.outerSize(),
          ])
          const next = await setRegionBoxConfig({
            ...configRef.current,
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
          })
          configRef.current = next
          setConfig(next)
        } catch {
          // Window move/resize events can fire while the window is being closed.
        }
      }, 140)
    }

    getRegionBoxConfig().then((value) => {
      configRef.current = value
      setConfig(value)
    })
    currentWindow.onMoved(syncGeometry).then((value) => {
      unlistenMoved = value
    })
    currentWindow.onResized(syncGeometry).then((value) => {
      unlistenResized = value
    })
    listen<RegionBoxConfig>("region-config-updated", (event) => {
      configRef.current = event.payload
      setConfig(event.payload)
    }).then((value) => {
      unlistenConfig = value
    })
    return () => {
      if (timer) window.clearTimeout(timer)
      unlistenMoved?.()
      unlistenResized?.()
      unlistenConfig?.()
      document.documentElement.style.background = previousHtmlBg
      document.body.style.background = previousBodyBg
      document.documentElement.classList.remove("tk-region-window-root")
      document.body.classList.remove("tk-region-window-root")
      root?.classList.remove("tk-region-window-root")
    }
  }, [])

  const startDrag = async () => {
    if (config.passThrough) return
    try {
      await getCurrentWindow().startDragging()
    } catch {
      // Native dragging can be rejected if the pointer is already released.
    }
  }

  const startResize = async (direction: ResizeDirection) => {
    if (config.passThrough) return
    try {
      await getCurrentWindow().startResizeDragging(direction)
    } catch {
      // Same as dragging: a missed native resize is harmless.
    }
  }

  const handles: { direction: ResizeDirection; className: string }[] = [
    { direction: "North", className: "tk-region-handle-n" },
    { direction: "South", className: "tk-region-handle-s" },
    { direction: "West", className: "tk-region-handle-w" },
    { direction: "East", className: "tk-region-handle-e" },
    { direction: "NorthWest", className: "tk-region-handle-nw" },
    { direction: "NorthEast", className: "tk-region-handle-ne" },
    { direction: "SouthWest", className: "tk-region-handle-sw" },
    { direction: "SouthEast", className: "tk-region-handle-se" },
  ]

  const frameStyle = config.passThrough
    ? {
        borderColor: "rgba(52, 211, 153, 0.9)",
        background: "transparent",
        boxShadow:
          "0 0 0 1px rgba(255, 255, 255, 0.38) inset, 0 0 18px rgba(16, 185, 129, 0.26)",
      }
    : {
        borderColor: "rgba(16, 185, 129, 0.98)",
        background: "transparent",
        boxShadow:
          "0 0 0 1px rgba(255, 255, 255, 0.85) inset, 0 0 0 9999px rgba(15, 23, 42, 0.025), 0 10px 28px rgba(15, 23, 42, 0.18)",
      }

  return (
    <div
      className={`tk-region-box ${config.passThrough ? "tk-region-box-passthrough" : ""}`}
      style={frameStyle}>
      {!config.passThrough && <div className="tk-region-drag-surface" onMouseDown={startDrag} />}
      <img className="tk-region-corner-brand" src={tabkeepIcon} alt="" aria-hidden="true" />
      {!config.passThrough &&
        handles.map((handle) => (
          <button
            key={handle.direction}
            className={`tk-region-handle ${handle.className}`}
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
              startResize(handle.direction)
            }}
            title="调整区域"
          />
        ))}
    </div>
  )
}

export function RegionPanelWindow() {
  const [result, setResult] = useState<OcrFlowResult | null>(null)
  const [config, setConfig] = useState<RegionBoxConfig>(DEFAULT_REGION_BOX_CONFIG)
  const [busy, setBusy] = useState<"translate" | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const configRef = useRef(config)
  const languageOptions = ["auto", "简体中文", "English", "日本語", "한국어", "Français", "Deutsch"]

  useEffect(() => {
    configRef.current = config
  }, [config])

  useEffect(() => {
    const previousHtmlBg = document.documentElement.style.background
    const previousBodyBg = document.body.style.background
    const root = document.getElementById("root")
    document.documentElement.style.background = "transparent"
    document.body.style.background = "transparent"
    document.documentElement.classList.add("tk-region-panel-window-root")
    document.body.classList.add("tk-region-panel-window-root")
    root?.classList.add("tk-region-panel-window-root")

    return () => {
      document.documentElement.style.background = previousHtmlBg
      document.body.style.background = previousBodyBg
      document.documentElement.classList.remove("tk-region-panel-window-root")
      document.body.classList.remove("tk-region-panel-window-root")
      root?.classList.remove("tk-region-panel-window-root")
    }
  }, [])

  useEffect(() => {
    let unlistenResult: (() => void) | undefined
    let unlistenConfig: (() => void) | undefined
    let unlistenMoved: (() => void) | undefined
    let unlistenResized: (() => void) | undefined
    let geometryTimer: number | undefined
    const currentWindow = getCurrentWindow()

    const syncPanelGeometry = () => {
      if (geometryTimer) window.clearTimeout(geometryTimer)
      geometryTimer = window.setTimeout(async () => {
        try {
          const [position, size] = await Promise.all([
            currentWindow.outerPosition(),
            currentWindow.innerSize(),
          ])
          const current = configRef.current
          if (
            current.panelX === position.x &&
            current.panelY === position.y &&
            current.panelWidth === size.width &&
            current.panelHeight === size.height
          ) {
            return
          }
          const next = await setRegionBoxConfig({
            ...current,
            panelX: position.x,
            panelY: position.y,
            panelWidth: size.width,
            panelHeight: size.height,
          })
          configRef.current = next
          setConfig(next)
        } catch {
          // Resize/move events may fire while the panel is closing.
        }
      }, 140)
    }

    getRegionBoxConfig().then((value) => {
      configRef.current = value
      setConfig(value)
    })
    currentWindow.onMoved(syncPanelGeometry).then((value) => {
      unlistenMoved = value
    })
    currentWindow.onResized(syncPanelGeometry).then((value) => {
      unlistenResized = value
    })
    listen<RegionBoxConfig>("region-config-updated", (event) => {
      configRef.current = event.payload
      setConfig(event.payload)
    }).then((value) => {
      unlistenConfig = value
    })
    listen<OcrFlowResult>("region-result-updated", (event) => {
      setResult(event.payload)
      setNotice(event.payload.message ?? (event.payload.ok ? "完成" : event.payload.error ?? "未完成"))
      if (event.payload.phase !== "translate") {
        setBusy(null)
      }
    }).then((value) => {
      unlistenResult = value
    })
    return () => {
      if (geometryTimer) window.clearTimeout(geometryTimer)
      unlistenMoved?.()
      unlistenResized?.()
      unlistenConfig?.()
      unlistenResult?.()
    }
  }, [])

  const copy = async (value?: string | null) => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setNotice("已复制")
    } catch (err) {
      setNotice(`复制失败: ${errorMessage(err)}`)
    }
  }

  const close = async () => {
    try {
      await closeRegionBox()
    } catch (err) {
      setNotice(errorMessage(err))
    }
  }

  const updateConfig = async (partial: Partial<RegionBoxConfig>) => {
    try {
      const next = await setRegionBoxConfig({ ...configRef.current, ...partial })
      configRef.current = next
      setConfig(next)
    } catch (err) {
      setNotice(errorMessage(err))
    }
  }

  const togglePassthrough = async () => {
    try {
      const next = await setRegionBoxPassthrough(!configRef.current.passThrough)
      configRef.current = next
      setConfig(next)
      setNotice(next.passThrough ? "内容区域已穿透，按钮仍可使用" : "已回到编辑模式")
    } catch (err) {
      setNotice(errorMessage(err))
    }
  }

  const runTranslate = async () => {
    setBusy("translate")
    setNotice("正在识别并翻译区域...")
    try {
      const value = await runRegionTranslate()
      setResult(value)
      setNotice(value.message ?? (value.ok ? "翻译完成" : value.error ?? "翻译未完成"))
    } catch (err) {
      setNotice(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const startPanelDrag = async (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest("button, input, select, textarea, a")) return
    try {
      await getCurrentWindow().startDragging()
    } catch (err) {
      setNotice(errorMessage(err))
    }
  }

  const startPanelResize = async (direction: ResizeDirection) => {
    try {
      await getCurrentWindow().startResizeDragging(direction)
    } catch (err) {
      setNotice(errorMessage(err))
    }
  }

  const panelResizeHandles: { direction: ResizeDirection; className: string }[] = [
    { direction: "North", className: "tk-region-panel-resize-n" },
    { direction: "South", className: "tk-region-panel-resize-s" },
    { direction: "West", className: "tk-region-panel-resize-w" },
    { direction: "East", className: "tk-region-panel-resize-e" },
    { direction: "NorthWest", className: "tk-region-panel-resize-nw" },
    { direction: "NorthEast", className: "tk-region-panel-resize-ne" },
    { direction: "SouthWest", className: "tk-region-panel-resize-sw" },
    { direction: "SouthEast", className: "tk-region-panel-resize-se" },
  ]

  const translationText =
    result?.translatedText ||
    (result?.error ? `翻译失败: ${result.error}` : "等待译文")
  const formattedTranslationText = result?.translatedText
    ? formatTranslationForPanel(result.translatedText)
    : translationText

  return (
    <div className="tk-region-panel tk-region-translation-panel tk-region-panel-resizable">
      <div
        className="tk-region-panel-toolbar tk-region-panel-dragbar"
        onMouseDown={startPanelDrag}
        title="按住拖动译文窗口">
        <div className="tk-region-result-title-inline">
          <Languages className="h-4 w-4 text-emerald-700" />
          <span>固定区域翻译{result?.model ? ` · ${result.model}` : ""}</span>
        </div>
        <button
          className="tk-icon-button"
          onClick={() => copy(result?.translatedText)}
          title="复制译文"
          disabled={!result?.translatedText}>
          <Copy className="h-4 w-4" />
        </button>
        <button className="tk-icon-button" onClick={close} title="关闭固定翻译框">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="tk-region-panel-controls">
        <select
          className="tk-select tk-region-select"
          value={config.sourceLang}
          onChange={(event) => updateConfig({ sourceLang: event.target.value })}
          title="源语言">
          <option value="auto">自动</option>
          {languageOptions
            .filter((lang) => lang !== "auto")
            .map((lang) => (
              <option key={lang} value={lang}>
                {lang}
              </option>
            ))}
        </select>
        <select
          className="tk-select tk-region-select"
          value={config.targetLang}
          onChange={(event) => updateConfig({ targetLang: event.target.value })}
          title="目标语言">
          {languageOptions
            .filter((lang) => lang !== "auto")
            .map((lang) => (
              <option key={lang} value={lang}>
                {lang}
              </option>
            ))}
        </select>
        <Button className="h-8" onClick={runTranslate} disabled={busy !== null}>
          <Languages className={`h-4 w-4 ${busy === "translate" ? "animate-pulse" : ""}`} />
          {busy === "translate" ? "翻译中" : "翻译"}
        </Button>
        <Button className="h-8" variant="ghost" onClick={togglePassthrough}>
          <MousePointer2 className="h-4 w-4" />
          {config.passThrough ? "编辑" : "穿透"}
        </Button>
      </div>

      {notice && <div className="tk-region-notice">{notice}</div>}

      <pre
        className={`tk-region-result-text tk-region-result-translation ${
          result && !result.ok && result.error ? "tk-region-result-error" : ""
        }`}>
        {formattedTranslationText}
      </pre>
      {panelResizeHandles.map((handle) => (
        <button
          key={handle.direction}
          className={`tk-region-panel-resize-handle ${handle.className}`}
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
            startPanelResize(handle.direction)
          }}
          title="调整译文框大小"
        />
      ))}
    </div>
  )
}

export function SelectionPanelWindow() {
  const [result, setResult] = useState<SelectionTranslateResult | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    const previousHtmlBg = document.documentElement.style.background
    const previousBodyBg = document.body.style.background
    const root = document.getElementById("root")
    document.documentElement.style.background = "transparent"
    document.body.style.background = "transparent"
    document.documentElement.classList.add("tk-region-panel-window-root")
    document.body.classList.add("tk-region-panel-window-root")
    root?.classList.add("tk-region-panel-window-root")

    return () => {
      document.documentElement.style.background = previousHtmlBg
      document.body.style.background = previousBodyBg
      document.documentElement.classList.remove("tk-region-panel-window-root")
      document.body.classList.remove("tk-region-panel-window-root")
      root?.classList.remove("tk-region-panel-window-root")
    }
  }, [])

  useEffect(() => {
    let unlistenResult: (() => void) | undefined
    getLatestSelectionTranslateResult()
      .then((value) => {
        if (value) {
          setResult(value)
          setNotice(value.message ?? null)
        }
      })
      .catch((err) => setNotice(errorMessage(err)))
    listen<SelectionTranslateResult>("selection-result-updated", (event) => {
      setResult(event.payload)
      setNotice(
        event.payload.message ??
          (event.payload.ok ? "完成" : event.payload.error ?? "未完成"),
      )
    }).then((value) => {
      unlistenResult = value
    })
    return () => {
      unlistenResult?.()
    }
  }, [])

  const copy = async (value?: string | null) => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setNotice("已复制")
    } catch (err) {
      setNotice(`复制失败: ${errorMessage(err)}`)
    }
  }

  const close = async () => {
    try {
      await getCurrentWindow().hide()
    } catch (err) {
      setNotice(errorMessage(err))
    }
  }

  const startPanelDrag = async (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest("button, input, select, textarea, a")) return
    try {
      await getCurrentWindow().startDragging()
    } catch (err) {
      setNotice(errorMessage(err))
    }
  }

  const translationText = result?.translatedText
    ? formatTranslationForPanel(result.translatedText)
    : result?.phase === "copy"
      ? "正在读取选中文本..."
      : result?.phase === "translate"
        ? "正在翻译..."
        : result?.error
          ? `翻译失败: ${result.error}`
          : "等待划词翻译"

  return (
    <div className="tk-region-panel tk-region-translation-panel">
      <div
        className="tk-region-panel-toolbar tk-region-panel-dragbar"
        onMouseDown={startPanelDrag}
        title="按住拖动划词译文窗口">
        <div className="tk-region-result-title-inline">
          <Keyboard className="h-4 w-4 text-emerald-700" />
          <span>划词译文{result?.model ? ` · ${result.model}` : ""}</span>
        </div>
        <button
          className="tk-icon-button"
          onClick={() => copy(result?.translatedText)}
          title="复制译文"
          disabled={!result?.translatedText}>
          <Copy className="h-4 w-4" />
        </button>
        <button className="tk-icon-button" onClick={close} title="关闭译文">
          <X className="h-4 w-4" />
        </button>
      </div>

      {notice && <div className="tk-region-notice">{notice}</div>}

      <pre
        className={`tk-region-result-text tk-region-result-translation ${
          result && !result.ok && result.error ? "tk-region-result-error" : ""
        }`}>
        {translationText}
      </pre>
    </div>
  )
}
