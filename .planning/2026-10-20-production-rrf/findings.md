# Findings

- Formal `/news/items?view=recommended` currently calls synchronous `interest.recommended_items`, which uses the keyword ranking path.
- The development evaluation implements `keyword`, `semantic`, `hybrid`, and `rrf`; RRF uses `sum(1 / (60 + rank))` and fuses keyword and semantic lists.
- Evaluation-local embedding helpers/cache live in `services.news.recommendation_evaluation`; reuse must not introduce a circular import or alter evaluation semantics.
- `NewsItemListResponse.recommendationState` currently supports `not_applicable`, `ready`, `warming_up`, and `no_matches`; frontend renders warming/no-match states and must add a clear keyword-fallback state.
- User selected RRF as the formal primary method; latest-list ordering remains chronological. No production provider request or package build was authorized as part of validation.
- The existing evaluation cache is keyed by provider base URL, model, and SHA-256 of text, and is stored under `DATA_DIR/news_recommendation_evaluations/embedding-cache.json`; vectors are cached without raw text or API key.
- Semantic item input is cleaned body text only, capped at 5,000 characters; interest input is topic label plus keywords, capped at 300 characters. Evaluation chunks requests at 24 texts.
- RRF evaluator fuses already source/freshness/diversity adjusted keyword and semantic rankings with rank constant 60; formal integration should share this implementation to avoid evaluation/production drift.
- Embedding configuration defaults to disabled. Formal RRF therefore needs a transparent `keyword_fallback` response state when embedding is disabled or unavailable.
- The production reader route now awaits the RRF recommender. The method computes a keyword list and a semantic list from cleaned article bodies plus aggregated positive/negative interest topics, then sums reciprocal ranks with `k=60`.
- Semantic vectors share the evaluation cache, use the same provider/model/text SHA-256 keys, and are requested in batches of at most 24. Cache entries contain vectors and hashes, not source text or API keys.
- The reader API reports `keyword_fallback` if embedding is disabled or fails; it continues to display keyword-ranked recommendations. “Latest” remains chronological and does not call embedding.
- Recommendation reasons expose each item’s keyword and semantic positions in the fused list. Evaluation batch preparation remains keyword-only and cannot call the provider.
- Verification: 38 focused news interest/evaluation tests and all 194 backend tests passed; `pnpm build` passed. No real provider request or installer build was performed.
