import type {
  KnowledgeEvalCase,
  KnowledgeEvalCaseRequest,
  KnowledgeEvalDeleteResponse,
  KnowledgeEvalRunRequest,
  KnowledgeEvalRunRecord,
  KnowledgeEvalRunResponse,
  KnowledgeEvalRunSummary,
  RgbEvalImportRequest,
  RgbEvalRunRecord,
  RgbEvalRunRequest,
  RgbEvalRunResponse,
  RgbEvalRunSummary,
  RgbEvalStatus,
} from "../types"
import { backendRequest } from "./client"

export async function listKnowledgeEvalCases(): Promise<KnowledgeEvalCase[]> {
  return backendRequest<KnowledgeEvalCase[]>("GET", "/knowledge/eval/cases")
}

export async function saveKnowledgeEvalCase(
  data: KnowledgeEvalCaseRequest,
  caseId?: string | null,
): Promise<KnowledgeEvalCase> {
  const path = caseId ? `/knowledge/eval/cases/${encodeURIComponent(caseId)}` : "/knowledge/eval/cases"
  return backendRequest<KnowledgeEvalCase>("POST", path, data)
}

export async function deleteKnowledgeEvalCase(caseId: string): Promise<KnowledgeEvalDeleteResponse> {
  return backendRequest<KnowledgeEvalDeleteResponse>(
    "POST",
    `/knowledge/eval/cases/${encodeURIComponent(caseId)}/delete`,
  )
}

export async function runKnowledgeEval(options: KnowledgeEvalRunRequest): Promise<KnowledgeEvalRunResponse> {
  return backendRequest<KnowledgeEvalRunResponse>("POST", "/knowledge/eval/run", options)
}

export async function listKnowledgeEvalRuns(limit = 20): Promise<KnowledgeEvalRunSummary[]> {
  return backendRequest<KnowledgeEvalRunSummary[]>("GET", `/knowledge/eval/runs?limit=${limit}`)
}

export async function getKnowledgeEvalRun(runId: string): Promise<KnowledgeEvalRunRecord> {
  return backendRequest<KnowledgeEvalRunRecord>(
    "GET",
    `/knowledge/eval/runs/${encodeURIComponent(runId)}`,
  )
}

export async function getRgbEvalStatus(): Promise<RgbEvalStatus> {
  return backendRequest<RgbEvalStatus>("GET", "/knowledge/eval/rgb/status")
}

export async function importRgbEvalDataset(request: RgbEvalImportRequest): Promise<RgbEvalStatus> {
  return backendRequest<RgbEvalStatus>("POST", "/knowledge/eval/rgb/import", request)
}

export async function importOfficialRgbEvalDataset(): Promise<RgbEvalStatus> {
  return backendRequest<RgbEvalStatus>("POST", "/knowledge/eval/rgb/import-official")
}

export async function runRgbEval(request: RgbEvalRunRequest): Promise<RgbEvalRunResponse> {
  return backendRequest<RgbEvalRunResponse>("POST", "/knowledge/eval/rgb/run", request)
}

export async function listRgbEvalRuns(limit = 20): Promise<RgbEvalRunSummary[]> {
  return backendRequest<RgbEvalRunSummary[]>("GET", `/knowledge/eval/rgb/runs?limit=${limit}`)
}

export async function getRgbEvalRun(runId: string): Promise<RgbEvalRunRecord> {
  return backendRequest<RgbEvalRunRecord>(
    "GET",
    `/knowledge/eval/rgb/runs/${encodeURIComponent(runId)}`,
  )
}
