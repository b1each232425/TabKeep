export type EvaluationLabel = "interested" | "not_interested" | "unsure"
export type EvaluationMode = "keyword" | "semantic" | "hybrid" | "rrf"
export type EvaluationSampleSize = 30 | 100

export interface EvaluationItem {
  itemId: string
  title: string
  excerpt: string
  label: EvaluationLabel | null
}

export interface EvaluationBatch {
  runId: string
  algorithmVersion: string
  sampleSize: number
  items: EvaluationItem[]
}

export interface EvaluationMetric {
  ndcgAll: number
  averagePrecision: number
  pairwiseAuc: number | null
  coverage: number
  rankedCount: number
  judgedCount: number
}

export interface EvaluationRankedItem {
  itemId: string
  label: EvaluationLabel
  reason: string
}

export interface EvaluationGroupSummary {
  sampleCount: number
  labeledCount: number
  judgedCount: number
  interestedCount: number
  notInterestedCount: number
  unsureCount: number
  randomBaseline: Pick<EvaluationMetric, "ndcgAll" | "averagePrecision" | "pairwiseAuc">
  metrics: Record<EvaluationMode, EvaluationMetric>
}

export interface EvaluationSampleCoverage {
  sourceCount: number
  publicationMonthCount: number
  keywordRankBands: Record<string, number>
}

export interface EvaluationReport {
  runId: string
  algorithmVersion: string
  embeddingModel: string
  rrfRankConstant: number
  sampleSize: number
  judgedCount: number
  metricsSufficient: boolean
  metrics: Record<EvaluationMode, EvaluationMetric>
  sampleCoverage: EvaluationSampleCoverage
  sampleGroups: Record<string, EvaluationGroupSummary>
  randomBaseline: Pick<EvaluationMetric, "ndcgAll" | "averagePrecision" | "pairwiseAuc">
  recommendation: string
  topItems: Record<EvaluationMode, EvaluationRankedItem[]>
  reportPath: string
}

export interface SavedLabels {
  labeledCount: number
  sampleSize: number
  readyToEvaluate: boolean
}

export class EvaluationApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = "EvaluationApiError"
  }
}

async function request<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (!response.ok) {
    const detail =
      payload && typeof payload === "object" && "detail" in payload && typeof payload.detail === "string"
        ? payload.detail
        : `请求失败（HTTP ${response.status}）`
    throw new EvaluationApiError(detail, response.status)
  }
  return payload as T
}

export function prepareEvaluation(sampleSize: EvaluationSampleSize): Promise<Omit<EvaluationBatch, "items">> {
  return request("POST", "/news/dev/recommendation-evaluation/runs", { sampleSize })
}

export function getEvaluationBatch(runId: string): Promise<EvaluationBatch> {
  return request("GET", `/news/dev/recommendation-evaluation/runs/${encodeURIComponent(runId)}`)
}

export function saveEvaluationLabel(
  runId: string,
  itemId: string,
  label: EvaluationLabel,
): Promise<SavedLabels> {
  return request("PUT", `/news/dev/recommendation-evaluation/runs/${encodeURIComponent(runId)}/labels`, {
    labels: { [itemId]: label },
  })
}

export function runEvaluation(runId: string): Promise<EvaluationReport> {
  return request("POST", `/news/dev/recommendation-evaluation/runs/${encodeURIComponent(runId)}/evaluate`, {})
}
