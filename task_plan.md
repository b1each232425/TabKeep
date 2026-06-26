# TabKeep Desktop Frontend and Knowledge Sync Engineering Plan

## Goal

Reduce the risk of the growing desktop frontend by extracting stable UI/section modules from `desktop/src/App.tsx`, then add a first engineering layer for knowledge index synchronization: inspect index consistency, surface drift, and repair safe orphan records.

## Current Goal

Keep the desktop frontend split by feature domain so `App.tsx` stays as the app shell, navigation, and window router.

## Phases

- [complete] Phase 1: Inspect current TabKeep RAG API/UI seams and define minimal hit-test contract.
- [complete] Phase 2: Implement backend hit-test schemas, retrieval diagnostics, and route.
- [complete] Phase 3: Add frontend API/types and a compact debug panel in the knowledge page.
- [complete] Phase 4: Add focused backend tests and run verification.
- [complete] Phase 5: Locate current knowledge sources, eval-case storage, and Obsidian/Markdown vault path.
- [complete] Phase 6: Generate a TabKeep project-issues Markdown note in the knowledge vault.
- [complete] Phase 7: Generate and import 200 total RAG evaluation cases from existing knowledge and the new TabKeep issues note.
- [complete] Phase 8: Verify case count, inspect samples, and run targeted backend checks if feasible.
- [complete] Phase 9: Add `case_type` support to eval schemas, SQLite migration, and aggregate metrics.
- [complete] Phase 10: Add type summaries and error explanations to the eval workbench UI.
- [complete] Phase 11: Add harder natural-language and challenge evaluation cases while preserving the keyword baseline.
- [complete] Phase 12: Verify migrations, backend tests, and desktop build.
- [complete] Phase 13: Normalize embedding defaults to SiliconFlow in backend and frontend config flows.
- [complete] Phase 14: Simplify the knowledge settings UI to only show semantic-search enablement and API key.
- [complete] Phase 15: Add focused verification for default config normalization and run tests/build.
- [complete] Phase 16: Map Ragas/TruLens/DeepEval concepts to TabKeep's lightweight local-first evaluation metrics.
- [complete] Phase 17: Extend eval cases with expected answer, answer keywords, and refusal-only cases.
- [complete] Phase 18: Add optional answer evaluation aggregation and standalone eval UI result explanations.
- [complete] Phase 19: Add backend regression tests and run backend/frontend verification.
- [complete] Phase 20: Populate real eval DB with answer-ready cases and refusal calibration cases.
- [complete] Phase 21: Prevent answer evaluation from appearing stuck by defaulting to sampled answer evaluation with per-call timeout.
- [complete] Phase 22: Reduce answer-eval false negatives with alias-aware keyword matching and broader refusal detection.
- [complete] Phase 23: Extract shared desktop UI primitives and the vector debug section from `App.tsx`.
- [complete] Phase 24: Add backend index health/repair schemas, service functions, and routes.
- [complete] Phase 25: Add desktop API/types and knowledge-page health controls.
- [complete] Phase 26: Add focused backend tests for index health/repair.
- [complete] Phase 27: Run backend tests and desktop build verification.
- [complete] Phase 28: Remove the extension settings button and options page so configuration lives in the desktop app.
- [complete] Phase 29: Stop extension startup from restoring stale local config into the backend; keep only API token initialization.
- [complete] Phase 30: Verify extension build, manifests, and backend tests after the extension settings removal.
- [complete] Phase 31: Extract the desktop knowledge page into `desktop/src/sections/KnowledgeSection.tsx`.
- [complete] Phase 32: Extract the remaining desktop sections/windows from `App.tsx` in one larger pass.
- [complete] Phase 33: Split the knowledge workbench into wrapper, topic panel, and graph panel modules.
- [complete] Phase 34: Add lightweight knowledge sync run metadata and recent sync logs.
- [complete] Phase 35: Add a desktop knowledge sync status/log panel.

## Decisions

- Keep TabKeep local-first: SQLite FTS plus optional LanceDB vector.
- Do not introduce MaxKB-style workspaces, PostgreSQL, Celery, or workflow nodes.
- Hit-test is diagnostic only for this first step; normal `/knowledge/search` and `/knowledge/ask` stay compatible.
- Preserve the 200 keyword-heavy cases as a stable regression baseline, then layer natural and challenge cases on top instead of replacing the baseline.
- Users should not choose embedding/rerank provider details in the main settings UI; TabKeep uses SiliconFlow `BAAI/bge-m3` and `BAAI/bge-reranker-v2-m3` by default.
- Do not import Ragas/TruLens/DeepEval yet. TabKeep extracts their core shape: retrieval recall/ranking, context grounding, answer relevance, and refusal correctness.
- Desktop refactor should start with low-risk extraction, not a full rewrite of `App.tsx`.
- Index sync engineering starts with observable health and safe repair before introducing a full background job queue.
- Browser extension should not be a second configuration surface. It stays focused on capture, grouping, translation triggers, and note target selection; durable app configuration belongs to the desktop app.
- Keep desktop section extraction incremental: `KnowledgeSection` owns knowledge config/search/ask/hit-test state, while graph/topic helpers remain in `App.tsx` until their panels are split separately.
- After the larger split, `App.tsx` should remain the app shell only: view routing, desktop status refresh, sidebar navigation, and the titlebar.
- The knowledge workbench is split into `KnowledgeGraphSection`, `TopicMapPanel`, and `KnowledgeGraphPanel`; deeper graph helper extraction can wait until graph behavior changes are needed.
- Sync engineering starts with in-process recent-run logs, not a durable job table. This gives the UI run id, status, timestamps, source status, duration, and recent logs without committing to a queue design yet.

## Errors Encountered

| Error | Attempt | Resolution |
| --- | --- | --- |
| `codex_research` unavailable | Tried tool discovery for brainstorming skill | Use local repository inspection as fallback. |
| WindowsApps `python.exe` failed to start | Tried inline Python with default `python` | Use the TabKeep conda interpreter from the existing test script path. |

## Verification

- `npm run test:backend` passed.
- `npm run build` in `desktop/` passed.
- 2026-06-24 eval expansion: `rag_eval_cases` count is 200 total: 30 manual baseline, 85 auto-generated from existing technical knowledge, 85 auto-generated from the TabKeep project-issues note.
- 2026-06-24 eval expansion: all 200 cases have non-empty `expected_text`, `expected_title`, and `expected_path`; the 170 generated cases also have `expected_document_id` and `expected_paragraph_id`.
- 2026-06-24 eval expansion: random FTS-only sample check hit expected paragraph for 40/40 generated cases.
- 2026-06-25 eval layering: `rag_eval_cases` now has 250 cases split into 200 `keyword`, 30 `natural`, and 20 `challenge`.
- 2026-06-25 verification: `npm run test:backend` passed.
- 2026-06-25 verification: `npm run build` in `desktop/` passed.
- 2026-06-25 smoke check: sample `challenge` FTS run returned `typeSummaries` and per-case `issueType` explanations.
- 2026-06-25 embedding config simplification: `npm run test:backend` passed with 25 tests.
- 2026-06-25 embedding config simplification: `npm run build` in `desktop/` passed.
- 2026-06-25 answer/refusal eval: `npm run test:backend` passed with 27 tests.
- 2026-06-25 answer/refusal eval: `npm run build` in `desktop/` passed.
- 2026-06-25 answer case population: `rag_eval_cases` now has 260 total cases, 250 retrieval-ready cases, 260 answer-ready cases, and 10 refusal cases.
- 2026-06-25 answer eval sampling: `npm run test:backend` passed with 28 tests.
- 2026-06-25 answer eval sampling: `npm run build` in `desktop/` passed.
- 2026-06-25 answer judgment update: `npm run test:backend` passed with 30 tests.
- 2026-06-25 answer judgment update: replaying the saved 30-case answer sample changed the score from 18/30 to 29/30, with the remaining failure still missing key configured concepts.
- 2026-06-26 desktop split/index engineering: `pnpm test:backend` passed with 31 tests.
- 2026-06-26 desktop split/index engineering: `pnpm build` in `desktop/` passed.
- 2026-06-26 extension settings removal: `pnpm build` in `extension/` completed with exit code 0; Plasmo's post-build package-info fetch failed under restricted network but did not fail the build.
- 2026-06-26 extension settings removal: production and dev extension manifests have no `options_ui`, `options_page`, or `options.html`.
- 2026-06-26 extension settings removal: `pnpm test:backend` passed with 31 tests.
- 2026-06-26 knowledge section extraction: `pnpm build` in `desktop/` passed.
- 2026-06-26 full desktop section extraction: `pnpm build` in `desktop/` passed after moving Overview, Translate, OCR, settings, notes, and graph workbench modules out of `App.tsx`.
- 2026-06-26 sync engineering UI: `pnpm test:backend` passed with 32 tests.
- 2026-06-26 sync engineering UI: `pnpm build` in `desktop/` passed.
