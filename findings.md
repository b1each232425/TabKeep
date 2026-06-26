# Findings

## MaxKB RAG Reference

- MaxKB models RAG as Knowledge -> Document -> Paragraph -> Problem/Embedding.
- It exposes hit-test through `KnowledgeSerializer.HitTest` and vector store `hit_test`.
- Search modes are explicit: `embedding`, `keywords`, `blend`.
- Search pipeline carries diagnostic fields such as `similarity`, `comprehensive_score`, document name, and hit handling method.
- Useful TabKeep borrowings: hit-test diagnostics, explicit search mode, score visibility, document/chunk observability.
- Not useful for first pass: workspace permissions, PostgreSQL/pgvector migration, Celery tasks, workflow canvas.

## TabKeep Current State

- Current search endpoint returns only merged citations and `sourceMode`.
- FTS and vector results lose detailed per-source score after merge.
- UI has search and ask panels but no retrieval diagnostics.
- Existing tests cover reindex/search/graph/topics but not hit-test diagnostics.

## 2026-06-24 Eval Dataset Expansion

- Current configured knowledge Markdown path is `E:\Applications\OpenWikii\TabKeep\tmp\mock-obsidian-vault`.
- Evaluation cases are stored in SQLite table `rag_eval_cases` inside `backend/data/knowledge.db`.
- Current task should write the TabKeep project-issues note into the configured Markdown vault, then create/import enough eval cases so the table has 200 cases total.
- Secrets were present in `backend/data/config.json`; do not echo config values back to the user.
- Added `tmp/mock-obsidian-vault/Projects/TabKeep/TabKeep Project Issues Knowledge Base.md` with 50 issue sections.
- Final eval case split: 30 existing manual baseline cases, 85 auto-generated cases from existing technical knowledge paragraphs, 85 auto-generated cases from the new TabKeep project-issues note.
- Auto-generated questions were changed from natural questions to keyword-style queries because SQLite FTS5 query construction uses AND-style token matching; phrase-like questions containing "是什么/为什么" caused avoidable FTS misses.
- Random FTS-only sample verification after keyword-style regeneration: 40/40 generated cases hit the expected paragraph in top 10.

## 2026-06-25 Eval Set Quality Follow-up

- The current 200-case score is useful as a regression baseline, but it is inflated because most generated questions are close to paragraph titles or exact keywords.
- The next useful distinction is case type: keep `keyword` cases for pipeline stability, add `natural` cases for user phrasing, and add `challenge` cases for ambiguous or cross-concept questions.
- Error explanations should separate true retrieval failures from ranking failures, because rerank can make Recall@K stay high while MRR/Top1 reveal whether the right context is early enough.
- Implemented case layering with 200 `keyword`, 30 `natural`, and 20 `challenge` cases. The new 50 cases bind to real paragraph IDs/text from `TabKeep Project Issues Knowledge Base.md`.
- The standalone eval workbench now has a bad-case panel that groups non-OK results by issue type such as `late_hit`, `missed`, `no_results`, and `error`.

## 2026-06-25 Embedding Config Simplification

- The knowledge settings UI previously exposed embedding BaseURL and model even though TabKeep now standardizes on SiliconFlow `BAAI/bge-m3` plus the matching BGE reranker.
- Hiding those fields requires backend and frontend default normalization, otherwise old empty `baseURL` or `model` values would keep semantic search disabled after saving.
- Rerank readiness should depend on semantic search being enabled and an API key being present; provider URL and model are now system defaults.

## 2026-06-25 Eval Workbench Issue Panel Follow-up

- The eval backend now returns `issueType`, but the standalone eval page may still receive old cached/old-server results without that field.
- The bad-case panel should not treat a missing `issueType` as a problem when `rank === 1`; it should infer issue state from `error`, `rank`, and `hits`.

## 2026-06-25 RAG Answer Evaluation Framework Notes

- Ragas RAG metrics cover context precision, context recall, response relevancy, and faithfulness. This maps to TabKeep retrieval ranking plus answer-level grounding/relevance.
- TruLens summarizes production RAG quality as a triad: context relevance, groundedness, and answer relevance.
- DeepEval treats faithfulness as an LLM-as-judge metric comparing actual output against retrieval context and returning a reason.
- TabKeep should not import a full framework yet; extract the core product shape: retrieval metrics, refusal correctness, answer keyword/reference coverage, citation presence, and grounding checks against retrieved contexts.
- Implemented the first lightweight extraction: optional answer evaluation now records generated answer, keyword coverage, context support (`answerFaithfulness`), answer relevance, refusal correctness, pass counts, and per-case failure messages.
- Retrieval-only and answer-only cases are now separated by `retrievalEvaluated`, so refusal cases without retrieval anchors do not distort Recall/MRR.
- The standalone eval workbench now shows answer-level aggregate metrics and flags answer failures separately from retrieval misses/late hits.
- A retrieval-only run can look unchanged if all cases only have retrieval anchors. The UI must explicitly expose `answerEligible` / answer-ready case counts and explain why answer metrics are absent.

## 2026-06-25 Answer Eval Case Population

- The real `backend/data/knowledge.db` initially had 250 eval cases but 0 `expected_answer`, 0 `answer_keywords`, and 0 refusal cases.
- Populated answer fields for the existing 250 retrieval cases using their stored `expected_text` as the source of truth, not an LLM-generated answer.
- Added 10 `negative` refusal calibration cases with `should_refuse = 1`; they have no retrieval anchors and therefore should not affect Recall/MRR.
- Created SQLite backups before mutation: `knowledge.before-answer-eval-cases-20260625105346.bak` and `knowledge.before-answer-eval-cleanup-20260625105517.bak`.
- A second cleanup pass removed heading/numbering artifacts and broad keywords such as Project/Issues/Knowledge where possible, favoring code identifiers and domain terms like `build_fts_query()`, `modelConfig`, `bool`, `打开来源`, and `复制来源`.

## 2026-06-25 Answer Eval Performance Follow-up

- Full answer evaluation over 260 cases can appear stuck because it performs many sequential retrieval/rerank operations plus up to 260 LLM answer-generation calls in one HTTP request.
- Default answer evaluation should be sampled. The backend now uses `answerLimit` with a default of 30 and prioritizes refusal, challenge, and natural cases before keyword cases.
- Each generated-answer evaluation now has a bounded timeout, defaulting to 45 seconds per case, so one slow model response does not block the whole run indefinitely.
- The eval workbench exposes the answer sample size next to the run button and labels answer metrics as sampled results (`answerEvaluated / answerEligible`).

## 2026-06-25 Answer Judgment Follow-up

- Inspecting 12 failed answer samples showed most were false negatives from literal keyword matching, not retrieval failure or obvious model failure.
- Added alias-aware keyword matching for common pairs such as `paragraph`/段落模式, `Region Box`/固定区域翻译框, `Selection Translate`/划词翻译, `hit-test`/命中测试, and `资料不足`/没有足够依据.
- Broadened refusal detection to include phrases like `没有任何信息表明`, `无法依据`, `无法断定`, and `未涉及`.
- Kept a guard against over-leniency: strict pass remains 80% keyword coverage, but 60% coverage can pass only when context support is very high.
- Replaying the saved 30-case sample changed answer pass count from 18/30 to 29/30; the remaining failure missed concrete expected concepts (`OCR`, `知识库`, `向量库`) and should stay flagged.

## 2026-06-26 Desktop Split and Index Sync Follow-up

- `desktop/src/App.tsx` has grown into a large multi-section file with independent blocks such as `VectorDebugSection`, `KnowledgeSection`, OCR windows, topic map, and shared primitives.
- The lowest-risk frontend split is extracting shared primitives (`Button`, `Checkbox`, `Notice`, `StatusCard`, `TextField`) and `VectorDebugSection`, because they have narrow dependencies and do not change application state routing.
- Current knowledge sync already unifies local Markdown/Obsidian and SiYuan through `/knowledge/sync/all`, but it lacks an explicit index health view for SQLite/FTS/LanceDB consistency.
- A practical first sync-engineering layer is read-only health checks plus safe repair of orphan FTS rows and graph/topic drift triggers, rather than introducing a full job queue immediately.
- Implemented the first layer as health/repair rather than queueing: it detects SQLite document/paragraph/chunk counts, FTS drift, stale Markdown paths, LanceDB schema gaps, and vector records missing SQLite/paragraph metadata.
- Auto-repair is intentionally narrow: it only deletes orphan FTS rows and inserts missing FTS rows. Structural SQLite drift and LanceDB orphan/vector schema problems still point users toward sync/reindex or vector schema migration.

## 2026-06-26 Extension Settings Removal

- The browser extension should not be a second configuration surface now that desktop owns durable TabKeep settings.
- Removing the popup settings button and `options.tsx` prevents users from editing stale plugin-local model/note settings.
- Extension background startup should only initialize the API token. Restoring `modelConfig`, `tabCategories`, or `noteAdapter` from old `chrome.storage.local` can overwrite newer desktop configuration and create confusing sync behavior.

## 2026-06-26 Knowledge Section Extraction

- `KnowledgeSection` has a cleaner boundary than the graph/topic workbench: it owns knowledge config, sync-all, index health controls, search, ask, and hit-test diagnostics.
- Moving citation and hit-test list components with `KnowledgeSection` keeps source open/copy behavior local to the knowledge page and removes a large block from `App.tsx`.
- Graph/topic helpers still share source-opening and relation-building code in `App.tsx`; splitting them should be a separate pass because their state and helper graph are denser.

## 2026-06-26 Full Desktop Frontend Split

- `App.tsx` can now be treated as an app shell: URL view routing, desktop status refresh, sidebar navigation, token actions, and the titlebar.
- The section boundary works well for most desktop features: overview, translation, OCR debug, OCR floating windows, settings, notes, knowledge search, vector debug, and knowledge workbench now live outside `App.tsx`.
- `KnowledgeGraphPanel.tsx` remains the largest extracted module because ReactFlow layout, graph expansion state, node rendering, and graph-specific helpers are tightly coupled. It is better to split that further only when changing graph behavior.
- Shared helpers should continue moving into `desktop/src/lib/` only when at least two feature modules use them; `errorMessage` and OCR layout formatting are the first examples.

## 2026-06-26 Sync Engineering UI

- The current practical sync observability layer can be in-process recent logs: run id, status, timestamps, duration, per-source status, and errors.
- This avoids introducing a durable job table before the product needs background sync or cross-process history.
- The desktop knowledge page benefits from separating sync status from configuration. Source state and recent logs are now visible even after the config form is collapsed or unchanged.
- A later durable queue can reuse the same frontend shape by replacing `GET /knowledge/sync/logs` with persisted jobs.
