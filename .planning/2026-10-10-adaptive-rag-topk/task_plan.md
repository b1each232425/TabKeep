# Adaptive RAG answer context: K5 default, K10 fallback

## Goal

Make normal knowledge-base answers use five retrieved contexts by default, while allowing ten contexts for clearly multi-part or weak-rerank queries and retrying with ten only when a K5 answer explicitly says the available evidence is insufficient.

## Approved behavior

- Desktop `/knowledge/ask` calls and its request schema default to K=5.
- Retrieve at most ten candidates once for the ask flow; ordinary questions send the first five to the answer model.
- Expand to ten before generation for explicit multi-part/list/comparison queries or when the top rerank score is below 0.30.
- If a K5 answer explicitly signals insufficient evidence and more candidates exist, make one fallback answer call with up to ten; if it fails, keep the first answer and its citations.
- Do not change search UI or evaluation Top-K controls.

## Phases

- [complete] Inspect current ask/search boundaries and test conventions.
- [complete] Implement K5 ask defaults and adaptive K10 selection/fallback.
- [complete] Add focused unit tests for expansion triggers, fallback, citation consistency, and failure behavior.
- [complete] Run backend tests and desktop type/build checks; inspect diff.

## Errors / constraints

| Issue | Resolution |
| --- | --- |
| `codex_research` and `codex_plan` MCP tools are unavailable | Use direct repository inspection and this local plan as the bounded fallback. |

