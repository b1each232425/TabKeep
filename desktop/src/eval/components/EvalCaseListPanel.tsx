import { Pencil, Search, Trash2 } from "lucide-react"

import type {
  KnowledgeEvalCase,
  KnowledgeSearchMode,
} from "../../types"
import {
  formatCaseType,
  safePositiveInt,
} from "../evalModel"
import { Button } from "./EvalControls"

export function EvalCaseListPanel({
  cases,
  evalScope,
  coreCount,
  onEvalScopeChange,
  retrievalReadyCount,
  answerReadyCount,
  searchMode,
  limit,
  minScore,
  queryRewrite,
  evaluateAnswer,
  evaluateRagas,
  ragasReadyCount,
  answerLimit,
  running,
  saving,
  onSearchModeChange,
  onLimitChange,
  onMinScoreChange,
  onQueryRewriteChange,
  onEvaluateAnswerChange,
  onEvaluateRagasChange,
  onAnswerLimitChange,
  onRunEval,
  onEditCase,
  onRemoveCase,
}: {
  cases: KnowledgeEvalCase[]
  evalScope: "core" | "full"
  coreCount: number
  onEvalScopeChange: (value: "core" | "full") => void
  retrievalReadyCount: number
  answerReadyCount: number
  searchMode: KnowledgeSearchMode
  limit: string
  minScore: string
  queryRewrite: boolean
  evaluateAnswer: boolean
  evaluateRagas: boolean
  ragasReadyCount: number
  answerLimit: string
  running: boolean
  saving: boolean
  onSearchModeChange: (value: KnowledgeSearchMode) => void
  onLimitChange: (value: string) => void
  onMinScoreChange: (value: string) => void
  onQueryRewriteChange: (value: boolean) => void
  onEvaluateAnswerChange: (value: boolean) => void
  onEvaluateRagasChange: (value: boolean) => void
  onAnswerLimitChange: (value: string) => void
  onRunEval: () => void
  onEditCase: (item: KnowledgeEvalCase) => void
  onRemoveCase: (caseId: string) => void
}) {
  return (
    <section className="tk-panel">
      <div className="tk-panel-header items-start">
        <div className="min-w-[10.5rem] shrink-0 pt-0.5">
          <h2 className="tk-panel-title">用例集</h2>
          <p className="whitespace-nowrap text-xs text-muted-foreground">
            本次 {evalScope === "core" ? coreCount : cases.length}/{cases.length} 条 · 检索 {retrievalReadyCount} · 答案 {answerReadyCount}
          </p>
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          <select className="tk-select !w-[142px] shrink-0" aria-label="评估范围" value={evalScope} onChange={(event) => onEvalScopeChange(event.target.value as "core" | "full")}>
            <option value="core">核心 {coreCount} 条</option>
            <option value="full">全量 {cases.length} 条</option>
          </select>
          <select
            className="tk-select !w-[120px] shrink-0"
            value={searchMode}
            onChange={(event) => onSearchModeChange(event.target.value as KnowledgeSearchMode)}>
            <option value="hybrid">Hybrid</option>
            <option value="fts">FTS</option>
            <option value="vector">Vector</option>
          </select>
          <input
            className="tk-input !w-[92px] shrink-0"
            type="number"
            min={1}
            max={50}
            value={limit}
            onChange={(event) => onLimitChange(event.target.value)}
            aria-label="评估召回数量"
          />
          <input
            className="tk-input !w-[92px] shrink-0"
            type="number"
            min={0}
            step={0.05}
            value={minScore}
            onChange={(event) => onMinScoreChange(event.target.value)}
            aria-label="评估最低分"
          />
          <label
            className={`inline-flex h-11 shrink-0 items-center gap-2 rounded-md border border-border px-3 text-sm ${
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
              onChange={(event) => onEvaluateAnswerChange(event.target.checked)}
            />
            答案评估
          </label>
          <label
            className={`inline-flex h-11 shrink-0 items-center gap-2 rounded-md border border-border px-3 text-sm ${
              evaluateAnswer && ragasReadyCount > 0
                ? "bg-white/75 text-slate-700"
                : "bg-slate-50 text-muted-foreground"
            }`}
            title={
              ragasReadyCount > 0
                ? "使用 Ragas 评估生成答案和检索上下文"
                : "Ragas 需要配置预期答案"
            }>
            <input
              type="checkbox"
              checked={evaluateRagas}
              disabled={!evaluateAnswer || ragasReadyCount === 0}
              onChange={(event) => onEvaluateRagasChange(event.target.checked)}
            />
            Ragas
          </label>
          <input
            className="tk-input !w-[92px] shrink-0"
            type="number"
            min={1}
            max={260}
            value={evalScope === "core" ? coreCount : answerLimit}
            disabled={evalScope === "core" || !evaluateAnswer || answerReadyCount === 0}
            onChange={(event) => onAnswerLimitChange(event.target.value)}
            aria-label="答案评估样本数"
            title="答案评估默认只抽样运行，避免一次调用过多模型服务"
          />
          <Button onClick={onRunEval} disabled={running || cases.length === 0 || (evalScope === "core" && coreCount === 0)}>
            <Search className="h-4 w-4" />
            {running ? "评估中..." : "运行评估"}
          </Button>
        </div>
      </div>
      <div className="tk-panel-body">
        <label className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-white/75 px-3 py-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={queryRewrite}
            disabled={running}
            onChange={(event) => onQueryRewriteChange(event.target.checked)}
          />
          启用 Query Rewrite
          <span className="text-xs leading-5 text-muted-foreground">
            仅自然语言问句且向量检索可用时调用模型；每题最多一次。
          </span>
        </label>
        {answerReadyCount === 0 && (
          <div className="mb-3 rounded-md border border-amber-100 bg-amber-50/70 px-3 py-2 text-xs leading-5 text-amber-800">
            当前没有答案评估用例；只会显示 Recall/Precision/MRR/Top1。填写预期答案、答案关键词或应拒答后，才会出现答案通过率、上下文支撑和拒答指标。
          </div>
        )}
        {answerReadyCount > 0 && !evaluateAnswer && (
          <div className="mb-3 rounded-md border border-blue-100 bg-blue-50/70 px-3 py-2 text-xs leading-5 text-blue-800">
            已有 {answerReadyCount} 条答案评估用例；勾选“答案评估”后才会调用问答链路并显示答案质量指标。
          </div>
        )}
        {answerReadyCount > 0 && evaluateAnswer && (
          <div className="mb-3 rounded-md border border-amber-100 bg-amber-50/70 px-3 py-2 text-xs leading-5 text-amber-800">
            答案评估会调用问答模型；本次最多评估 {evalScope === "core" ? coreCount : safePositiveInt(answerLimit, cases.length)} 条，默认优先跑拒答、困难问法和自然问法。
          </div>
        )}
        {evaluateRagas && (
          <div className="mb-3 rounded-md border border-violet-100 bg-violet-50/70 px-3 py-2 text-xs leading-5 text-violet-800">
            Ragas 会对 {ragasReadyCount} 条含预期答案的用例进行抽样评审，并复用本地缓存。每条用例会产生额外模型调用。
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
                      {item.isCore && <span className="tk-badge tk-badge-success">核心</span>}
                      {item.expectedText && <span className="tk-badge">文本</span>}
                      {item.expectedPath && <span className="tk-badge">路径</span>}
                      {item.expectedTitle && <span className="tk-badge">标题</span>}
                      {item.expectedDocumentId && <span className="tk-badge">文档 ID</span>}
                      {item.expectedParagraphId && <span className="tk-badge">段落 ID</span>}
                      {(item.additionalRelevantTargets?.length ?? 0) > 0 && (
                        <span className="tk-badge">
                          相关结果 {1 + item.additionalRelevantTargets.length}
                        </span>
                      )}
                      {item.expectedAnswer && <span className="tk-badge">答案</span>}
                      {item.answerKeywords && <span className="tk-badge">关键词</span>}
                      {item.shouldRefuse && <span className="tk-badge tk-badge-warning">拒答</span>}
                    </div>
                    {item.note && (
                      <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">{item.note}</p>
                    )}
                  </div>
                  <button className="tk-icon-button" onClick={() => onEditCase(item)} title="编辑">
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    className="tk-icon-button"
                    onClick={() => onRemoveCase(item.id)}
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
  )
}
