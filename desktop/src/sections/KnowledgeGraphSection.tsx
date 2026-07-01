import { useState } from "react"

import type { NoteAdapterConfig } from "../types"
import { Notice } from "../components/primitives"
import { KnowledgeGraphPanel } from "./KnowledgeGraphPanel"
import { TopicMapPanel } from "./TopicMapPanel"

type WorkbenchView = "graph" | "topics"

export function KnowledgeGraphSection({ noteAdapter }: { noteAdapter: NoteAdapterConfig }) {
  const [status, setStatus] = useState<string | null>(null)
  const [view, setView] = useState<WorkbenchView>("graph")
  const statusTone =
    status?.includes("已更新") || status?.includes("已生成") || status?.includes("已打开") || status?.includes("已重建")
      ? "success"
      : "warning"

  return (
    <div className="space-y-5">
      <header className="tk-topbar">
        <div>
          <h1 className="tk-page-title">知识图谱</h1>
          <p className="tk-page-subtitle">关系与主题</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className={view === "graph" ? "tk-primary-button" : "tk-secondary-button"}
            onClick={() => setView("graph")}>
            关系图谱
          </button>
          <button
            className={view === "topics" ? "tk-primary-button" : "tk-secondary-button"}
            onClick={() => setView("topics")}>
            主题目录
          </button>
        </div>
      </header>
      {status && <Notice tone={statusTone}>{status}</Notice>}
      {view === "graph" ? (
        <KnowledgeGraphPanel onStatus={setStatus} noteAdapter={noteAdapter} />
      ) : (
        <TopicMapPanel onStatus={setStatus} noteAdapter={noteAdapter} />
      )}
    </div>
  )
}
