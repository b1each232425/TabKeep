import { useEffect, useMemo, useState } from "react"
import type { ButtonHTMLAttributes } from "react"
import {
  CheckCircle2,
  Copy,
  Folder,
  Pencil,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react"
import {
  BackendRequestError,
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
  KnowledgeCitation,
  KnowledgeEvalCase,
  KnowledgeEvalCaseRequest,
  KnowledgeEvalRunResponse,
  KnowledgeSearchMode,
} from "../types"

const EMPTY_EVAL_CASE: KnowledgeEvalCaseRequest = {
  question: "",
  caseType: "keyword",
  expectedText: "",
  expectedPath: "",
  expectedTitle: "",
  expectedDocumentId: "",
  expectedParagraphId: "",
  expectedAnswer: "",
  answerKeywords: "",
  shouldRefuse: false,
  note: "",
}

const CASE_TYPE_OPTIONS = [
  { value: "keyword", label: "关键词" },
  { value: "natural", label: "自然问法" },
  { value: "challenge", label: "困难问法" },
  { value: "negative", label: "拒答" },
] as const

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

        <section className="tk-panel">
          <div className="tk-panel-header">
            <div>
              <h2 className="tk-panel-title">连接</h2>
              <p className="text-xs text-muted-foreground">浏览器直连 TabKeep 后端</p>
            </div>
            <Settings2 className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="tk-panel-body">
            <div className="grid gap-3 lg:grid-cols-[minmax(260px,1fr)_minmax(260px,1fr)_auto]">
              <TextField
                label="API BaseURL"
                value={apiBaseUrl}
                onChange={setApiBaseUrlState}
                placeholder="http://127.0.0.1:38471"
              />
              <TextField
                label="API Token"
                type="password"
                value={apiToken}
                onChange={setApiTokenState}
                placeholder="开发模式可留空"
              />
              <div className="flex items-end">
                <Button onClick={saveConnection} disabled={loading}>
                  <CheckCircle2 className="h-4 w-4" />
                  应用连接
                </Button>
              </div>
            </div>
          </div>
        </section>

        <div className="grid gap-5 xl:grid-cols-[minmax(340px,0.95fr)_minmax(420px,1.05fr)]">
          <section className="tk-panel">
            <div className="tk-panel-header">
              <div>
                <h2 className="tk-panel-title">{editingCaseId ? "编辑用例" : "新增用例"}</h2>
                <p className="text-xs text-muted-foreground">用预期锚点标记正确召回</p>
              </div>
              {editingCaseId && (
                <Button variant="ghost" onClick={resetDraft}>
                  <X className="h-4 w-4" />
                  取消编辑
                </Button>
              )}
            </div>
            <div className="tk-panel-body space-y-3">
              <label className="tk-field">
                <span className="tk-label">问题</span>
                <textarea
                  className="tk-textarea min-h-20"
                  value={draft.question}
                  onChange={(event) => setDraft({ ...draft, question: event.target.value })}
                  placeholder="例如：TabKeep 的知识库同步按钮会处理哪些来源？"
                />
              </label>
              <label className="tk-field">
                <span className="tk-label">用例类型</span>
                <select
                  className="tk-select"
                  value={draft.caseType}
                  onChange={(event) => setDraft({ ...draft, caseType: event.target.value })}>
                  {CASE_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="tk-field">
                <span className="tk-label">预期命中文本</span>
                <textarea
                  className="tk-textarea min-h-24"
                  value={draft.expectedText}
                  onChange={(event) => setDraft({ ...draft, expectedText: event.target.value })}
                  placeholder="填一段应该被召回的原文"
                />
              </label>
              <div className="grid gap-3 md:grid-cols-2">
                <TextField
                  label="预期路径"
                  value={draft.expectedPath}
                  onChange={(value) => setDraft({ ...draft, expectedPath: value })}
                  placeholder="notes/rag.md"
                />
                <TextField
                  label="预期标题"
                  value={draft.expectedTitle}
                  onChange={(value) => setDraft({ ...draft, expectedTitle: value })}
                  placeholder="RAG 评估"
                />
                <TextField
                  label="Document ID"
                  value={draft.expectedDocumentId}
                  onChange={(value) => setDraft({ ...draft, expectedDocumentId: value })}
                  placeholder="可选"
                />
                <TextField
                  label="Paragraph ID"
                  value={draft.expectedParagraphId}
                  onChange={(value) => setDraft({ ...draft, expectedParagraphId: value })}
                  placeholder="可选"
                />
              </div>
              <label className="tk-field">
                <span className="tk-label">预期答案</span>
                <textarea
                  className="tk-textarea min-h-20"
                  value={draft.expectedAnswer}
                  onChange={(event) => setDraft({ ...draft, expectedAnswer: event.target.value })}
                  placeholder="可选，用于答案质量评估的参考答案"
                />
              </label>
              <label className="tk-field">
                <span className="tk-label">答案关键词</span>
                <textarea
                  className="tk-textarea min-h-16"
                  value={draft.answerKeywords}
                  onChange={(event) => setDraft({ ...draft, answerKeywords: event.target.value })}
                  placeholder="可选，逗号或换行分隔"
                />
              </label>
              <Checkbox
                label="应拒答"
                checked={draft.shouldRefuse}
                onChange={(checked) => setDraft({ ...draft, shouldRefuse: checked })}
              />
              <TextField
                label="备注"
                value={draft.note}
                onChange={(value) => setDraft({ ...draft, note: value })}
                placeholder="可选"
              />
            </div>
            <div className="tk-command-bar justify-between">
              <Button onClick={saveDraft} disabled={saving}>
                {saving ? "保存中..." : editingCaseId ? "保存修改" : "添加用例"}
              </Button>
              <Button variant="secondary" onClick={resetDraft} disabled={saving}>
                清空
              </Button>
            </div>
          </section>

          <section className="tk-panel">
            <div className="tk-panel-header">
              <div>
                <h2 className="tk-panel-title">用例集</h2>
                <p className="text-xs text-muted-foreground">
                  {cases.length} 条 · 检索 {retrievalReadyCount} · 答案 {answerReadyCount}
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-[120px_92px_92px_108px_auto_auto]">
                <select
                  className="tk-select"
                  value={searchMode}
                  onChange={(event) => setSearchMode(event.target.value as KnowledgeSearchMode)}>
                  <option value="hybrid">Hybrid</option>
                  <option value="fts">FTS</option>
                  <option value="vector">Vector</option>
                </select>
                <input
                  className="tk-input"
                  type="number"
                  min={1}
                  max={50}
                  value={limit}
                  onChange={(event) => setLimit(event.target.value)}
                  aria-label="评估召回数量"
                />
                <input
                  className="tk-input"
                  type="number"
                  min={0}
                  step={0.05}
                  value={minScore}
                  onChange={(event) => setMinScore(event.target.value)}
                  aria-label="评估最低分"
                />
                <label
                  className={`inline-flex h-11 items-center gap-2 rounded-md border border-border px-3 text-sm ${
                    answerReadyCount > 0
                      ? "bg-white/75 text-slate-700"
                      : "bg-slate-50 text-muted-foreground"
                  }`}
                  title={
                    answerReadyCount > 0
                      ? "运行答案质量与拒答评估"
                      : "当前没有配置预期答案、答案关键词或应拒答的用例"
                  }>
                  <input
                    type="checkbox"
                    checked={evaluateAnswer}
                    disabled={answerReadyCount === 0}
                    onChange={(event) => setEvaluateAnswer(event.target.checked)}
                  />
                  答案评估
                </label>
                <input
                  className="tk-input"
                  type="number"
                  min={1}
                  max={260}
                  value={answerLimit}
                  disabled={!evaluateAnswer || answerReadyCount === 0}
                  onChange={(event) => setAnswerLimit(event.target.value)}
                  aria-label="答案评估样本数"
                  title="答案评估默认只抽样运行，避免一次调用过多模型服务"
                />
                <Button onClick={runEval} disabled={running || cases.length === 0}>
                  <Search className="h-4 w-4" />
                  {running ? "评估中..." : "运行评估"}
                </Button>
              </div>
            </div>
            <div className="tk-panel-body">
              {answerReadyCount === 0 && (
                <div className="mb-3 rounded-md border border-amber-100 bg-amber-50/70 px-3 py-2 text-xs leading-5 text-amber-800">
                  当前没有答案评估用例；只会显示 Recall/MRR/Top1。填写预期答案、答案关键词或应拒答后，才会出现答案通过率、上下文支撑和拒答指标。
                </div>
              )}
              {answerReadyCount > 0 && !evaluateAnswer && (
                <div className="mb-3 rounded-md border border-blue-100 bg-blue-50/70 px-3 py-2 text-xs leading-5 text-blue-800">
                  已有 {answerReadyCount} 条答案评估用例；勾选“答案评估”后才会调用问答链路并显示答案质量指标。
                </div>
              )}
              {answerReadyCount > 0 && evaluateAnswer && (
                <div className="mb-3 rounded-md border border-amber-100 bg-amber-50/70 px-3 py-2 text-xs leading-5 text-amber-800">
                  答案评估会调用问答模型；本次最多评估 {safePositiveInt(answerLimit, 30)} 条，默认优先跑拒答、困难问法和自然问法。
                </div>
              )}
              {cases.length === 0 ? (
                <div className="tk-muted-box">暂无评估用例</div>
              ) : (
                <div className="grid max-h-[32rem] gap-2 overflow-auto pr-1">
                  {cases.map((item) => (
                    <div key={item.id} className="rounded-md border border-border bg-white/70 p-3">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="line-clamp-2 text-sm font-medium leading-6 text-slate-900">
                            {item.question}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            <span className="tk-badge tk-badge-success">{formatCaseType(item.caseType)}</span>
                            {item.expectedText && <span className="tk-badge">文本</span>}
                            {item.expectedPath && <span className="tk-badge">路径</span>}
                            {item.expectedTitle && <span className="tk-badge">标题</span>}
                            {item.expectedDocumentId && <span className="tk-badge">文档 ID</span>}
                            {item.expectedParagraphId && <span className="tk-badge">段落 ID</span>}
                            {item.expectedAnswer && <span className="tk-badge">答案</span>}
                            {item.answerKeywords && <span className="tk-badge">关键词</span>}
                            {item.shouldRefuse && <span className="tk-badge tk-badge-warning">拒答</span>}
                          </div>
                          {item.note && (
                            <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">{item.note}</p>
                          )}
                        </div>
                        <button className="tk-icon-button" onClick={() => editCase(item)} title="编辑">
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          className="tk-icon-button"
                          onClick={() => removeCase(item.id)}
                          title="删除"
                          disabled={saving}>
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>

        {result && <EvalResultPanel result={result} onStatus={setStatus} />}
      </div>
    </main>
  )
}

function EvalResultPanel({
  result,
  onStatus,
}: {
  result: KnowledgeEvalRunResponse
  onStatus: (message: string) => void
}) {
  return (
    <section className="tk-panel">
      <div className="tk-panel-header">
        <div>
          <h2 className="tk-panel-title">评估结果</h2>
          <p className="text-xs text-muted-foreground">
            {result.hitCount}/{retrievalEvaluatedCount(result)} 检索命中 · {result.searchMode}
            {result.answerEvaluated > 0
              ? ` · ${result.answerPassCount}/${result.answerEvaluated} 答案通过（${result.answerEvaluated}/${result.answerEligible} 已评估）`
              : ""}
          </p>
        </div>
      </div>
      <div className="tk-panel-body space-y-3">
        <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-5">
          <Metric title={`Recall@${result.limit}`} value={formatPercent(result.recallAtK)} />
          <Metric title="MRR" value={formatScore(result.mrr)} />
          <Metric title="Top1 命中率" value={formatPercent(result.top1Accuracy)} />
          <Metric title="检索命中" value={`${result.hitCount}/${retrievalEvaluatedCount(result)}`} />
          <Metric title="检索模式" value={result.searchMode} />
        </div>
        {result.answerEvaluated > 0 ? (
          <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-6">
            <Metric title="答案通过率" value={formatPercent(result.answerAccuracy)} />
            <Metric title="答案样本" value={`${result.answerEvaluated}/${result.answerEligible}`} />
            <Metric title="平均答案分" value={formatScore(result.averageAnswerScore)} />
            <Metric title="上下文支撑" value={formatPercent(result.averageFaithfulness)} />
            <Metric title="答案相关性" value={formatPercent(result.averageAnswerRelevance)} />
            <Metric
              title="拒答通过"
              value={
                result.refusalEvaluated > 0
                  ? `${result.refusalPassCount}/${result.refusalEvaluated}`
                  : "未评估"
              }
            />
          </div>
        ) : (
          <AnswerEvalEmptyState result={result} />
        )}
        <RankDistribution result={result} />
        <TypeSummaryPanel result={result} />
        <BadCasePanel result={result} onStatus={onStatus} />

        <div className="grid gap-2">
          {result.results.map((item) => {
            const bestRelevant = item.hits.find((hit) => hit.relevant)
            const previewHits = item.hits.slice(0, 5)
            const issueType = getResultIssueType(item)
            const issueMessage = getResultIssueMessage(item, issueType)
            const retrievalOk = issueType === "ok" || issueType === "not_evaluated"
            const cardOk = retrievalOk && (!item.answerEvaluated || item.answerOk !== false)
            return (
              <div
                key={item.case.id}
                className={`rounded-md border p-3 ${
                  cardOk ? "border-emerald-100 bg-emerald-50/45" : "border-amber-100 bg-amber-50/45"
                }`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`tk-badge ${item.rank ? "tk-badge-success" : "tk-badge-warning"}`}>
                    {item.rank ? `命中 #${item.rank}` : issueType === "not_evaluated" ? "不评估检索" : "未命中"}
                  </span>
                  <span className="tk-badge">{formatCaseType(item.case.caseType)}</span>
                  <span className="tk-badge">RR {formatScore(item.reciprocalRank)}</span>
                  {issueType !== "ok" && (
                    <span className="tk-badge tk-badge-warning">{formatIssueType(issueType)}</span>
                  )}
                  {item.answerEvaluated && (
                    <span className={`tk-badge ${item.answerOk ? "tk-badge-success" : "tk-badge-warning"}`}>
                      {item.answerOk ? "答案通过" : "答案问题"}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-950">
                    {item.case.question}
                  </span>
                </div>
                {issueType !== "ok" && issueMessage && (
                  <p className="mt-2 text-xs leading-5 text-amber-800">{issueMessage}</p>
                )}
                {item.answerEvaluated && <AnswerEvalBox item={item} />}
                {item.error ? (
                  <p className="mt-2 text-sm text-amber-800">{item.error}</p>
                ) : (
                  <div className="mt-3 grid gap-2">
                    {bestRelevant && (
                      <HitCard hit={bestRelevant} primary onStatus={onStatus} />
                    )}
                    <div className="grid gap-2">
                      {previewHits.map((hit) => (
                        <HitCard key={`${item.case.id}:${hit.rank}`} hit={hit} onStatus={onStatus} />
                      ))}
                      {previewHits.length === 0 && <div className="tk-muted-box">没有召回结果</div>}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function TypeSummaryPanel({ result }: { result: KnowledgeEvalRunResponse }) {
  const summaries = result.typeSummaries ?? []
  if (summaries.length === 0) {
    return null
  }
  return (
    <div className="rounded-md border border-slate-200/80 bg-slate-50 px-3 py-3">
      <p className="text-xs font-medium text-slate-700">分层统计</p>
      <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {summaries.map((summary) => (
          <div key={summary.caseType} className="rounded-md border border-border bg-white/70 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="tk-badge tk-badge-success">{formatCaseType(summary.caseType)}</span>
              <span className="text-xs text-muted-foreground">{summary.hitCount}/{summary.total}</span>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
              <div>
                <p className="text-muted-foreground">R@{result.limit}</p>
                <p className="mt-1 font-semibold text-slate-950">{formatPercent(summary.recallAtK)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Top1</p>
                <p className="mt-1 font-semibold text-slate-950">{formatPercent(summary.top1Accuracy)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">MRR</p>
                <p className="mt-1 font-semibold text-slate-950">{formatScore(summary.mrr)}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function AnswerEvalEmptyState({ result }: { result: KnowledgeEvalRunResponse }) {
  const eligible = result.answerEligible ?? 0
  return (
    <div className="rounded-md border border-amber-100 bg-amber-50/60 px-3 py-3 text-sm leading-6 text-amber-800">
      {eligible > 0
        ? `本次没有运行答案评估；已有 ${eligible} 条答案型用例，下次运行前请勾选“答案评估”。`
        : "本次没有答案评估结果；当前用例没有配置预期答案、答案关键词或应拒答条件。"}
    </div>
  )
}

function BadCasePanel({
  result,
  onStatus,
}: {
  result: KnowledgeEvalRunResponse
  onStatus: (message: string) => void
}) {
  const badCases = result.results.filter((item) => isProblemCase(item))
  if (badCases.length === 0) {
    return (
      <div className="rounded-md border border-emerald-100 bg-emerald-50 px-3 py-3 text-sm text-emerald-700">
        暂无问题 case
      </div>
    )
  }
  return (
    <div className="rounded-md border border-amber-100 bg-amber-50/60 px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-amber-900">问题 case</p>
        <span className="tk-badge tk-badge-warning">{badCases.length} 条</span>
      </div>
      <div className="mt-3 grid max-h-[30rem] gap-2 overflow-auto pr-1">
        {badCases.map((item) => {
          const topHit = item.hits[0]
          const issueType = getResultIssueType(item)
          const issueMessage = getResultIssueMessage(item, issueType)
          return (
            <div key={`bad:${item.case.id}`} className="rounded-md border border-amber-100 bg-white/80 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="tk-badge tk-badge-warning">{formatIssueType(issueType)}</span>
                <span className="tk-badge">{formatCaseType(item.case.caseType)}</span>
                <span className="tk-badge">RR {formatScore(item.reciprocalRank)}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-950">
                  {item.case.question}
                </span>
              </div>
              {issueMessage && <p className="mt-2 text-xs leading-5 text-amber-800">{issueMessage}</p>}
              {item.answerEvaluated && <AnswerEvalBox item={item} compact />}
              {topHit && (
                <div className="mt-2">
                  <HitCard hit={topHit} onStatus={onStatus} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function AnswerEvalBox({
  item,
  compact = false,
}: {
  item: KnowledgeEvalRunResponse["results"][number]
  compact?: boolean
}) {
  if (!item.answerEvaluated) return null
  return (
    <div className="mt-2 rounded-md border border-slate-200/80 bg-white/70 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`tk-badge ${item.answerOk ? "tk-badge-success" : "tk-badge-warning"}`}>
          {item.answerOk ? "答案 OK" : formatIssueType(item.answerIssueType)}
        </span>
        <span className="tk-badge">Score {formatScore(item.answerScore)}</span>
        <span className="tk-badge">关键词 {formatPercent(item.answerKeywordCoverage)}</span>
        <span className="tk-badge">支撑 {formatPercent(item.answerFaithfulness)}</span>
        <span className="tk-badge">相关 {formatPercent(item.answerRelevance)}</span>
      </div>
      {item.answerIssueMessage && (
        <p className="mt-2 text-xs leading-5 text-slate-700">{item.answerIssueMessage}</p>
      )}
      {item.missingAnswerKeywords.length > 0 && (
        <p className="mt-1 text-xs leading-5 text-amber-800">
          缺少关键词：{item.missingAnswerKeywords.slice(0, 6).join("、")}
        </p>
      )}
      {!compact && item.answer && (
        <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-xs leading-5 text-slate-600">
          {item.answer}
        </p>
      )}
    </div>
  )
}

function HitCard({
  hit,
  primary = false,
  onStatus,
}: {
  hit: KnowledgeEvalRunResponse["results"][number]["hits"][number]
  primary?: boolean
  onStatus: (message: string) => void
}) {
  return (
    <div
      className={`rounded-md border bg-white/75 px-3 py-2 ${
        primary ? "border-emerald-100" : "border-border"
      }`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`tk-badge ${hit.relevant ? "tk-badge-success" : ""}`}>
          {primary ? "相关命中" : hit.relevant ? "相关" : `#${hit.rank}`}
        </span>
        {!primary && <span className="tk-badge">{hit.relevant ? `#${hit.rank}` : "召回"}</span>}
        {hit.matchedBy.map((source) => (
          <span key={source} className="tk-badge">
            {formatRetrievalSource(source)}
          </span>
        ))}
        {hit.matchedExpectations.map((expectation) => (
          <span key={`${hit.rank}:${expectation}`} className={`tk-badge ${hit.relevant ? "tk-badge-success" : ""}`}>
            {formatEvalExpectation(expectation)}
          </span>
        ))}
        {hit.rerankScore !== null && hit.rerankScore !== undefined && (
          <span className="tk-badge tk-badge-success">Rerank {formatScore(hit.rerankScore)}</span>
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">{hit.title}</span>
        <button className="tk-icon-button" title="打开来源" disabled={!sourceTarget(hit)} onClick={() => openSource(hit, onStatus)}>
          <Folder className="h-4 w-4" />
        </button>
        <button className="tk-icon-button" title="复制来源" onClick={() => copySource(hit, onStatus)}>
          <Copy className="h-4 w-4" />
        </button>
      </div>
      <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-xs leading-5 text-slate-700">
        {hit.matchedContent || hit.content}
      </p>
    </div>
  )
}

function Metric({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-md border border-slate-200/80 bg-slate-50 px-3 py-2">
      <p className="text-xs text-muted-foreground">{title}</p>
      <p className="mt-1 text-sm font-semibold text-slate-950">{value}</p>
    </div>
  )
}

function RankDistribution({ result }: { result: KnowledgeEvalRunResponse }) {
  const buckets = result.rankDistribution ?? []
  if (buckets.length === 0) {
    return <div className="tk-muted-box">暂无 rank 分布</div>
  }
  const denominator = retrievalEvaluatedCount(result)
  return (
    <div className="rounded-md border border-slate-200/80 bg-slate-50 px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-slate-700">Rank 分布</p>
        <p className="text-xs text-muted-foreground">正确结果第一次出现的位置</p>
      </div>
      <div className="mt-3 grid gap-2">
        {buckets.map((bucket) => {
          const ratio = denominator > 0 ? bucket.count / denominator : 0
          return (
            <div key={bucket.rank} className="grid items-center gap-2 sm:grid-cols-[48px_minmax(0,1fr)_72px]">
              <span className="text-xs font-medium text-slate-600">#{bucket.rank}</span>
              <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full rounded-full bg-emerald-500"
                  style={{ width: `${Math.max(2, Math.round(ratio * 100))}%` }}
                />
              </div>
              <span className="text-right text-xs text-slate-600">
                {bucket.count} · {formatPercent(ratio)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Notice({
  children,
  tone = "neutral",
}: {
  children: string
  tone?: "success" | "warning" | "neutral"
}) {
  const className =
    tone === "success"
      ? "border-green-100 bg-green-50 text-green-700 before:bg-green-500"
      : tone === "warning"
        ? "border-amber-100 bg-amber-50 text-amber-800 before:bg-amber-500"
        : "border-blue-100 bg-blue-50 text-blue-800 before:bg-blue-500"
  return (
    <div className={`relative overflow-hidden rounded-md border px-3 py-2 pl-4 text-sm leading-6 before:absolute before:inset-y-0 before:left-0 before:w-1 before:content-[''] ${className}`}>
      {children}
    </div>
  )
}

function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost"
}) {
  const base =
    variant === "secondary"
      ? "tk-secondary-button"
      : variant === "ghost"
        ? "tk-ghost-button"
        : "tk-primary-button"
  return <button className={`${base} ${className}`} {...props} />
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: string
}) {
  return (
    <label className="tk-field">
      <span className="tk-label">{label}</span>
      <input
        className="tk-input"
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </label>
  )
}

function isRetrievalReadyCase(item: KnowledgeEvalCaseRequest): boolean {
  return Boolean(
    item.expectedText.trim() ||
      item.expectedPath.trim() ||
      item.expectedTitle.trim() ||
      item.expectedDocumentId.trim() ||
      item.expectedParagraphId.trim(),
  )
}

function isAnswerReadyCase(item: KnowledgeEvalCaseRequest): boolean {
  return Boolean(item.expectedAnswer.trim() || item.answerKeywords.trim() || item.shouldRefuse)
}

function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-white/70 px-3 py-2 text-sm text-slate-700">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  )
}

function hasExpectation(draft: KnowledgeEvalCaseRequest): boolean {
  return isRetrievalReadyCase(draft) || isAnswerReadyCase(draft)
}

function formatEvalStatus(result: KnowledgeEvalRunResponse): string {
  const retrieval = `${result.hitCount}/${retrievalEvaluatedCount(result)} 检索命中`
  const answer =
    result.answerEvaluated > 0
      ? `，答案样本 ${result.answerPassCount}/${result.answerEvaluated} 通过（${result.answerEvaluated}/${result.answerEligible} 已评估）`
      : (result.answerEligible ?? 0) > 0
        ? `，答案评估未运行（${result.answerEligible} 条可评估）`
        : "，答案评估 0 条可评估"
  return `RAG 评估完成：${retrieval}${answer}，Recall@${result.limit} ${formatPercent(result.recallAtK)}，Top1 ${formatPercent(result.top1Accuracy)}，MRR ${formatScore(result.mrr)}`
}

function retrievalEvaluatedCount(result: KnowledgeEvalRunResponse): number {
  return result.retrievalEvaluated ?? result.evaluated
}

function formatAnswerRunBadge(result: KnowledgeEvalRunResponse): string {
  if (result.answerEvaluated > 0) {
    return `答案 ${result.answerEvaluated}/${result.answerEligible}`
  }
  const eligible = result.answerEligible ?? 0
  return eligible > 0 ? `答案未跑 ${eligible}` : "答案 0"
}

function safePositiveInt(value: string, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.round(parsed)
}

function formatPercent(value: number): string {
  return `${Math.round((value || 0) * 100)}%`
}

function formatScore(value?: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-"
  if (Math.abs(value) >= 100) return value.toFixed(1)
  if (Math.abs(value) >= 1) return value.toFixed(3)
  return value.toFixed(4)
}

function formatCaseType(value?: string): string {
  if (value === "keyword") return "关键词"
  if (value === "natural") return "自然问法"
  if (value === "challenge") return "困难问法"
  if (value === "negative") return "拒答"
  return value || "关键词"
}

function getResultIssueType(item: KnowledgeEvalRunResponse["results"][number]): string {
  if (item.error) return "error"
  if (item.issueType && item.issueType !== "ok" && item.issueType !== "not_evaluated") return item.issueType
  if (item.answerEvaluated && item.answerOk === false) return item.answerIssueType || "answer_quality"
  if (item.issueType && item.issueType !== "ok") return item.issueType
  if (item.issueType === "ok") return "ok"
  if (item.issueType === "not_evaluated") return item.answerEvaluated && item.answerOk ? "ok" : "not_evaluated"
  if (item.rank === 1) return "ok"
  if (!item.hits.length) return "no_results"
  if (item.rank && item.rank > 1) return "late_hit"
  return "missed"
}

function isProblemCase(item: KnowledgeEvalRunResponse["results"][number]): boolean {
  const issueType = getResultIssueType(item)
  if (issueType !== "ok" && issueType !== "not_evaluated") return true
  return item.answerEvaluated && item.answerOk === false
}

function getResultIssueMessage(
  item: KnowledgeEvalRunResponse["results"][number],
  issueType: string,
): string {
  if (item.answerEvaluated && item.answerOk === false) {
    return item.answerIssueMessage || "答案评估未通过。"
  }
  if (item.issueMessage) return item.issueMessage
  if (issueType === "error") return item.error || "评估运行异常。"
  if (issueType === "not_evaluated") return "未配置检索预期；这个用例只参与答案或拒答评估。"
  if (issueType === "answer_quality") return item.answerIssueMessage || "答案质量未达到预期。"
  if (issueType === "refusal_failed") return item.answerIssueMessage || "应拒答的问题给出了实质性回答。"
  if (issueType === "model_config") return item.answerIssueMessage || "模型配置不完整，无法运行答案评估。"
  if (issueType === "llm_error") return item.answerIssueMessage || "LLM 调用失败。"
  if (issueType === "no_context") return item.answerIssueMessage || "没有检索上下文。"
  if (issueType === "no_results") return "没有召回结果，优先检查索引、Embedding 配置和检索模式。"
  if (issueType === "late_hit") return `正确结果出现在第 ${item.rank} 名，召回可用但排序仍可优化。`
  if (issueType === "missed") return "TopK 内没有满足预期的结果，可检查问题表达、切块边界或预期锚点。"
  return ""
}

function formatIssueType(value?: string): string {
  if (value === "late_hit") return "排序靠后"
  if (value === "missed") return "未命中"
  if (value === "no_results") return "无结果"
  if (value === "error") return "异常"
  if (value === "not_evaluated") return "未评估检索"
  if (value === "answer_quality") return "答案问题"
  if (value === "refusal_failed") return "拒答失败"
  if (value === "model_config") return "模型配置"
  if (value === "llm_error") return "LLM 异常"
  if (value === "no_context") return "无上下文"
  return value || "问题"
}

function formatEvalExpectation(value: string): string {
  if (value === "documentId") return "文档 ID"
  if (value === "paragraphId") return "段落 ID"
  if (value === "path") return "路径"
  if (value === "title") return "标题"
  if (value === "text") return "文本"
  return value
}

function formatRetrievalSource(value: string): string {
  if (value === "source") return "来源"
  if (value === "fts") return "FTS"
  if (value === "vector") return "Vector"
  if (value === "rerank") return "Rerank"
  return value || "来源"
}

function sourceTarget(item: KnowledgeCitation): string {
  return item.url || item.path || ""
}

function openSource(item: KnowledgeCitation, onStatus: (message: string) => void): void {
  const target = sourceTarget(item)
  if (!target) {
    onStatus("这个来源没有可打开的路径")
    return
  }
  window.open(target, "_blank", "noopener,noreferrer")
  onStatus("已打开来源")
}

async function copySource(item: KnowledgeCitation, onStatus: (message: string) => void): Promise<void> {
  const target = sourceTarget(item) || item.documentId
  try {
    await navigator.clipboard.writeText(target)
    onStatus("来源已复制")
  } catch (err) {
    onStatus(`复制来源失败: ${errorMessage(err)}`)
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof BackendRequestError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}
