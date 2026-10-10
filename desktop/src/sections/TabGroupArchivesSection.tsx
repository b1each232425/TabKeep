import { useCallback, useEffect, useState } from "react"
import { Archive, CircleHelp, ExternalLink, Monitor, RefreshCw, RotateCcw, Trash2 } from "lucide-react"

import { deleteTabGroupArchive, listTabGroupArchives, restoreTabGroupArchive } from "../api"
import { Button, ConfirmDialog, Notice } from "../components/primitives"
import type { TabGroupArchive, TabGroupColor, TabGroupRestoreTarget } from "../types"

const COLOR_CLASS: Record<TabGroupColor, string> = {
  grey: "bg-slate-400",
  blue: "bg-blue-500",
  red: "bg-red-500",
  yellow: "bg-yellow-400",
  green: "bg-green-500",
  pink: "bg-pink-500",
  purple: "bg-purple-500",
  cyan: "bg-cyan-500",
  orange: "bg-orange-500",
}

export function TabGroupArchivesSection() {
  const [archives, setArchives] = useState<TabGroupArchive[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [busyId, setBusyId] = useState("")
  const [deleteCandidate, setDeleteCandidate] = useState<TabGroupArchive | null>(null)
  const [status, setStatus] = useState("")
  const [error, setError] = useState("")

  const refresh = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    setRefreshing(true)
    try {
      const result = await listTabGroupArchives()
      setArchives(result.items)
      setError("")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void refresh(true)
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const restore = async (archive: TabGroupArchive, target: TabGroupRestoreTarget) => {
    setBusyId(archive.id)
    setStatus("")
    setError("")
    try {
      await restoreTabGroupArchive(archive.id, target)
      setStatus(`“${archive.title}”的恢复命令已发送，浏览器正在打开标签组。`)
      window.setTimeout(() => void refresh(), 1000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId("")
    }
  }

  const remove = async () => {
    if (!deleteCandidate) return
    const archive = deleteCandidate
    setBusyId(archive.id)
    setError("")
    try {
      const result = await deleteTabGroupArchive(archive.id)
      setArchives((items) => items.filter((item) => item.id !== archive.id))
      setDeleteCandidate(null)
      setStatus(
        result.status === "queued"
          ? !archive.browserOnline
            ? `“${archive.title}”已从归档删除；来源浏览器重新连接后会关闭原标签组。`
            : !archive.browserReady
              ? `“${archive.title}”已从归档删除；浏览器完成标签同步后会关闭原标签组。`
              : `“${archive.title}”已从归档删除，并已请求关闭浏览器中的标签组。`
          : `“${archive.title}”已删除。`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId("")
    }
  }

  return (
    <div className="space-y-5">
      <header className="tk-topbar">
        <div>
          <h1 className="tk-page-title">标签归档</h1>
          <p className="tk-page-subtitle">持久保存 Chrome 和 Edge 的原生标签组</p>
        </div>
        <Button variant="secondary" onClick={() => void refresh()} disabled={refreshing}>
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          刷新
        </Button>
      </header>

      <Notice>
        归档保存标签组名称、颜色、折叠状态及网页标题和地址，不保存网页正文、滚动位置或表单状态。浏览器中关闭标签组后，归档仍会保留；恢复时会重新加载网页。
      </Notice>
      {status && <Notice tone="success">{status}</Notice>}
      {error && <Notice tone="warning">{error}</Notice>}

      <section className="tk-panel">
        <div className="tk-panel-header">
          <div>
            <h2 className="tk-panel-title">已保存的标签组</h2>
          </div>
          <span className="tk-badge">{archives.length} 组</span>
        </div>
        <div className="tk-panel-body space-y-3">
          {loading ? (
            <p className="text-sm text-muted-foreground">正在读取本机归档…</p>
          ) : archives.length === 0 ? (
            <div className="flex items-start gap-3 rounded-md border border-dashed border-border p-4">
              <Archive className="mt-0.5 h-5 w-5 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium text-foreground">还没有标签归档</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  安装并连接 TabKeep 浏览器扩展后，Chrome 或 Edge 中的原生标签组会自动保存到这里。
                </p>
              </div>
            </div>
          ) : (
            archives.map((archive) => (
              <ArchiveCard
                key={archive.id}
                archive={archive}
                busy={busyId === archive.id}
                onRestore={(target) => void restore(archive, target)}
                onDelete={() => setDeleteCandidate(archive)}
              />
            ))
          )}
        </div>
      </section>

      <ConfirmDialog
        open={deleteCandidate !== null}
        title="删除标签归档？"
        description={
          <>
            <span className="font-medium">“{deleteCandidate?.title}”</span> 将从本机归档中删除；如果来源浏览器中仍有这个组，也会关闭其中的标签页。
            {!deleteCandidate?.browserOnline && " 来源浏览器离线时，关闭操作会等它重新连接后执行。"}
            {" 如果浏览器在重连前重启，TabKeep 会按来源浏览器、组名、颜色和标签 URL 尝试唯一关联；存在多个相同候选组时不会自动关闭，相关组会保留为独立归档。"}
          </>
        }
        confirmLabel="删除并关闭标签组"
        busy={Boolean(busyId && busyId === deleteCandidate?.id)}
        onConfirm={() => void remove()}
        onCancel={() => setDeleteCandidate(null)}
      />
    </div>
  )
}

function ArchiveCard({
  archive,
  busy,
  onRestore,
  onDelete,
}: {
  archive: TabGroupArchive
  busy: boolean
  onRestore: (target: TabGroupRestoreTarget) => void
  onDelete: () => void
}) {
  const browserLabel = archive.browser === "edge" ? "Microsoft Edge" : "Google Chrome"
  const state = !archive.browserOnline
    ? archive.isOpen ? "浏览器离线 · 状态未知" : "浏览器离线"
    : !archive.browserReady
      ? "浏览器正在同步"
      : archive.isOpen ? "浏览器中" : "已归档"
  const stateTone = archive.browserOnline && archive.browserReady && archive.isOpen
    ? "text-emerald-700 bg-emerald-50"
    : archive.browserOnline && archive.browserReady
      ? "text-slate-600 bg-slate-100"
      : "text-amber-800 bg-amber-50"
  const restoreBlockedReason = !archive.browserOnline
    ? "来源浏览器连接后才能恢复"
    : !archive.browserReady
      ? "来源浏览器仍在同步标签组"
      : undefined

  return (
    <article className="rounded-lg border border-border bg-white/75 p-4 shadow-sm">
      <div className="flex flex-wrap items-start gap-3">
        <span className={`mt-1 h-3 w-3 shrink-0 rounded-full ${COLOR_CLASS[archive.color]}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-semibold text-foreground">
              {archive.title || "未命名标签组"}
            </h3>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${stateTone}`}>{state}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1"><Monitor className="h-3.5 w-3.5" />{browserLabel}</span>
            <span>{archive.tabs.length} 个网页</span>
            <span>更新于 {formatArchiveTime(archive.updatedAt)}</span>
          </div>
        </div>
      </div>

      <div className="mt-3 space-y-1.5 border-l-2 border-border pl-4">
        {archive.tabs.slice(0, 5).map((tab, index) => (
          <div key={`${tab.url}-${index}`} className="flex min-w-0 items-center gap-2 text-sm">
            <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-slate-700">{tab.title || displayHost(tab.url)}</span>
            <span className="hidden max-w-[35%] truncate text-xs text-muted-foreground sm:block">
              {displayHost(tab.url)}
            </span>
          </div>
        ))}
        {archive.tabs.length > 5 && (
          <p className="text-xs text-muted-foreground">以及另外 {archive.tabs.length - 5} 个网页</p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <CircleHelp className="h-3.5 w-3.5" />{archive.collapsed ? "折叠状态已保存" : "展开状态已保存"}
        </span>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => onRestore("current")}
            disabled={busy || Boolean(restoreBlockedReason)}
            title={restoreBlockedReason}>
            <RotateCcw className="h-4 w-4" />当前窗口
          </Button>
          <Button
            variant="secondary"
            onClick={() => onRestore("new")}
            disabled={busy || Boolean(restoreBlockedReason)}
            title={restoreBlockedReason}>
            新窗口
          </Button>
          <Button
            variant="ghost"
            className="text-red-700 hover:bg-red-50 hover:text-red-800"
            onClick={onDelete}
            disabled={busy}>
            <Trash2 className="h-4 w-4" />删除
          </Button>
        </div>
      </div>
    </article>
  )
}

function displayHost(value: string): string {
  try {
    return new URL(value).host
  } catch {
    return value
  }
}

function formatArchiveTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "刚刚"
  return date.toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}
