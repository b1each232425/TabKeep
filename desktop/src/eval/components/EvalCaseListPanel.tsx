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
  retrievalReadyCount,
  answerReadyCount,
  searchMode,
  limit,
  minScore,
  evaluateAnswer,
  answerLimit,
  running,
  saving,
  onSearchModeChange,
  onLimitChange,
  onMinScoreChange,
  onEvaluateAnswerChange,
  onAnswerLimitChange,
  onRunEval,
  onEditCase,
  onRemoveCase,
}: {
  cases: KnowledgeEvalCase[]
  retrievalReadyCount: number
  answerReadyCount: number
  searchMode: KnowledgeSearchMode
  limit: string
  minScore: string
  evaluateAnswer: boolean
  answerLimit: string
  running: boolean
  saving: boolean
  onSearchModeChange: (value: KnowledgeSearchMode) => void
  onLimitChange: (value: string) => void
  onMinScoreChange: (value: string) => void
  onEvaluateAnswerChange: (value: boolean) => void
  onAnswerLimitChange: (value: string) => void
  onRunEval: () => void
  onEditCase: (item: KnowledgeEvalCase) => void
  onRemoveCase: (caseId: string) => void
}) {
  return (
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
            onChange={(event) => onSearchModeChange(event.target.value as KnowledgeSearchMode)}>
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
            onChange={(event) => onLimitChange(event.target.value)}
            aria-label="评估召回数量"
          />
          <input
            className="tk-input"
            type="number"
            min={0}
            step={0.05}
            value={minScore}
            onChange={(event) => onMinScoreChange(event.target.value)}
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
              onChange={(event) => onEvaluateAnswerChange(event.target.checked)}
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
            onChange={(event) => onAnswerLimitChange(event.target.value)}
            aria-label="答案评估样本数"
            title="答案评估默认只抽样运行，避免一次调用过多模型服务"
          />
          <Button onClick={onRunEval} disabled={running || cases.length === 0}>
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
