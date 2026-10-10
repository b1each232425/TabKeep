# Progress — RAG Top-10 Retrieval Diagnosis

## 2026-10-09

- Read the relevant prior RGB benchmark plan and preserved its completed files.
- Confirmed v2 contains 56 cases (52 answerable, 4 refusal) and both the main vector index and Rerank configuration are available.
- Ran four controlled retrieval conditions over the same 52 answerable queries, fixed Top K=10 and 20-candidate pool; no answer model or Ragas calls.
- Persisted all four runs in the evaluation history. The index fingerprint was identical before and after.
- Initial signal: FTS-only is weak, Vector and Hybrid/RRF no-rerank are similar, and Hybrid+Rerank improves all aggregate metrics. Case-level inspection is now complete.
- Inspected all 52 cases across Hybrid/RRF and Hybrid+Rerank. Exact duplicate paragraph blocks from mirrored `tabkeep_note`/`markdown` documents consume roughly half of the Top 10; reranking rescues all ten Hybrid no-rerank misses from original ranks 11–18.
- Found four cases with identical evidence text but inconsistent relevant/not-relevant labels across indexed document versions. This benchmark-label issue could confound de-dup evaluation; no retrieval/index changes made. Exact de-dup plus label alignment is the proposed next action.
- User approved exact-content de-dup with source provenance preserved. Implementation will group only exact normalized title+paragraph matches before candidate truncation/reranking, surface alternate sources, and let evaluation treat alternate source IDs as equivalent; no index/document deletion.
- Preliminary implementation and 52-case eval completed (run `ced70b67cc6a4e98876589fe04e93e27`; index fingerprint unchanged). Pre-rerank grouping returned 10 unique contexts/query but shifted ranking (Top1 65.38%, MRR 0.7867) below the prior unique-content baseline (Top1 69.23%, MRR 0.8147). Moving de-dup after rerank to preserve established ranking before final context assembly.
- Final behavior is after-rerank exact-context collapse; alternate citation provenance is returned to the UI and evaluation matches all attached source IDs. Final 52-case retrieval run `6cdd133a4370458fbc0da951879614fd`: Recall@10 100%, P@10 16.92%, MRR 0.814744, Top1 69.23%, 10 unique contexts/query; index fingerprint unchanged.
- Fresh verification completed: backend suite 86/86 passed, desktop `pnpm build` passed, and `git diff --check` passed. No note/index rewrite and no Ragas/answer-generation calls.

## 2026-10-10

- User approved a Top-K/context-size comparison. Confirmed persisted run `6cdd133a4370458fbc0da951879614fd` is the exact 52-case v2 Hybrid Top-10 retrieval-only run and contains ten ranked hits per case; answer evaluation and Ragas were disabled.
- Recomputed K=3/5/8/10 from identical per-case ranked prefixes offline, with no additional embedding, rerank, answer-model, or Ragas calls. K=5 retains 52/52 query hits, MRR 0.814744, Top1 69.23%, with mean 4,219 passage-body characters versus K=10's 8,741; K=3 has 49/52 hits.
- Recommendation: K=5 is promising as the default context budget, but first validate answer quality on the 20-case core set. No runtime default or source code changed in this sweep.
- User requested the K=5/K=10 answer-quality check. Starting paired answer-only runs for the 20 marked core cases; Ragas remains disabled.
- The first pilot using the saved alias `Xing4.0-29B` failed and was stopped immediately. SiliconFlow's official catalog lists `XingChenAGI/Xing4.0-29B`; using that exact ID only in-memory, with the same thinking parameter, succeeded on the first core case (K=5, heuristic answer score 0.833333, pass). No config file was changed. Proceeding to paired runs.

