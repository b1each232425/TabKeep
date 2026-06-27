import type {
  KnowledgeEvalCase,
  KnowledgeEvalCaseRequest,
  KnowledgeEvalDeleteResponse,
  KnowledgeEvalRunRequest,
  KnowledgeEvalRunResponse,
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
