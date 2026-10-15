import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  Clock3,
  ImageOff,
  LoaderCircle,
  Newspaper,
  Plus,
  RefreshCw,
  Rss,
} from "lucide-react"

import type { NewsItem, NewsSource } from "../../src/types"
import {
  addNewsSource,
  exchangeNewsWebSession,
  listNewsItems,
  listNewsSources,
  NewsApiError,
  refreshAllNewsSources,
  refreshNewsSource,
  deleteNewsSource,
} from "./api"

const PAGE_SIZE = 50

function CachedImage({
  src,
  alt,
  className,
  fallback,
}: {
  src?: string | null
  alt: string
  className: string
  fallback: ReactNode
}) {
  const [failed, setFailed] = useState(false)

  useEffect(() => setFailed(false), [src])

  if (!src || failed) return <>{fallback}</>
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  )
}

function SourceIcon({ src, label }: { src?: string | null; label: string }) {
  return (
    <span className="reader-source-icon" title={label} aria-hidden="true">
      <CachedImage
        src={src}
        alt=""
        className="reader-source-icon-image"
        fallback={<Newspaper />}
      />
    </span>
  )
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "时间未知"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "时间未知"
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

function sourceStatus(source: NewsSource): { label: string; className: string } {
  if (!source.isActive) return { label: "已停用", className: "status-muted" }
  if (source.lastError) return { label: "采集异常", className: "status-warning" }
  if (source.lastSuccessAt) return { label: "正常", className: "status-success" }
  return { label: "等待采集", className: "status-neutral" }
}

function isSafeWebUrl(value: string | null | undefined): value is string {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function ticketFromLocation(): string | null {
  return new URLSearchParams(window.location.hash.slice(1)).get("ticket")
}

function clearLocationTicket(): void {
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`)
}

export function NewsReader() {
  const [sessionState, setSessionState] = useState<"checking" | "ready" | "expired">("checking")
  const [sessionError, setSessionError] = useState("")
  const [sources, setSources] = useState<NewsSource[]>([])
  const [allItemCount, setAllItemCount] = useState(0)
  const [items, setItems] = useState<NewsItem[]>([])
  const [total, setTotal] = useState(0)
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [feedUrl, setFeedUrl] = useState("")
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [busySourceId, setBusySourceId] = useState<string | null>(null)
  const [pageError, setPageError] = useState("")
  const [serviceDisconnected, setServiceDisconnected] = useState(false)
  const [notice, setNotice] = useState("")
  const [reloadVersion, setReloadVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    const ticket = ticketFromLocation()
    if (!ticket) {
      setSessionState("ready")
      return () => {
        cancelled = true
      }
    }

    void exchangeNewsWebSession(ticket)
      .then(() => {
        if (cancelled) return
        clearLocationTicket()
        setSessionState("ready")
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setSessionError(error instanceof Error ? error.message : String(error))
        setSessionState("expired")
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (sessionState !== "ready") return
    let cancelled = false
    setLoading(true)
    setPageError("")
    Promise.all([
      listNewsSources(),
      listNewsItems({ sourceId: selectedSourceId, limit: PAGE_SIZE, offset: 0 }),
    ])
      .then(([sourceResponse, itemResponse]) => {
        if (cancelled) return
        setServiceDisconnected(false)
        setSources(sourceResponse.items)
        setAllItemCount(sourceResponse.totalItemCount)
        setItems(itemResponse.items)
        setTotal(itemResponse.total)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof NewsApiError && error.status === 401) {
          setSessionState("expired")
          setSessionError(error.message)
          return
        }
        setServiceDisconnected(error instanceof TypeError)
        setPageError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [reloadVersion, selectedSourceId, sessionState])

  const activeSourceCount = sources.filter((source) => source.isActive).length
  const itemCount = allItemCount
  const selectedSource = sources.find((source) => source.id === selectedSourceId)

  function handleApiError(error: unknown): void {
    if (error instanceof NewsApiError && error.status === 401) {
      setSessionError(error.message)
      setSessionState("expired")
      return
    }
    setServiceDisconnected(error instanceof TypeError)
    setPageError(error instanceof Error ? error.message : String(error))
  }

  async function handleAddSource(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const cleanUrl = feedUrl.trim()
    if (!cleanUrl) {
      setPageError("请先输入小黑盒主页、贴吧主页、RSSHub 路由或 RSS/Atom 地址。")
      return
    }
    setSubmitting(true)
    setPageError("")
    setNotice("")
    try {
      const result = await addNewsSource(cleanUrl)
      setFeedUrl("")
      setSelectedSourceId(result.source.id)
      setNotice(
        result.source.lastError
          ? `订阅已保存，但首次采集失败：${result.source.lastError}`
          : `已添加“${result.source.title}”，新增 ${result.newItems} 条资讯。`,
      )
      setReloadVersion((version) => version + 1)
    } catch (error) {
      handleApiError(error)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRefreshAll(): Promise<void> {
    setRefreshingAll(true)
    setPageError("")
    setNotice("")
    try {
      const result = await refreshAllNewsSources()
      const failed = result.items.filter((item) => item.error).length
      setNotice(
        failed > 0
          ? `刷新完成，新增 ${result.newItems} 条；${failed} 个订阅源采集失败。`
          : `刷新完成，新增 ${result.newItems} 条资讯。`,
      )
      setReloadVersion((version) => version + 1)
    } catch (error) {
      handleApiError(error)
    } finally {
      setRefreshingAll(false)
    }
  }

  async function handleRefreshSource(source: NewsSource): Promise<void> {
    setBusySourceId(source.id)
    setPageError("")
    setNotice("")
    try {
      const result = await refreshNewsSource(source.id)
      setNotice(
        result.source.lastError
          ? `${source.title} 采集失败：${result.source.lastError}`
          : `${source.title} 已更新，新增 ${result.newItems} 条资讯。`,
      )
      setReloadVersion((version) => version + 1)
    } catch (error) {
      handleApiError(error)
    } finally {
      setBusySourceId(null)
    }
  }

  async function handleDeleteSource(source: NewsSource): Promise<void> {
    setBusySourceId(source.id)
    setPageError("")
    setNotice("")
    try {
      await deleteNewsSource(source.id)
      setNotice(`已取消订阅“${source.title}”，历史资讯仍会保留。`)
      setSelectedSourceId((current) => current === source.id ? null : current)
      setReloadVersion((version) => version + 1)
    } catch (error) {
      handleApiError(error)
    } finally {
      setBusySourceId(null)
    }
  }

  async function handleLoadMore(): Promise<void> {
    setLoadingMore(true)
    setPageError("")
    try {
      const result = await listNewsItems({
        sourceId: selectedSourceId,
        limit: PAGE_SIZE,
        offset: items.length,
      })
      setItems((current) => [...current, ...result.items])
      setTotal(result.total)
    } catch (error) {
      handleApiError(error)
    } finally {
      setLoadingMore(false)
    }
  }

  if (sessionState === "checking") {
    return (
      <main className="reader-access-state">
        <LoaderCircle aria-label="正在验证资讯页面" className="reader-spinner" />
        <p>正在连接 TabKeep 资讯库…</p>
      </main>
    )
  }

  if (sessionState === "expired") {
    return (
      <main className="reader-access-state">
        <div className="reader-access-icon"><AlertCircle aria-hidden="true" /></div>
        <h1>无法连接资讯库</h1>
        <p>{sessionError || "本机资讯会话已失效。"}</p>
        <p>请确认 TabKeep 正在运行，然后从桌面端点击“资讯”重新打开此页面。</p>
      </main>
    )
  }

  return (
    <div className="reader-shell">
      <header className="reader-topbar">
        <a className="reader-brand" href={window.location.pathname} aria-label="TabKeep 资讯首页">
          <span className="reader-brand-mark"><Newspaper aria-hidden="true" /></span>
          <span>Tab<span>Keep</span></span>
          <span className="reader-brand-divider" />
          <span className="reader-brand-section">资讯</span>
        </a>
        <div className="reader-topbar-actions">
          <span className="reader-local-state"><span />本地资讯库</span>
          <button
            className="reader-button reader-button-secondary"
            type="button"
            disabled={refreshingAll || activeSourceCount === 0}
            onClick={() => void handleRefreshAll()}>
            {refreshingAll ? <LoaderCircle aria-hidden="true" className="reader-spin" /> : <RefreshCw aria-hidden="true" />}
            <span>{refreshingAll ? "刷新中" : "全部刷新"}</span>
          </button>
        </div>
      </header>

      <main className="reader-content">
        <form className="reader-add-form" onSubmit={(event) => void handleAddSource(event)}>
          <label htmlFor="reader-feed-url">添加订阅源</label>
          <div className="reader-add-row">
            <div className="reader-input-wrap">
              <Rss aria-hidden="true" />
              <input
                id="reader-feed-url"
                type="url"
                inputMode="url"
                autoComplete="url"
                value={feedUrl}
                onChange={(event) => setFeedUrl(event.target.value)}
                placeholder="小黑盒主页、贴吧主页、RSSHub 路由或 RSS/Atom 地址"
                aria-describedby="reader-feed-help"
              />
            </div>
            <button className="reader-button reader-button-primary" type="submit" disabled={submitting}>
              {submitting ? <LoaderCircle aria-hidden="true" className="reader-spin" /> : <Plus aria-hidden="true" />}
              <span>{submitting ? "正在添加" : "添加并采集"}</span>
            </button>
          </div>
          <p id="reader-feed-help">
            支持小黑盒主页（如 https://www.xiaoheihe.cn/）、贴吧主页 URL、RSSHub 和 RSS/Atom。微博请填写 RSSHub 用户路由（/weibo/user/UID）；TabKeep 只读取订阅地址，上游授权需自行确认。采集内容只保存在本机。
          </p>
        </form>

        <section className="reader-heading">
          <div>
            <p className="reader-eyebrow">PERSONAL FEED</p>
            <h1>今天有什么新鲜事</h1>
            <p className="reader-subtitle">订阅社区和博客，把值得回看的内容留在本地。</p>
          </div>
          <div className="reader-count"><strong>{itemCount}</strong><span>条已收集</span></div>
        </section>

        {pageError && (
          <div className="reader-notice reader-notice-error" role="alert">
            <AlertCircle aria-hidden="true" />
            <span>
              {serviceDisconnected
                ? "无法连接本机资讯服务。请确认 TabKeep 正在运行，然后重新读取；如果应用刚退出，请从桌面端重新打开资讯入口。"
                : pageError}
            </span>
            {serviceDisconnected && (
              <button
                className="reader-retry-button"
                type="button"
                disabled={loading}
                onClick={() => setReloadVersion((version) => version + 1)}>
                重新读取
              </button>
            )}
          </div>
        )}
        {notice && !pageError && <div className="reader-notice reader-notice-success" role="status"><Check aria-hidden="true" />{notice}</div>}

        <div className="reader-layout">
          <aside className="reader-sidebar" aria-label="资讯筛选和订阅源">
            <div className="reader-sidebar-heading">
              <h2>订阅</h2>
              <span>{activeSourceCount} 个启用</span>
            </div>
            <button
              type="button"
              className={`reader-source-row ${selectedSourceId === null ? "is-selected" : ""}`}
              aria-pressed={selectedSourceId === null}
              onClick={() => setSelectedSourceId(null)}>
              <SourceIcon label="全部资讯" />
              <span className="reader-source-name">全部资讯</span>
              <span className="reader-source-count">{itemCount}</span>
            </button>
            <div className="reader-source-list">
              {sources.map((source) => {
                const status = sourceStatus(source)
                const busy = busySourceId === source.id
                return (
                  <div key={source.id} className={`reader-source-card ${selectedSourceId === source.id ? "is-selected" : ""}`}>
                    <button
                      className="reader-source-main"
                      type="button"
                      aria-pressed={selectedSourceId === source.id}
                      onClick={() => setSelectedSourceId(source.id)}>
                      <SourceIcon src={source.iconUrl} label={source.title} />
                      <span className="reader-source-name">{source.title}</span>
                      <span className="reader-source-count">{source.itemCount}</span>
                    </button>
                    <div className="reader-source-meta">
                      <span className={`reader-status ${status.className}`}>{status.label}</span>
                      <span className="reader-source-kind">
                        {source.sourceType === "tieba" ? "贴吧" : source.sourceType === "xiaoheihe" ? "小黑盒" : "RSS"}
                      </span>
                    </div>
                    <div className="reader-source-actions">
                      <button type="button" disabled={busy || refreshingAll} onClick={() => void handleRefreshSource(source)}>
                        {busy ? "采集中…" : "刷新"}
                      </button>
                      <button type="button" disabled={busy} onClick={() => void handleDeleteSource(source)}>取消订阅</button>
                    </div>
                    {source.lastError && <p className="reader-source-error">{source.lastError}</p>}
                    {source.lastCheckedAt && !source.lastError && (
                      <p className="reader-source-checked"><Clock3 aria-hidden="true" />最近检查 {formatTime(source.lastCheckedAt)}</p>
                    )}
                  </div>
                )
              })}
            </div>
            {sources.length === 0 && !loading && (
              <p className="reader-sidebar-empty">还没有订阅源。添加一个地址后即可开始收集。</p>
            )}
          </aside>

          <section className="reader-feed" aria-label="资讯列表">
            <div className="reader-feed-heading">
              <div>
                <h2>{selectedSource?.title ?? "最近采集"}</h2>
                <p>共 {total} 条已保存</p>
              </div>
              {loading && <LoaderCircle aria-label="正在加载资讯" className="reader-spinner reader-spinner-small" />}
            </div>

            {!loading && items.length === 0 ? (
              <div className="reader-empty">
                <span><Rss aria-hidden="true" /></span>
                <h3>{sources.length === 0 ? "先添加一个订阅源" : "这里暂时没有资讯"}</h3>
                <p>新采集的帖子和文章会按时间排列，之后可以随时回来查看。</p>
              </div>
            ) : (
              <div className="reader-item-list">
                {items.map((item) => (
                  <article key={item.id} className="reader-item">
                    <div className="reader-item-copy">
                      <div className="reader-item-meta">
                        <SourceIcon src={item.sourceIconUrl} label={item.sourceTitle} />
                        <span className="reader-item-source">{item.sourceTitle}</span>
                        {item.author && <span>{item.author}</span>}
                        <time dateTime={item.publishedAt ?? item.fetchedAt}>{formatTime(item.publishedAt ?? item.fetchedAt)}</time>
                      </div>
                      <h3>{item.title}</h3>
                      {item.content && <p className="reader-item-content">{item.content}</p>}
                      {isSafeWebUrl(item.url) && (
                        <a className="reader-item-link" href={item.url} target="_blank" rel="noopener noreferrer">
                          阅读原文 <ArrowUpRight aria-hidden="true" />
                        </a>
                      )}
                    </div>
                    {item.imageUrl && (
                      <div className="reader-item-thumbnail">
                        <CachedImage
                          src={item.imageUrl}
                          alt={`${item.title} 的配图`}
                          className="reader-item-thumbnail-image"
                          fallback={(
                            <span className="reader-item-thumbnail-fallback" aria-label="图片无法显示">
                              <ImageOff aria-hidden="true" />
                            </span>
                          )}
                        />
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}

            {items.length > 0 && items.length < total && (
              <div className="reader-load-more">
                <button className="reader-button reader-button-secondary" type="button" disabled={loadingMore} onClick={() => void handleLoadMore()}>
                  {loadingMore ? <LoaderCircle aria-hidden="true" className="reader-spin" /> : <Plus aria-hidden="true" />}
                  <span>{loadingMore ? "正在加载" : "加载更多"}</span>
                </button>
              </div>
            )}
          </section>
        </div>
      </main>
      <footer className="reader-footer"><span>内容保存在本机</span><span>TabKeep 资讯</span></footer>
    </div>
  )
}
