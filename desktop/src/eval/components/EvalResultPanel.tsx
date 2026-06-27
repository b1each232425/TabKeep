import { Copy, Folder } from "lucide-react"

import type { KnowledgeEvalRunResponse } from "../../types"
import {
  copySource,
  formatCaseType,
  formatEvalExpectation,
  formatIssueType,
  formatPercent,
  formatRetrievalSource,
  formatScore,
  getResultIssueMessage,
  getResultIssueType,
  isProblemCase,
  openSource,
  retrievalEvaluatedCount,
  sourceTarget,
} from "../evalModel"

export function EvalResultPanel({
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
