import { Plus, Trash2, X } from "lucide-react"

import type { KnowledgeEvalCaseRequest, KnowledgeEvalRelevantTarget } from "../../types"
import { CASE_TYPE_OPTIONS } from "../evalModel"
import { Button, Checkbox, TextField } from "./EvalControls"

export function EvalCaseEditor({
  draft,
  editingCaseId,
  saving,
  onDraftChange,
  onSaveDraft,
  onResetDraft,
}: {
  draft: KnowledgeEvalCaseRequest
  editingCaseId: string | null
  saving: boolean
  onDraftChange: (draft: KnowledgeEvalCaseRequest) => void
  onSaveDraft: () => void
  onResetDraft: () => void
}) {
  return (
    <section className="tk-panel">
      <div className="tk-panel-header">
        <div>
          <h2 className="tk-panel-title">{editingCaseId ? "编辑用例" : "新增用例"}</h2>
          <p className="text-xs text-muted-foreground">用预期锚点标记正确召回</p>
        </div>
        {editingCaseId && (
          <Button variant="ghost" onClick={onResetDraft}>
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
            onChange={(event) => onDraftChange({ ...draft, question: event.target.value })}
            placeholder="例如：TabKeep 的知识库同步按钮会处理哪些来源？"
          />
        </label>
        <label className="tk-field">
          <span className="tk-label">用例类型</span>
          <select
            className="tk-select"
            value={draft.caseType}
            onChange={(event) => onDraftChange({ ...draft, caseType: event.target.value })}>
            {CASE_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="tk-field">
          <span className="tk-label">主要命中文本</span>
          <textarea
            className="tk-textarea min-h-24"
            value={draft.expectedText}
            onChange={(event) => onDraftChange({ ...draft, expectedText: event.target.value })}
            placeholder="填一段应该被召回的原文"
          />
        </label>
        <div className="grid gap-3 md:grid-cols-2">
          <TextField
            label="预期路径"
            value={draft.expectedPath}
            onChange={(value) => onDraftChange({ ...draft, expectedPath: value })}
            placeholder="notes/rag.md"
          />
          <TextField
            label="预期标题"
            value={draft.expectedTitle}
            onChange={(value) => onDraftChange({ ...draft, expectedTitle: value })}
            placeholder="RAG 评估"
          />
          <TextField
            label="Document ID"
            value={draft.expectedDocumentId}
            onChange={(value) => onDraftChange({ ...draft, expectedDocumentId: value })}
            placeholder="可选"
          />
          <TextField
            label="Paragraph ID"
            value={draft.expectedParagraphId}
            onChange={(value) => onDraftChange({ ...draft, expectedParagraphId: value })}
            placeholder="可选"
          />
        </div>
        <div className="rounded-md border border-border bg-slate-50/70 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-slate-900">其他相关结果</p>
              <p className="text-xs text-muted-foreground">用于计算 Top K 中有多少结果真正相关</p>
            </div>
            <Button
              variant="secondary"
              onClick={() =>
                onDraftChange({
                  ...draft,
                  additionalRelevantTargets: [
                    ...draft.additionalRelevantTargets,
                    emptyRelevantTarget(),
                  ],
                })
              }>
              <Plus className="h-4 w-4" />
              添加
            </Button>
          </div>
          {draft.additionalRelevantTargets.length > 0 && (
            <div className="mt-3 grid gap-3">
              {draft.additionalRelevantTargets.map((target, index) => (
                <div key={index} className="rounded-md border border-border bg-white/80 p-3">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <span className="text-xs font-medium text-slate-600">相关结果 {index + 2}</span>
                    <button
                      type="button"
                      className="tk-icon-button"
                      title="删除相关结果"
                      aria-label={`删除相关结果 ${index + 2}`}
                      onClick={() =>
                        onDraftChange({
                          ...draft,
                          additionalRelevantTargets: draft.additionalRelevantTargets.filter(
                            (_, targetIndex) => targetIndex !== index,
                          ),
                        })
                      }>
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <label className="tk-field">
                    <span className="tk-label">命中文本</span>
                    <textarea
                      className="tk-textarea min-h-16"
                      value={target.text}
                      onChange={(event) =>
                        onDraftChange(
                          updateRelevantTarget(draft, index, {
                            ...target,
                            text: event.target.value,
                          }),
                        )
                      }
                      placeholder="可选，填入该结果中的稳定原文"
                    />
                  </label>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <TextField
                      label="路径"
                      value={target.path}
                      onChange={(value) =>
                        onDraftChange(updateRelevantTarget(draft, index, { ...target, path: value }))
                      }
                      placeholder="可选"
                    />
                    <TextField
                      label="标题"
                      value={target.title}
                      onChange={(value) =>
                        onDraftChange(updateRelevantTarget(draft, index, { ...target, title: value }))
                      }
                      placeholder="可选"
                    />
                    <TextField
                      label="Document ID"
                      value={target.documentId}
                      onChange={(value) =>
                        onDraftChange(
                          updateRelevantTarget(draft, index, { ...target, documentId: value }),
                        )
                      }
                      placeholder="可选"
                    />
                    <TextField
                      label="Paragraph ID"
                      value={target.paragraphId}
                      onChange={(value) =>
                        onDraftChange(
                          updateRelevantTarget(draft, index, { ...target, paragraphId: value }),
                        )
                      }
                      placeholder="可选"
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <label className="tk-field">
          <span className="tk-label">预期答案</span>
          <textarea
            className="tk-textarea min-h-20"
            value={draft.expectedAnswer}
            onChange={(event) => onDraftChange({ ...draft, expectedAnswer: event.target.value })}
            placeholder="可选，用于答案质量评估的参考答案"
          />
        </label>
        <label className="tk-field">
          <span className="tk-label">答案关键词</span>
          <textarea
            className="tk-textarea min-h-16"
            value={draft.answerKeywords}
            onChange={(event) => onDraftChange({ ...draft, answerKeywords: event.target.value })}
            placeholder="可选，逗号或换行分隔"
          />
        </label>
        <Checkbox
          label="应拒答"
          checked={draft.shouldRefuse}
          onChange={(checked) => onDraftChange({ ...draft, shouldRefuse: checked })}
        />
        <TextField
          label="备注"
          value={draft.note}
          onChange={(value) => onDraftChange({ ...draft, note: value })}
          placeholder="可选"
        />
      </div>
      <div className="tk-command-bar justify-between">
        <Button onClick={onSaveDraft} disabled={saving}>
          {saving ? "保存中..." : editingCaseId ? "保存修改" : "添加用例"}
        </Button>
        <Button variant="secondary" onClick={onResetDraft} disabled={saving}>
          清空
        </Button>
      </div>
    </section>
  )
}

function emptyRelevantTarget(): KnowledgeEvalRelevantTarget {
  return {
    text: "",
    path: "",
    title: "",
    documentId: "",
    paragraphId: "",
  }
}

function updateRelevantTarget(
  draft: KnowledgeEvalCaseRequest,
  index: number,
  target: KnowledgeEvalRelevantTarget,
): KnowledgeEvalCaseRequest {
  return {
    ...draft,
    additionalRelevantTargets: draft.additionalRelevantTargets.map((item, targetIndex) =>
      targetIndex === index ? target : item,
    ),
  }
}
