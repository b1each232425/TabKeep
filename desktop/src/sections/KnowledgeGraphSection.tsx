import { useState } from "react"

import type { NoteAdapterConfig } from "../types"
import { Notice } from "../components/primitives"
import { TopicMapPanel } from "./TopicMapPanel"

export function KnowledgeGraphSection({ noteAdapter }: { noteAdapter: NoteAdapterConfig }) {
  const [status, setStatus] = useState<string | null>(null)
  const statusTone =
    status?.includes("已重建") || status?.includes("已打开") || status?.includes("已复制")
      ? "success"
      : "warning"

  return (
    <div className="space-y-5">
      <header className="tk-topbar">
        <div>
          <h1 className="tk-page-title">知识工作台</h1>
          <p className="tk-page-subtitle">围绕主题查笔记、看证据、回到原文，并继续整理知识</p>
        </div>
      </header>
      {status && <Notice tone={statusTone}>{status}</Notice>}
      <TopicMapPanel onStatus={setStatus} noteAdapter={noteAdapter} />
    </div>
  )
}