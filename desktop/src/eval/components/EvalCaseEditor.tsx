import { X } from "lucide-react"

import type { KnowledgeEvalCaseRequest } from "../../types"
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
          <span className="tk-label">预期命中文本</span>
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
