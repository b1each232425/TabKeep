import { useEffect, useState } from "react"
import { RefreshCw } from "lucide-react"

import {
  DEFAULT_KNOWLEDGE_CONFIG,
  askKnowledge,
  getKnowledgeConfig,
  getKnowledgeIndexHealth,
  getKnowledgeSyncLogs,
  getKnowledgeStats,
  repairKnowledgeIndex,
  searchKnowledge,
  setKnowledgeConfig,
  syncAllKnowledge,
} from "../api"
import type {
  KnowledgeAskResponse,
  KnowledgeConfig,
  KnowledgeIndexHealthResponse,
  KnowledgeSearchResponse,
  KnowledgeStats,
  KnowledgeSyncAllResponse,
} from "../types"
import { Button, Notice } from "../components/primitives"
import { errorMessage } from "../lib/errors"
import { KnowledgeAskPanel } from "./knowledge/KnowledgeAskPanel"
import { KnowledgeConfigPanel } from "./knowledge/KnowledgeConfigPanel"
import { KnowledgeHealthSummary } from "./knowledge/KnowledgeHealthSummary"
import { KnowledgeSearchPanel } from "./knowledge/KnowledgeSearchPanel"
import { KnowledgeSyncPanel } from "./knowledge/KnowledgeSyncPanel"
import {
  formatIndexHealthStatus,
  formatIndexRepairStatus,
  formatKnowledgeSyncStatus,
} from "./knowledge/knowledgeFormat"

export function KnowledgeSection() {
  const [config, setConfigState] = useState<KnowledgeConfig>(DEFAULT_KNOWLEDGE_CONFIG)
  const [pathText, setPathText] = useState("")
  const [stats, setStats] = useState<KnowledgeStats | null>(null)
  const [indexHealth, setIndexHealth] = useState<KnowledgeIndexHealthResponse | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [syncingKnowledge, setSyncingKnowledge] = useState(false)
  const [checkingIndex, setCheckingIndex] = useState(false)
  const [repairingIndex, setRepairingIndex] = useState(false)
  const [syncResult, setSyncResult] = useState<KnowledgeSyncAllResponse | null>(null)
  const [syncLogs, setSyncLogs] = useState<KnowledgeSyncAllResponse[]>([])
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResult, setSearchResult] = useState<KnowledgeSearchResponse | null>(null)
  const [searching, setSearching] = useState(false)
  const [question, setQuestion] = useState("")
  const [askResult, setAskResult] = useState<KnowledgeAskResponse | null>(null)
  const [asking, setAsking] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const autoRerankReady = Boolean(config.embedding.enabled && config.embedding.apiKey.trim())

  const refresh = async () => {
    setLoading(true)
    setStatus(null)
    try {
      const [nextConfig, nextStats, nextHealth, nextLogs] = await Promise.all([
        getKnowledgeConfig(),
        getKnowledgeStats(),
        getKnowledgeIndexHealth(),
        getKnowledgeSyncLogs(),
      ])
      setConfigState(nextConfig)
      setPathText(nextConfig.markdownPaths.join("\n"))
      setStats(nextStats)
      setIndexHealth(nextHealth)
      setSyncLogs(nextLogs.items)
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const buildDraft = (): KnowledgeConfig => ({
    ...config,
    markdownPaths: pathText
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean),
    maxFileBytes:
      Number.isFinite(config.maxFileBytes) && config.maxFileBytes > 0
        ? config.maxFileBytes
        : DEFAULT_KNOWLEDGE_CONFIG.maxFileBytes,
    embedding: {
      ...config.embedding,
      baseURL: DEFAULT_KNOWLEDGE_CONFIG.embedding.baseURL,
      model: DEFAULT_KNOWLEDGE_CONFIG.embedding.model,
    },
  })

  const save = async () => {
    setSaving(true)
    setStatus(null)
    try {
      const saved = await setKnowledgeConfig(buildDraft())
      setConfigState(saved)
      setPathText(saved.markdownPaths.join("\n"))
      setStatus("知识库设置已保存")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const runSyncAll = async () => {
    setSyncingKnowledge(true)
    setStatus(null)
    setSyncResult(null)
    try {
      const saved = await setKnowledgeConfig(buildDraft())
      setConfigState(saved)
      setPathText(saved.markdownPaths.join("\n"))
      const result = await syncAllKnowledge()
      setStats(result.stats)
      setSyncResult(result)
      setStatus(formatKnowledgeSyncStatus(result))
      const health = await getKnowledgeIndexHealth()
      setIndexHealth(health)
      const logs = await getKnowledgeSyncLogs()
      setSyncLogs(logs.items)
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setSyncingKnowledge(false)
    }
  }

  const checkIndexHealth = async () => {
    setCheckingIndex(true)
    setStatus(null)
    try {
      const health = await getKnowledgeIndexHealth()
      setIndexHealth(health)
      setStats(health.stats)
      setStatus(formatIndexHealthStatus(health))
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setCheckingIndex(false)
    }
  }

  const repairIndex = async () => {
    setRepairingIndex(true)
    setStatus(null)
    try {
      const result = await repairKnowledgeIndex()
      setIndexHealth(result.health)
      setStats(result.health.stats)
      setStatus(formatIndexRepairStatus(result))
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setRepairingIndex(false)
    }
  }

  const runSearch = async () => {
    const query = searchQuery.trim()
    if (!query) return
    setSearching(true)
    setStatus(null)
    try {
      const result = await searchKnowledge(query, 8)
      setSearchResult(result)
      if (!result.ok) setStatus(result.error ?? "搜索失败")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setSearching(false)
    }
  }

  const runAsk = async () => {
    const value = question.trim()
    if (!value) return
    setAsking(true)
    setStatus(null)
    try {
      const result = await askKnowledge(value, sessionId, 8)
      setAskResult(result)
      if (result.sessionId) setSessionId(result.sessionId)
      if (!result.ok) setStatus(result.error ?? "知识库问答失败")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setAsking(false)
    }
  }

  const copyAnswer = async () => {
    if (!askResult?.answer) return
    try {
      await navigator.clipboard.writeText(askResult.answer)
      setStatus("回答已复制")
    } catch (err) {
      setStatus(`复制失败: ${errorMessage(err)}`)
    }
  }

  const statusTone =
    status?.includes("已保存") ||
    status?.includes("完成") ||
    status?.includes("健康") ||
    status?.includes("已复制") ||
    status?.includes("可用")
      ? "success"
      : "warning"

  return (
    <div className="space-y-5">
      <header className="tk-topbar">
        <div>
          <h1 className="tk-page-title">知识库</h1>
          <p className="tk-page-subtitle">索引 TabKeep 收藏和 Markdown / Obsidian 笔记，进行搜索与 RAG 问答</p>
        </div>
        <Button variant="secondary" onClick={refresh} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          刷新
        </Button>
      </header>

      {status && <Notice tone={statusTone}>{status}</Notice>}

      <section className="tk-grid-two">
        <KnowledgeSearchPanel
          searchQuery={searchQuery}
          searchResult={searchResult}
          searching={searching}
          onQueryChange={setSearchQuery}
          onSearch={runSearch}
          onStatus={setStatus}
        />
        <KnowledgeAskPanel
          question={question}
          askResult={askResult}
          asking={asking}
          onQuestionChange={setQuestion}
          onAsk={runAsk}
          onCopyAnswer={copyAnswer}
          onStatus={setStatus}
        />
      </section>

      <KnowledgeHealthSummary
        stats={stats}
        health={indexHealth}
        checking={checkingIndex}
        repairing={repairingIndex}
        onCheck={checkIndexHealth}
        onRepair={repairIndex}
      />

      <KnowledgeSyncPanel
        current={syncResult}
        logs={syncLogs}
        syncing={syncingKnowledge}
      />

      <KnowledgeConfigPanel
        config={config}
        pathText={pathText}
        stats={stats}
        autoRerankReady={autoRerankReady}
        saving={saving}
        syncingKnowledge={syncingKnowledge}
        onConfigChange={setConfigState}
        onPathTextChange={setPathText}
        onSave={save}
        onSyncAll={runSyncAll}
      />
    </div>
  )
}
