import { RefreshCw } from "lucide-react"

import { Button, Checkbox, TextField } from "../../components/primitives"
import type { KnowledgeConfig, KnowledgeStats } from "../../types"

export function KnowledgeConfigPanel({
  config,
  pathText,
  stats,
  autoRerankReady,
  saving,
  syncingKnowledge,
  onConfigChange,
  onPathTextChange,
  onSave,
  onSyncAll,
}: {
  config: KnowledgeConfig
  pathText: string
  stats: KnowledgeStats | null
  autoRerankReady: boolean
  saving: boolean
  syncingKnowledge: boolean
  onConfigChange: (config: KnowledgeConfig) => void
  onPathTextChange: (value: string) => void
  onSave: () => void
  onSyncAll: () => void
}) {
  return (
    <section className="tk-panel">
      <div className="tk-panel-header">
        <div>
          <h2 className="tk-panel-title">知识库索引与检索</h2>
          <p className="text-xs text-muted-foreground">统一配置同步来源和语义检索；rerank 自动复用同一 API Key</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="tk-badge">{config.enabled ? "索引启用" : "索引关闭"}</span>
          <span className="tk-badge">{config.embedding.enabled ? "语义检索" : "FTS"}</span>
          <span className="tk-badge">{autoRerankReady ? "自动 Rerank" : "未重排"}</span>
        </div>
      </div>
      <div className="tk-panel-body">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.08fr)_minmax(300px,0.92fr)]">
          <section className="space-y-4 lg:border-r lg:border-slate-200/70 lg:pr-6">
            <div>
              <h3 className="text-sm font-semibold text-slate-950">同步来源</h3>
              <p className="mt-1 text-xs text-muted-foreground">本地 Markdown、Obsidian 和已配置的笔记集成</p>
            </div>
            <Checkbox
              label="启用知识库索引"
              checked={config.enabled}
              onChange={(checked) => onConfigChange({ ...config, enabled: checked })}
            />
            <label className="tk-field">
              <span className="tk-label">Markdown / Obsidian 路径</span>
              <textarea
                className="tk-textarea min-h-36"
                value={pathText}
                onChange={(event) => onPathTextChange(event.target.value)}
                placeholder={"E:\\Notes\\ObsidianVault\nE:\\Projects\\TabKeep\\docs"}
              />
            </label>
            <TextField
              label="单文件最大字节数"
              type="number"
              value={String(config.maxFileBytes)}
              onChange={(value) =>
                onConfigChange({ ...config, maxFileBytes: Number(value) || 1_000_000 })
              }
              placeholder="1000000"
            />
          </section>

          <section className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-950">向量检索</h3>
              <p className="mt-1 text-xs text-muted-foreground">默认使用 SiliconFlow embedding 和 rerank</p>
            </div>
            <Checkbox
              label="启用语义检索"
              checked={config.embedding.enabled}
              onChange={(checked) =>
                onConfigChange({
                  ...config,
                  embedding: { ...config.embedding, enabled: checked },
                })
              }
            />
            <TextField
              label="API Key"
              type="password"
              value={config.embedding.apiKey}
              onChange={(value) =>
                onConfigChange({
                  ...config,
                  embedding: { ...config.embedding, apiKey: value },
                })
              }
              placeholder="sk-..."
            />
            {stats?.vectorMessage && <div className="tk-muted-box">{stats.vectorMessage}</div>}
          </section>
        </div>
      </div>
      <div className="tk-command-bar justify-between">
        <span className="text-xs text-muted-foreground">保存会同时写入同步来源和向量检索配置</span>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={onSave} disabled={saving || syncingKnowledge}>
            {saving ? "保存中..." : "保存知识库设置"}
          </Button>
          <Button onClick={onSyncAll} disabled={syncingKnowledge || saving}>
            <RefreshCw className={`h-4 w-4 ${syncingKnowledge ? "animate-spin" : ""}`} />
            {syncingKnowledge ? "同步中..." : "同步知识库"}
          </Button>
        </div>
      </div>
    </section>
  )
}
