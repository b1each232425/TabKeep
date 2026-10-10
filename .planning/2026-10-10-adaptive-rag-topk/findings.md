# Findings

- The actual answer flow is `backend/services/knowledge/qa.py::ask_knowledge` → `search_knowledge` → `build_rag_messages`; desktop calls it from `desktop/src/sections/KnowledgeSection.tsx` through `desktop/src/api/knowledge.ts`.
- Current ask defaults are K=8 in `KnowledgeAskRequest`, `askKnowledge`, and the desktop handler. The search endpoint and evaluation workbench use separate limits and should remain unchanged.
- `search_knowledge` already returns rerank scores on citations when reranking is active. Core-set retrieval snapshot: 18 answerable core cases had top-1 rerank scores with minimum 0.264; only one was below 0.30. This makes 0.30 a cautious initial trigger, not a calibrated universal confidence threshold.
- Answer evaluation showed K5 and K10 both passed all six paired successful cases; K10 had four timeouts among the ten sampled cases. Keep K5 as baseline and avoid automatic second calls except explicit insufficiency fallback.
- Context budget is capped at 14,000 characters by `rag_contexts`, so K10 remains bounded.

