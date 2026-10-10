import { useMemo, useState } from "react"
import { Download, Sparkles, X } from "lucide-react"
import { save } from "@tauri-apps/plugin-dialog"

import { Button, Notice } from "../../components/primitives"
import { errorMessage } from "../../lib/errors"
import {
  exportStandaloneSkill,
  generateStandaloneSkillDraft,
  searchKnowledge,
  writeBase64File,
} from "../../api"
import type { KnowledgeCitation, KnowledgeSkillDraftResponse } from "../../types"

function candidateKey(item: KnowledgeCitation): string {
  return item.paragraphId || item.chunkId
}

export function KnowledgeSkillExportTrigger({
  onClick,
}: {
  onClick: () => void
}) {
  return (
    <Button onClick={onClick}>
      <Sparkles className="h-4 w-4" />
      创建 Skill
    </Button>
  )
}

export function KnowledgeSkillExportPanel({
  onClose,
  onStatus,
}: {
  onClose: () => void
  onStatus: (message: string) => void
}) {
  const [goal, setGoal] = useState("")
  const [candidates, setCandidates] = useState<KnowledgeCitation[]>([])
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState<KnowledgeSkillDraftResponse | null>(null)
  const [searching, setSearching] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const visibleCandidates = useMemo(() => {
    const seen = new Set<string>()
    return candidates.filter((item) => {
      const key = candidateKey(item)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [candidates])

  const runCandidateSearch = async () => {
    const query = goal.trim()
    if (!query) {
      setError("请先描述这个 Skill 要解决的问题")
      return
    }
    setSearching(true)
    setError(null)
    setDraft(null)
    setCandidates([])
    setSelectedKeys(new Set())
    try {
      const result = await searchKnowledge(query, 20)
      if (!result.ok) {
        setError(result.error ?? "召回知识失败")
        return
      }
      const unique: KnowledgeCitation[] = []
      const seen = new Set<string>()
      for (const item of result.items) {
        const key = candidateKey(item)
        if (seen.has(key)) continue
        seen.add(key)
        unique.push(item)
      }
      setCandidates(unique)
      setSelectedKeys(new Set(unique.filter((item) => item.paragraphId).map(candidateKey)))
      if (!unique.length) setError("没有召回相关知识，请换一种目标描述")
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSearching(false)
    }
  }

  const toggleCandidate = (item: KnowledgeCitation) => {
    if (!item.paragraphId || drafting) return
    const key = candidateKey(item)
    setDraft(null)
    setSelectedKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const getSelected = () => visibleCandidates.filter((item) => selectedKeys.has(candidateKey(item)))

  const generateDraft = async () => {
    const selected = getSelected()
    if (!goal.trim()) {
      setError("请先描述这个 Skill 要解决的问题")
      return
    }
    if (!selected.length) {
      setError("请至少保留一条知识结果")
      return
    }
    setDrafting(true)
    setDraft(null)
    setError(null)
    try {
      const result = await generateStandaloneSkillDraft({
        goal: goal.trim(),
        documentIds: [...new Set(selected.map((item) => item.documentId))],
        paragraphIds: [...new Set(selected.map((item) => item.paragraphId).filter(Boolean) as string[])],
      })
      setDraft(result)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setDrafting(false)
    }
  }

  const exportSkill = async () => {
    const selected = getSelected()
    if (!selected.length || !draft) {
      setError("请先生成当前知识范围对应的 Skill 草稿")
      return
    }
    setExporting(true)
    setError(null)
    try {
      const result = await exportStandaloneSkill({
        goal: goal.trim(),
        documentIds: [...new Set(selected.map((item) => item.documentId))],
        paragraphIds: [...new Set(selected.map((item) => item.paragraphId).filter(Boolean) as string[])],
        skillName: draft.skillName,
        displayName: draft.displayName,
        description: draft.description,
        skillVersion: draft.skillVersion,
        triggers: draft.triggers,
        capabilities: draft.capabilities,
      })
      const target = await save({
        defaultPath: result.fileName,
        filters: [{ name: "Skill package", extensions: ["zip"] }],
      })
      if (!target) return
      await writeBase64File(target, result.archiveBase64)
      onStatus(`Skill 已导出：${result.sourceCount} 篇笔记，${result.blockCount} 个知识块`)
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setExporting(false)
    }
  }

  return (
    <section className="tk-panel">
      <div className="tk-panel-header">
        <div>
          <h2 className="tk-panel-title">创建独立 Skill</h2>
          <p className="text-xs text-muted-foreground">描述目标后召回候选知识，确认范围后再导出</p>
        </div>
        <Button variant="ghost" onClick={onClose} aria-label="关闭 Skill 导出面板">
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="tk-panel-body space-y-4">
        {error && <Notice tone="warning">{error}</Notice>}
        <label className="tk-field">
          <span className="tk-label">Skill 目标</span>
          <textarea
            className="tk-textarea min-h-20"
            value={goal}
            disabled={drafting}
            onChange={(event) => {
              setGoal(event.target.value)
              setDraft(null)
              setCandidates([])
              setSelectedKeys(new Set())
            }}
            placeholder="例如：帮助我排查 MySQL InnoDB 锁等待和死锁问题"
          />
        </label>
        <div className="tk-command-bar px-0">
          <Button onClick={runCandidateSearch} disabled={searching || drafting}>
            <Sparkles className="h-4 w-4" />
            {searching ? "召回中..." : "召回候选知识"}
          </Button>
          {visibleCandidates.length > 0 && (
            <span className="text-xs text-muted-foreground">
              已选择 {selectedKeys.size} 条
              {visibleCandidates.some((item) => !item.paragraphId) &&
                `；${visibleCandidates.filter((item) => !item.paragraphId).length} 条缺少段落标识`}
            </span>
          )}
        </div>

        {visibleCandidates.length > 0 && (
          <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-800">候选知识</span>
              <span className="text-xs text-muted-foreground">取消勾选即可排除</span>
            </div>
            <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
              {visibleCandidates.map((item) => {
                const key = candidateKey(item)
                return (
                  <label key={key} className="flex cursor-pointer gap-3 rounded-lg border border-slate-200 bg-white p-3">
                    <input
                      className="mt-1"
                      type="checkbox"
                      checked={Boolean(item.paragraphId) && selectedKeys.has(key)}
                      disabled={!item.paragraphId || drafting}
                      onChange={() => toggleCandidate(item)}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-slate-800">
                        {item.paragraphTitle || item.title}
                      </span>
                      <span className="mt-1 block line-clamp-3 text-xs leading-5 text-muted-foreground">
                        {item.content}
                      </span>
                      <span className="mt-1 block text-[11px] text-slate-400">来源：{item.title}</span>
                      {!item.paragraphId && (
                        <span className="mt-1 block text-[11px] text-amber-700">
                          缺少段落标识，无法精确导出此结果
                        </span>
                      )}
                    </span>
                  </label>
                )
              })}
            </div>
          </div>
        )}

        {visibleCandidates.length > 0 && (
          <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-800">Skill 草稿</h3>
                <p className="text-xs text-muted-foreground">
                  根据当前勾选的笔记生成；所选片段会发送给当前配置的模型 API。生成后可预览，元数据暂不支持手动编辑。
                </p>
              </div>
              <Button onClick={generateDraft} disabled={drafting || searching || !selectedKeys.size}>
                <Sparkles className="h-4 w-4" />
                {drafting ? "生成中..." : draft ? "重新生成草稿" : "生成 Skill 草稿"}
              </Button>
            </div>
            {draft && (
              <div className="space-y-3 rounded-lg bg-slate-50 p-3 text-sm">
                <div>
                  <span className="text-xs text-muted-foreground">名称 · 版本</span>
                  <p className="font-medium text-slate-800">{draft.displayName} <span className="text-xs text-slate-500">{draft.skillVersion}</span></p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">适用范围</span>
                  <p className="text-slate-700">{draft.description}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">适用问题范围</span>
                  <ul className="list-disc space-y-1 pl-5 text-slate-700">
                    {draft.triggers.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">可提供的帮助</span>
                  <ul className="list-disc space-y-1 pl-5 text-slate-700">
                    {draft.capabilities.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </div>
                <p className="text-xs text-slate-500">Skill ID：{draft.skillName}</p>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="tk-command-bar">
        <Button onClick={exportSkill} disabled={exporting || drafting || !visibleCandidates.length || !selectedKeys.size || !draft}>
          <Download className="h-4 w-4" />
          {exporting ? "打包中..." : draft ? "确认并导出 ZIP" : "生成草稿后可导出"}
        </Button>
      </div>
    </section>
  )
}
