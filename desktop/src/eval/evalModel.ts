import { BackendRequestError } from "../api"
import type {
  KnowledgeCitation,
  KnowledgeEvalCaseRequest,
  KnowledgeEvalRunResponse,
} from "../types"

export const EMPTY_EVAL_CASE: KnowledgeEvalCaseRequest = {
  question: "",
  caseType: "keyword",
  expectedText: "",
  expectedPath: "",
  expectedTitle: "",
  expectedDocumentId: "",
  expectedParagraphId: "",
  additionalRelevantTargets: [],
  expectedAnswer: "",
  answerKeywords: "",
  shouldRefuse: false,
  note: "",
}

export const CASE_TYPE_OPTIONS = [
  { value: "keyword", label: "关键词" },
  { value: "natural", label: "自然问法" },
  { value: "challenge", label: "困难问法" },
  { value: "negative", label: "拒答" },
] as const

export function isRetrievalReadyCase(item: KnowledgeEvalCaseRequest): boolean {
  return Boolean(
    item.expectedText.trim() ||
      item.expectedPath.trim() ||
      item.expectedTitle.trim() ||
      item.expectedDocumentId.trim() ||
      item.expectedParagraphId.trim() ||
      (item.additionalRelevantTargets ?? []).some((target) =>
        Boolean(
          target.text.trim() ||
            target.path.trim() ||
            target.title.trim() ||
            target.documentId.trim() ||
            target.paragraphId.trim(),
        ),
      ),
  )
}

export function isAnswerReadyCase(item: KnowledgeEvalCaseRequest): boolean {
  return Boolean(item.expectedAnswer.trim() || item.answerKeywords.trim() || item.shouldRefuse)
}

export function hasExpectation(draft: KnowledgeEvalCaseRequest): boolean {
  return isRetrievalReadyCase(draft) || isAnswerReadyCase(draft)
}

export function formatEvalStatus(result: KnowledgeEvalRunResponse): string {
  const retrieval = `${result.hitCount}/${retrievalEvaluatedCount(result)} 检索命中`
  const answer =
    result.answerEvaluated > 0
      ? `，答案样本 ${result.answerPassCount}/${result.answerEvaluated} 通过（${result.answerEvaluated}/${result.answerEligible} 已评估）`
      : (result.answerEligible ?? 0) > 0
        ? `，答案评估未运行（${result.answerEligible} 条可评估）`
        : "，答案评估 0 条可评估"
  const ragas = result.ragasRequested
    ? `，Ragas ${result.ragasEvaluated}/${result.ragasEligible}${result.ragasFailed > 0 ? `（失败 ${result.ragasFailed}）` : ""}`
    : ""
  return `RAG 评估完成：${retrieval}${answer}${ragas}，Recall@${result.limit} ${formatPercent(result.recallAtK)}，Precision@${result.limit} ${formatPercent(result.precisionAtK)}，Top1 ${formatPercent(result.top1Accuracy)}，MRR ${formatScore(result.mrr)}`
}

export function retrievalEvaluatedCount(result: KnowledgeEvalRunResponse): number {
  return result.retrievalEvaluated ?? result.evaluated
}

export function formatAnswerRunBadge(result: KnowledgeEvalRunResponse): string {
  if (result.answerEvaluated > 0) {
    return `答案 ${result.answerEvaluated}/${result.answerEligible}`
  }
  const eligible = result.answerEligible ?? 0
  return eligible > 0 ? `答案未跑 ${eligible}` : "答案 0"
}

export function safePositiveInt(value: string, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.round(parsed)
}

export function formatPercent(value: number): string {
  return `${Math.round((value || 0) * 100)}%`
}

export function formatScore(value?: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-"
  if (Math.abs(value) >= 100) return value.toFixed(1)
  if (Math.abs(value) >= 1) return value.toFixed(3)
  return value.toFixed(4)
}

export function formatCaseType(value?: string): string {
  if (value === "keyword") return "关键词"
  if (value === "natural") return "自然问法"
  if (value === "challenge") return "困难问法"
  if (value === "negative") return "拒答"
  return value || "关键词"
}

export function getResultIssueType(item: KnowledgeEvalRunResponse["results"][number]): string {
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

export function isProblemCase(item: KnowledgeEvalRunResponse["results"][number]): boolean {
  const issueType = getResultIssueType(item)
  if (issueType !== "ok" && issueType !== "not_evaluated") return true
  return item.answerEvaluated && item.answerOk === false
}

export function getResultIssueMessage(
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

export function formatIssueType(value?: string): string {
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

export function formatEvalExpectation(value: string): string {
  if (value === "documentId") return "文档 ID"
  if (value === "paragraphId") return "段落 ID"
  if (value === "path") return "路径"
  if (value === "title") return "标题"
  if (value === "text") return "文本"
  return value
}

export function formatRetrievalSource(value: string): string {
  if (value === "source") return "来源"
  if (value === "fts") return "FTS"
  if (value === "vector") return "Vector"
  if (value === "rerank") return "Rerank"
  return value || "来源"
}

export function sourceTarget(item: KnowledgeCitation): string {
  return item.url || item.path || ""
}

export function openSource(item: KnowledgeCitation, onStatus: (message: string) => void): void {
  const target = sourceTarget(item)
  if (!target) {
    onStatus("这个来源没有可打开的路径")
    return
  }
  window.open(target, "_blank", "noopener,noreferrer")
  onStatus("已打开来源")
}

export async function copySource(item: KnowledgeCitation, onStatus: (message: string) => void): Promise<void> {
  const target = sourceTarget(item) || item.documentId
  try {
    await navigator.clipboard.writeText(target)
    onStatus("来源已复制")
  } catch (err) {
    onStatus(`复制来源失败: ${errorMessage(err)}`)
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof BackendRequestError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}
