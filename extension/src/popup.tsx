import { useEffect, useState } from "react"
import { Bookmark, BookmarkCheck, Settings, Sparkles, Star, StarOff } from "lucide-react"
import type { TabData } from "./types"
import { groupTabsByDomain } from "./utils/tabUtils"
import { loadFromIDB } from "./utils/indexedDB"
import { Button } from "./components/ui/button"
import "./style.css"

const openDashboard = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("options.html") })
}

type SaveStatus = "extracting" | "saving" | "ok" | "error"

function IndexPopup() {
  const [tabs, setTabs] = useState<TabData[]>([])
  const [loading, setLoading] = useState(true)
  const [showGrouped, setShowGrouped] = useState(false)
  const [aiGrouping, setAiGrouping] = useState(false)
  const [saveStatus, setSaveStatus] = useState<Record<number, SaveStatus>>({})

  useEffect(() => {
    loadFromIDB<TabData>().then((data) => {
      if (data) {
        setTabs(data)
      }
      setLoading(false)
    })
  }, [])

  const groupedTabs = groupTabsByDomain(tabs)

  const handleSave = async (tab: TabData) => {
    if (tab.id === undefined) return
    const tabId = tab.id
    setSaveStatus((s) => ({ ...s, [tabId]: "saving" }))
    try {
      const res = await chrome.runtime.sendMessage({ type: "SAVE_TAB_TO_NOTE", tab })
      setSaveStatus((s) => ({ ...s, [tabId]: res?.ok ? "ok" : "error" }))
      if (!res?.ok) {
        alert(`收藏失败：${res?.error ?? "未知错误"}\n请先在仪表盘配置笔记集成。`)
      }
    } catch (err) {
      setSaveStatus((s) => ({ ...s, [tabId]: "error" }))
      alert(`收藏失败：${String(err)}`)
    }
  }

  const handleSaveFull = async (tab: TabData) => {
    if (tab.id === undefined) return
    const tabId = tab.id
    setSaveStatus((s) => ({ ...s, [tabId]: "extracting" }))
    try {
      const res = await chrome.runtime.sendMessage({ type: "SAVE_TAB_FULL", tab })
      setSaveStatus((s) => ({ ...s, [tabId]: res?.ok ? "ok" : "error" }))
      if (!res?.ok) {
        alert(`全文收藏失败：${res?.error ?? "未知错误"}`)
      }
    } catch (err) {
      setSaveStatus((s) => ({ ...s, [tabId]: "error" }))
      alert(`全文收藏失败：${String(err)}`)
    }
  }

  return (
    <div className="p-4 max-h-96 overflow-y-auto" style={{ minWidth: 500, width: 500 }}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1">
          <h3 className="text-lg font-semibold">TabKeep</h3>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={openDashboard}
            title="打开仪表盘">
            <Settings className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={showGrouped ? "default" : "outline"}
            onClick={() => setShowGrouped(!showGrouped)}>
            {showGrouped ? "原始" : "整理"}
          </Button>
          {showGrouped && (
            <>
              <Button
                size="sm"
                onClick={() => chrome.runtime.sendMessage({ type: "CREATE_TAB_GROUPS" })}>
                执行分组
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={aiGrouping}
                onClick={async () => {
                  setAiGrouping(true)
                  try {
                    await chrome.runtime.sendMessage({ type: "CLASSIFY_AND_GROUP_TABS" })
                  } finally {
                    setAiGrouping(false)
                  }
                }}>
                <Sparkles className="h-4 w-4 mr-1" />
                {aiGrouping ? "分组中..." : "AI 分组"}
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="text-xs text-gray-500 mb-2 flex items-center gap-3">
        <span className="flex items-center gap-1">
          <Bookmark className="h-3 w-3" /> 仅链接
        </span>
        <span className="flex items-center gap-1">
          <Star className="h-3 w-3" /> 全文（用 Defuddle 提取）
        </span>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">加载中...</p>
      ) : showGrouped ? (
        <>
          <p className="text-sm text-gray-600 mb-3">共 {tabs.length} 个标签页，{groupedTabs.length} 个域名</p>
          <div className="space-y-2">
            {groupedTabs.map((group) => (
              <div key={group.domain} className="border border-gray-200 rounded-lg p-2">
                <div className="flex items-center gap-2 mb-2">
                  {group.favIconUrl ? (
                    <img
                      src={group.favIconUrl}
                      className="w-5 h-5 flex-shrink-0 object-cover"
                      alt=""
                      onError={(e) => e.currentTarget.classList.add("hidden")}
                    />
                  ) : (
                    <div className="w-5 h-5 flex-shrink-0 bg-gray-200 rounded flex items-center justify-center text-xs text-gray-500">
                      {group.isOther ? "?" : group.domain[0].toUpperCase()}
                    </div>
                  )}
                  <span className="flex-1 text-sm font-medium truncate">{group.domain}</span>
                  <span className="text-xs text-gray-500">({group.count})</span>
                </div>
                <div className="pl-7">
                  {group.tabs.map((tab, idx) => (
                    <div key={tab.id}>
                      <a
                        href={tab.url}
                        target="_blank"
                        className="block text-xs truncate text-blue-600 hover:underline"
                        title={tab.url}>
                        {tab.title || "无标题"}
                      </a>
                      {idx < group.tabs.length - 1 && <br />}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-gray-600 mb-3">共 {tabs.length} 个标签页</p>
          <div className="space-y-1">
            {tabs.map((tab) => {
              const status = tab.id !== undefined ? saveStatus[tab.id] : undefined
              const busy = status === "saving" || status === "extracting"
              const LinkIcon = status === "ok" ? BookmarkCheck : Bookmark
              const FullIcon = status === "ok" ? StarOff : Star
              return (
                <div key={tab.id} className="flex items-center gap-2 py-1 border-b border-gray-100">
                  {tab.favIconUrl && (
                    <img
                      src={tab.favIconUrl}
                      className="w-3 h-3 flex-shrink-0"
                      style={{ width: 12, height: 12 }}
                      alt=""
                      onError={(e) => e.currentTarget.classList.add("hidden")}
                    />
                  )}
                  <a
                    href={tab.url}
                    target="_blank"
                    className="flex-1 text-xs truncate text-blue-600 hover:underline"
                    title={tab.url}>
                    {tab.title || "无标题"}
                  </a>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6"
                    disabled={busy}
                    onClick={() => handleSave(tab)}
                    title={status === "ok" ? "已收藏链接" : "仅链接收藏"}>
                    <LinkIcon
                      className={`h-3 w-3 ${
                        status === "ok"
                          ? "text-green-600"
                          : status === "error"
                          ? "text-red-600"
                          : ""
                      }`}
                    />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6"
                    disabled={busy}
                    onClick={() => handleSaveFull(tab)}
                    title={status === "extracting" ? "提取中..." : "全文收藏（含正文）"}>
                    <FullIcon
                      className={`h-3 w-3 ${
                        status === "ok"
                          ? "text-green-600"
                          : status === "error"
                          ? "text-red-600"
                          : "text-amber-500"
                      } ${status === "extracting" ? "animate-pulse" : ""}`}
                    />
                  </Button>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

export default IndexPopup
