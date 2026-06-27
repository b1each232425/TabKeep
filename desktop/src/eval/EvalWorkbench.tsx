import { useEffect, useMemo, useState } from "react"
import { RefreshCw } from "lucide-react"

import {
  checkBackendHealth,
  deleteKnowledgeEvalCase,
  getBrowserApiBaseUrl,
  getBrowserApiToken,
  listKnowledgeEvalCases,
  runKnowledgeEval,
  saveKnowledgeEvalCase,
  setBrowserApiBaseUrl,
  setBrowserApiToken,
} from "../api"
import type {
  KnowledgeEvalCase,
  KnowledgeEvalCaseRequest,
  KnowledgeEvalRunResponse,
  KnowledgeSearchMode,
} from "../types"
import { EvalCaseEditor } from "./components/EvalCaseEditor"
import { EvalCaseListPanel } from "./components/EvalCaseListPanel"
import { EvalConnectionPanel } from "./components/EvalConnectionPanel"
import { Button, Notice } from "./components/EvalControls"
import { EvalResultPanel } from "./components/EvalResultPanel"
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
  const [cases, setCases] = useState<KnowledgeEvalCase[]>([])
  const [draft, setDraft] = useState<KnowledgeEvalCaseRequest>({ ...EMPTY_EVAL_CASE })
  const [editingCaseId, setEditingCaseId] = useState<string | null>(null)
  const [limit, setLimit] = useState("10")
  const [searchMode, setSearchMode] = useState<KnowledgeSearchMode>("hybrid")
  const [minScore, setMinScore] = useState("0")
  const [evaluateAnswer, setEvaluateAnswer] = useState(false)
  const [answerLimit, setAnswerLimit] = useState("30")
  const [result, setResult] = useState<KnowledgeEvalRunResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const retrievalReadyCount = useMemo(() => cases.filter(isRetrievalReadyCase).length, [cases])
  const answerReadyCount = useMemo(() => cases.filter(isAnswerReadyCase).length, [cases])

  const statusTone = useMemo<"success" | "warning" | "neutral">(() => {
    if (!status) return "neutral"
    return status.includes("完成") ||
      status.includes("已保存") ||
      status.includes("已删除") ||
      status.includes("已连接") ||
      status.includes("已复制") ||
      status.includes("已打开")
      ? "success"
      : "warning"
  }, [status])

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
      const nextCases = await listKnowledgeEvalCases()
      setCases(nextCases)
      setStatus(`已连接后端，加载 ${nextCases.length} 条评估用例`)
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
      expectedAnswer: item.expectedAnswer ?? "",
      answerKeywords: item.answerKeywords ?? "",
      shouldRefuse: Boolean(item.shouldRefuse),
      note: item.note,
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
    setRunning(true)
    setStatus(null)
    try {
      const parsedLimit = Number(limit)
      const parsedMinScore = Number(minScore)
      const parsedAnswerLimit = Number(answerLimit)
      const nextResult = await runKnowledgeEval({
        limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 10,
        searchMode,
        minScore: Number.isFinite(parsedMinScore) && parsedMinScore > 0 ? parsedMinScore : 0,
        evaluateAnswer,
        answerLimit:
          evaluateAnswer && Number.isFinite(parsedAnswerLimit) && parsedAnswerLimit > 0
            ? parsedAnswerLimit
            : 30,
      })
      setResult(nextResult)
      setStatus(formatEvalStatus(nextResult))
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
            <p className="tk-page-subtitle">独立浏览器工作台</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className={`tk-badge ${backendReady ? "tk-badge-success" : "tk-badge-warning"}`}>
              {backendReady ? "后端可用" : "未连接"}
            </span>
            <span className="tk-badge">{cases.length} 个用例</span>
            <span className="tk-badge">检索 {retrievalReadyCount}</span>
            <span className={`tk-badge ${answerReadyCount > 0 ? "tk-badge-success" : "tk-badge-warning"}`}>
              答案 {answerReadyCount}
            </span>
            {result && <span className="tk-badge">Recall {formatPercent(result.recallAtK)}</span>}
            {result && <span className="tk-badge">MRR {formatScore(result.mrr)}</span>}
            {result && <span className="tk-badge">{formatAnswerRunBadge(result)}</span>}
            <Button variant="secondary" onClick={refresh} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              刷新
            </Button>
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
            retrievalReadyCount={retrievalReadyCount}
            answerReadyCount={answerReadyCount}
            searchMode={searchMode}
            limit={limit}
            minScore={minScore}
            evaluateAnswer={evaluateAnswer}
            answerLimit={answerLimit}
            running={running}
            saving={saving}
            onSearchModeChange={setSearchMode}
            onLimitChange={setLimit}
            onMinScoreChange={setMinScore}
            onEvaluateAnswerChange={setEvaluateAnswer}
            onAnswerLimitChange={setAnswerLimit}
            onRunEval={runEval}
            onEditCase={editCase}
            onRemoveCase={removeCase}
          />
        </div>

        {result && <EvalResultPanel result={result} onStatus={setStatus} />}
      </div>
    </main>
  )
}
