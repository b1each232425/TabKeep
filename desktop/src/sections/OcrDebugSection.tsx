import { useEffect, useState } from "react"
import { Clipboard, X } from "lucide-react"

import { DEFAULT_OCR_CONFIG, debugRegionOcr, getOcrConfig, openRegionBox, setOcrConfig } from "../api"
import type { OcrConfig, OcrDebugResult, OcrProvider, OcrTextLayoutMode } from "../types"
import { Button, Checkbox, Notice, TextField } from "../components/primitives"
import { errorMessage } from "../lib/errors"
import { OCR_TEXT_LAYOUT_OPTIONS } from "../lib/ocr"

export function OcrDebugSection() {
  const [ocrConfig, setOcrConfigState] = useState<OcrConfig>(DEFAULT_OCR_CONFIG)
  const [result, setResult] = useState<OcrDebugResult | null>(null)
  const [status, setStatus] = useState("打开固定区域框后，运行一次调试即可对比原图和预处理效果")
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    getOcrConfig()
      .then((config) => {
        setOcrConfigState(config)
      })
      .catch((err) => {
        setStatus(`读取 OCR 设置失败: ${errorMessage(err)}`)
      })
      .finally(() => setLoading(false))
  }, [])

  const updateNumber = (
    key: "paddleMinScore" | "preprocessScale" | "preprocessContrast",
    value: string,
    fallback: number,
  ) => {
    const numeric = Number(value)
    setOcrConfigState({
      ...ocrConfig,
      [key]: Number.isFinite(numeric) ? numeric : fallback,
    })
  }

  const saveDebugSettings = async () => {
    setSaving(true)
    try {
      await setOcrConfig(ocrConfig)
      setStatus("调试参数已保存，下一次 OCR 会使用这组设置")
    } catch (err) {
      setStatus(`保存 OCR 设置失败: ${errorMessage(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const runDebug = async () => {
    setRunning(true)
    setStatus("正在捕获固定区域并运行 OCR 调试...")
    try {
      await setOcrConfig(ocrConfig)
      const nextResult = await debugRegionOcr()
      setResult(nextResult)
      const textState = nextResult.text.trim() ? "已识别到文本" : "未识别到文本"
      setStatus(`${textState}，耗时 ${nextResult.elapsedMs} ms`)
    } catch (err) {
      setStatus(`OCR 调试失败: ${errorMessage(err)}`)
    } finally {
      setRunning(false)
    }
  }

  const copyText = async (value: string, label: string) => {
    await navigator.clipboard.writeText(value)
    setStatus(`${label}已复制`)
  }

  const originalSize = result ? `${result.originalWidth} x ${result.originalHeight}` : "--"
  const preprocessedSize = result?.preprocessedWidth && result.preprocessedHeight
    ? `${result.preprocessedWidth} x ${result.preprocessedHeight}`
    : result?.preprocessedImagePath
      ? "已生成"
      : "未启用"

  return (
    <div className="space-y-5">
      <header className="tk-topbar">
        <div>
          <h1 className="tk-page-title">OCR 调试</h1>
          <p className="tk-page-subtitle">对比固定区域原图、预处理图和文本后处理结果</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="secondary" onClick={openRegionBox}>
            打开固定区域框
          </Button>
          <Button onClick={runDebug} disabled={loading || running}>
            {running ? "调试中..." : "运行区域 OCR 调试"}
          </Button>
        </div>
      </header>

      <Notice tone={status.includes("失败") ? "warning" : result ? "success" : "neutral"}>
        {status}
      </Notice>

      <section className="tk-ocr-debug-layout">
        <div className="space-y-4">
          <section className="tk-panel">
            <div className="tk-panel-header">
              <div>
                <h2 className="tk-panel-title">图像对比</h2>
                <p className="mt-1 text-xs text-muted-foreground">左侧是固定区域原图，右侧是 OCR 实际使用的预处理图</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <span className="tk-badge">原图 {originalSize}</span>
                <span className="tk-badge">预处理 {preprocessedSize}</span>
                {result && <span className="tk-badge">耗时 {result.elapsedMs} ms</span>}
              </div>
            </div>
            <div className="tk-panel-body">
              <div className="tk-ocr-debug-images">
                <DebugImagePreview
                  title="原始区域"
                  imageDataUrl={result?.originalImageDataUrl}
                  path={result?.originalImagePath}
                />
                <DebugImagePreview
                  title="预处理后"
                  imageDataUrl={result?.preprocessedImageDataUrl}
                  path={result?.preprocessedImagePath}
                />
              </div>
            </div>
          </section>

          <section className="tk-panel">
            <div className="tk-panel-header">
              <div>
                <h2 className="tk-panel-title">文本对比</h2>
                <p className="mt-1 text-xs text-muted-foreground">原始输出用于判断 OCR 质量，后处理输出会进入翻译流程</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="ghost"
                  disabled={!result?.rawText}
                  onClick={() => result && copyText(result.rawText, "原始 OCR 文本")}>
                  复制原始文本
                </Button>
                <Button
                  variant="ghost"
                  disabled={!result?.text}
                  onClick={() => result && copyText(result.text, "后处理文本")}>
                  复制后处理文本
                </Button>
              </div>
            </div>
            <div className="tk-panel-body">
              <div className="tk-ocr-debug-text-grid">
                <DebugTextBlock title="原始 OCR 输出" value={result?.rawText ?? ""} />
                <DebugTextBlock title="后处理输出" value={result?.text ?? ""} />
              </div>
            </div>
          </section>
        </div>

        <aside className="tk-panel">
          <div className="tk-panel-header">
            <div>
              <h2 className="tk-panel-title">调试参数</h2>
              <p className="mt-1 text-xs text-muted-foreground">保存后会同步影响截图 OCR、固定区域翻译和划词外的 OCR 流程</p>
            </div>
          </div>
          <div className="tk-panel-body space-y-4">
            <label className="tk-field">
              <span className="tk-label">OCR Provider</span>
              <select
                className="tk-select"
                value={ocrConfig.provider}
                onChange={(event) =>
                  setOcrConfigState({
                    ...ocrConfig,
                    provider: event.target.value as OcrProvider,
                  })
                }>
                <option value="paddleocr_json">PaddleOCR-json</option>
                <option value="windows_ocr">Windows OCR</option>
              </select>
            </label>
            <TextField
              label="PaddleOCR-json.exe"
              value={ocrConfig.paddleExePath}
              onChange={(value) => setOcrConfigState({ ...ocrConfig, paddleExePath: value })}
              placeholder="E:\\Applications\\OpenWikii\\PaddleOCR-json_v1.4.1\\PaddleOCR-json.exe"
            />
            <TextField
              label="模型目录"
              value={ocrConfig.paddleModelsPath}
              onChange={(value) => setOcrConfigState({ ...ocrConfig, paddleModelsPath: value })}
              placeholder="models"
            />
            <TextField
              label="最低置信度"
              type="number"
              value={String(ocrConfig.paddleMinScore)}
              onChange={(value) => updateNumber("paddleMinScore", value, DEFAULT_OCR_CONFIG.paddleMinScore)}
            />

            <div className="space-y-3 rounded-md border border-white/70 bg-[rgb(247_250_248)] p-3 ring-1 ring-slate-900/5">
              <h3 className="text-sm font-semibold text-slate-900">图像预处理</h3>
              <Checkbox
                label="启用图像预处理"
                checked={ocrConfig.preprocessEnabled}
                onChange={(checked) => setOcrConfigState({ ...ocrConfig, preprocessEnabled: checked })}
              />
              <label className="tk-field">
                <span className="tk-label">放大倍率</span>
                <select
                  className="tk-select"
                  value={String(ocrConfig.preprocessScale)}
                  onChange={(event) =>
                    updateNumber("preprocessScale", event.target.value, DEFAULT_OCR_CONFIG.preprocessScale)
                  }>
                  <option value="1">1x</option>
                  <option value="2">2x</option>
                  <option value="3">3x</option>
                  <option value="4">4x</option>
                </select>
              </label>
              <TextField
                label="对比度增强"
                type="number"
                value={String(ocrConfig.preprocessContrast)}
                onChange={(value) =>
                  updateNumber("preprocessContrast", value, DEFAULT_OCR_CONFIG.preprocessContrast)
                }
              />
              <Checkbox
                label="灰度化"
                checked={ocrConfig.preprocessGrayscale}
                onChange={(checked) => setOcrConfigState({ ...ocrConfig, preprocessGrayscale: checked })}
              />
              <Checkbox
                label="锐化边缘"
                checked={ocrConfig.preprocessSharpen}
                onChange={(checked) => setOcrConfigState({ ...ocrConfig, preprocessSharpen: checked })}
              />
              <Checkbox
                label="二值化"
                checked={ocrConfig.preprocessThreshold}
                onChange={(checked) => setOcrConfigState({ ...ocrConfig, preprocessThreshold: checked })}
              />
            </div>

            <div className="space-y-3 rounded-md border border-white/70 bg-[rgb(247_250_248)] p-3 ring-1 ring-slate-900/5">
              <h3 className="text-sm font-semibold text-slate-900">文本后处理</h3>
              <Checkbox
                label="启用文本后处理"
                checked={ocrConfig.textPostprocessEnabled}
                onChange={(checked) => setOcrConfigState({ ...ocrConfig, textPostprocessEnabled: checked })}
              />
              <label className="tk-field">
                <span className="tk-label">文本重排模式</span>
                <select
                  className="tk-select"
                  value={ocrConfig.textLayoutMode}
                  disabled={!ocrConfig.textPostprocessEnabled}
                  onChange={(event) =>
                    setOcrConfigState({
                      ...ocrConfig,
                      textLayoutMode: event.target.value as OcrTextLayoutMode,
                    })
                  }>
                  {OCR_TEXT_LAYOUT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-muted-foreground">
                  {OCR_TEXT_LAYOUT_OPTIONS.find((option) => option.value === ocrConfig.textLayoutMode)?.description}
                </span>
              </label>
            </div>
          </div>
          <div className="tk-command-bar">
            <Button onClick={saveDebugSettings} disabled={saving || loading}>
              {saving ? "保存中..." : "保存参数"}
            </Button>
            <Button variant="ghost" onClick={() => setOcrConfigState(DEFAULT_OCR_CONFIG)}>
              重置默认
            </Button>
          </div>
        </aside>
      </section>
    </div>
  )
}

function DebugImagePreview({
  title,
  imageDataUrl,
  path,
}: {
  title: string
  imageDataUrl?: string | null
  path?: string | null
}) {
  return (
    <div className="tk-ocr-debug-preview">
      <div className="flex items-center justify-between gap-2 border-b border-slate-200/65 px-3 py-2">
        <span className="text-sm font-semibold text-slate-800">{title}</span>
        {path && <span className="max-w-[56%] truncate text-[11px] text-muted-foreground">{path}</span>}
      </div>
      <div className="tk-ocr-debug-image-stage">
        {imageDataUrl ? (
          <img className="tk-ocr-debug-image" src={imageDataUrl} alt={title} />
        ) : (
          <div className="text-sm text-muted-foreground">暂无图片</div>
        )}
      </div>
    </div>
  )
}

function DebugTextBlock({ title, value }: { title: string; value: string }) {
  return (
    <div className="tk-ocr-debug-text-block">
      <div className="border-b border-slate-200/65 px-3 py-2 text-sm font-semibold text-slate-800">
        {title}
      </div>
      <pre className="tk-ocr-debug-text">{value.trim() || "暂无文本"}</pre>
    </div>
  )
}