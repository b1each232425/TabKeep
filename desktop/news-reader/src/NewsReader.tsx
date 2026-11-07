import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  Clock3,
  Gamepad2,
  History as HistoryIcon,
  ImageOff,
  LoaderCircle,
  Newspaper,
  Plus,
  RefreshCw,
  Rss,
  Search,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react"

import type { NewsItem, NewsItemListResponse, NewsSource } from "../../src/types"
import { ProviderDialog } from "./ProviderDialog"
import { TopicSearchPanel } from "./TopicSearchPanel"
import {
  addNewsSource,
  exchangeNewsWebSession,
  listNewsItems,
  listNewsReadingHistory,
  listNewsSources,
  NewsApiError,
  refreshAllNewsSources,
  refreshNewsSource,
  deleteNewsSource,
  recordArticleFeedback,
  recordOriginalOpened,
} from "./api"

const PAGE_SIZE = 50
const CONTENT_PREVIEW_CHARACTERS = 500

function previewContent(content: string): { text: string; truncated: boolean } {
  const characters = Array.from(content)
  if (characters.length <= CONTENT_PREVIEW_CHARACTERS) {
    return { text: content, truncated: false }
  }
  return {
    text: `${characters.slice(0, CONTENT_PREVIEW_CHARACTERS).join("")}…`,
    truncated: true,
  }
}

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

function SourceIcon({
  src,
  label,
  sourceType,
}: {
  src?: string | null
  label: string
  sourceType?: NewsSource["sourceType"]
}) {
  return (
    <span className="reader-source-icon" title={label} aria-hidden="true">
      <CachedImage
        src={src}
        alt=""
        className="reader-source-icon-image"
        fallback={sourceType === "xiaoheihe" ? <Gamepad2 /> : <Newspaper />}
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

function isXiaoheiheHomepage(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return ["xiaoheihe.cn", "www.xiaoheihe.cn"].includes(url.hostname.toLowerCase())
      && url.pathname.replace(/\/$/, "") === ""
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
  const [expandedContentIds, setExpandedContentIds] = useState<Set<string>>(() => new Set())
  const [total, setTotal] = useState(0)
  const [selectedView, setSelectedView] = useState<"latest" | "recommended" | "history">("latest")
  const [topicSearchOpen, setTopicSearchOpen] = useState(false)
  const [recommendationState, setRecommendationState] = useState<"not_applicable" | "ready" | "warming_up" | "no_matches" | "keyword_fallback">("not_applicable")
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [feedUrl, setFeedUrl] = useState("")
  const [xiaoheiheSection, setXiaoheiheSection] = useState<"news" | "discount">("news")
  const [xiaoheihePlatform, setXiaoheihePlatform] = useState<"pc" | "switch" | "psn" | "xbox">("pc")
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [busySourceId, setBusySourceId] = useState<string | null>(null)
  const [feedbackPendingItemId, setFeedbackPendingItemId] = useState<string | null>(null)
  const [pageError, setPageError] = useState("")
  const [serviceDisconnected, setServiceDisconnected] = useState(false)
  const [notice, setNotice] = useState("")
  const [reloadVersion, setReloadVersion] = useState(0)
  const [providerDialogOpen, setProviderDialogOpen] = useState(false)

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
      selectedView === "history"
        ? listNewsReadingHistory({ limit: PAGE_SIZE, offset: 0 })
        : listNewsItems({ sourceId: selectedSourceId, view: selectedView, limit: PAGE_SIZE, offset: 0 }),
    ])
      .then(([sourceResponse, itemResponse]) => {
        if (cancelled) return
        setServiceDisconnected(false)
        setSources(sourceResponse.items)
        setAllItemCount(sourceResponse.totalItemCount)
        setItems(itemResponse.items)
        setTotal(itemResponse.total)
        setRecommendationState(selectedView === "history"
          ? "not_applicable"
          : (itemResponse as NewsItemListResponse).recommendationState)
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
  }, [reloadVersion, selectedSourceId, selectedView, sessionState])

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
      const result = await addNewsSource(cleanUrl, xiaoheiheSection, xiaoheihePlatform)
      setFeedUrl("")
      setXiaoheiheSection("news")
      setXiaoheihePlatform("pc")
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

  async function handleArticleFeedback(
    item: NewsItem,
    feedback: "like" | "not_interested",
  ): Promise<void> {
    if (item.userFeedback === feedback || feedbackPendingItemId !== null) return
    setFeedbackPendingItemId(item.id)
    setPageError("")
    try {
      await recordArticleFeedback(item.id, feedback)
      setItems((current) => current.map((currentItem) =>
        currentItem.id === item.id ? { ...currentItem, userFeedback: feedback } : currentItem,
      ))
    } catch (error) {
      handleApiError(error)
    } finally {
      setFeedbackPendingItemId(null)
    }
  }

  async function handleLoadMore(): Promise<void> {
    setLoadingMore(true)
    setPageError("")
    try {
      const result = selectedView === "history"
        ? await listNewsReadingHistory({ limit: PAGE_SIZE, offset: items.length })
        : await listNewsItems({
          sourceId: selectedSourceId,
          view: selectedView,
          limit: PAGE_SIZE,
          offset: items.length,
        })
      setItems((current) => [...current, ...result.items])
      setTotal(result.total)
      setRecommendationState(selectedView === "history"
        ? "not_applicable"
        : (result as NewsItemListResponse).recommendationState)
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
          {isXiaoheiheHomepage(feedUrl) && (
            <div className="reader-provider-options">
              <label>
                <span>小黑盒区块</span>
                <select
                  value={xiaoheiheSection}
                  onChange={(event) => setXiaoheiheSection(event.target.value as "news" | "discount")}
                >
                  <option value="news">游戏新闻</option>
                  <option value="discount">游戏折扣</option>
                </select>
              </label>
              {xiaoheiheSection === "discount" && (
                <label>
                  <span>游戏平台</span>
                  <select
                    value={xiaoheihePlatform}
                    onChange={(event) => setXiaoheihePlatform(event.target.value as typeof xiaoheihePlatform)}
                  >
                    <option value="pc">PC</option>
                    <option value="switch">Switch</option>
                    <option value="psn">PSN</option>
                    <option value="xbox">Xbox</option>
                  </select>
                </label>
              )}
            </div>
          )}
          <p id="reader-feed-help">
            支持小黑盒游戏新闻与游戏折扣、贴吧主页 URL、RSSHub 和 RSS/Atom。微博请填写 RSSHub 用户路由（/weibo/user/UID）；TabKeep 只读取订阅地址，上游授权需自行确认。采集内容只保存在本机。
          </p>
        </form>

        <section className="reader-heading">
          <div>
            <p className="reader-eyebrow">PERSONAL FEED</p>
            <h1>{topicSearchOpen ? "话题搜索" : selectedView === "history" ? "浏览记录" : "今天有什么新鲜事"}</h1>
            <p className="reader-subtitle">
              {topicSearchOpen
                ? "输入一个话题，搜索本地资讯和可公开访问的平台结果。"
                : selectedView === "history"
                ? "点击过阅读原文的文章会留在这里，方便回来继续阅读。"
                : "订阅社区和博客，把值得回看的内容留在本地。"}
            </p>
          </div>
          {!topicSearchOpen && <div className="reader-count">
            <strong>{selectedView === "history" ? total : itemCount}</strong>
            <span>{selectedView === "history" ? "篇已打开" : "条已收集"}</span>
          </div>}
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
              <div className="reader-sidebar-heading-actions">
                <span>{activeSourceCount} 个启用</span>
                <button
                  type="button"
                  className="reader-icon-button reader-sidebar-add"
                  aria-label="添加特殊订阅源"
                  aria-haspopup="dialog"
                  onClick={() => setProviderDialogOpen(true)}
                >
                  <Plus aria-hidden="true" />
                </button>
              </div>
            </div>
            <nav className="reader-view-list" aria-label="资讯列表类型">
              <button
                type="button"
                className={`reader-source-row ${selectedView === "latest" && !topicSearchOpen ? "is-selected" : ""}`}
                aria-pressed={selectedView === "latest" && !topicSearchOpen}
                onClick={() => { setTopicSearchOpen(false); setSelectedView("latest") }}
              >
                <Clock3 aria-hidden="true" />
                <span className="reader-source-name">最新</span>
              </button>
              <button
                type="button"
                className={`reader-source-row ${selectedView === "recommended" && !topicSearchOpen ? "is-selected" : ""}`}
                aria-pressed={selectedView === "recommended" && !topicSearchOpen}
                onClick={() => { setTopicSearchOpen(false); setSelectedView("recommended") }}
              >
                <Sparkles aria-hidden="true" />
                <span className="reader-source-name">推荐</span>
              </button>
              <button
                type="button"
                className={`reader-source-row ${selectedView === "history" && !topicSearchOpen ? "is-selected" : ""}`}
                aria-pressed={selectedView === "history" && !topicSearchOpen}
                onClick={() => {
                  setTopicSearchOpen(false)
                  setSelectedSourceId(null)
                  setSelectedView("history")
                }}
              >
                <HistoryIcon aria-hidden="true" />
                <span className="reader-source-name">浏览记录</span>
                <span className="reader-source-count">{selectedView === "history" ? total : ""}</span>
              </button>
              <button
                type="button"
                className={`reader-source-row ${topicSearchOpen ? "is-selected" : ""}`}
                aria-pressed={topicSearchOpen}
                onClick={() => {
                  setSelectedSourceId(null)
                  setTopicSearchOpen(true)
                }}
              >
                <Search aria-hidden="true" />
                <span className="reader-source-name">话题搜索</span>
              </button>
            </nav>
            <div className="reader-sidebar-section-label">订阅源</div>
            <button
              type="button"
              className={`reader-source-row ${selectedSourceId === null && selectedView !== "history" && !topicSearchOpen ? "is-selected" : ""}`}
              aria-pressed={selectedSourceId === null && selectedView !== "history" && !topicSearchOpen}
              onClick={() => {
                setTopicSearchOpen(false)
                setSelectedSourceId(null)
                setSelectedView("latest")
              }}>
              <SourceIcon label="全部资讯" />
              <span className="reader-source-name">全部来源</span>
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
                      onClick={() => {
                        setTopicSearchOpen(false)
                        setSelectedView("latest")
                        setSelectedSourceId(source.id)
                      }}>
                      <SourceIcon src={source.iconUrl} label={source.title} sourceType={source.sourceType} />
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

          {topicSearchOpen ? (
            <TopicSearchPanel onUnauthorized={(message) => {
              setSessionError(message)
              setSessionState("expired")
            }} />
          ) : <section className="reader-feed" aria-label="资讯列表">
            <div className="reader-feed-heading">
              <div>
                <h2>{selectedView === "history" ? "浏览记录" : selectedSource?.title ?? (selectedView === "latest" ? "最新" : "推荐")}</h2>
                <p>
                  {selectedView === "history"
                    ? `共 ${total} 篇曾打开的文章`
                    : selectedView === "recommended" && recommendationState === "warming_up"
                    ? `兴趣信号较少，暂按最新顺序展示（${total} 条）`
                    : selectedView === "recommended" && recommendationState === "keyword_fallback"
                    ? `语义排序不可用，暂按关键词推荐（${total} 条）`
                    : selectedView === "recommended" && recommendationState === "no_matches"
                      ? "当前兴趣关键词没有匹配到已采集内容"
                      : `共 ${total} 条${selectedView === "recommended" ? "匹配内容" : "已保存"}`}
                </p>
              </div>
              {loading && <LoaderCircle aria-label="正在加载资讯" className="reader-spinner reader-spinner-small" />}
            </div>

            {!loading && items.length === 0 ? (
              <div className="reader-empty">
                <span><Rss aria-hidden="true" /></span>
                <h3>
                  {selectedView === "history"
                    ? "还没有浏览记录"
                    : sources.length === 0
                    ? "先添加一个订阅源"
                    : selectedView === "recommended" && recommendationState === "warming_up"
                      ? "还没有足够的兴趣信号"
                      : selectedView === "recommended" && recommendationState === "keyword_fallback"
                        ? "语义排序暂不可用"
                      : selectedView === "recommended" && recommendationState === "no_matches"
                        ? "暂时没有匹配内容"
                        : "这里暂时没有资讯"}
                </h3>
                <p>
                  {selectedView === "history"
                    ? "点击资讯中的“阅读原文”后，文章会出现在这里。"
                    : sources.length === 0
                    ? "添加 RSS、贴吧或小黑盒订阅源后，资讯会出现在这里。"
                    : selectedView === "recommended" && recommendationState === "warming_up"
                    ? "阅读原文或导入浏览历史后，推荐列表会根据本地兴趣记录生成。"
                    : selectedView === "recommended" && recommendationState === "keyword_fallback"
                    ? "当前按关键词排序展示已采集内容。配置并启用 embedding 后，推荐会使用 RRF 融合关键词与正文语义排序。"
                    : selectedView === "recommended" && recommendationState === "no_matches"
                      ? "当前已采集文章中没有匹配兴趣关键词的内容。"
                      : "新采集的帖子和文章会按时间排列，之后可以随时回来查看。"}
                </p>
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
                        {selectedView === "history" && (item.openCount ?? 0) > 1 && (
                          <span>打开 {item.openCount} 次</span>
                        )}
                        <time dateTime={selectedView === "history" ? item.lastOpenedAt ?? item.fetchedAt : item.publishedAt ?? item.fetchedAt}>
                          {selectedView === "history" ? "最近打开 " : ""}
                          {formatTime(selectedView === "history" ? item.lastOpenedAt ?? item.fetchedAt : item.publishedAt ?? item.fetchedAt)}
                        </time>
                      </div>
                      <h3>{item.title}</h3>
                      {item.recommendationReason && <p className="reader-recommendation-reason">{item.recommendationReason}</p>}
                      {item.content && (() => {
                        const preview = previewContent(item.content)
                        const expanded = expandedContentIds.has(item.id)
                        return (
                          <>
                            <p className="reader-item-content">{expanded ? item.content : preview.text}</p>
                            {preview.truncated && (
                              <button
                                type="button"
                                className="reader-content-toggle"
                                aria-expanded={expanded}
                                onClick={() => setExpandedContentIds((current) => {
                                  const next = new Set(current)
                                  if (next.has(item.id)) next.delete(item.id)
                                  else next.add(item.id)
                                  return next
                                })}
                              >
                                {expanded ? "收起" : "展开全部"}
                              </button>
                            )}
                          </>
                        )
                      })()}
                      <div className="reader-item-actions">
                        <div className="reader-feedback-actions" aria-label="资讯反馈">
                          <button
                            type="button"
                            className={`reader-feedback-button ${item.userFeedback === "like" ? "is-selected" : ""}`}
                            aria-label={`赞：${item.title}`}
                            aria-pressed={item.userFeedback === "like"}
                            disabled={feedbackPendingItemId !== null}
                            onClick={() => void handleArticleFeedback(item, "like")}
                          >
                            <ThumbsUp aria-hidden="true" />
                            <span>{item.userFeedback === "like" ? "已赞" : "赞"}</span>
                          </button>
                          <button
                            type="button"
                            className={`reader-feedback-button ${item.userFeedback === "not_interested" ? "is-selected" : ""}`}
                            aria-label={`踩：${item.title}`}
                            aria-pressed={item.userFeedback === "not_interested"}
                            disabled={feedbackPendingItemId !== null}
                            onClick={() => void handleArticleFeedback(item, "not_interested")}
                          >
                            <ThumbsDown aria-hidden="true" />
                            <span>{item.userFeedback === "not_interested" ? "已踩" : "踩"}</span>
                          </button>
                        </div>
                        {isSafeWebUrl(item.url) && (
                          <a
                            className="reader-item-link"
                            href={item.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => void recordOriginalOpened(item.id).catch(() => undefined)}
                          >
                            {selectedView === "history" ? "再次阅读原文" : "阅读原文"} <ArrowUpRight aria-hidden="true" />
                          </a>
                        )}
                      </div>
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
          </section>}
        </div>
      </main>
      <footer className="reader-footer"><span>内容保存在本机</span><span>TabKeep 资讯</span></footer>
      <ProviderDialog
        open={providerDialogOpen}
        onClose={() => setProviderDialogOpen(false)}
        onSubscribed={(addedSources, newItems) => {
          const lastAdded = addedSources.at(-1)
          if (lastAdded) setSelectedSourceId(lastAdded.id)
          setNotice(`已添加 ${addedSources.length} 个小黑盒话题，新增 ${newItems} 条资讯。`)
          setReloadVersion((version) => version + 1)
        }}
      />
    </div>
  )
}
