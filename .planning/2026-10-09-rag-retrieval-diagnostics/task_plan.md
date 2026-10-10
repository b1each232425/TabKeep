# RAG Top-10 Retrieval Diagnosis

**Goal:** Inspect the v2 personal-note benchmark's retrieved Top 10 to classify noise and ranking failures, then make only evidence-supported, narrowly scoped improvements if the cause is clear.

**Constraints:** Keep `tabkeep-mysql-notes-v2` and the current index frozen. Retrieval-only phases do not call answer generation/Ragas. The newly authorized Phase 6 runs answer generation only for the 20 marked core cases at K=5 and K=10; do not run Ragas. Preserve unrelated working-tree changes and user data.

## Phases

1. **Run controlled retrieval ablation** — `complete`
   - Evaluate the same 52 answerable v2 cases at Top K=10.
   - Compare FTS-only, vector-only, Hybrid/RRF without reranking, and Hybrid with reranking.
   - Hold the 20-candidate pool and index fingerprint constant.
2. **Inspect case-level Top 10 and categorize errors** — `complete`
   - Compare Hybrid/RRF candidates with reranked order.
   - Check duplicate passages/sources, paragraph/chunk concentration, lexical false positives, and rerank position changes.
   - Summarize affected queries and likely causes without dumping full note text.
3. **Apply a targeted change if evidence supports one** — `complete`
   - Group only exact normalized paragraph contexts after reranking and before the top-k cut; retain the best-ranked citation and attach alternate source metadata.
   - Let evaluation relevance match any attached alternate source, so mirrored copies do not create false negatives.
   - Surface alternate source links in the desktop citation list; do not delete or rewrite index records.
4. **Verify and report** — `complete`
   - Confirm the index stayed unchanged and rerun the same fixed cases only if code/index behavior changed.
   - Report metrics, changed files, and remaining limitations.
5. **Compare Top K/context size** — `complete`
   - Use the persisted post-dedup Top-10 results for the same 52 answerable cases, if they include each ranked hit and gold labels, to compute K=3/5/8/10 prefixes offline.
   - Compare Recall@K, Precision@K, MRR, Top1, average returned context length, and total contexts supplied; do not call the answer model or Ragas.
   - If the persisted record is incomplete, run one fixed Top-10 retrieval pass and derive all prefixes from it, avoiding four duplicate Rerank calls per query.
6. **Paired answer-quality check on core 20** — `in_progress`
   - Confirm exactly 20 cases are marked core and identify whether they include refusal cases.
   - Using the same index, dataset, model configuration, and Hybrid+Rerank pipeline, generate answers for each core case at K=5 and K=10; disable Ragas.
   - Persist both runs separately, compare answer pass/keyword coverage/faithfulness/relevance and refusal outcomes, and report API failures separately from answer-quality failures.

## Errors Encountered

| Error | Attempt | Resolution |
|---|---:|---|
| Pilot answer call with local model alias `Xing4.0-29B` returned `llm_error` | 1 | Verified SiliconFlow's model catalog; use the listed API ID `XingChenAGI/Xing4.0-29B` in-memory for the experiment. A one-case K=5 pilot then succeeded; the saved config was not edited. |

