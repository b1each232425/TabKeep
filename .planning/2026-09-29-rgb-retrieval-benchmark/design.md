# RGB Chinese Retrieval Benchmark Design

## Goal
Add an isolated RGB `zh_refine` retrieval benchmark to the TabKeep desktop evaluation workbench, using TabKeep's retrieval pipeline against a separately built corpus without changing the user's primary knowledge base or its existing 56-case evaluation history.

## Constraints
- Do not bundle RGB source data in the repository or application. The user imports a local official JSONL file.
- Keep RGB SQLite FTS and LanceDB storage isolated from the main knowledge index.
- Label results as a TabKeep-RGB retrieval adaptation benchmark, not official RGB scores.
- Preserve current dirty worktree changes; do not revert or commit.
- Phase 1 is retrieval-only for `zh_refine`; generation/Ragas, `zh_int`, and `zh_fact` are out of scope.

## Recommended Approach
Add a benchmark-scoped corpus profile and normalized import records. Import each question's positive and negative passages into a dedicated SQLite/FTS database and LanceDB table, assign stable IDs by normalized content hash, and preserve per-query positive IDs as retrieval ground truth. Route evaluation searches through the existing FTS/vector/RRF/rerank pipeline with an explicit RGB corpus profile. Extend the desktop workbench with a distinct RGB view for importing, indexing, running and reviewing RGB retrieval results; keep the existing notes evaluator untouched by default.

## Alternatives Considered
- Add RGB cases to the existing eval case table and search the primary index: rejected because it evaluates corpus coverage rather than retrieval quality on RGB and contaminates the user's benchmark.
- Reuse the primary SQLite/LanceDB with a corpus filter: rejected because FTS queries and existing vector search are global and corpus filters would be easy to omit on write/read paths.
- Build isolated RGB storage and explicitly route the same retrieval pipeline: selected for reliable data and metric isolation.

## File/Component Impact
- Backend: RGB import/normalization and isolated corpus storage; retrieval profile routing; RGB eval endpoints and persisted run records.
- Desktop: separate RGB benchmark view in the existing evaluation workbench, file import, index status and run results.
- Tests: importer/ground-truth normalization, corpus isolation, retrieval routing, API behavior, and frontend type/build checks.

## Risks
- Dataset revisions may have schema differences; validate each JSONL record and report rejected rows rather than silently dropping them.
- Embedding generation may call the configured embedding provider and incur latency/cost; surface this as an explicit import/index action, and support FTS-only evaluation where embeddings are unavailable.
- RGB's positive/negative labels are query-specific; use per-case stable passage IDs rather than global passage labels.
- The custom passage-union corpus and metrics are not directly comparable to official RGB robustness/generation scores.

## Validation Plan
- Unit tests for accepted `zh_refine` fields, malformed rows, text deduplication, and query-specific positive labels.
- Integration tests proving RGB FTS/vector searches cannot return primary-corpus records and vice versa.
- API tests for import/status/evaluation and persistence isolation.
- Run backend tests, desktop typecheck/build, and focused test suites.
