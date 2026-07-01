import { useEffect, useState } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { Clipboard, Copy, Keyboard, Languages, Move, PlugZap, RotateCcw, Settings2, X } from "lucide-react"

import {
  DEFAULT_OCR_CONFIG,
  DEFAULT_SELECTION_TRANSLATE_CONFIG,
  DEFAULT_TRANSLATE_PROVIDER_CONFIG,
  closeRegionBox,
  getOcrConfig,
  getSelectionTranslateConfig,
  getTranslateProviderConfig,
  openRegionBox,
  setOcrConfig,
  setSelectionTranslateConfig,
  setTranslateProviderConfig,
  startOcrTranslate,
  testTranslateProvider,
  translateText,
  triggerSelectionTranslate,
} from "../api"
import type {
  OcrConfig,
  OcrProvider,
  OcrTextLayoutMode,
  SelectionTranslateConfig,
  TranslateProvider,
  TranslateProviderConfig,
  TranslateProviderTestResponse,
} from "../types"
import { Button, Checkbox, Notice, TextField } from "../components/primitives"
import { errorMessage } from "../lib/errors"
import { OCR_TEXT_LAYOUT_OPTIONS } from "../lib/ocr"

export function TranslateSection() {
  const [sourceText, setSourceText] = useState("")
  const [translatedText, setTranslatedText] = useState("")
  const [sourceLang, setSourceLang] = useState("auto")
  const [targetLang, setTargetLang] = useState("简体中文")
  const [status, setStatus] = useState<string | null>(null)
  const [translating, setTranslating] = useState(false)
  const [ocrConfig, setOcrConfigState] = useState<OcrConfig>(DEFAULT_OCR_CONFIG)
  const [ocrSaving, setOcrSaving] = useState(false)
  const [ocrBusy, setOcrBusy] = useState<"translate" | null>(null)
  const [translateProviderConfig, setTranslateProviderConfigState] =
    useState<TranslateProviderConfig>(DEFAULT_TRANSLATE_PROVIDER_CONFIG)
  const [translateProviderSaving, setTranslateProviderSaving] = useState(false)
  const [translateProviderTesting, setTranslateProviderTesting] = useState(false)
  const [translateProviderTest, setTranslateProviderTest] =
    useState<TranslateProviderTestResponse | null>(null)
  const [selectionConfig, setSelectionConfigState] =
    useState<SelectionTranslateConfig>(DEFAULT_SELECTION_TRANSLATE_CONFIG)
  const [selectionSaving, setSelectionSaving] = useState(false)
  const [selectionTriggering, setSelectionTriggering] = useState(false)

  const targetOptions = ["简体中文", "English", "日本語", "한국어", "Français", "Deutsch"]
  const canTranslate = sourceText.trim().length > 0 && !translating

  useEffect(() => {
    let cancelled = false
    Promise.allSettled([
      getOcrConfig(),
      getTranslateProviderConfig(),
      getSelectionTranslateConfig(),
    ]).then((results) => {
      if (cancelled) return
      const [ocrResult, translateProviderResult, selectionResult] = results
      if (ocrResult.status === "fulfilled") {
        setOcrConfigState(ocrResult.value)
      } else {
        setStatus(`读取 OCR 设置失败: ${errorMessage(ocrResult.reason)}`)
      }
      if (translateProviderResult.status === "fulfilled") {
        setTranslateProviderConfigState(translateProviderResult.value)
      } else {
        setStatus(`读取翻译服务设置失败: ${errorMessage(translateProviderResult.reason)}`)
      }
      if (selectionResult.status === "fulfilled") {
        setSelectionConfigState(selectionResult.value)
      } else {
        setStatus(`读取划词翻译设置失败: ${errorMessage(selectionResult.reason)}`)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const runTranslate = async () => {
    const text = sourceText.trim()
    if (!text) return
    setTranslating(true)
    setStatus(null)
    setTranslatedText("")
    try {
      const result = await translateText({
        text,
        sourceLang,
        targetLang,
      }, "/input_translate")
      setTranslatedText(result.translatedText)
      setStatus(`已完成 · ${result.model}`)
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setTranslating(false)
    }
  }

  const pasteText = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) setSourceText(text)
    } catch (err) {
      setStatus(`读取剪贴板失败: ${errorMessage(err)}`)
    }
  }

  const copyResult = async () => {
    if (!translatedText) return
    try {
      await navigator.clipboard.writeText(translatedText)
      setStatus("译文已复制")
    } catch (err) {
      setStatus(`复制失败: ${errorMessage(err)}`)
    }
  }

  const swapText = () => {
    if (!translatedText) return
    setSourceText(translatedText)
    setTranslatedText(sourceText)
    setSourceLang(targetLang)
    setTargetLang(sourceLang === "auto" ? "English" : sourceLang)
  }

  const saveOcrSettings = async () => {
    setOcrSaving(true)
    setStatus(null)
    try {
      await setOcrConfig(ocrConfig)
      setStatus("OCR 设置已保存")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setOcrSaving(false)
    }
  }

  const updateOcrNumber = (
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

  const saveTranslateProviderSettings = async () => {
    setTranslateProviderSaving(true)
    setStatus(null)
    try {
      const saved = await setTranslateProviderConfig(translateProviderConfig)
      setTranslateProviderConfigState(saved)
      setStatus("翻译服务设置已保存")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setTranslateProviderSaving(false)
    }
  }

  const testCurrentTranslateProvider = async () => {
    setTranslateProviderTesting(true)
    setTranslateProviderTest(null)
    setStatus(null)
    try {
      const result = await testTranslateProvider(translateProviderConfig)
      setTranslateProviderTest(result)
      setStatus(
        result.ok
          ? `测试成功 · ${result.provider} · ${result.latencyMs}ms`
          : result.error ?? "翻译服务测试失败",
      )
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setTranslateProviderTesting(false)
    }
  }

  const saveSelectionTranslateSettings = async () => {
    setSelectionSaving(true)
    setStatus(null)
    try {
      const saved = await setSelectionTranslateConfig(selectionConfig)
      setSelectionConfigState(saved)
      setStatus(saved.hotkeyError ?? "划词翻译设置已保存")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setSelectionSaving(false)
    }
  }

  const runSelectionTranslateTest = async () => {
    setSelectionTriggering(true)
    setStatus("正在最小化桌面端，1 秒后读取当前应用选中文本")
    try {
      try {
        await getCurrentWindow().minimize()
      } catch {
        // Ignore minimize failures; the global hotkey flow still works.
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1000))
      const result = await triggerSelectionTranslate()
      setStatus(result.ok ? "划词翻译已完成" : result.error ?? "划词翻译未完成")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setSelectionTriggering(false)
    }
  }

  const runScreenshotTranslate = async () => {
    setOcrBusy("translate")
    setStatus("请在屏幕上框选要翻译的区域")
    try {
      const payload = {
        screenshot: true,
        provider: ocrConfig.provider,
        sourceLang,
        targetLang,
      }
      const result = await startOcrTranslate(payload)
      setStatus(result.ok ? "截图翻译结果已在悬浮窗显示" : result.error ?? "截图翻译未完成")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setOcrBusy(null)
    }
  }

  const openFixedRegion = async () => {
    setStatus(null)
    try {
      const config = await openRegionBox()
      setStatus(
        `固定翻译框已打开 · ${config.width}x${config.height} @ ${config.x},${config.y}`,
      )
    } catch (err) {
      setStatus(errorMessage(err))
    }
  }

  const closeFixedRegion = async () => {
    setStatus(null)
    try {
      await closeRegionBox()
      setStatus("固定翻译框已关闭")
    } catch (err) {
      setStatus(errorMessage(err))
    }
  }

  return (
    <div className="space-y-5">
      <header className="tk-topbar">
        <div>
          <h1 className="tk-page-title">翻译</h1>
          <p className="tk-page-subtitle">文本、截图与固定区域</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={pasteText}>
            <Clipboard className="h-4 w-4" />
            粘贴
          </Button>
          <Button onClick={runTranslate} disabled={!canTranslate}>
            <Languages className={`h-4 w-4 ${translating ? "animate-pulse" : ""}`} />
            {translating ? "翻译中..." : "翻译"}
          </Button>
        </div>
      </header>

      {status && <Notice tone={translatedText ? "success" : "warning"}>{status}</Notice>}

      <section className="tk-translate-grid">
        <div className="tk-panel">
          <div className="tk-panel-header">
            <h2 className="tk-panel-title">原文</h2>
            <div className="flex items-center gap-2">
              <select
                className="tk-select tk-compact-select"
                value={sourceLang}
                onChange={(event) => setSourceLang(event.target.value)}>
                <option value="auto">自动识别</option>
                {targetOptions.map((lang) => (
                  <option key={lang} value={lang}>
                    {lang}
                  </option>
                ))}
              </select>
              <button className="tk-icon-button" onClick={() => setSourceText("")} title="清空">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="tk-panel-body">
            <textarea
              className="tk-textarea tk-translate-textarea"
              value={sourceText}
              onChange={(event) => setSourceText(event.target.value)}
              placeholder="输入或粘贴要翻译的文本"
            />
          </div>
          <div className="tk-command-bar">
            <span className="text-xs text-muted-foreground">{sourceText.trim().length} 字符</span>
          </div>
        </div>

        <div className="tk-panel">
          <div className="tk-panel-header">
            <h2 className="tk-panel-title">译文</h2>
            <div className="flex items-center gap-2">
              <select
                className="tk-select tk-compact-select"
                value={targetLang}
                onChange={(event) => setTargetLang(event.target.value)}>
                {targetOptions.map((lang) => (
                  <option key={lang} value={lang}>
                    {lang}
                  </option>
                ))}
              </select>
              <button className="tk-icon-button" onClick={copyResult} title="复制译文" disabled={!translatedText}>
                <Copy className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="tk-panel-body">
            <textarea
              className="tk-textarea tk-translate-textarea"
              value={translatedText}
              onChange={(event) => setTranslatedText(event.target.value)}
              placeholder={translating ? "正在生成译文..." : "译文会显示在这里"}
            />
          </div>
          <div className="tk-command-bar">
            <Button variant="secondary" onClick={swapText} disabled={!translatedText}>
              交换
            </Button>
            <span className="text-xs text-muted-foreground">{translatedText.trim().length} 字符</span>
          </div>
        </div>
      </section>

      <section className="tk-panel">
        <div className="tk-panel-header">
          <div>
            <h2 className="tk-panel-title">划词翻译</h2>
            <p className="text-xs text-muted-foreground">
              在任意应用中选中文字，按 {selectionConfig.hotkey} 直接翻译
            </p>
          </div>
          <span className={`tk-badge ${selectionConfig.enabled ? "tk-badge-success" : "tk-badge-warning"}`}>
            {selectionConfig.enabled ? "已启用" : "已关闭"}
          </span>
        </div>
        <div className="tk-panel-body space-y-4">
          <div className="tk-form-grid">
            <label className="tk-field">
              <span className="tk-label">快捷键</span>
              <input className="tk-input" value={selectionConfig.hotkey} readOnly />
            </label>
            <label className="tk-field">
              <span className="tk-label">源语言</span>
              <select
                className="tk-select"
                value={selectionConfig.sourceLang}
                onChange={(event) =>
                  setSelectionConfigState({
                    ...selectionConfig,
                    sourceLang: event.target.value,
                  })
                }>
                <option value="auto">自动识别</option>
                {targetOptions.map((lang) => (
                  <option key={lang} value={lang}>
                    {lang}
                  </option>
                ))}
              </select>
            </label>
            <label className="tk-field">
              <span className="tk-label">目标语言</span>
              <select
                className="tk-select"
                value={selectionConfig.targetLang}
                onChange={(event) =>
                  setSelectionConfigState({
                    ...selectionConfig,
                    targetLang: event.target.value,
                  })
                }>
                {targetOptions.map((lang) => (
                  <option key={lang} value={lang}>
                    {lang}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Checkbox
            label="启用全局划词翻译快捷键"
            checked={selectionConfig.enabled}
            onChange={(enabled) => setSelectionConfigState({ ...selectionConfig, enabled })}
          />
          {selectionConfig.hotkeyError && (
            <Notice tone="warning">{selectionConfig.hotkeyError}</Notice>
          )}
        </div>
        <div className="tk-command-bar">
          <Button onClick={saveSelectionTranslateSettings} disabled={selectionSaving}>
            <Settings2 className="h-4 w-4" />
            {selectionSaving ? "保存中..." : "保存划词设置"}
          </Button>
          <Button
            variant="secondary"
            onClick={runSelectionTranslateTest}
            disabled={selectionTriggering}>
            <Keyboard className={`h-4 w-4 ${selectionTriggering ? "animate-pulse" : ""}`} />
            {selectionTriggering ? "读取中..." : "手动测试"}
          </Button>
        </div>
      </section>

      <section className="tk-panel">
        <div className="tk-panel-header">
          <div>
            <h2 className="tk-panel-title">固定区域翻译框</h2>
            <p className="text-xs text-muted-foreground">框选字幕或固定区域</p>
          </div>
          <span className="tk-badge">区域</span>
        </div>
        <div className="tk-panel-body">
          <div className="flex flex-wrap gap-2">
            <Button onClick={openFixedRegion}>
              <Move className="h-4 w-4" />
              打开固定翻译框
            </Button>
            <Button variant="secondary" onClick={closeFixedRegion}>
              <X className="h-4 w-4" />
              关闭固定翻译框
            </Button>
          </div>
        </div>
      </section>

      <section className="tk-panel">
        <div className="tk-panel-header">
          <div>
            <h2 className="tk-panel-title">翻译服务</h2>
            <p className="text-xs text-muted-foreground">
              文本、截图和固定区域共用此处设置
            </p>
          </div>
          <span className="tk-badge">
            {translateProviderConfig.provider === "openai_compatible"
              ? "模型"
              : translateProviderConfig.provider === "baidu"
                ? "百度"
                : "火山"}
          </span>
        </div>
        <div className="tk-panel-body space-y-4">
          <div className="tk-form-grid">
            <label className="tk-field">
              <span className="tk-label">服务</span>
              <select
                className="tk-select"
                value={translateProviderConfig.provider}
                onChange={(event) =>
                  setTranslateProviderConfigState({
                    ...translateProviderConfig,
                    provider: event.target.value as TranslateProvider,
                  })
                }>
                <option value="openai_compatible">OpenAI-compatible 精翻</option>
                <option value="baidu">百度翻译 快速</option>
                <option value="volcengine">火山翻译 快速</option>
              </select>
            </label>

            {translateProviderConfig.provider === "baidu" && (
              <>
                <TextField
                  label="百度 App ID"
                  value={translateProviderConfig.baiduAppId}
                  onChange={(value) =>
                    setTranslateProviderConfigState({
                      ...translateProviderConfig,
                      baiduAppId: value,
                    })
                  }
                  placeholder="在百度翻译开放平台获取"
                />
                <TextField
                  label="百度密钥"
                  type="password"
                  value={translateProviderConfig.baiduSecret}
                  onChange={(value) =>
                    setTranslateProviderConfigState({
                      ...translateProviderConfig,
                      baiduSecret: value,
                    })
                  }
                  placeholder="Secret Key"
                />
              </>
            )}

            {translateProviderConfig.provider === "volcengine" && (
              <>
                <TextField
                  label="火山 Access Key"
                  value={translateProviderConfig.volcengineAccessKey}
                  onChange={(value) =>
                    setTranslateProviderConfigState({
                      ...translateProviderConfig,
                      volcengineAccessKey: value,
                    })
                  }
                  placeholder="Access Key ID"
                />
                <TextField
                  label="火山 Secret Key"
                  type="password"
                  value={translateProviderConfig.volcengineSecretKey}
                  onChange={(value) =>
                    setTranslateProviderConfigState({
                      ...translateProviderConfig,
                      volcengineSecretKey: value,
                    })
                  }
                  placeholder="Secret Access Key"
                />
                <TextField
                  label="火山 Region"
                  value={translateProviderConfig.volcengineRegion}
                  onChange={(value) =>
                    setTranslateProviderConfigState({
                      ...translateProviderConfig,
                      volcengineRegion: value,
                    })
                  }
                  placeholder="cn-north-1"
                />
              </>
            )}
          </div>
        </div>
        <div className="tk-command-bar">
          <Button
            variant="secondary"
            onClick={testCurrentTranslateProvider}
            disabled={translateProviderTesting}>
            <PlugZap className={`h-4 w-4 ${translateProviderTesting ? "animate-pulse" : ""}`} />
            {translateProviderTesting ? "测试中..." : "测试连接"}
          </Button>
          <Button onClick={saveTranslateProviderSettings} disabled={translateProviderSaving}>
            <Settings2 className="h-4 w-4" />
            {translateProviderSaving ? "保存中..." : "保存翻译服务"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => setTranslateProviderConfigState(DEFAULT_TRANSLATE_PROVIDER_CONFIG)}>
            <RotateCcw className="h-4 w-4" />
            重置为模型翻译
          </Button>
          {translateProviderTest && (
            <span
              className={`text-sm ${
                translateProviderTest.ok ? "text-emerald-700" : "text-rose-700"
              }`}>
              {translateProviderTest.ok
                ? `${translateProviderTest.provider} · ${translateProviderTest.latencyMs}ms · ${translateProviderTest.translatedText ?? ""}`
                : translateProviderTest.error ?? "测试失败"}
            </span>
          )}
        </div>
      </section>

      <section className="tk-panel">
        <div className="tk-panel-header">
          <div>
            <h2 className="tk-panel-title">截图翻译</h2>
            <p className="text-xs text-muted-foreground">框选屏幕区域后，译文会在置顶悬浮窗显示</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={runScreenshotTranslate} disabled={ocrBusy !== null}>
              <Languages className={`h-4 w-4 ${ocrBusy === "translate" ? "animate-pulse" : ""}`} />
              截图翻译
            </Button>
          </div>
        </div>
        <div className="tk-panel-body space-y-4">
          <div className="tk-form-grid">
            <label className="tk-field">
              <span className="tk-label">OCR 引擎</span>
              <select
                className="tk-select"
                value={ocrConfig.provider}
                onChange={(event) =>
                  setOcrConfigState({
                    ...ocrConfig,
                    provider: event.target.value as OcrProvider,
                  })
                }>
                <option value="windows_ocr">Windows OCR</option>
                <option value="paddleocr_json">PaddleOCR-json</option>
              </select>
            </label>
            <TextField
              label="PaddleOCR-json.exe"
              value={ocrConfig.paddleExePath}
              onChange={(value) => setOcrConfigState({ ...ocrConfig, paddleExePath: value })}
              placeholder="D:\\PaddleOCR-json\\PaddleOCR-json.exe"
            />
            <TextField
              label="Paddle models"
              value={ocrConfig.paddleModelsPath}
              onChange={(value) => setOcrConfigState({ ...ocrConfig, paddleModelsPath: value })}
              placeholder="可留空"
            />
            <TextField
              label="Paddle config"
              value={ocrConfig.paddleConfigPath}
              onChange={(value) => setOcrConfigState({ ...ocrConfig, paddleConfigPath: value })}
              placeholder="可留空"
            />
            <TextField
              label="Paddle 最低置信度"
              type="number"
              value={String(ocrConfig.paddleMinScore)}
              onChange={(value) => updateOcrNumber("paddleMinScore", value, DEFAULT_OCR_CONFIG.paddleMinScore)}
              placeholder="0.45"
            />
          </div>

          <div className="rounded-md border border-white/70 bg-[rgb(247_250_248)] p-3 ring-1 ring-slate-900/5">
            <div className="mb-3">
              <h3 className="text-sm font-semibold text-slate-900">图像预处理</h3>
              <p className="mt-1 text-xs text-muted-foreground">适合小字、字幕描边和复杂背景，二值化建议只在普通增强不够时开启</p>
            </div>
            <div className="tk-form-grid">
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
                    updateOcrNumber("preprocessScale", event.target.value, DEFAULT_OCR_CONFIG.preprocessScale)
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
                  updateOcrNumber("preprocessContrast", value, DEFAULT_OCR_CONFIG.preprocessContrast)
                }
                placeholder="18"
              />
              <Checkbox
                label="灰度化"
                checked={ocrConfig.preprocessGrayscale}
                onChange={(checked) => setOcrConfigState({ ...ocrConfig, preprocessGrayscale: checked })}
              />
              <Checkbox
                label="锐化文字边缘"
                checked={ocrConfig.preprocessSharpen}
                onChange={(checked) => setOcrConfigState({ ...ocrConfig, preprocessSharpen: checked })}
              />
              <Checkbox
                label="二值化"
                checked={ocrConfig.preprocessThreshold}
                onChange={(checked) => setOcrConfigState({ ...ocrConfig, preprocessThreshold: checked })}
              />
            </div>
          </div>

          <div className="rounded-md border border-white/70 bg-[rgb(247_250_248)] p-3 ring-1 ring-slate-900/5">
            <div className="mb-3">
              <h3 className="text-sm font-semibold text-slate-900">文本后处理</h3>
              <p className="mt-1 text-xs text-muted-foreground">清理 OCR 空格、噪声和相邻重复行，翻译前会先使用处理后的文本</p>
            </div>
            <div className="tk-form-grid">
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
        </div>
        <div className="tk-command-bar">
          <Button onClick={saveOcrSettings} disabled={ocrSaving}>
            <Settings2 className="h-4 w-4" />
            {ocrSaving ? "保存中..." : "保存 OCR 设置"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => setOcrConfigState(DEFAULT_OCR_CONFIG)}>
            <RotateCcw className="h-4 w-4" />
            重置为 PaddleOCR-json
          </Button>
        </div>
      </section>

    </div>
  )
}
