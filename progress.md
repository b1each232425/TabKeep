# Progress

## 2026-06-22

- Started minimal RAG debug console implementation.
- Read outer MaxKB optimization roadmap and compared MaxKB hit-test/search pipeline to TabKeep RAG files.
- Created planning files in `TabKeep/`.
- Added backend hit-test request/response schemas, retrieval diagnostics, and `/knowledge/hit-test` route.
- Added desktop types/API wrapper and a compact knowledge-page retrieval debug panel.
- Added focused backend tests for retrieval diagnostics and API response shape.
- Verification passed: `npm run test:backend`; `npm run build` from `desktop/`.

## 2026-06-24

- Started expanding RAG evaluation cases to 200 total and adding a TabKeep project-issues note into the knowledge vault.
- Brainstorming skill requested `codex_research`, but that tool is unavailable in this session; using local repository inspection as fallback.
- Located current Markdown knowledge path: `tmp/mock-obsidian-vault`.
- Added `Projects/TabKeep/TabKeep Project Issues Knowledge Base.md` with 50 structured issue sections for knowledge-base indexing and eval-case generation.
- Indexed the new Markdown note into `backend/data/knowledge.db` using the existing knowledge DB upsert path.
- Regenerated automatic eval cases until `rag_eval_cases` reached 200 total: 30 manual, 85 existing-knowledge generated, 85 project-issue generated.
- Refined generated questions from natural-language templates to keyword-style queries after FTS sample checks showed natural questions over-constrained SQLite FTS.
- Verification: 200 total cases; no empty expected text/title/path; generated cases have document and paragraph IDs; random FTS-only sample check passed 40/40.

## 2026-06-25

- Started improving the evaluation set beyond the 200-case keyword baseline.
- Planned case-type layering (`keyword`, `natural`, `challenge`) plus a bad-case explanation panel for misses, late hits, and backend errors.
- Added `caseType` to eval schemas, DB storage, frontend types, and eval workbench editing.
- Added per-type eval summaries and per-case issue explanations to eval results.
- Added 50 layered eval cases from the TabKeep project issues knowledge note: 30 natural-language cases and 20 challenge cases.
- Verification passed: `npm run test:backend`; `npm run build` from `desktop/`; DB summary is 250 total cases split into 200 keyword, 30 natural, and 20 challenge.
- Simplified knowledge embedding settings to show only semantic-search enablement and API Key.
- Added SiliconFlow defaults for embedding config in backend schemas and frontend API normalization.
- Added backend regression coverage for blank BaseURL/model being normalized to SiliconFlow defaults.
- Verification passed after the embedding config change: `npm run test:backend`; `npm run build` from `desktop/`.
- Fixed eval workbench bad-case filtering so old/missing `issueType` does not mark rank-1 hits as problems.
- Verification passed after the bad-case panel fix: `npm run build` from `desktop/`.
- Added answer/refusal evaluation fields to eval cases and eval run responses.
- Added optional answer evaluation execution using the existing RAG answer chain, then scoring keyword coverage, context support, answer relevance, and refusal correctness.
- Updated the standalone eval workbench to save expected answers/keywords/refusal cases, run answer evaluation on demand, show answer aggregate metrics, and explain answer failures in the problem case panel.
- Added backend regression tests for answer-quality evaluation and refusal-only cases.
- Verification passed for answer/refusal eval: `npm run test:backend` ran 27 tests successfully; `npm run build` from `desktop/` completed successfully.
- Clarified the eval workbench UX after seeing a retrieval-only screenshot: it now counts retrieval-ready and answer-ready cases separately, disables the answer toggle when no answer cases exist, and shows an explicit empty state when answer evaluation does not run.
- Verification passed after the answer-eval visibility fix: `npm run test:backend` ran 27 tests successfully; `npm run build` from `desktop/` completed successfully.
- Populated answer evaluation data in the real SQLite eval set: updated 250 existing cases with `expected_answer` and `answer_keywords`, then added 10 refusal-only calibration cases.
- Created DB backups before each mutation pass and ran a cleanup pass to remove heading artifacts and overly broad keywords.
- Verification query after population: 260 total cases, 250 retrieval-ready, 260 answer-ready, and 10 refusal cases.
- Investigated answer-eval "stuck" behavior: enabling answer evaluation on 260 cases can trigger too many serial LLM calls in one browser request.
- Added `answerLimit` and `answerTimeoutSeconds` to eval run requests; backend defaults to 30 sampled answer cases and 45 seconds per answer generation.
- Updated the standalone eval workbench to show/edit answer sample size and to label answer metrics as sampled (`answerEvaluated / answerEligible`).
- Added a backend regression test proving `answerLimit=1` caps model calls to one.
- Verification passed after sampling fix: `npm run test:backend` ran 28 tests successfully; `npm run build` from `desktop/` completed successfully.
- Updated answer judgment to reduce false negatives: alias-aware keyword matching, broader refusal phrase detection, and a guarded 60% keyword coverage pass path when context support is strong.
- Added backend tests for answer keyword aliases and refusal phrasing.
- Verification passed after answer judgment update: `npm run test:backend` ran 30 tests successfully.
- Replayed the saved 30-case answer sample without re-calling the model; the revised evaluator would score it 29/30 instead of 18/30, with one remaining likely-real answer gap.

## 2026-06-26

- Started desktop frontend split and knowledge index sync engineering pass.
- Chosen first frontend split target: shared UI primitives plus `VectorDebugSection`, because this reduces `App.tsx` size without touching core workflows.
- Chosen first sync-engineering target: index health/repair API and UI, before a larger background job queue.
- Extracted shared desktop primitives into `desktop/src/components/primitives.tsx`.
- Extracted vector database inspection UI into `desktop/src/sections/VectorDebugSection.tsx`.
- Added backend index health inspection and safe FTS repair service, then exposed `/knowledge/index/health` and `/knowledge/index/repair`.
- Added a knowledge-page index health panel that shows SQLite/FTS/vector consistency, embedding status counts, repairable issues, and a one-click light repair action.
- Added a backend regression test for missing FTS rows being detected, repaired, and searchable again.
- Verification passed: `pnpm test:backend` ran 31 tests successfully; `pnpm build` from `desktop/` completed successfully.
- Removed the browser extension settings button from `popup.tsx`.
- Deleted the extension `options.tsx` settings page and cleared stale dev build options artifacts.
- Changed extension startup from restoring `modelConfig`, `tabCategories`, and `noteAdapter` into the backend to only initializing the API token.
- Updated user-facing messages that referenced the old plugin dashboard to point to the desktop app.
- Verification passed: `pnpm build` from `extension/` completed with exit code 0; production and dev manifests have no options page entry; `pnpm test:backend` ran 31 tests successfully.
- Continued the desktop split by extracting the full knowledge page from `App.tsx` into `desktop/src/sections/KnowledgeSection.tsx`.
- Moved knowledge-page-only pieces with it: sync source cards, citation list, hit-test list, knowledge sync/index status formatters, and citation open/copy helpers.
- Kept graph/topic source-opening helpers in `App.tsx` for now to avoid mixing this extraction with a graph workbench split.
- Verification passed after the knowledge section extraction: `pnpm build` from `desktop/` completed successfully.
- User asked to do the desktop split in one larger pass instead of one section at a time.
- Extracted remaining desktop page/window components from `App.tsx`: `OverviewSection`, `TranslateSection`, `OcrDebugSection`, `OcrWindows`, `SettingsSections`, and `NotesSection`.
- Moved shared `errorMessage` and OCR text layout helpers into `desktop/src/lib/errors.ts` and `desktop/src/lib/ocr.ts`.
- Split the knowledge workbench again into `KnowledgeGraphSection`, `TopicMapPanel`, and `KnowledgeGraphPanel`, leaving the app shell free of graph/ReactFlow dependencies.
- `App.tsx` is now 322 lines and only contains view routing, sidebar navigation, desktop status refresh, token actions, and the titlebar.
- Verification passed after the full desktop split: `pnpm build` from `desktop/` completed successfully.
- Started sync engineering UI pass after the desktop split.
- Extended `KnowledgeSyncAllResponse` and per-source sync results with run id, status, start/end timestamps, and duration.
- Added in-process recent sync history plus `GET /knowledge/sync/logs`.
- Updated the desktop knowledge page with a dedicated sync status panel that shows the latest run, per-source status cards, duration, errors, and the last five sync records.
- Added a backend regression test for sync run metadata and recent logs.
- Verification passed: `pnpm test:backend` ran 32 tests successfully; `pnpm build` from `desktop/` completed successfully.
