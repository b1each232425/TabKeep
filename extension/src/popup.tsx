import { useEffect, useState } from "react"
import type { TabData } from "./types"
import { groupTabsByDomain } from "./utils/tabUtils"
import { loadFromIDB } from "./utils/indexedDB"
import { Button } from "./components/ui/button"
import "./style.css"

function IndexPopup() {
  const [tabs, setTabs] = useState<TabData[]>([])
  const [loading, setLoading] = useState(true)
  const [showGrouped, setShowGrouped] = useState(false)

  useEffect(() => {
    loadFromIDB<TabData>().then((data) => {
      if (data) {
        setTabs(data)
      }
      setLoading(false)
    })
  }, [])

  const groupedTabs = groupTabsByDomain(tabs)

  return (
    <div className="p-4 max-h-96 overflow-y-auto" style={{ minWidth: 500, width: 500 }}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold">TabKeep</h3>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={showGrouped ? "default" : "outline"}
            onClick={() => setShowGrouped(!showGrouped)}>
            {showGrouped ? "原始" : "整理"}
          </Button>
          {showGrouped && (
            <Button
              size="sm"
              onClick={() => chrome.runtime.sendMessage({ type: "CREATE_TAB_GROUPS" })}>
              执行分组
            </Button>
          )}
        </div>
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
            {tabs.map((tab) => (
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
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export default IndexPopup