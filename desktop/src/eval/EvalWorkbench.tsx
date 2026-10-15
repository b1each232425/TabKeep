import { useEffect, useMemo, useState } from "react"
import { RefreshCw } from "lucide-react"

import {
  checkBackendHealth,
  deleteKnowledgeEvalCase,
  getKnowledgeEvalRun,
  getBrowserApiBaseUrl,
  getBrowserApiToken,
  listKnowledgeEvalCases,
  listKnowledgeEvalRuns,
  runKnowledgeEval,
  saveKnowledgeEvalCase,
  setBrowserApiBaseUrl,
  setBrowserApiToken,
} from "../api"
import type {
  KnowledgeEvalCase,
  KnowledgeEvalCaseRequest,
  KnowledgeEvalRunRecord,
  KnowledgeEvalRunResponse,
  KnowledgeEvalRunSummary,
  KnowledgeSearchMode,
} from "../types"
import { EvalCaseEditor } from "./components/EvalCaseEditor"
import { EvalCaseListPanel } from "./components/EvalCaseListPanel"
import { EvalConnectionPanel } from "./components/EvalConnectionPanel"
import { Button, Notice } from "./components/EvalControls"
import { EvalResultPanel } from "./components/EvalResultPanel"
import { RgbBenchmarkPanel } from "./RgbBenchmarkPanel"
import {
  EMPTY_EVAL_CASE,
  errorMessage,
  formatAnswerRunBadge,
  formatEvalStatus,
  formatPercent,
  formatScore,
  hasExpectation,
  isAnswerReadyCase,
  isRetrievalReadyCase,
} from "./evalModel"

export default function EvalWorkbench() {
  const [apiBaseUrl, setApiBaseUrlState] = useState(getBrowserApiBaseUrl())
  const [apiToken, setApiTokenState] = useState(getBrowserApiToken())
  const [backendReady, setBackendReady] = useState(false)
  const [activeBenchmark, setActiveBenchmark] = useState<"notes" | "rgb">("notes")
  const [cases, setCases] = useState<KnowledgeEvalCase[]>([])
  const [draft, setDraft] = useState<KnowledgeEvalCaseRequest>({ ...EMPTY_EVAL_CASE })
  const [editingCaseId, setEditingCaseId] = useState<string | null>(null)
  const [limit, setLimit] = useState("10")
  const [searchMode, setSearchMode] = useState<KnowledgeSearchMode>("hybrid")
  const [minScore, setMinScore] = useState("0")
  const [queryRewrite, setQueryRewrite] = useState(false)
  const [evaluateAnswer, setEvaluateAnswer] = useState(false)
  const [evaluateRagas, setEvaluateRagas] = useState(false)
  const [answerLimit, setAnswerLimit] = useState("56")
  const [evalScope, setEvalScope] = useState<"core" | "full">("core")
  const [result, setResult] = useState<KnowledgeEvalRunResponse | null>(null)
  const [runHistory, setRunHistory] = useState<KnowledgeEvalRunSummary[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const retrievalReadyCount = useMemo(() => cases.filter(isRetrievalReadyCase).length, [cases])
  const answerReadyCount = useMemo(() => cases.filter(isAnswerReadyCase).length, [cases])
  const ragasReadyCount = useMemo(
    () => cases.filter((item) => Boolean(!item.shouldRefuse && item.expectedAnswer.trim())).length,
    [cases],
  )
  const coreCases = useMemo(() => cases.filter((item) => item.isCore), [cases])
  const selectedCases = evalScope === "core" ? coreCases : cases

  const statusTone = useMemo<"success" | "warning" | "neutral">(() => {
    if (!status) return "neutral"
    return status.includes("完成") ||
      status.includes("已保存") ||
      status.includes("已删除") ||
      status.includes("已连接") ||
      status.includes("已导入") ||
      status.includes("已复制") ||
      status.includes("已打开") ||
      status.includes("已加载")
      ? "success"
      : "warning"
  }, [status])

  const applyRunRecord = (record: KnowledgeEvalRunRecord) => {
    setResult(record.result)
    setSelectedRunId(record.runId)
    setLimit(String(record.request.limit ?? 10))
    setSearchMode(record.request.searchMode ?? "hybrid")
    setMinScore(String(record.request.minScore ?? 0))
    setQueryRewrite(Boolean(record.request.queryRewrite))
    setEvaluateAnswer(Boolean(record.request.evaluateAnswer))
    setEvaluateRagas(Boolean(record.request.evaluateRagas))
    setAnswerLimit(String(record.request.answerLimit ?? 56))
    const requestedIds = record.request.caseIds ?? []
    setEvalScope(requestedIds.length > 0 && requestedIds.length === record.result.total && requestedIds.every((id) => record.result.results.some((row) => row.case.id === id && row.case.isCore)) ? "core" : "full")
  }

  const loadHistoricalRun = async (runId: string) => {
    setLoading(true)
    setStatus(null)
    try {
      const record = await getKnowledgeEvalRun(runId)
      applyRunRecord(record)
      setStatus(`已加载评估记录：${new Date(record.createdAt).toLocaleString()}`)
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  const refresh = async () => {
    setLoading(true)
    setStatus(null)
    try {
      const ok = await checkBackendHealth()
      setBackendReady(ok)
      if (!ok) {
        setStatus("后端不可用")
        return
      }
      const [nextCases, nextRuns] = await Promise.all([listKnowledgeEvalCases(), listKnowledgeEvalRuns()])
      setCases(nextCases)
      setRunHistory(nextRuns)
      if (nextRuns.length > 0) {
        const latest = await getKnowledgeEvalRun(nextRuns[0].runId)
        applyRunRecord(latest)
        setEvalScope("core")
        setStatus(`已连接后端，加载 ${nextCases.length} 条评估用例，已恢复最近一次评估`)
      } else {
        setResult(null)
        setSelectedRunId(null)
        setStatus(`已连接后端，加载 ${nextCases.length} 条评估用例`)
      }
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    if (answerReadyCount === 0 && evaluateAnswer) {
      setEvaluateAnswer(false)
    }
  }, [answerReadyCount, evaluateAnswer])

  useEffect(() => {
    if ((!evaluateAnswer || ragasReadyCount === 0) && evaluateRagas) {
      setEvaluateRagas(false)
    }
  }, [evaluateAnswer, evaluateRagas, ragasReadyCount])

  const saveConnection = async () => {
    setBrowserApiBaseUrl(apiBaseUrl)
    setBrowserApiToken(apiToken)
    await refresh()
  }

  const resetDraft = () => {
    setDraft({ ...EMPTY_EVAL_CASE })
    setEditingCaseId(null)
  }

  const saveDraft = async () => {
    if (!draft.question.trim()) {
      setStatus("评估问题不能为空")
      return
    }
    if (!hasExpectation(draft)) {
      setStatus("至少填写一个预期命中、预期答案、答案关键词或拒答条件")
      return
    }
    setSaving(true)
    setStatus(null)
    try {
      await saveKnowledgeEvalCase(draft, editingCaseId)
      const nextCases = await listKnowledgeEvalCases()
      setCases(nextCases)
      resetDraft()
      setStatus("评估用例已保存")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const editCase = (item: KnowledgeEvalCase) => {
    setEditingCaseId(item.id)
    setDraft({
      question: item.question,
      caseType: item.caseType || "keyword",
      expectedText: item.expectedText,
      expectedPath: item.expectedPath,
      expectedTitle: item.expectedTitle,
      expectedDocumentId: item.expectedDocumentId,
      expectedParagraphId: item.expectedParagraphId,
      additionalRelevantTargets: item.additionalRelevantTargets ?? [],
      expectedAnswer: item.expectedAnswer ?? "",
      answerKeywords: item.answerKeywords ?? "",
      shouldRefuse: Boolean(item.shouldRefuse),
      isCore: Boolean(item.isCore),
      note: item.note,
      dataset: item.dataset || "tabkeep-mysql-notes-v2",
    })
  }

  const removeCase = async (caseId: string) => {
    setSaving(true)
    setStatus(null)
    try {
      await deleteKnowledgeEvalCase(caseId)
      const nextCases = await listKnowledgeEvalCases()
      setCases(nextCases)
      if (editingCaseId === caseId) resetDraft()
      setStatus("评估用例已删除")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const runEval = async () => {
    if (cases.length === 0) {
      setStatus("请先添加评估用例")
      return
    }
    if (evaluateAnswer && answerReadyCount === 0) {
      setStatus("当前没有答案评估用例。请先给用例填写预期答案、答案关键词，或勾选应拒答。")
      return
    }
    if (evalScope === "core" && coreCases.length === 0) {
      setStatus("当前用例集没有核心用例，请选择全量或导入 v2 用例集")
      return
    }
    setRunning(true)
    setStatus(null)
    try {
      const parsedLimit = Number(limit)
      const parsedMinScore = Number(minScore)
      const parsedAnswerLimit = Number(answerLimit)
      const nextResult = await runKnowledgeEval({
        caseIds: evalScope === "core" ? coreCases.map((item) => item.id) : cases.map((item) => item.id),
        limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 10,
        searchMode,
        minScore: Number.isFinite(parsedMinScore) && parsedMinScore > 0 ? parsedMinScore : 0,
        queryRewrite,
        evaluateAnswer,
        evaluateRagas,
        answerLimit: evalScope === "core" ? coreCases.length : evaluateAnswer && Number.isFinite(parsedAnswerLimit) && parsedAnswerLimit > 0 ? parsedAnswerLimit : cases.length,
      })
      setResult(nextResult)
      const nextRuns = await listKnowledgeEvalRuns()
      setRunHistory(nextRuns)
      setSelectedRunId(nextResult.runId ?? nextRuns[0]?.runId ?? null)
      setStatus(`${formatEvalStatus(nextResult)}，结果已保存`)
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <main className="min-h-screen bg-[rgb(239_246_244)] bg-[linear-gradient(rgba(15,23,42,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(15,23,42,0.05)_1px,transparent_1px)] bg-[length:34px_34px] px-5 py-6 text-slate-900">
      <div className="mx-auto grid max-w-7xl gap-5">
        <header className="tk-topbar">
          <div>
            <h1 className="tk-page-title">TabKeep RAG 评估台</h1>
            <p className="tk-page-subtitle">检索与回答评估 · 支持独立语料基准</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className={`tk-badge ${backendReady ? "tk-badge-success" : "tk-badge-warning"}`}>
              {backendReady ? "后端可用" : "未连接"}
            </span>
            {activeBenchmark === "notes" && (
              <>
                <span className="tk-badge">{cases.length} 个用例</span>
                <span className="tk-badge">默认核心 {coreCases.length}</span>
                <span className="tk-badge">检索 {retrievalReadyCount}</span>
                <span className={`tk-badge ${answerReadyCount > 0 ? "tk-badge-success" : "tk-badge-warning"}`}>
                  答案 {answerReadyCount}
                </span>
                {result && <span className="tk-badge">Recall {formatPercent(result.recallAtK)}</span>}
                {result && <span className="tk-badge">Precision {formatPercent(result.precisionAtK)}</span>}
                {result && <span className="tk-badge">MRR {formatScore(result.mrr)}</span>}
                {result && <span className="tk-badge">{formatAnswerRunBadge(result)}</span>}
                {result?.ragasRequested && (
                  <span className={`tk-badge ${result.ragasFailed > 0 ? "tk-badge-warning" : "tk-badge-success"}`}>
                    Ragas {result.ragasEvaluated}/{result.ragasEligible}
                  </span>
                )}
                {runHistory.length > 0 && (
                  <select
                    className="tk-select !w-[220px] shrink-0"
                    value={selectedRunId ?? runHistory[0].runId}
                    onChange={(event) => void loadHistoricalRun(event.target.value)}
                    aria-label="评估历史记录"
                    title="加载历史评估结果">
                    {runHistory.map((item) => (
                      <option key={item.runId} value={item.runId}>
                        {formatRunHistoryLabel(item)}
                      </option>
                    ))}
                  </select>
                )}
                <Button variant="secondary" onClick={refresh} disabled={loading}>
                  <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                  刷新
                </Button>
              </>
            )}
          </div>
        </header>

        {status && <Notice tone={statusTone}>{status}</Notice>}

        <EvalConnectionPanel
          apiBaseUrl={apiBaseUrl}
          apiToken={apiToken}
          loading={loading}
          onApiBaseUrlChange={setApiBaseUrlState}
          onApiTokenChange={setApiTokenState}
          onSaveConnection={saveConnection}
        />

        <div className="inline-flex w-fit flex-wrap gap-1 rounded-lg border border-border bg-white/70 p-1" role="tablist" aria-label="评估基准">
          <button
            type="button"
            role="tab"
            aria-selected={activeBenchmark === "notes"}
            className={`rounded-md px-4 py-2 text-sm font-medium transition ${activeBenchmark === "notes" ? "bg-emerald-700 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"}`}
            onClick={() => setActiveBenchmark("notes")}>
            笔记集评估
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeBenchmark === "rgb"}
            className={`rounded-md px-4 py-2 text-sm font-medium transition ${activeBenchmark === "rgb" ? "bg-emerald-700 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"}`}
            onClick={() => setActiveBenchmark("rgb")}>
            RGB 独立语料
          </button>
        </div>

        {activeBenchmark === "notes" ? (
          <>
            <div className="grid gap-5 xl:grid-cols-[minmax(340px,0.95fr)_minmax(420px,1.05fr)]">
              <EvalCaseEditor
                draft={draft}
                editingCaseId={editingCaseId}
                saving={saving}
                onDraftChange={setDraft}
                onSaveDraft={saveDraft}
                onResetDraft={resetDraft}
              />
              <EvalCaseListPanel
                cases={cases}
                evalScope={evalScope}
                coreCount={coreCases.length}
                onEvalScopeChange={setEvalScope}
                retrievalReadyCount={selectedCases.filter(isRetrievalReadyCase).length}
                answerReadyCount={selectedCases.filter(isAnswerReadyCase).length}
                searchMode={searchMode}
                limit={limit}
                minScore={minScore}
                queryRewrite={queryRewrite}
                evaluateAnswer={evaluateAnswer}
                evaluateRagas={evaluateRagas}
                ragasReadyCount={selectedCases.filter((item) => !item.shouldRefuse && Boolean(item.expectedAnswer.trim())).length}
                answerLimit={answerLimit}
                running={running}
                saving={saving}
                onSearchModeChange={setSearchMode}
                onLimitChange={setLimit}
                onMinScoreChange={setMinScore}
                onQueryRewriteChange={setQueryRewrite}
                onEvaluateAnswerChange={(value) => {
                  setEvaluateAnswer(value)
                  if (!value) setEvaluateRagas(false)
                }}
                onEvaluateRagasChange={setEvaluateRagas}
                onAnswerLimitChange={setAnswerLimit}
                onRunEval={runEval}
                onEditCase={editCase}
                onRemoveCase={removeCase}
              />
            </div>
            {result && <EvalResultPanel result={result} onStatus={setStatus} />}
          </>
        ) : (
          <RgbBenchmarkPanel enabled={backendReady} onStatus={setStatus} />
        )}
      </div>
    </main>
  )
}

function formatRunHistoryLabel(item: KnowledgeEvalRunSummary): string {
  const time = new Date(item.createdAt).toLocaleString()
  const mode = item.evaluateRagas ? "Ragas" : item.evaluateAnswer ? "答案" : "检索"
  const version = item.datasetVersion || "旧版"
  const rewrite = item.queryRewriteEnabled ? "改写" : "原查询"
  return `${time} · ${version} · ${item.total} 条 · ${rewrite} · ${mode} · MRR ${formatScore(item.mrr)}`
}
