import { useEffect, useMemo, useState } from "react"
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
  const [showAllCandidateSources, setShowAllCandidateSources] = useState(false)
  const allCitations = askResult?.citations ?? []
  const citedSourceIndexes = useMemo(
    () => extractCitedSourceIndexes(askResult?.answer ?? "", allCitations.length),
    [askResult?.answer, allCitations.length],
  )
  const hasExplicitCitations = citedSourceIndexes.length > 0
  const visibleSourceIndexes = showAllCandidateSources
    ? allCitations.map((_, index) => index + 1)
    : hasExplicitCitations
      ? citedSourceIndexes
      : allCitations.slice(0, 3).map((_, index) => index + 1)
  const visibleCitations = visibleSourceIndexes
    .map((sourceIndex) => allCitations[sourceIndex - 1])
    .filter((item): item is NonNullable<typeof item> => Boolean(item))

  useEffect(() => {
    setShowAllCandidateSources(false)
  }, [askResult?.answer])

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
          <div className="tk-knowledge-answer">
            {askResult.answer}
          </div>
        ) : (
          <div className="tk-muted-box">回答会基于下方引用段落生成，不会默认读取整个笔记库。</div>
        )}
        <div className="tk-citation-section">
          <div className="tk-citation-section-header">
            <div>
              <h3 className="tk-citation-section-title">
                {showAllCandidateSources ? "全部候选来源" : "回答引用来源"}
              </h3>
              <p className="tk-citation-section-hint">
                {hasExplicitCitations
                  ? "只显示回答中标注过的来源，编号与回答保持一致。"
                  : askResult?.answer
                    ? "回答没有明确标注来源编号，先显示排序靠前的候选来源。"
                    : "提问后会显示本次回答用到的来源。"}
              </p>
            </div>
            {allCitations.length > 0 &&
              (showAllCandidateSources || allCitations.length > visibleCitations.length) && (
              <button
                className="tk-citation-toggle"
                type="button"
                onClick={() => setShowAllCandidateSources((value) => !value)}>
                {showAllCandidateSources
                  ? "只看引用"
                  : `展开全部 ${allCitations.length} 条`}
              </button>
            )}
          </div>
          <CitationList
            items={visibleCitations}
            sourceIndexes={visibleSourceIndexes}
            emptyText="暂无引用来源"
            compact
            onStatus={onStatus}
          />
        </div>
      </div>
    </section>
  )
}

function extractCitedSourceIndexes(answer: string, total: number): number[] {
  if (!answer.trim() || total <= 0) return []
  const indexes = new Set<number>()
  const sourceRefPattern = /[［\[(（【]?\s*来源\s*(\d{1,2})\s*[］\])）】]?/g
  for (const match of answer.matchAll(sourceRefPattern)) {
    const index = Number(match[1])
    if (Number.isInteger(index) && index >= 1 && index <= total) {
      indexes.add(index)
    }
  }
  return Array.from(indexes).sort((left, right) => left - right)
}
