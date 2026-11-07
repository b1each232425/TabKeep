import { useEffect, useMemo, useState } from "react"
import { ArrowRight, Check, ChevronLeft, ChevronRight, FlaskConical, LoaderCircle, RotateCcw } from "lucide-react"

import {
  type EvaluationBatch,
  type EvaluationItem,
  type EvaluationLabel,
  type EvaluationMode,
  type EvaluationReport,
  type EvaluationSampleSize,
  getEvaluationBatch,
  prepareEvaluation,
  runEvaluation,
  saveEvaluationLabel,
} from "./recommendationEvaluationApi"

const LABEL_OPTIONS: { value: EvaluationLabel; title: string; hint: string; className: string }[] = [
  { value: "interested", title: "感兴趣", hint: "之后会想看类似内容", className: "eval-choice-positive" },
  { value: "not_interested", title: "不感兴趣", hint: "以后少推荐类似内容", className: "eval-choice-negative" },
  { value: "unsure", title: "不确定", hint: "暂时无法判断", className: "eval-choice-unsure" },
]

const MODE_LABELS: Record<EvaluationMode, string> = {
  keyword: "当前关键词",
  semantic: "语义匹配",
  hybrid: "混合排序",
  rrf: "RRF 融合",
}

const SAMPLE_GROUP_LABELS: Record<string, string> = {
  keyword_recommendations: "关键词榜单候选",
  recent_not_ranked: "近期未进入关键词榜",
  source_time_balanced_random: "来源与时间均衡随机",
}

const RANK_BAND_LABELS: Record<string, string> = {
  top: "前段",
  middle: "中段",
  tail: "后段",
  unranked: "未入榜",
}

function queryRunId(): string | null {
  return new URLSearchParams(window.location.search).get("runId")
}

function setQueryRunId(runId: string | null): void {
  const url = new URL(window.location.href)
  if (runId) url.searchParams.set("runId", runId)
  else url.searchParams.delete("runId")
  window.history.replaceState({}, "", url)
}

function countLabels(items: EvaluationItem[]) {
  return items.reduce(
    (counts, item) => {
      if (item.label) counts[item.label] += 1
      return counts
    },
    { interested: 0, not_interested: 0, unsure: 0 },
  )
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后重试。"
}

export function RecommendationEvaluationPage() {
  const [batch, setBatch] = useState<EvaluationBatch | null>(null)
  const [sampleSize, setSampleSize] = useState<EvaluationSampleSize>(100)
  const [activeIndex, setActiveIndex] = useState(0)
  const [report, setReport] = useState<EvaluationReport | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState<"loading" | "preparing" | "saving" | "evaluating" | null>(null)
  const counts = useMemo(() => countLabels(batch?.items ?? []), [batch])
  const currentItem = batch?.items[activeIndex] ?? null
  const readyToEvaluate = counts.interested >= 3 && counts.not_interested >= 3 &&
    counts.interested + counts.not_interested >= 10
  const labeledCount = counts.interested + counts.not_interested + counts.unsure

  async function loadBatch(runId: string): Promise<void> {
    setBusy("loading")
    setError("")
    try {
      const nextBatch = await getEvaluationBatch(runId)
      setBatch(nextBatch)
      setActiveIndex(0)
      setReport(null)
    } catch (loadError) {
      setBatch(null)
      setError(`${readableError(loadError)} 如果后端刚更新过，请重启本地开发后端后再试。`)
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    const runId = queryRunId()
    if (runId) void loadBatch(runId)
  }, [])

  async function createBatch(): Promise<void> {
    setBusy("preparing")
    setError("")
    setReport(null)
    try {
      const prepared = await prepareEvaluation(sampleSize)
      setQueryRunId(prepared.runId)
      await loadBatch(prepared.runId)
    } catch (prepareError) {
      setError(`${readableError(prepareError)} 请确认本机已有正向兴趣行为，并在样本不足时等待新资讯积累。`)
      setBusy(null)
    }
  }

  async function chooseLabel(label: EvaluationLabel): Promise<void> {
    if (!batch || !currentItem || busy) return
    setBusy("saving")
    setError("")
    try {
      await saveEvaluationLabel(batch.runId, currentItem.itemId, label)
      setBatch((previous) => previous ? {
        ...previous,
        items: previous.items.map((item) => item.itemId === currentItem.itemId ? { ...item, label } : item),
      } : previous)
      setReport(null)
    } catch (saveError) {
      setError(`${readableError(saveError)} 标注未保存，请重试。`)
    } finally {
      setBusy(null)
    }
  }

  async function compareRankings(): Promise<void> {
    if (!batch || !readyToEvaluate || busy) return
    setBusy("evaluating")
    setError("")
    try {
      setReport(await runEvaluation(batch.runId))
    } catch (evaluationError) {
      setError(`${readableError(evaluationError)} 检查 embedding 配置；本次请求只会在你点击运行后发出。`)
    } finally {
      setBusy(null)
    }
  }

  function moveTo(index: number): void {
    if (!batch) return
    setActiveIndex(Math.max(0, Math.min(batch.items.length - 1, index)))
    setError("")
  }

  const busyLabel = busy === "loading" ? "正在读取样本…"
    : busy === "preparing" ? "正在准备样本…"
      : busy === "saving" ? "保存标注中…"
        : busy === "evaluating" ? "正在运行对照…" : ""

  return (
    <main className="eval-page">
      <header className="eval-header">
        <a className="eval-brand" href="/" aria-label="TabKeep 资讯开发页">
          <span className="eval-brand-mark"><FlaskConical aria-hidden="true" /></span>
          <span>TabKeep <i>推荐评估</i></span>
        </a>
        <span className="eval-dev-badge">仅开发环境</span>
      </header>

      <div className="eval-main">
        <section className="eval-intro">
          <p className="eval-eyebrow">LOCAL RECOMMENDATION CHECK</p>
          <h1>看看推荐是否符合你的兴趣</h1>
          <p>先按正文给资讯打标签，再手动运行排序对照。标签仅保存在本机评估文件中，不会改变推荐画像。</p>
        </section>

        {!batch ? (
          <section className="eval-start-card">
            <div className="eval-start-icon"><FlaskConical aria-hidden="true" /></div>
            <h2>{busy === "loading" ? "正在恢复评估批次" : "准备一组盲测资讯"}</h2>
          <p>从未评估过且内容不重复的资讯中，按推荐位置、来源和发布时间抽样；标注时会隐藏来源与原推荐名次。新样本不足时不会复用旧资讯。</p>
            <label className="eval-size-control">
              样本数量
              <select
                value={sampleSize}
                onChange={(event) => setSampleSize(Number(event.target.value) as EvaluationSampleSize)}
                disabled={busy !== null}
              >
                <option value={30}>30 篇</option>
                <option value={100}>100 篇</option>
              </select>
            </label>
            {error && <div className="eval-alert" role="alert">{error}</div>}
            {busyLabel && <p className="eval-loading" role="status"><LoaderCircle className="eval-spinner" />{busyLabel}</p>}
            <button className="eval-button eval-button-primary" type="button" onClick={() => void createBatch()} disabled={busy !== null}>
              {busy === "preparing" ? <LoaderCircle className="eval-spinner" /> : <RotateCcw aria-hidden="true" />}
              准备 {sampleSize} 篇样本
            </button>
          </section>
        ) : (
          <>
            <section className="eval-progress-card" aria-label="标注进度">
              <div className="eval-progress-copy">
                <span>本地评估批次 <code>{batch.runId}</code></span>
                <strong>{labeledCount}<small> / {batch.sampleSize} 已标注</small></strong>
              </div>
              <div className="eval-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={batch.sampleSize} aria-valuenow={labeledCount}>
                <span style={{ width: `${Math.min(100, labeledCount / Math.max(1, batch.sampleSize) * 100)}%` }} />
              </div>
              <div className="eval-counts">
                <span><i className="eval-dot eval-dot-positive" />感兴趣 {counts.interested}</span>
                <span><i className="eval-dot eval-dot-negative" />不感兴趣 {counts.not_interested}</span>
                <span><i className="eval-dot eval-dot-unsure" />不确定 {counts.unsure}</span>
                <label className="eval-size-control eval-size-control-inline">
                  新批次样本数
                  <select
                    value={sampleSize}
                    onChange={(event) => setSampleSize(Number(event.target.value) as EvaluationSampleSize)}
                    disabled={busy !== null}
                  >
                    <option value={30}>30 篇</option>
                    <option value={100}>100 篇</option>
                  </select>
                </label>
                <button type="button" className="eval-text-button" onClick={() => void createBatch()} disabled={busy !== null}>新建批次</button>
              </div>
            </section>

            <section className="eval-review-card" aria-labelledby="eval-item-title">
              {currentItem ? (
                <>
                  <div className="eval-review-meta">
                    <span>第 {activeIndex + 1} 篇，共 {batch.sampleSize} 篇</span>
                    {currentItem.label && <span className="eval-saved"><Check aria-hidden="true" />已保存：{LABEL_OPTIONS.find((option) => option.value === currentItem.label)?.title}</span>}
                  </div>
                  <article className="eval-article">
                    <h2 id="eval-item-title">{currentItem.title}</h2>
                    <p>{currentItem.excerpt || "（没有正文摘要）"}</p>
                  </article>
                  <p className="eval-prompt">只根据这篇资讯的内容判断，不必考虑来源或它之前的推荐位置。</p>
                  <div className="eval-choice-list" role="group" aria-label="选择兴趣标签">
                    {LABEL_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={`eval-choice ${option.className}${currentItem.label === option.value ? " is-selected" : ""}`}
                        onClick={() => void chooseLabel(option.value)}
                        disabled={busy !== null}
                        aria-pressed={currentItem.label === option.value}
                      >
                        <span className="eval-choice-check">{currentItem.label === option.value && <Check aria-hidden="true" />}</span>
                        <span><strong>{option.title}</strong><small>{option.hint}</small></span>
                      </button>
                    ))}
                  </div>
                  {error && <div className="eval-alert" role="alert">{error}</div>}
                  {busyLabel && <p className="eval-loading" role="status"><LoaderCircle className="eval-spinner" />{busyLabel}</p>}
                  <nav className="eval-nav" aria-label="样本导航">
                    <button type="button" className="eval-button eval-button-secondary" onClick={() => moveTo(activeIndex - 1)} disabled={activeIndex === 0 || busy !== null}>
                      <ChevronLeft aria-hidden="true" />上一篇
                    </button>
                    <span>使用下方按钮逐篇查看</span>
                    <button type="button" className="eval-button eval-button-secondary" onClick={() => moveTo(activeIndex + 1)} disabled={activeIndex === batch.sampleSize - 1 || busy !== null}>
                      下一篇<ChevronRight aria-hidden="true" />
                    </button>
                  </nav>
                </>
              ) : (
                <div className="eval-empty">这个批次没有可显示的样本。</div>
              )}
            </section>

            <section className="eval-compare-card" aria-labelledby="eval-compare-title">
              <div className="eval-section-heading">
                <div>
                  <p className="eval-eyebrow">OPTIONAL EMBEDDING REQUEST</p>
                  <h2 id="eval-compare-title">运行排序对照</h2>
                </div>
                <button className="eval-button eval-button-primary" type="button" onClick={() => void compareRankings()} disabled={!readyToEvaluate || busy !== null}>
                  {busy === "evaluating" ? <LoaderCircle className="eval-spinner" /> : <ArrowRight aria-hidden="true" />}
                  运行对照
                </button>
              </div>
              <p className="eval-compare-help">
                需要至少 10 条确定标签，且“感兴趣”和“不感兴趣”各至少 3 条。仅点击运行后，才会把标注文章正文和汇总兴趣主题发送给已配置的 embedding 服务；不发送 URL、浏览历史或标题。
              </p>
              {!readyToEvaluate && <p className="eval-gate">还差一些确定标签：当前感兴趣 {counts.interested} 条，不感兴趣 {counts.not_interested} 条。</p>}
              {error && !currentItem && <div className="eval-alert" role="alert">{error}</div>}
              {report && <EvaluationResults report={report} batch={batch} />}
            </section>
          </>
        )}
      </div>
    </main>
  )
}

function EvaluationResults({ report, batch }: { report: EvaluationReport; batch: EvaluationBatch }) {
  const titleById = new Map(batch.items.map((item) => [item.itemId, item.title]))
  const modes: EvaluationMode[] = ["keyword", "semantic", "hybrid", "rrf"]

  return (
    <div className="eval-results" aria-live="polite">
      <p className="eval-result-recommendation">{report.recommendation}</p>
      <p className="eval-result-model">模型：{report.embeddingModel} · RRF k={report.rrfRankConstant} · 有效标签：{report.judgedCount} · 版本：{report.algorithmVersion}</p>
      <p className="eval-sample-coverage">
        样本覆盖：{report.sampleCoverage.sourceCount} 个来源 · {report.sampleCoverage.publicationMonthCount} 个发布时间月份 · 关键词排名
        {Object.entries(report.sampleCoverage.keywordRankBands).map(([band, count], index) => (
          <span key={band}>{index > 0 ? " / " : "："}{RANK_BAND_LABELS[band] ?? band} {count}</span>
        ))}
      </p>
      <div className="eval-metrics-grid">
        {modes.map((mode) => {
          const metric = report.metrics[mode]
          return (
            <article className={`eval-metric-card${mode === "keyword" ? " is-baseline" : ""}`} key={mode}>
              <h3>{MODE_LABELS[mode]}{mode === "keyword" && <small>基线</small>}</h3>
              <dl>
                <div><dt>NDCG（整批）</dt><dd>{metric.ndcgAll.toFixed(3)}</dd></div>
                <div><dt>AP（整批）</dt><dd>{metric.averagePrecision.toFixed(3)}</dd></div>
                <div><dt>正负排序 AUC</dt><dd>{metric.pairwiseAuc?.toFixed(3) ?? "—"}</dd></div>
                <div><dt>排序覆盖</dt><dd>{(metric.coverage * 100).toFixed(1)}%（{metric.rankedCount}/{metric.judgedCount}）</dd></div>
              </dl>
            </article>
          )
        })}
      </div>
      <p className="eval-random-baseline">随机排序参考：NDCG {report.randomBaseline.ndcgAll.toFixed(3)} · AP {report.randomBaseline.averagePrecision.toFixed(3)} · AUC {report.randomBaseline.pairwiseAuc?.toFixed(3) ?? "—"}</p>
      <p className="eval-metric-help">NDCG 和 AP 按整批明确标注的文章计算，并把未进入榜单的文章视为未推荐；AUC 衡量感兴趣文章排在不感兴趣文章前面的比例，两个都未进入榜单时按并列计算；覆盖率显示实际排出榜单的样本比例。本地单用户单批结果不代表普遍效果，评估报告不会自动改变线上排序。下方只预览各排序的前 10 名。</p>
      <section className="eval-group-results" aria-label="各抽样组指标">
        <h3>按抽样组查看</h3>
        <div className="eval-group-grid">
          {Object.entries(report.sampleGroups).map(([group, summary]) => (
            <article className="eval-group-card" key={group}>
              <h4>{SAMPLE_GROUP_LABELS[group] ?? group}</h4>
              <p>样本 {summary.sampleCount} · 已标 {summary.labeledCount} · 感兴趣 {summary.interestedCount} · 不感兴趣 {summary.notInterestedCount} · 不确定 {summary.unsureCount}</p>
              <div className="eval-group-table-wrap">
                <table>
                  <thead><tr><th>排序</th><th>NDCG</th><th>AP</th><th>AUC</th><th>覆盖</th></tr></thead>
                  <tbody>
                    {(["keyword", "semantic", "hybrid", "rrf"] as EvaluationMode[]).map((mode) => {
                      const metric = summary.metrics[mode]
                      return (
                        <tr key={mode}>
                          <th scope="row">{MODE_LABELS[mode]}</th>
                          <td>{metric.ndcgAll.toFixed(3)}</td>
                          <td>{metric.averagePrecision.toFixed(3)}</td>
                          <td>{metric.pairwiseAuc?.toFixed(3) ?? "—"}</td>
                          <td>{metric.rankedCount}/{metric.judgedCount}</td>
                        </tr>
                      )
                    })}
                    <tr>
                      <th scope="row">随机基线</th>
                      <td>{summary.randomBaseline.ndcgAll.toFixed(3)}</td>
                      <td>{summary.randomBaseline.averagePrecision.toFixed(3)}</td>
                      <td>{summary.randomBaseline.pairwiseAuc?.toFixed(3) ?? "—"}</td>
                      <td>—</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </article>
          ))}
        </div>
      </section>
      <details className="eval-ranking-details">
        <summary>查看四种排序的前 10 条</summary>
        <div className="eval-ranking-grid">
          {modes.map((mode) => (
            <section key={mode}>
              <h3>{MODE_LABELS[mode]}</h3>
              <ol>
                {report.topItems[mode].map((item) => (
                  <li key={item.itemId}>
                    <span className={`eval-rank-label eval-rank-${item.label}`}>{LABEL_OPTIONS.find((option) => option.value === item.label)?.title}</span>
                    <strong>{titleById.get(item.itemId) ?? "样本内容已变化"}</strong>
                    <small>{item.reason}</small>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      </details>
    </div>
  )
}
