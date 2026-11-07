import { useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Gamepad2,
  LoaderCircle,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react"

import {
  cancelXiaoheiheLogin,
  createXiaoheiheLoginQr,
  getXiaoheiheAccount,
  getXiaoheiheLoginStatus,
  listXiaoheiheTopics,
  logoutXiaoheihe,
  NewsApiError,
  subscribeXiaoheiheTopics,
  type XiaoheiheAccount,
  type XiaoheiheLogin,
  type XiaoheiheTopic,
} from "./api"
import type { NewsSource } from "../../src/types"

interface ProviderDialogProps {
  open: boolean
  onClose: () => void
  onSubscribed: (sources: NewsSource[], newItems: number) => void
}

function isPending(login: XiaoheiheLogin | null): boolean {
  return login?.state === "waiting_scan" || login?.state === "scanned_waiting_confirmation"
}

export function ProviderDialog({ open, onClose, onSubscribed }: ProviderDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const openRef = useRef(open)
  const viewRef = useRef<"providers" | "xiaoheihe">("providers")
  const [view, setView] = useState<"providers" | "xiaoheihe">("providers")
  const [account, setAccount] = useState<XiaoheiheAccount | null>(null)
  const [login, setLogin] = useState<XiaoheiheLogin | null>(null)
  const [topics, setTopics] = useState<XiaoheiheTopic[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    openRef.current = open
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  async function startLogin(): Promise<void> {
    setBusy(true)
    setError("")
    setLogin(null)
    try {
      const nextLogin = await createXiaoheiheLoginQr()
      if (!openRef.current || viewRef.current !== "xiaoheihe") {
        if (isPending(nextLogin)) void cancelXiaoheiheLogin(nextLogin.loginId).catch(() => undefined)
        return
      }
      setLogin(nextLogin)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "暂时无法生成二维码")
    } finally {
      setBusy(false)
    }
  }

  async function loadTopics(): Promise<void> {
    setLoading(true)
    setError("")
    try {
      const result = await listXiaoheiheTopics()
      setTopics(result.items)
      setSelectedIds([])
    } catch (requestError) {
      if (requestError instanceof NewsApiError && requestError.status === 401) {
        setAccount({ connected: false })
        setError("小黑盒登录已失效，请重新扫码。")
      } else {
        setError(requestError instanceof Error ? requestError.message : "无法读取小黑盒话题目录")
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open || view !== "xiaoheihe") return
    let cancelled = false
    setLoading(true)
    setError("")
    void getXiaoheiheAccount()
      .then(async (currentAccount) => {
        if (cancelled) return
        setAccount(currentAccount)
        if (currentAccount.connected) {
          await loadTopics()
        } else {
          await startLogin()
        }
      })
      .catch((requestError: unknown) => {
        if (cancelled) return
        setError(requestError instanceof Error ? requestError.message : "无法读取小黑盒账号状态")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, view])

  useEffect(() => {
    if (!open || view !== "xiaoheihe" || !isPending(login)) return
    let cancelled = false
    let timer: number | undefined
    const poll = async (): Promise<void> => {
      if (!login) return
      try {
        const nextLogin = await getXiaoheiheLoginStatus(login.loginId)
        if (cancelled) return
        setLogin(nextLogin)
        if (isPending(nextLogin)) timer = window.setTimeout(() => void poll(), 2200)
        else if (nextLogin.state === "failed" || nextLogin.state === "expired") setError(nextLogin.message)
      } catch (requestError) {
        if (cancelled) return
        setError(requestError instanceof Error ? requestError.message : "暂时无法检查扫码状态")
        timer = window.setTimeout(() => void poll(), 3000)
      }
    }
    timer = window.setTimeout(() => void poll(), 1500)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [open, view, login?.loginId, login?.state])

  useEffect(() => {
    if (!open || view !== "xiaoheihe" || login?.state !== "success") return
    setAccount({
      connected: true,
      uid: login.uid,
      nickname: login.nickname,
    })
    void loadTopics()
  }, [open, view, login?.state])

  const filteredTopics = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    if (!query) return topics
    return topics.filter((topic) => `${topic.group} ${topic.name}`.toLocaleLowerCase().includes(query))
  }, [search, topics])

  function closeDialog(): void {
    if (login && isPending(login)) void cancelXiaoheiheLogin(login.loginId).catch(() => undefined)
    openRef.current = false
    viewRef.current = "providers"
    setLogin(null)
    setError("")
    setView("providers")
    onClose()
  }

  function backToProviders(): void {
    if (login && isPending(login)) void cancelXiaoheiheLogin(login.loginId).catch(() => undefined)
    viewRef.current = "providers"
    setLogin(null)
    setView("providers")
  }

  function toggleTopic(topic: XiaoheiheTopic): void {
    if (topic.subscribed) return
    setSelectedIds((current) => {
      if (current.includes(topic.id)) return current.filter((id) => id !== topic.id)
      if (current.length >= 20) return current
      return [...current, topic.id]
    })
  }

  async function handleSubscribe(): Promise<void> {
    if (!selectedIds.length) return
    setBusy(true)
    setError("")
    try {
      const result = await subscribeXiaoheiheTopics(selectedIds)
      onSubscribed(result.sources, result.newItems)
      setTopics((current) => current.map((topic) => (
        selectedIds.includes(topic.id) ? { ...topic, subscribed: true } : topic
      )))
      setSelectedIds([])
    } catch (requestError) {
      if (requestError instanceof NewsApiError && requestError.status === 401) {
        setAccount({ connected: false })
        setError("小黑盒登录已失效，请重新扫码。")
      } else {
        setError(requestError instanceof Error ? requestError.message : "添加话题失败")
      }
    } finally {
      setBusy(false)
    }
  }

  async function handleLogout(): Promise<void> {
    if (!window.confirm("清除保存在此电脑上的小黑盒登录信息？现有话题订阅会保留，但之后需要重新扫码。")) return
    setBusy(true)
    setError("")
    try {
      await logoutXiaoheihe()
      setAccount({ connected: false })
      setTopics([])
      setLogin(null)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "退出小黑盒账号失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="reader-provider-dialog"
      aria-labelledby="reader-provider-title"
      onCancel={(event) => { event.preventDefault(); closeDialog() }}
      onClick={(event) => { if (event.target === event.currentTarget) closeDialog() }}
    >
      <div className="reader-provider-dialog-panel">
        <header className="reader-provider-dialog-header">
          {view === "xiaoheihe" && (
            <button className="reader-icon-button" type="button" aria-label="返回平台列表" onClick={backToProviders}>
              <ArrowLeft aria-hidden="true" />
            </button>
          )}
          <div>
            <p className="reader-eyebrow">SPECIAL SOURCES</p>
            <h2 id="reader-provider-title">{view === "providers" ? "添加特殊订阅源" : "小黑盒话题"}</h2>
          </div>
          <button className="reader-icon-button" type="button" aria-label="关闭弹窗" onClick={closeDialog}>
            <X aria-hidden="true" />
          </button>
        </header>

        {view === "providers" ? (
          <div className="reader-provider-list">
            <button
              type="button"
              className="reader-provider-card"
              onClick={() => { viewRef.current = "xiaoheihe"; setView("xiaoheihe") }}
            >
              <span className="reader-provider-logo"><Gamepad2 aria-hidden="true" /></span>
              <span className="reader-provider-copy">
                <strong>小黑盒</strong>
                <small>扫码登录后选择话题订阅</small>
              </span>
              <ChevronRight aria-hidden="true" />
            </button>
          </div>
        ) : (
          <>
            <div className="reader-provider-account">
              <span className={`reader-account-dot ${account?.connected ? "is-connected" : ""}`} />
              <span>
                {account?.connected
                  ? `已登录${account.nickname ? `：${account.nickname}` : ""}`
                  : isPending(login) ? login?.message : "未登录小黑盒"}
              </span>
              {account?.connected ? (
                <button className="reader-link-button" type="button" disabled={busy} onClick={() => void handleLogout()}>
                  <LogOut aria-hidden="true" />退出账号
                </button>
              ) : null}
            </div>

            {error && <p className="reader-dialog-error" role="alert">{error}</p>}

            {loading && !login && !account?.connected ? (
              <div className="reader-dialog-loading"><LoaderCircle aria-hidden="true" className="reader-spin" />正在连接小黑盒…</div>
            ) : !account?.connected ? (
              <section className="reader-qr-section" aria-label="小黑盒扫码登录">
                {login?.qrImage && isPending(login) ? (
                  <>
                    <img className="reader-qr-image" src={login.qrImage} alt="小黑盒登录二维码" />
                    <p className="reader-qr-hint">使用小黑盒客户端扫码，并在手机上确认登录。</p>
                    <p className="reader-qr-expiry">二维码有效期至 {new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(login.expiresAt))}</p>
                  </>
                ) : (
                  <div className="reader-qr-expired">
                    <Gamepad2 aria-hidden="true" />
                    <p>{login?.message || "准备小黑盒扫码登录"}</p>
                    <button className="reader-button reader-button-primary" type="button" disabled={busy} onClick={() => void startLogin()}>
                      {busy ? <LoaderCircle aria-hidden="true" className="reader-spin" /> : <RefreshCw aria-hidden="true" />}
                      <span>{busy ? "正在生成" : "生成登录二维码"}</span>
                    </button>
                  </div>
                )}
              </section>
            ) : (
              <section className="reader-topic-section" aria-label="选择小黑盒话题">
                <div className="reader-topic-toolbar">
                  <label className="reader-topic-search">
                    <Search aria-hidden="true" />
                    <span className="reader-visually-hidden">搜索话题</span>
                    <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索话题" />
                  </label>
                  <button className="reader-icon-button" type="button" aria-label="刷新话题目录" disabled={loading} onClick={() => void loadTopics()}>
                    {loading ? <LoaderCircle aria-hidden="true" className="reader-spin" /> : <RefreshCw aria-hidden="true" />}
                  </button>
                </div>
                <p className="reader-topic-help">选择最多 20 个话题。每个话题会作为独立订阅源保存在 TabKeep 本机。</p>
                <div className="reader-topic-list" aria-live="polite">
                  {filteredTopics.map((topic) => {
                    const checked = topic.subscribed || selectedIds.includes(topic.id)
                    return (
                      <label key={topic.id} className={`reader-topic-option ${topic.subscribed ? "is-subscribed" : ""}`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={topic.subscribed || busy}
                          onChange={() => toggleTopic(topic)}
                        />
                        <span className="reader-topic-check"><Check aria-hidden="true" /></span>
                        <span className="reader-topic-label">
                          <strong>{topic.name}</strong>
                          {topic.group && <small>{topic.group}</small>}
                        </span>
                        {topic.subscribed && <span className="reader-topic-existing">已订阅</span>}
                      </label>
                    )
                  })}
                  {!loading && filteredTopics.length === 0 && <p className="reader-topic-empty">没有找到匹配的话题。</p>}
                  {loading && <div className="reader-dialog-loading"><LoaderCircle aria-hidden="true" className="reader-spin" />正在读取话题目录…</div>}
                </div>
                <footer className="reader-topic-footer">
                  <span>已选择 {selectedIds.length} / 20</span>
                  <button className="reader-button reader-button-primary" type="button" disabled={!selectedIds.length || busy} onClick={() => void handleSubscribe()}>
                    {busy ? <LoaderCircle aria-hidden="true" className="reader-spin" /> : <Plus aria-hidden="true" />}
                    <span>{busy ? "添加并采集中…" : "添加所选话题"}</span>
                  </button>
                </footer>
              </section>
            )}
          </>
        )}
      </div>
    </dialog>
  )
}
