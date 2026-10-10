import { useCallback, useEffect, useRef, useState } from "react"
import { Database, FileUp, Play, RefreshCw } from "lucide-react"

import {
  getRgbEvalRun,
  getRgbEvalStatus,
  importOfficialRgbEvalDataset,
  importRgbEvalDataset,
  listRgbEvalRuns,
  runRgbEval,
} from "../api"
import type {
  KnowledgeSearchMode,
  RgbEvalRunRecord,
  RgbEvalRunResponse,
  RgbEvalRunSummary,
  RgbEvalStatus,
} from "../types"
import { formatPercent, formatScore } from "./evalModel"
import { Button, Notice } from "./components/EvalControls"

export function RgbBenchmarkPanel({
  enabled,
  onStatus,
}: {
  enabled: boolean
  onStatus: (message: string) => void
}) {
  const [corpus, setCorpus] = useState<RgbEvalStatus | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [runs, setRuns] = useState<RgbEvalRunSummary[]>([])
  const [result, setResult] = useState<RgbEvalRunResponse | null>(null)
  const [selectedRunId, setSelectedRunId] = useState("")
  const [autoImportError, setAutoImportError] = useState<string | null>(null)
  const [caseLimit, setCaseLimit] = useState("10")
  const [limit, setLimit] = useState("10")
  const [minScore, setMinScore] = useState("0")
  const [searchMode, setSearchMode] = useState<KnowledgeSearchMode>("hybrid")
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [running, setRunning] = useState(false)
  const initialLoadStarted = useRef(false)

  const applyRunRecord = (record: RgbEvalRunRecord) => {
    setResult(record.result)
    setSelectedRunId(record.runId)
    setCaseLimit(String(record.request.caseLimit))
    setLimit(String(record.request.limit))
    setSearchMode(record.request.searchMode)
    setMinScore(String(record.request.minScore))
  }

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [nextCorpus, nextRuns] = await Promise.all([getRgbEvalStatus(), listRgbEvalRuns()])
      setCorpus(nextCorpus)
      setRuns(nextRuns)
      if (!nextCorpus.imported) {
        setImporting(true)
        setAutoImportError(null)
        onStatus("首次使用：正在下载 RGB 官方语料并建立独立索引；不会自动运行评估")
        try {
          const importedCorpus = await importOfficialRgbEvalDataset()
          setCorpus(importedCorpus)
          setAutoImportError(null)
          onStatus(
            importedCorpus.warning
              ? `RGB 官方语料已自动导入：${importedCorpus.caseCount} 题、${importedCorpus.passageCount} 段；${importedCorpus.warning}`
              : `RGB 官方语料已自动导入并建索引：${importedCorpus.caseCount} 题、${importedCorpus.passageCount} 段`,
          )
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          const message = `自动准备 RGB 语料失败：${detail}。可刷新重试，或选择本地语料文件导入。`
          setAutoImportError(message)
          onStatus(message)
        } finally {
          setImporting(false)
        }
      }
      if (nextRuns.length > 0) {
        const latest = await getRgbEvalRun(nextRuns[0].runId)
        applyRunRecord(latest)
      } else {
        setResult(null)
        setSelectedRunId("")
      }
    } catch (error) {
      onStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [onStatus])

  useEffect(() => {
    if (!enabled || initialLoadStarted.current) return
    initialLoadStarted.current = true
    void refresh()
  }, [enabled, refresh])

  const importDataset = async () => {
    if (!file) {
      onStatus("先选择 RGB zh_refine JSONL 文件")
      return
    }
    setImporting(true)
    try {
      const nextCorpus = await importRgbEvalDataset({ fileName: file.name, content: await file.text() })
      setCorpus(nextCorpus)
      setAutoImportError(null)
      setFile(null)
      const input = document.getElementById("rgb-dataset-file") as HTMLInputElement | null
      if (input) input.value = ""
      onStatus(
        nextCorpus.warning
          ? `RGB 语料已导入：${nextCorpus.caseCount} 题、${nextCorpus.passageCount} 段；${nextCorpus.warning}`
          : `RGB 语料已导入：${nextCorpus.caseCount} 题、${nextCorpus.passageCount} 段`,
      )
    } catch (error) {
      onStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setImporting(false)
    }
  }

  const run = async () => {
    setRunning(true)
    try {
      const parsedCaseLimit = caseLimit.trim() ? Number(caseLimit) : Number.NaN
      const nextResult = await runRgbEval({
        caseLimit: Number.isFinite(parsedCaseLimit)
          ? Math.max(0, Math.min(10000, Math.floor(parsedCaseLimit)))
          : 10,
        limit: Math.max(1, Math.min(50, Math.floor(Number(limit) || 10))),
        searchMode,
        minScore: Math.max(0, Number(minScore) || 0),
      })
      setResult(nextResult)
      const nextRuns = await listRgbEvalRuns()
      setRuns(nextRuns)
      setSelectedRunId(nextResult.runId ?? nextRuns[0]?.runId ?? "")
      onStatus(
        `RGB 检索评估完成：${nextResult.evaluated}/${nextResult.totalCases} 题，MRR ${formatScore(nextResult.mrr)}；结果已独立保存`,
      )
    } catch (error) {
      onStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setRunning(false)
    }
  }

  const loadRun = async (runId: string) => {
    setLoading(true)
    try {
      applyRunRecord(await getRgbEvalRun(runId))
      onStatus("已加载 RGB 历史评估结果")
    } catch (error) {
      onStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="grid gap-5">
      <section className="tk-panel">
        <div className="tk-panel-header">
          <div>
            <h2 className="tk-panel-title">RGB 中文集 · 独立语料评估</h2>
            <p className="text-xs text-muted-foreground">
              自定义检索适配基准，不与官方 RGB 完整分数混用；首版支持 zh_refine。
            </p>
          </div>
          <Button variant="secondary" onClick={refresh} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            刷新
          </Button>
        </div>
        <div className="tk-panel-body grid gap-4 xl:grid-cols-[minmax(280px,0.8fr)_minmax(420px,1.2fr)]">
          <div className="rounded-lg border border-border bg-white/70 p-4">
            <h3 className="text-sm font-semibold">RGB 官方语料</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              首次打开会自动下载并导入官方 zh_refine 语料，建立本机独立索引；不会改动笔记知识库，也不会自动运行评估。若自动下载失败，可选择本地文件重试。应用不会打包或分发数据集，请遵守源数据许可。
            </p>
            <input
              id="rgb-dataset-file"
              className="tk-input mt-3 h-auto min-h-11 py-2"
              type="file"
              accept=".json,.jsonl,application/json"
              disabled={importing}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              aria-label="选择 RGB zh_refine 数据文件"
            />
            <Button className="mt-3" onClick={importDataset} disabled={importing || !file}>
              <FileUp className="h-4 w-4" />
              {importing ? "导入并建索引中..." : "导入并建索引"}
            </Button>
            {autoImportError && (
              <p className="mt-3 rounded-md border border-rose-100 bg-rose-50/70 px-3 py-2 text-xs leading-5 text-rose-800" role="alert">
                {autoImportError}
              </p>
            )}
            <p className="mt-3 rounded-md border border-amber-100 bg-amber-50/70 px-3 py-2 text-xs leading-5 text-amber-800">
              若 Embedding 已启用，自动导入会把段落文本发送到配置的 Embedding API 生成向量，可能产生费用；未启用时仅建 FTS 索引。
            </p>
            {importing && (
              <p className="mt-3 text-sm text-emerald-800" role="status" aria-live="polite">
                正在准备 RGB 语料与索引，请稍候…
              </p>
            )}
          </div>

          <div className="rounded-lg border border-border bg-white/70 p-4">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-emerald-700" />
              <h3 className="text-sm font-semibold">独立语料索引</h3>
              <span className={`tk-badge ${corpus?.imported ? "tk-badge-success" : ""}`}>
                {corpus?.imported ? "已就绪" : "待导入"}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
              <StatusValue label="问题" value={corpus?.caseCount ?? 0} />
              <StatusValue label="去重段落" value={corpus?.passageCount ?? 0} />
              <StatusValue label="向量" value={corpus?.vectorCount ?? 0} />
              <StatusValue label="版本" value={corpus?.datasetVersion || "—"} />
            </div>
            {corpus?.fileName && (
              <p className="mt-3 truncate text-xs text-muted-foreground" title={corpus.fileName}>
                当前语料：{corpus.fileName}
                {corpus.importedAt ? ` · ${new Date(corpus.importedAt).toLocaleString()}` : ""}
              </p>
            )}
            {corpus?.warning && (
              <p className="mt-3 rounded-md border border-amber-100 bg-amber-50/70 px-3 py-2 text-xs leading-5 text-amber-800">
                {corpus.warning}
              </p>
            )}
          </div>
        </div>
      </section>

      <section className="tk-panel">
        <div className="tk-panel-header flex-wrap">
          <div>
            <h2 className="tk-panel-title">运行检索评估</h2>
            <p className="text-xs text-muted-foreground">
              {corpus?.caseCount ?? 0} 题 · {corpus?.passageCount ?? 0} 段
              {corpus?.vectorAvailable ? " · 向量索引可用" : " · 无向量索引（Hybrid 使用 FTS 召回）"}
            </p>
          </div>
          <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
            {runs.length > 0 && (
              <select
                className="tk-select !w-[240px] shrink-0"
                value={selectedRunId || runs[0].runId}
                onChange={(event) => void loadRun(event.target.value)}
                aria-label="RGB 评估历史记录">
                {runs.map((item) => (
                  <option key={item.runId} value={item.runId}>
                    {formatRunLabel(item)}
                  </option>
                ))}
              </select>
            )}
            <select
              className="tk-select !w-[120px] shrink-0"
              value={searchMode}
              onChange={(event) => setSearchMode(event.target.value as KnowledgeSearchMode)}
              aria-label="RGB 检索模式">
              <option value="hybrid">Hybrid</option>
              <option value="fts">FTS</option>
              <option value="vector" disabled={!corpus?.vectorAvailable}>
                Vector
              </option>
            </select>
            <label className="grid gap-1 text-xs text-muted-foreground">
              Top K
              <input
                className="tk-input !w-[84px]"
                type="number"
                min={1}
                max={50}
                value={limit}
                onChange={(event) => setLimit(event.target.value)}
              />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              样本数（0=全部）
              <input
                className="tk-input !w-[100px]"
                type="number"
                min={0}
                max={10000}
                value={caseLimit}
                onChange={(event) => setCaseLimit(event.target.value)}
              />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              最低分
              <input
                className="tk-input !w-[84px]"
                type="number"
                min={0}
                step={0.05}
                value={minScore}
                onChange={(event) => setMinScore(event.target.value)}
              />
            </label>
            <Button onClick={run} disabled={running || !corpus?.imported}>
              <Play className="h-4 w-4" />
              {running ? "评估中..." : "运行评估"}
            </Button>
          </div>
        </div>
        <div className="tk-panel-body">
          <Notice tone="neutral">
            这是 RGB 段落并集上的 TabKeep 检索适配测试：按每题 positive 段落计算 Recall@K、Precision@K、MRR、Top1；已知 negative 命中率单独展示。它不是官方 RGB 全量鲁棒性/生成评测。
          </Notice>
          {result && (
            <>
              <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
                <Metric label={`Recall@${result.limit}`} value={formatPercent(result.recallAtK)} />
                <Metric label={`Precision@${result.limit}`} value={formatPercent(result.precisionAtK)} />
                <Metric label="MRR" value={formatScore(result.mrr)} />
                <Metric label="Top1 命中率" value={formatPercent(result.top1Accuracy)} />
                <Metric label="已知负例命中率 ↓" value={formatPercent(result.negativeHitRateAtK)} />
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                {result.evaluated}/{result.totalCases} 题已评估 · TopK {result.limit} · {result.searchMode} · 耗时 {result.durationMs} ms
                {result.caseLimit === 0 ? " · 全量" : ` · 抽样上限 ${result.caseLimit}`}
              </p>
              <div className="mt-4 grid max-h-[50rem] gap-2 overflow-auto pr-1">
                {result.results.map((item) => (
                  <article key={item.caseId} className="rounded-md border border-border bg-white/70 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="min-w-0 flex-1 text-sm font-medium leading-6">{item.question}</p>
                      <span className={`tk-badge ${item.error ? "tk-badge-warning" : item.firstRelevantRank ? "tk-badge-success" : "tk-badge-warning"}`}>
                        {item.error
                          ? "检索异常"
                          : item.firstRelevantRank
                            ? `首个正例 #${item.firstRelevantRank} · Recall ${formatPercent(item.recallAtK)}`
                            : "未命中正例"}
                      </span>
                    </div>
                    {item.error ? (
                      <p className="mt-2 text-xs text-rose-700">{item.error}</p>
                    ) : item.hits.length === 0 ? (
                      <p className="mt-2 text-xs text-muted-foreground">没有召回结果</p>
                    ) : (
                      <div className="mt-3 grid gap-2">
                        {item.hits.map((hit) => (
                          <div key={hit.chunkId} className="rounded-md border border-border/80 bg-slate-50/80 p-2.5">
                            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                              <span className="tk-badge">#{hit.rank}</span>
                              {hit.relevant && <span className="tk-badge tk-badge-success">正例</span>}
                              {hit.knownNegative && <span className="tk-badge tk-badge-warning">已知负例</span>}
                              {!hit.relevant && !hit.knownNegative && <span className="tk-badge">其他段落</span>}
                              <span className="text-xs text-muted-foreground">{hit.matchedBy.join(" + ") || "—"}</span>
                            </div>
                            <p className="line-clamp-4 whitespace-pre-wrap text-xs leading-5 text-slate-700">
                              {hit.matchedContent || hit.content}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  )
}

function StatusValue({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-border bg-slate-50/80 px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold" title={String(value)}>{value}</p>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-slate-50/80 px-3 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  )
}

function formatRunLabel(item: RgbEvalRunSummary): string {
  const time = new Date(item.createdAt).toLocaleString()
  return `${time} · ${item.searchMode} · MRR ${formatScore(item.mrr)}`
}
