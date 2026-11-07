import { useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import {
  ArrowLeft,
  AlertCircle,
  ArrowUpRight,
  LoaderCircle,
  LockKeyhole,
  Search,
  ShieldCheck,
  Unplug,
  X,
} from "lucide-react"

import {
  cancelTopicSearchAuth,
  completeTopicSearchAuth,
  disconnectTopicSearchAuth,
  getTopicSearchAuth,
  getTopicSearchComments,
  getTopicSearchPreferences,
  NewsApiError,
  saveTopicSearchPreference,
  searchNewsTopics,
  startTopicSearchAuth,
  type TopicSearchAuth,
  type TopicSearchAuthProvider,
  type TopicSearchCommentTaskResponse,
  type TopicSearchCommentTaskState,
  type TopicSearchItem,
  type TopicSearchPreferences,
  type TopicSearchProviderId,
  type TopicSearchProviderState,
  type TopicSearchResponse,
} from "./api"

const PROVIDERS: { id: TopicSearchProviderId; title: string }[] = [
  { id: "local", title: "本地资讯" },
  { id: "tieba", title: "百度贴吧" },
  { id: "xiaoheihe", title: "小黑盒" },
  { id: "zhihu", title: "知乎" },
  { id: "weibo", title: "微博" },
  { id: "douyin", title: "抖音" },
  { id: "bilibili", title: "哔哩哔哩" },
  { id: "kuaishou", title: "快手" },
]

const AUTH_PROVIDERS: TopicSearchAuthProvider[] = ["tieba", "zhihu", "weibo", "douyin", "bilibili", "kuaishou"]
const MANUAL_BROWSER_PROVIDERS = new Set<TopicSearchAuthProvider>(["douyin", "bilibili", "kuaishou"])
type AuthProvider = TopicSearchAuthProvider
type TopicSearchOptions = {
  query: string
  providers: TopicSearchProviderId[]
  timeRange: "all" | "24h" | "7d" | "30d"
}

const INITIAL_PREFERENCES: TopicSearchPreferences = {
  tieba: false,
  zhihu: false,
  weibo: false,
  douyin: false,
  bilibili: false,
  kuaishou: false,
}

function isAuthProvider(provider: TopicSearchProviderId): provider is AuthProvider {
  return (AUTH_PROVIDERS as readonly string[]).includes(provider)
}

function authProviderTitle(provider: AuthProvider): string {
  const titles: Record<AuthProvider, string> = {
    tieba: "百度贴吧",
    zhihu: "知乎",
    weibo: "微博",
    douyin: "抖音",
    bilibili: "哔哩哔哩",
    kuaishou: "快手",
  }
  return titles[provider]
}

function commentStateLabel(state: TopicSearchCommentTaskState | TopicSearchCommentTaskResponse["items"][number]["state"]): string {
  switch (state) {
    case "queued": return "等待采集"
    case "running": return "正在采集"
    case "completed": return "采集完成"
    case "partial": return "部分可用"
    case "login_required": return "需要登录"
    case "limited": return "平台限制"
    case "expired": return "任务已过期"
    case "failed": return "采集失败"
  }
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

function formatTime(value: string | null): string {
  if (!value) return "时间未知"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date)
}

function providerStateLabel(state: TopicSearchProviderState["state"]): string {
  switch (state) {
    case "success": return "已返回结果"
    case "empty": return "没有匹配结果"
    case "unsupported": return "暂不支持"
    case "login_required": return "需要授权"
    case "auth_expired_fallback": return "授权失效，已回退匿名"
    case "timeout": return "请求超时"
    case "not_selected": return "未选择"
    case "error": return "暂时不可用"
  }
}

function providerBadgeClass(state: TopicSearchProviderState["state"]): string {
  if (state === "success") return "topic-search-state topic-search-state-success"
  if (state === "empty" || state === "not_selected") return "topic-search-state topic-search-state-muted"
  if (state === "unsupported") return "topic-search-state topic-search-state-neutral"
  return "topic-search-state topic-search-state-warning"
}

function groupItems(items: TopicSearchItem[]): Map<TopicSearchProviderId, TopicSearchItem[]> {
  const groups = new Map<TopicSearchProviderId, TopicSearchItem[]>()
  for (const item of items) {
    const group = groups.get(item.provider) ?? []
    group.push(item)
    groups.set(item.provider, group)
  }
  return groups
}

export function TopicSearchPanel({ onUnauthorized }: { onUnauthorized: (message: string) => void }) {
  const [query, setQuery] = useState("")
  const [providers, setProviders] = useState<TopicSearchProviderId[]>(PROVIDERS.map(({ id }) => id))
  const [timeRange, setTimeRange] = useState<"all" | "24h" | "7d" | "30d">("7d")
  const [activeSearch, setActiveSearch] = useState<TopicSearchOptions | null>(null)
  const [searchResult, setSearchResult] = useState<TopicSearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState("")
  const [preferences, setPreferences] = useState<TopicSearchPreferences>(INITIAL_PREFERENCES)
  const [accounts, setAccounts] = useState<Partial<Record<AuthProvider, TopicSearchAuth>>>({})
  const [commentTaskIds, setCommentTaskIds] = useState<string[]>([])
  const [commentTasks, setCommentTasks] = useState<Record<string, TopicSearchCommentTaskResponse>>({})
  const [commentTaskMessages, setCommentTaskMessages] = useState<Record<string, { state: "expired" | "error"; message: string }>>({})
  const [commentItemTaskIds, setCommentItemTaskIds] = useState<Record<string, string>>({})
  const [authBusy, setAuthBusy] = useState<AuthProvider | null>(null)
  const [authMessage, setAuthMessage] = useState("")
  const [authError, setAuthError] = useState("")
  const [authDialogOpen, setAuthDialogOpen] = useState(false)
  const [activeLoginProvider, setActiveLoginProvider] = useState<AuthProvider | null>(null)
  const authDialogRef = useRef<HTMLDialogElement>(null)
  const commentPollInFlightRef = useRef(false)
  const searchGenerationRef = useRef(0)

  useEffect(() => {
    const dialog = authDialogRef.current
    if (!dialog) return
    if (authDialogOpen && !dialog.open) dialog.showModal()
    if (!authDialogOpen && dialog.open) dialog.close()
  }, [authDialogOpen])

  useEffect(() => {
    let cancelled = false
    void Promise.allSettled([
      getTopicSearchPreferences(),
      ...AUTH_PROVIDERS.map((provider) => getTopicSearchAuth(provider)),
    ]).then(([preferenceResult, ...accountResults]) => {
      if (cancelled) return
      if (preferenceResult.status === "fulfilled") setPreferences(preferenceResult.value)
      const nextAccounts: Partial<Record<AuthProvider, TopicSearchAuth>> = {}
      AUTH_PROVIDERS.forEach((provider, index) => {
        const result = accountResults[index]
        if (result?.status === "fulfilled") nextAccounts[provider] = result.value
      })
      setAccounts(nextAccounts)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!authDialogOpen || !activeLoginProvider) return
    let cancelled = false
    let timer = 0
    const pollLogin = async () => {
      try {
        const result = await completeTopicSearchAuth(activeLoginProvider)
        if (cancelled) return
        setAuthError("")
        setAccounts((current) => ({ ...current, [activeLoginProvider]: result }))
        setAuthMessage(result.message)
        if (result.connected || result.state === "login_required") {
          setActiveLoginProvider(null)
          return
        }
      } catch (reason) {
        if (!cancelled) {
          if (reason instanceof NewsApiError && reason.status === 401) onUnauthorized(reason.message)
          else setAuthError(reason instanceof Error ? reason.message : String(reason))
        }
      }
      if (!cancelled) timer = window.setTimeout(() => void pollLogin(), 2000)
    }
    timer = window.setTimeout(() => void pollLogin(), 500)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [activeLoginProvider, authDialogOpen, onUnauthorized])

  useEffect(() => {
    if (commentTaskIds.length === 0) return
    let cancelled = false
    let timer = 0
    const poll = async () => {
      if (cancelled) return
      if (commentPollInFlightRef.current) {
        timer = window.setTimeout(() => void poll(), 350)
        return
      }
      commentPollInFlightRef.current = true
      let shouldContinue = false
      try {
        for (const taskId of commentTaskIds) {
          if (cancelled) break
          try {
            const task = await getTopicSearchComments(taskId)
            if (cancelled) break
            setCommentTasks((current) => ({ ...current, [taskId]: task }))
            setCommentTaskMessages((current) => {
              if (!(taskId in current)) return current
              const next = { ...current }
              delete next[taskId]
              return next
            })
            if (task.state === "queued" || task.state === "running") shouldContinue = true
            else setCommentTaskIds((current) => current.filter((id) => id !== taskId))
          } catch (reason) {
            if (cancelled) break
            if (reason instanceof NewsApiError && reason.status === 401) {
              onUnauthorized(reason.message)
              setCommentTaskMessages((current) => ({
                ...current,
                [taskId]: { state: "error", message: reason.message },
              }))
              setCommentTaskIds((current) => current.filter((id) => id !== taskId))
            } else if (reason instanceof NewsApiError && (reason.status === 404 || reason.status === 410)) {
              setCommentTaskMessages((current) => ({
                ...current,
                [taskId]: {
                  state: reason.status === 410 ? "expired" : "error",
                  message: reason.message,
                },
              }))
              setCommentTaskIds((current) => current.filter((id) => id !== taskId))
            } else {
              setCommentTaskMessages((current) => ({
                ...current,
                [taskId]: {
                  state: "error",
                  message: reason instanceof Error ? reason.message : "读取评论任务失败。",
                },
              }))
              shouldContinue = true
            }
          }
        }
      } finally {
        commentPollInFlightRef.current = false
      }
      if (!cancelled && shouldContinue) timer = window.setTimeout(() => void poll(), 1200)
    }
    void poll()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [commentTaskIds, onUnauthorized])

  const resultGroups = useMemo(() => groupItems(searchResult?.items ?? []), [searchResult?.items])
  const commentResultsByKey = useMemo(() => {
    const results = new Map<string, TopicSearchCommentTaskResponse["items"][number]>()
    for (const task of Object.values(commentTasks)) {
      for (const item of task.items) results.set(item.key, item)
    }
    return results
  }, [commentTasks])
  const resultStates = useMemo(
    () => new Map((searchResult?.states ?? []).map((state) => [state.provider, state])),
    [searchResult?.states],
  )

  function reportError(reason: unknown): void {
    if (reason instanceof NewsApiError && reason.status === 401) {
      onUnauthorized(reason.message)
      return
    }
    setError(reason instanceof Error ? reason.message : String(reason))
  }

  async function runSearch(event?: FormEvent<HTMLFormElement>, cursor?: string, append = false): Promise<void> {
    event?.preventDefault()
    const generation = append ? searchGenerationRef.current : searchGenerationRef.current + 1
    if (!append) searchGenerationRef.current = generation
    const options: TopicSearchOptions = append && activeSearch
      ? activeSearch
      : { query: query.trim(), providers, timeRange }
    if (!append && !options.query) {
      setError("请输入要搜索的话题关键词。")
      return
    }
    if (!append && options.providers.length === 0) {
      setError("至少选择一个搜索范围。")
      return
    }
    setError("")
    if (append) setLoadingMore(true)
    else {
      setLoading(true)
      setSearchResult(null)
      setActiveSearch(options)
      setCommentTaskIds([])
      setCommentTasks({})
      setCommentTaskMessages({})
      setCommentItemTaskIds({})
    }
    try {
      const result = await searchNewsTopics({ ...options, cursor })
      if (generation !== searchGenerationRef.current) return
      const expiredProviders = result.states.filter(
        (state): state is TopicSearchProviderState & { provider: AuthProvider } =>
          isAuthProvider(state.provider) && state.state === "auth_expired_fallback",
      )
      if (expiredProviders.length > 0) {
        setAccounts((current) => {
          const next = { ...current }
          for (const state of expiredProviders) {
            const account = next[state.provider]
            if (account) {
              next[state.provider] = {
                ...account,
                connected: false,
                state: "login_required",
                message: state.message,
              }
            }
          }
          return next
        })
      }
      setSearchResult((current) => append && current
        ? { ...result, items: [...current.items, ...result.items] }
        : result)
      if (result.commentTaskId) {
        setCommentTaskIds((current) => current.includes(result.commentTaskId!) ? current : [...current, result.commentTaskId!])
        setCommentItemTaskIds((current) => {
          const next = { ...current }
          for (const item of result.items) {
            if (item.provider === "douyin" || item.provider === "bilibili" || item.provider === "kuaishou") {
              next[item.key] = result.commentTaskId!
            }
          }
          return next
        })
      }
    } catch (reason) {
      if (generation === searchGenerationRef.current) reportError(reason)
    } finally {
      if (generation === searchGenerationRef.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }

  async function handleAuthAction(provider: AuthProvider, action: "start" | "cancel" | "disconnect"): Promise<void> {
    setAuthBusy(provider)
    setAuthError("")
    setAuthMessage("")
    try {
      const result = action === "start"
        ? await startTopicSearchAuth(provider)
        : action === "cancel"
          ? await cancelTopicSearchAuth(provider)
          : await disconnectTopicSearchAuth(provider)
      setAccounts((current) => ({ ...current, [provider]: result }))
      setAuthMessage(result.message)
      if (action === "start") setActiveLoginProvider(provider)
      if (action === "cancel") setActiveLoginProvider(null)
      if (action === "disconnect") {
        setPreferences((current) => ({ ...current, [provider]: false }))
      }
    } catch (reason) {
      if (reason instanceof NewsApiError && reason.status === 401) onUnauthorized(reason.message)
      else setAuthError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setAuthBusy(null)
    }
  }

  async function handlePreferenceChange(provider: AuthProvider, enabled: boolean): Promise<void> {
    setAuthBusy(provider)
    setAuthError("")
    try {
      const result = await saveTopicSearchPreference(provider, enabled)
      setPreferences(result.preferences)
      setAccounts((current) => {
        const account = current[provider]
        return account ? { ...current, [provider]: { ...account, useAuthenticated: enabled } } : current
      })
    } catch (reason) {
      if (reason instanceof NewsApiError && reason.status === 401) onUnauthorized(reason.message)
      else setAuthError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setAuthBusy(null)
    }
  }

  function closeAuthDialog(): void {
    const provider = activeLoginProvider
    setActiveLoginProvider(null)
    setAuthDialogOpen(false)
    if (provider) void handleAuthAction(provider, "cancel")
  }

  return (
    <section className="reader-feed topic-search-panel" aria-label="跨平台话题搜索">
      <div className="reader-feed-heading topic-search-heading">
        <div>
          <p className="reader-eyebrow">TOPIC SEARCH</p>
          <h2>跨平台话题搜索</h2>
          <p>先查本地已采集资讯，再并行搜索公开平台。单个平台受限不会中断其他结果。</p>
        </div>
        {loading && <LoaderCircle aria-label="正在搜索" className="reader-spinner reader-spinner-small" />}
      </div>

      <form className="topic-search-form" onSubmit={(event) => void runSearch(event)}>
        <label className="reader-visually-hidden" htmlFor="topic-search-query">搜索话题</label>
        <div className="topic-search-query-row">
          <div className="reader-input-wrap">
            <Search aria-hidden="true" />
            <input
              id="topic-search-query"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="输入关键词，例如：独立游戏、AI 编程、某款游戏"
              maxLength={160}
              autoComplete="off"
            />
          </div>
          <label className="topic-search-range-label" htmlFor="topic-search-range">时间范围</label>
          <select id="topic-search-range" value={timeRange} onChange={(event) => setTimeRange(event.target.value as typeof timeRange)}>
            <option value="24h">最近 24 小时</option>
            <option value="7d">最近 7 天</option>
            <option value="30d">最近 30 天</option>
            <option value="all">不限时间</option>
          </select>
          <button className="reader-button reader-button-primary" type="submit" disabled={loading || loadingMore || providers.length === 0}>
            {loading ? <LoaderCircle aria-hidden="true" className="reader-spin" /> : <Search aria-hidden="true" />}
            <span>{loading ? "搜索中" : "搜索话题"}</span>
          </button>
        </div>
        <fieldset className="topic-search-provider-list">
          <legend>搜索范围</legend>
          {PROVIDERS.map((provider) => (
            <label key={provider.id} className="topic-search-provider-option">
              <input
                type="checkbox"
                checked={providers.includes(provider.id)}
                onChange={(event) => setProviders((current) => event.target.checked
                  ? [...current, provider.id]
                  : current.filter((selected) => selected !== provider.id))}
              />
              <span>{provider.title}</span>
              {resultStates.get(provider.id) && <small className={providerBadgeClass(resultStates.get(provider.id)!.state)}>{providerStateLabel(resultStates.get(provider.id)!.state)}</small>}
            </label>
          ))}
        </fieldset>
        <p className="topic-search-privacy"><ShieldCheck aria-hidden="true" /> 默认匿名搜索。视频评论只短期保存在后端内存和当前页面，不写入订阅、资讯库或搜索历史。</p>
      </form>

      {error && <div className="reader-notice reader-notice-error topic-search-notice" role="alert"><AlertCircle aria-hidden="true" /><span>{error}</span></div>}

      <div className="topic-search-auth-launch">
        <span><LockKeyhole aria-hidden="true" />可选账号授权 <small>默认匿名搜索</small></span>
        <button type="button" className="reader-button reader-button-secondary" onClick={() => setAuthDialogOpen(true)}>
          管理平台账号
        </button>
      </div>

      <dialog
        ref={authDialogRef}
        className="reader-provider-dialog topic-search-auth-dialog"
        aria-labelledby="topic-search-auth-title"
        onCancel={(event) => { event.preventDefault(); closeAuthDialog() }}
        onClick={(event) => { if (event.target === event.currentTarget) closeAuthDialog() }}
      >
        <div className="reader-provider-dialog-panel">
          <header className="reader-provider-dialog-header">
            <div>
              <p className="reader-eyebrow">OPTIONAL ACCOUNT ACCESS</p>
              <h2 id="topic-search-auth-title">平台账号授权</h2>
            </div>
            <button className="reader-icon-button" type="button" aria-label="关闭弹窗" onClick={closeAuthDialog}>
              <X aria-hidden="true" />
            </button>
          </header>
          <div className="topic-search-auth-dialog-body">
          <p className="topic-search-auth-help">贴吧和微博使用扫码登录；知乎在已连接的浏览器中新开标签。抖音、哔哩哔哩和快手会在当前 Edge/Chrome 新标签中手动登录或完成验证。授权搜索默认关闭。</p>
            {activeLoginProvider ? (
              <div className="topic-search-login-view">
                <div className="topic-search-login-heading">
                  <button type="button" className="reader-link-button" disabled={authBusy === activeLoginProvider} onClick={() => { setActiveLoginProvider(null); void handleAuthAction(activeLoginProvider, "cancel") }}>
                    <ArrowLeft aria-hidden="true" />返回平台列表
                  </button>
                  <strong>{authProviderTitle(activeLoginProvider)}{MANUAL_BROWSER_PROVIDERS.has(activeLoginProvider) ? "登录" : "扫码登录"}</strong>
                </div>
                {accounts[activeLoginProvider]?.loginImage ? (
                  <img className="topic-search-login-image" src={accounts[activeLoginProvider].loginImage!} alt={`${authProviderTitle(activeLoginProvider)}登录二维码`} />
                ) : (
                  <div className="topic-search-login-image-empty" role="status">
                    <LoaderCircle aria-hidden="true" className="reader-spin" />
                    <span>
                      {MANUAL_BROWSER_PROVIDERS.has(activeLoginProvider)
                        ? `请在当前 Edge/Chrome 新标签中完成${authProviderTitle(activeLoginProvider)}登录；完成后返回此处等待确认。`
                        : activeLoginProvider === "zhihu"
                          ? "请在已连接浏览器的知乎标签页中完成页面提示；二维码出现后会显示在这里。"
                          : "正在生成登录二维码…"}
                    </span>
                  </div>
                )}
                <p className="topic-search-login-status" role="status">
                  {authBusy === activeLoginProvider
                    ? MANUAL_BROWSER_PROVIDERS.has(activeLoginProvider) ? "正在当前浏览器打开登录页…" : "正在生成登录二维码…"
                    : accounts[activeLoginProvider]?.message ?? "请使用平台 App 扫码登录。"}
                </p>
                {!accounts[activeLoginProvider]?.loginImage && !authBusy && (
                  <p className="topic-search-login-hint">
                    {MANUAL_BROWSER_PROVIDERS.has(activeLoginProvider)
                      ? "请在当前 Edge/Chrome 新标签完成登录或安全验证，再返回此处；TabKeep 不会绕过平台验证。"
                      : activeLoginProvider === "zhihu"
                        ? "请在已连接浏览器的知乎标签页按页面提示操作。TabKeep 不会自动绕过平台验证。"
                        : "二维码暂不可用。可重新生成，或稍后再试；TabKeep 不会打开外部浏览器，也不会绕过平台验证。"}
                  </p>
                )}
                <div className="topic-search-login-actions">
                  <button type="button" className="reader-button reader-button-secondary" disabled={authBusy === activeLoginProvider} onClick={() => void handleAuthAction(activeLoginProvider, "start")}>
                    {authBusy === activeLoginProvider ? <LoaderCircle aria-hidden="true" className="reader-spin" /> : <Search aria-hidden="true" />}
                    <span>{MANUAL_BROWSER_PROVIDERS.has(activeLoginProvider) ? "重新打开登录页" : "重新生成二维码"}</span>
                  </button>
                  <button type="button" className="reader-button reader-button-secondary" disabled={authBusy === activeLoginProvider} onClick={() => { setActiveLoginProvider(null); void handleAuthAction(activeLoginProvider, "cancel") }}>
                    <X aria-hidden="true" /><span>取消登录</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="topic-search-auth-list">
              {AUTH_PROVIDERS.map((provider) => {
                const account = accounts[provider]
                const connected = account?.connected ?? false
                const busy = authBusy === provider
                return (
                  <article className="topic-search-auth-card" key={provider}>
                    <div className="topic-search-auth-title">
                      <span className={`reader-account-dot ${connected ? "is-connected" : ""}`} />
                      <strong>{authProviderTitle(provider)}</strong>
                      <small>{connected ? "账号已连接" : account?.state === "connecting" ? "等待登录确认" : "未连接"}</small>
                    </div>
                    <div className="topic-search-auth-controls">
                      {!connected && account?.state !== "connecting" && (
                        <button type="button" className="reader-button reader-button-secondary" disabled={busy} onClick={() => void handleAuthAction(provider, "start")}>
                          {busy ? <LoaderCircle aria-hidden="true" className="reader-spin" /> : <LockKeyhole aria-hidden="true" />}
                          <span>连接账号</span>
                        </button>
                      )}
                      {connected && (
                        <>
                          <label className="topic-search-auth-toggle">
                            <input
                              type="checkbox"
                              checked={preferences[provider]}
                              disabled={busy}
                              onChange={(event) => void handlePreferenceChange(provider, event.target.checked)}
                            />
                            <span>搜索时使用已授权账号</span>
                          </label>
                          <button type="button" className="reader-link-button" disabled={busy} onClick={() => void handleAuthAction(provider, "disconnect")}>
                            <Unplug aria-hidden="true" />断开
                          </button>
                        </>
                      )}
                    </div>
                  </article>
                )
              })}
              </div>
            )}
            {!activeLoginProvider && authMessage && <p className="topic-search-auth-message" role="status">{authMessage}</p>}
            {authError && <p className="topic-search-auth-error" role="alert">{authError}</p>}
          </div>
        </div>
      </dialog>

      {searchResult && (
        <div className="topic-search-results" aria-live="polite">
          <div className="topic-search-results-summary">
            <h3>“{searchResult.query}”的搜索结果</h3>
            <div className="topic-search-result-meta">
              <span>{searchResult.items.length} 条本页结果</span>
              {searchResult.requestId && <span title="用于定位本次搜索的后端诊断日志">诊断编号 {searchResult.requestId}</span>}
            </div>
          </div>
          <div className="topic-search-status-grid">
            {searchResult.states.filter((state) => state.state !== "not_selected").map((state) => (
              <div className="topic-search-status-card" key={state.provider}>
                <div><strong>{state.title}</strong><span className={providerBadgeClass(state.state)}>{providerStateLabel(state.state)}</span></div>
                <p>{state.message || (state.connected && !state.useAuthenticated ? "账号已连接，但本次搜索保持匿名。" : "")}</p>
              </div>
            ))}
          </div>
          {searchResult.items.length === 0 ? (
            <div className="reader-empty topic-search-empty">
              <span><Search aria-hidden="true" /></span>
              <h3>没有可显示的结果</h3>
              <p>查看上方每个平台的状态。可调整关键词或时间范围后再次搜索。</p>
            </div>
          ) : (
            <div className="topic-search-result-groups">
              {PROVIDERS.filter(({ id }) => resultGroups.has(id)).map(({ id, title }) => (
                <section className="topic-search-result-group" key={id} aria-label={`${title}搜索结果`}>
                  <h3>{title}<span>{resultGroups.get(id)?.length ?? 0}</span></h3>
                  {resultGroups.get(id)?.map((item) => {
                    const taskId = commentItemTaskIds[item.key]
                    const taskMessage = taskId ? commentTaskMessages[taskId] : undefined
                    const task = taskId ? commentTasks[taskId] : undefined
                    return (
                      <TopicResultCard
                        item={item}
                        key={item.key}
                        commentResult={commentResultsByKey.get(item.key)}
                        commentState={taskMessage ? taskMessage.state === "expired" ? "expired" : "failed" : undefined}
                        commentMessage={taskMessage?.message}
                        waitingForComments={Boolean(taskId && commentTaskIds.includes(taskId))}
                        taskState={task?.state}
                      />
                    )
                  })}
                </section>
              ))}
            </div>
          )}
          {searchResult.nextCursor && (
            <div className="reader-load-more">
              <button className="reader-button reader-button-secondary" type="button" disabled={loadingMore} onClick={() => void runSearch(undefined, searchResult.nextCursor ?? undefined, true)}>
                {loadingMore ? <LoaderCircle aria-hidden="true" className="reader-spin" /> : <Search aria-hidden="true" />}
                <span>{loadingMore ? "正在加载" : "加载更多结果"}</span>
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function TopicResultCard({
  item,
  commentResult,
  commentState,
  commentMessage,
  waitingForComments,
  taskState,
}: {
  item: TopicSearchItem
  commentResult?: TopicSearchCommentTaskResponse["items"][number]
  commentState?: TopicSearchCommentTaskState
  commentMessage?: string
  waitingForComments: boolean
  taskState?: TopicSearchCommentTaskState
}) {
  const isVideo = item.provider === "douyin" || item.provider === "bilibili" || item.provider === "kuaishou"
  const ranksCommentsByLikes = item.provider === "douyin" || item.provider === "bilibili"
  const comments = commentResult?.comments.slice(0, 10) ?? []
  const resolvedState = commentResult?.state ?? commentState ?? taskState ?? (waitingForComments ? "queued" : undefined)
  return (
    <article className="topic-search-result">
      <div className="topic-search-result-copy">
        <div className="reader-item-meta">
          {item.author && <span>{item.author}</span>}
          <time dateTime={item.publishedAt ?? undefined}>{formatTime(item.publishedAt)}</time>
        </div>
        <h4>{item.title}</h4>
        {item.content && <p>{item.content}</p>}
        {isVideo && (
          <div className="topic-search-comments">
            <p className="topic-search-comments-status" role="status">
              {resolvedState
                ? `一级评论：${commentStateLabel(resolvedState)}${commentResult ? `（${comments.length} 条）` : ""}`
                : "一级评论：本次没有启动采集任务"}
            </p>
            {(commentMessage || commentResult?.message) && (
              <p className="topic-search-comments-message">{commentMessage || commentResult?.message}</p>
            )}
            {commentResult?.state === "completed" && comments.length === 0 && (
              <p className="topic-search-comments-empty">页面未显示可读取的一级评论。</p>
            )}
            {comments.length > 0 && (
              <details className="topic-search-comments-details">
                <summary>
                  展开 {comments.length} 条一级评论{ranksCommentsByLikes ? "（前 100 条内按点赞排序）" : ""}
                </summary>
                <ul>
                  {comments.map((comment) => (
                    <li key={comment.key}>
                      <div className="topic-search-comment-meta">
                        {comment.author && <strong>{comment.author}</strong>}
                        {comment.publishedAt && <time>{formatTime(comment.publishedAt)}</time>}
                        {typeof comment.likeCount === "number" && (
                          <span>{comment.likeCount.toLocaleString("zh-CN")} 赞</span>
                        )}
                      </div>
                      <p>{comment.content}</p>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
        {isSafeWebUrl(item.url) && (
          <a className="reader-item-link" href={item.url} target="_blank" rel="noopener noreferrer">
            打开原文 <ArrowUpRight aria-hidden="true" />
          </a>
        )}
      </div>
      {isSafeWebUrl(item.imageUrl) && (
        <a className="topic-search-result-image" href={isSafeWebUrl(item.url) ? item.url : item.imageUrl} target="_blank" rel="noopener noreferrer" tabIndex={-1} aria-hidden="true">
          <img src={item.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
        </a>
      )}
    </article>
  )
}
