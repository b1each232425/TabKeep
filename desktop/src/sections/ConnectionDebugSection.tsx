import { useState } from "react"
import { KeyRound, Server } from "lucide-react"

import { Button, Notice, StatusCard } from "../components/primitives"
import type { DesktopStatus } from "../types"

export function ConnectionDebugSection({
  desktopStatus,
  backendReady,
  connectionError,
  tokenInput,
  setTokenInput,
  onSaveToken,
  onClearToken,
}: {
  desktopStatus: DesktopStatus | null
  backendReady: boolean | null
  connectionError: string | null
  tokenInput: string
  setTokenInput: (value: string) => void
  onSaveToken: () => Promise<void>
  onClearToken: () => Promise<void>
}) {
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState("")

  const run = async (action: () => Promise<void>, successMessage: string) => {
    setPending(true)
    setNotice("")
    try {
      await action()
      setNotice(successMessage)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-5">
      <header className="tk-topbar">
        <div>
          <h1 className="tk-page-title">连接调试</h1>
          <p className="tk-page-subtitle">本地服务与扩展凭据</p>
        </div>
      </header>

      <section className="tk-status-grid">
        <StatusCard
          icon={<Server className="h-4 w-4" />}
          title="后端连接"
          value={backendReady === null ? "检查中" : backendReady ? "已连接" : "未连接"}
          tone={backendReady ? "success" : backendReady === false ? "error" : "warning"}
        />
        <StatusCard
          icon={<KeyRound className="h-4 w-4" />}
          title="连接密钥"
          value={desktopStatus?.token_cached ? "已缓存" : "未缓存"}
          tone={desktopStatus?.token_cached ? "success" : "warning"}
        />
      </section>

      {connectionError && <Notice tone="warning">{connectionError}</Notice>}
      {notice && <Notice>{notice}</Notice>}

      <section className="tk-panel">
        <div className="tk-panel-header">
          <h2 className="tk-panel-title">故障恢复</h2>
          <span className="tk-badge tk-badge-warning">开发工具</span>
        </div>
        <div className="tk-panel-body space-y-3">
          <label className="tk-field">
            <span className="tk-label">连接密钥</span>
            <input
              className="tk-input"
              type="password"
              autoComplete="off"
              value={tokenInput}
              onChange={(event) => setTokenInput(event.target.value)}
              placeholder="粘贴扩展使用的连接密钥"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={pending || !tokenInput.trim()}
              onClick={() => void run(onSaveToken, "连接密钥已更新")}>
              保存密钥
            </Button>
            <Button
              variant="secondary"
              disabled={pending || !desktopStatus?.token_cached}
              onClick={() => void run(onClearToken, "桌面端缓存已清除")}>
              清除缓存
            </Button>
          </div>
          <div className="tk-muted-box">
            正常连接由浏览器扩展自动完成，仅在扩展与桌面端凭据不一致时使用。
          </div>
        </div>
      </section>
    </div>
  )
}
