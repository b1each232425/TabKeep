# RGB Retrieval Benchmark Implementation Plan

**Goal:** Add an isolated RGB `zh_refine` retrieval benchmark to TabKeep's desktop evaluation workbench and make it the default, automatically downloading and indexing the official corpus on first use.

**Architecture:** Import user-provided RGB JSONL into separate SQLite FTS and LanceDB indexes. Run the current retrieval pipeline with an explicit corpus profile, derive retrieval relevance from each case's positive passage IDs, and persist/display RGB results separately from the main notes evaluation.

**Tech Stack:** Python, FastAPI, SQLite FTS5, LanceDB, existing React/TypeScript desktop evaluation UI.

## Phases

1. **Inspect current user changes and API/data contracts** — `complete`
   - Review diffs for overlapping backend/UI files.
   - Confirm embedding, chunking, Ragas persistence, and frontend build/test conventions.
2. **Implement isolated RGB corpus importer and storage** — `complete`
   - Parse JSONL `zh_refine` records, validate, deduplicate passage content, retain per-case positives.
   - Keep corpus and vectors in dedicated paths/tables.
3. **Route retrieval evaluation through RGB profile** — `complete`
   - Add explicit benchmark/profile API contracts.
   - Reuse FTS/vector/RRF/rerank behavior without switching the default notes profile.
   - Persist separate RGB run results.
4. **Add desktop RGB benchmark workflow** — `complete`
   - Import local data, show corpus/index status, run and review RGB retrieval metrics separately.
5. **Verify and report** — `complete`
   - Focused backend tests, relevant existing tests, desktop typecheck/build, and diff review.
6. **Default RGB and auto-initialize corpus** — `complete`
   - Open the eval workbench on RGB while preserving the notes benchmark tab.
   - If no RGB corpus is imported, fetch official `zh_refine.json`, import it and build the independent indexes once.
   - Never auto-run an evaluation; display progress/errors and a retry action; avoid duplicate concurrent initialization.
7. **Verify the first-use initialization flow** — `complete`
   - Focused RGB tests, full backend suite, TypeScript/desktop build, Python compilation, and whitespace checks.
   - Review the targeted diff and preserve all unrelated existing worktree changes.

## Errors Encountered
| Error | Attempt | Resolution |
|---|---:|---|
| `codex_research` / `codex_plan` MCP tools unavailable | 1 | Use bounded manual repository inspection and maintain this explicit local plan; do not claim tool-backed research/planning. |
| Regression tests failed before implementation because the official-download importer and route did not exist | 1 | Implemented the backend importer/API and UI call; focused RGB suite now passes. |
| Vite standalone eval-page check could not bind to port 5175 although the initial listener probe showed it free | 1 | Do not disturb the existing listener; retry this read-only compile check on a different temporary port. |
| A read-only inspection command used the parent directory as cwd | 1 | Re-ran with the TabKeep repository cwd; no files affected. |
| Findings patch used stale context | 1 | Re-read the exact planning file and applied the update against current contents. |
| Focused RGB test expected a relevant hit but got Recall@K 0 | 1 | Inspect showed FTS correctly required every query token; test question contained extra Chinese tokens absent from its positive passage. Change the synthetic query to the exact unique token so this test isolates corpus routing/metric math, not query formulation quality. |
| Diagnostic assertion patch used an extra `TabKeep` path segment | 1 | Corrected to the repository-relative absolute path; no file was changed by the failed attempt. |
| Verification plan update used a findings-file context line | 1 | Re-read the actual task plan and update only its phase markers. |

## Decisions
- `zh_refine` only in this first phase; `zh_int`, `zh_fact`, Ragas, and answer generation remain future extensions.
- No bundled RGB data and no commit.
- Preserve all pre-existing user modifications.
- User approved automatic first-use download and indexing, including the configured embedding API call/cost risk; do not run an evaluation automatically.
