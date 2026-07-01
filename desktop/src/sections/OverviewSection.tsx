import { useMemo, useState } from "react"
import type { ReactNode } from "react"
import {
  KeyRound,
  Languages,
  Monitor,
  PanelsTopLeft,
  RefreshCw,
  RotateCcw,
  ScanText,
  Server,
} from "lucide-react"

import type { DesktopStatus, TabData, TabGroupColor, TabGroupStyleOptions } from "../types"
import { groupTabsByDomain } from "../utils"
import { Button, Checkbox, Notice, StatusCard } from "../components/primitives"

const TAB_GROUP_STYLE_KEY = "tabkeep.desktop.tabGroupStyle"
const COLORS: TabGroupColor[] = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
]

const COLOR_LABEL: Record<TabGroupColor, string> = {
  grey: "灰色",
  blue: "蓝色",
  red: "红色",
  yellow: "黄色",
  green: "绿色",
  pink: "粉色",
  purple: "紫色",
  cyan: "青色",
  orange: "橙色",
}

const DEFAULT_STYLE: TabGroupStyleOptions = {
  colorMode: "random",
  uniformColor: "blue",
  useDomainAsTitle: true,
  collapsedByDefault: false,
}

export function OverviewSection({
  tabs,
  backendReady,
  desktopStatus,
  connectionError,
  tokenInput,
  setTokenInput,
  onSaveToken,
  onClearToken,
  onRefresh,
  refreshing,
}: {
  tabs: TabData[]
  backendReady: boolean | null
  desktopStatus: DesktopStatus | null
  connectionError: string | null
  tokenInput: string
  setTokenInput: (value: string) => void
  onSaveToken: () => Promise<void>
  onClearToken: () => Promise<void>
  onRefresh: () => Promise<void>
  refreshing: boolean
}) {
  const groupedTabs = useMemo(() => groupTabsByDomain(tabs), [tabs])
  const groupableCount = groupedTabs.reduce(
    (sum, group) => sum + (group.tabs.length >= 2 ? group.tabs.length : 0),
    0,
  )
  const [style, setStyle] = useState<TabGroupStyleOptions>(() => loadTabGroupStyle())
  const [saved, setSaved] = useState(false)

  const saveStyle = () => {
    localStorage.setItem(TAB_GROUP_STYLE_KEY, JSON.stringify(style))
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className="space-y-5">
      <header className="tk-topbar">
        <div>
          <h1 className="tk-page-title">概览</h1>
          <p className="tk-page-subtitle">今日概况</p>
        </div>
        <Button variant="secondary" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          刷新
        </Button>
      </header>

      <section className="tk-status-grid">
        <StatusCard
          icon={<Monitor className="h-4 w-4" />}
          title="桌面端"
          value={desktopStatus?.ok ? "在线" : "未就绪"}
          tone={desktopStatus?.ok ? "success" : "warning"}
          detail={desktopStatus?.version ? `v${desktopStatus.version}` : "等待状态"}
        />
        <StatusCard
          icon={<Server className="h-4 w-4" />}
          title="后端连接"
          value={backendReady === null ? "检查中" : backendReady ? "已连接" : "未连接"}
          tone={backendReady ? "success" : backendReady === false ? "error" : "warning"}
          detail={backendReady ? "服务正常" : "等待连接"}
        />
        <StatusCard
          icon={<KeyRound className="h-4 w-4" />}
          title="模型凭据"
          value={desktopStatus?.token_cached ? "已缓存" : "未缓存"}
          tone={desktopStatus?.token_cached ? "success" : "warning"}
          detail="翻译与知识问答"
        />
        <StatusCard
          icon={<PanelsTopLeft className="h-4 w-4" />}
          title="标签页"
          value={`${tabs.length} 个`}
          tone="neutral"
          detail={groupableCount > 0 ? `${groupableCount} 个可分组` : "暂无可分组标签"}
        />
      </section>

      <section className="tk-overview-usage-strip">
        <OverviewUsageItem
          icon={<Languages className="h-5 w-5" />}
          label="今日翻译"
          value={desktopStatus?.today_translation_count ?? 0}
          suffix="次"
        />
        <OverviewUsageItem
          icon={<ScanText className="h-5 w-5" />}
          label="今日 OCR"
          value={desktopStatus?.today_ocr_count ?? 0}
          suffix="次"
        />
        <div className="tk-overview-usage-meta">
          <span>统计日期</span>
          <strong>{desktopStatus?.usage_date ?? "今天"}</strong>
        </div>
      </section>

      {connectionError && <Notice tone="warning">{connectionError}</Notice>}

      <section className="tk-grid-two">
        <div className="space-y-4">
          <section className="tk-panel">
            <div className="tk-panel-header">
              <div>
                <h2 className="tk-panel-title">标签分组样式</h2>
              </div>
              <span className="tk-badge">{saved ? "已保存" : "本地"}</span>
            </div>
            <div className="tk-panel-body space-y-4">
              <div className="tk-form-grid">
                <label className="tk-field">
                  <span className="tk-label">颜色模式</span>
                  <select
                    className="tk-select"
                    value={style.colorMode}
                    onChange={(event) =>
                      setStyle({
                        ...style,
                        colorMode: event.target.value as TabGroupStyleOptions["colorMode"],
                      })
                    }>
                    <option value="random">按域名随机</option>
                    <option value="uniform">统一颜色</option>
                  </select>
                </label>

                {style.colorMode === "uniform" && (
                  <label className="tk-field">
                    <span className="tk-label">统一颜色</span>
                    <select
                      className="tk-select"
                      value={style.uniformColor}
                      onChange={(event) =>
                        setStyle({ ...style, uniformColor: event.target.value as TabGroupColor })
                      }>
                      {COLORS.map((color) => (
                        <option key={color} value={color}>
                          {COLOR_LABEL[color]}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>

              <div className="grid gap-2">
                <Checkbox
                  label="使用域名作为分组标题"
                  checked={style.useDomainAsTitle}
                  onChange={(checked) => setStyle({ ...style, useDomainAsTitle: checked })}
                />
                <Checkbox
                  label="默认折叠分组"
                  checked={style.collapsedByDefault}
                  onChange={(checked) => setStyle({ ...style, collapsedByDefault: checked })}
                />
              </div>
            </div>
            <div className="tk-command-bar">
              <Button onClick={saveStyle}>{saved ? "已保存" : "保存设置"}</Button>
              <Button variant="ghost" onClick={() => setStyle(DEFAULT_STYLE)}>
                <RotateCcw className="h-4 w-4" />
                重置
              </Button>
            </div>
          </section>
        </div>

        <section className="tk-panel">
          <div className="tk-panel-header">
            <h2 className="tk-panel-title">连接凭据</h2>
            <span className="tk-badge tk-badge-warning">本机</span>
          </div>
          <div className="tk-panel-body space-y-3">
            <label className="tk-field">
              <span className="tk-label">连接密钥</span>
              <input
                className="tk-input"
                type="password"
                value={tokenInput}
                onChange={(event) => setTokenInput(event.target.value)}
                placeholder="自动获取，或手动粘贴"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button onClick={onSaveToken} disabled={!tokenInput.trim()}>
                保存密钥
              </Button>
              <Button variant="secondary" onClick={onClearToken}>
                清除
              </Button>
            </div>
            <div className="tk-muted-box">
              打开浏览器扩展后会自动完成连接。
            </div>
          </div>
        </section>
      </section>

      <section className="tk-panel">
        <div className="tk-panel-header">
          <h2 className="tk-panel-title">域名分布</h2>
          <span className="tk-badge">{groupedTabs.length} 组</span>
        </div>
        <div className="tk-panel-body">
          {groupedTabs.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无标签页数据</p>
          ) : (
            <div className="grid gap-2">
              {groupedTabs.map((group) => (
                <div
                  key={group.domain}
                  className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{group.domain}</span>
                  <span className="text-xs text-muted-foreground">
                    {group.count} 个{group.tabs.length >= 2 ? " · 可分组" : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
          {groupableCount > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">当前可分组标签：{groupableCount} 个</p>
          )}
        </div>
      </section>
    </div>
  )
}

function OverviewUsageItem({
  icon,
  label,
  value,
  suffix,
}: {
  icon: ReactNode
  label: string
  value: number
  suffix: string
}) {
  return (
    <div className="tk-overview-usage-item">
      <span className="tk-overview-usage-icon">{icon}</span>
      <div>
        <p>{label}</p>
        <strong>
          {value}
          <span>{suffix}</span>
        </strong>
      </div>
    </div>
  )
}

function loadTabGroupStyle(): TabGroupStyleOptions {
  try {
    const stored = localStorage.getItem(TAB_GROUP_STYLE_KEY)
    if (!stored) return DEFAULT_STYLE
    return { ...DEFAULT_STYLE, ...JSON.parse(stored) }
  } catch {
    return DEFAULT_STYLE
  }
}
