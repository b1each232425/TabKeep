# Progress

## 2026-10-20

- Started formal RRF integration after user clarified that RRF should become the actual recommendation method, not just the evaluation candidate.
- Confirmed current formal API remains keyword-only; RRF exists only in development evaluation.
- The default `python` launcher points to a broken Windows Store alias. Located the existing project Conda environment at `%USERPROFILE%\.conda\envs\tabkeep\python.exe`; no dependency installation was needed.
- Phase 1 complete: confirmed evaluator-only RRF, exact cache/input behavior, synchronous news route, and current UI state handling.
- Added a shared semantic helper module and redirected evaluation embedding/cache/text/scoring helpers through it, preserving the existing cache path and the evaluation module's patch points.
- Implemented async production recommendation: configured embeddings produce keyword and semantic rankings, then shared RRF (`k=60`) fuses rank positions. Disabled or failing embeddings fall back to keyword rankings; failure logs only exception type.
- Added the `keyword_fallback` API/UI state and RRF position reasons. Latest view does not call embeddings.
- Kept evaluation sample preparation keyword-only so creating a blind batch does not make a provider request; evaluation and production now call the same RRF implementation.
- Verification: focused news recommendation tests (38) passed; full backend suite (194) passed; `pnpm build` passed including the reader static build. No live embedding request or installer build was run.
