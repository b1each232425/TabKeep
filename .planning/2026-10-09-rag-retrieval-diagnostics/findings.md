# Findings — RAG Top-10 Retrieval Diagnosis

- Benchmark: `tabkeep-mysql-notes-v2`, 52 answerable queries (4 refusal cases excluded from retrieval metrics), Top K=10.
- Main notes index fingerprint before and after the ablation: `a3114020fca02c89e122366481f842590b639155f33d5aa2e7a4573855c23252` (unchanged).
- Rerank candidate pool: 20. The three no-rerank baselines used an in-process no-op reranker so candidate-pool size remained the same; Hybrid+Rerank called the configured rerank service.
- Runs persisted in `backend/data/knowledge.db`:
  - FTS-only: `6443f0243ed547308ff83e40e4e434a3`
  - Vector-only: `f242132022834e11a1c4c96806fc7e03`
  - Hybrid/RRF, no rerank: `69c78b0739b841e99fbf43c88f3336d9`
  - Hybrid + rerank: `5b3ed9ae32c3405abf1142cba7f4e0c6`
- Aggregate results:
  - FTS-only: Recall@10 0.076923, P@10 0.015385, MRR 0.076923, Top1 0.076923.
  - Vector-only: Recall@10 0.807692, P@10 0.217308, MRR 0.453510, Top1 0.346154.
  - Hybrid/RRF no rerank: Recall@10 0.807692, P@10 0.213462, MRR 0.455220, Top1 0.346154.
  - Hybrid + rerank: Recall@10 1.0, P@10 0.317308, MRR 0.772375, Top1 0.673077; rerank applied on all 52 queries.
- The largest aggregate gain is reranking; Vector and Hybrid/RRF without reranking are close. Case-level inspection is needed to determine whether top-10 noise comes from duplicate sources, nearby but non-gold paragraphs, lexical matches, or reranker ordering.
- Case-level inspection confirms 52/52 queries have cross-document exact duplicate hits in the Top 10 for Vector, Hybrid/RRF no-rerank, and Hybrid+Rerank. Across all result lists this accounts for 266, 265, and 248 redundant Top-10 hits respectively.
- SQLite `documents` metadata shows exact `content_hash` pairs are consistently `tabkeep_note` + `markdown` copies (including same titles; the Markdown item has a local `.md` basename). There are 21 such exact-content groups across the full local index, so this appears to be mirrored-source indexing rather than a retrieval-only coincidence. No source/index rows have been changed.
- The ten Hybrid no-rerank Top-10 misses are all present within the rerank candidate pool at original RRF positions 11–18; the configured reranker promotes them into Top 10. This indicates the current reranker is materially helping candidate ordering, while duplicate copies reduce unique-source diversity.
- In the reranked Top 10, exact `(paragraphTitle, content)` de-dup leaves a mean of only 5.23 unique entries per query (median 5; minimum 4), with 248 redundant slots across the 52 queries. Hybrid/RRF without rerank averages 4.90 unique entries (265 redundant slots).
- Four query cases contain identical returned evidence text with mixed gold labels (one copy marked relevant and another not), due to multiple indexed document versions. Naïve retrieval-time de-dup could therefore alter benchmark scores depending on which source citation is retained; v2 gold semantics should be aligned with exact-content duplicates before using score deltas as acceptance criteria.
- User approved exact-content retrieval de-dup while preserving all source information. Implementation scope: group only identical normalized `(display title, paragraph content)` candidates before the rerank/top-k cut; keep the highest-ranked citation and attach other source metadata. Evaluation should treat those attached source records as equivalent citation targets to avoid the observed mixed-label false negatives. The desktop citation list should show/open alternates. No user documents or index rows will be deleted or rewritten.
- First implementation experiment deduplicated before reranking and ran the 52-case set: Recall@10 100%, P@10 17.69%, MRR 0.7867, Top1 65.38%; it returned 10 unique contexts/query. Recomputing the previous result at content-level relevance gave P@10 15.96%, MRR 0.8147, Top1 69.23% with only 5.23 unique contexts/query. The MRR/Top1 regression suggests pre-rerank de-dup changes candidate ordering; move collapse to after rerank, then refill Top K from remaining ranked candidates, preserving the established reranker order.
- Final implementation now deduplicates after reranking. It normalizes Unicode with NFKC and collapses whitespace, groups by exact `(title, content)`, keeps the highest-ranked result, and attaches the other source references. Candidate retrieval keeps a tail so duplicates removed from the final Top K can be replaced by the next ranked unique passage.
- Final fixed 52-answerable-case rerun is persisted as `6cdd133a4370458fbc0da951879614fd`: Recall@10 100%, P@10 16.92%, MRR 0.814744, Top1 69.23%; every query returns 10 unique contexts (mean/minimum 10). The index fingerprint remains `a3114020fca02c89e122366481f842590b639155f33d5aa2e7a4573855c23252`.
- For a fair comparison, the previous reranked results scored by unique content had P@10 15.96%, MRR 0.8147, Top1 69.23%, and only 5.23 unique contexts/query. Thus deduplication improves unique-context diversity and slightly improves content-level P@10 while preserving MRR/Top1; the older raw P@10 31.73% counted duplicate copies as separate relevant hits and is not directly comparable.
- Verification: all 86 backend tests pass; desktop `pnpm build` passes; `git diff --check` passes. No index rebuild or note mutation was performed. Ragas and answer generation were not run.
- Top-K sweep reused the persisted final Top-10 record above, so every K is a prefix of the exact same ranked results; no new retrieval/Rerank/LLM requests were made. It contains all 10 hits for each of the 52 answerable v2 cases, with answer and Ragas evaluation disabled; the index fingerprint matches the recorded baseline.
- Context-size measure is the character count of passage bodies actually selected from the top K, applying the same 14,000-character context cap; source headers and prompt text are excluded. Maximum measured passage-body context was 12,210 characters, so the cap did not truncate this run. This is not an exact tokenizer token count.

| K | Query hit rate / Recall@K | P@K | MRR@K | Top1 | Mean unique contexts | Mean passage-body chars |
|---:|---:|---:|---:|---:|---:|---:|
| 3 | 49/52 (94.23%) | 48.08% | 0.801282 | 69.23% | 3 | 2,611 |
| 5 | 52/52 (100%) | 31.92% | 0.814744 | 69.23% | 5 | 4,219 |
| 8 | 52/52 (100%) | 20.67% | 0.814744 | 69.23% | 8 | 6,925 |
| 10 | 52/52 (100%) | 16.92% | 0.814744 | 69.23% | 10 | 8,741 |

- K=5 is the best efficiency candidate in this sweep: it preserves the measured query-level hit rate, MRR, and Top1 of K=10 while halving returned contexts and reducing average passage-body characters by 51.7%. K=3 saves more context (70.1% fewer characters than K=10) but misses gold evidence in 3 cases and slightly reduces MRR. These are retrieval-benchmark results only; they do not establish answer-generation quality. Recommend testing K=5 in a small answer-quality evaluation before changing the application's default.
- Answer-quality experiment setup: core set has 20 cases (18 answerable, 2 refusal). Local config's short model alias `Xing4.0-29B` failed on a pilot request. SiliconFlow's official model directory lists `XingChenAGI/Xing4.0-29B`; a pilot using this exact ID succeeded with the existing `enable_thinking=true` payload. The saved config was not modified. Official docs: [model catalog](https://www.siliconflow.cn/models), [Chat Completions API](https://docs.siliconflow.cn/docs/api/chat-completions-post).

