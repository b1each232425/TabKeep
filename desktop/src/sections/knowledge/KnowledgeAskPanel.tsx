import { Copy, Sparkles } from "lucide-react"

import { Button } from "../../components/primitives"
import type { KnowledgeAskResponse } from "../../types"
import { CitationList } from "./CitationList"

export function KnowledgeAskPanel({
  question,
  askResult,
  asking,
  onQuestionChange,
  onAsk,
  onCopyAnswer,
  onStatus,
}: {
  question: string
  askResult: KnowledgeAskResponse | null
  asking: boolean
  onQuestionChange: (value: string) => void
  onAsk: () => void
  onCopyAnswer: () => void
  onStatus: (message: string) => void
}) {
  return (
    <section className="tk-panel">
      <div className="tk-panel-header">
        <h2 className="tk-panel-title">知识库问答</h2>
        <span className="tk-badge">{askResult?.sourceMode ?? "RAG"}</span>
      </div>
      <div className="tk-panel-body space-y-4">
        <textarea
          className="tk-textarea"
          value={question}
          onChange={(event) => onQuestionChange(event.target.value)}
          placeholder="例如：最近保存的翻译方案是什么？"
        />
        <div className="flex flex-wrap gap-2">
          <Button onClick={onAsk} disabled={asking || !question.trim()}>
            <Sparkles className="h-4 w-4" />
            {asking ? "思考中..." : "提问"}
          </Button>
          <Button variant="secondary" onClick={onCopyAnswer} disabled={!askResult?.answer}>
            <Copy className="h-4 w-4" />
            复制回答
          </Button>
        </div>
        {askResult?.answer ? (
          <div className="rounded-md border border-border bg-white p-3 text-sm leading-7 text-slate-800 whitespace-pre-wrap">
            {askResult.answer}
          </div>
        ) : (
          <div className="tk-muted-box">回答会基于下方引用段落生成，不会默认读取整个笔记库。</div>
        )}
        <CitationList
          items={askResult?.citations ?? []}
          emptyText="暂无引用来源"
          compact
          onStatus={onStatus}
        />
      </div>
    </section>
  )
}
