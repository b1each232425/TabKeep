from __future__ import annotations

import re

from schemas.knowledge import KnowledgeAskRequest, KnowledgeAskResponse, KnowledgeCitation
from services import storage
from services.knowledge import db
from services.knowledge.retrieval import search_knowledge
from services.llm import chat_completion
from logger import logger

MAX_CONTEXT_CHARS = 14_000
DEFAULT_ASK_LIMIT = 5
EXPANDED_ASK_LIMIT = 10
RERANK_EXPANSION_THRESHOLD = 0.30
_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)
_MULTI_EVIDENCE_QUERY_RE = re.compile(
    r"对比|比较|区别|差异|异同|优缺点|分别|各自|有哪些|列举|全部|所有|以及|并且|同时"
)
_INSUFFICIENT_CONTEXT_RE = re.compile(
    r"没有足够(?:的)?(?:依据|信息)|资料不足|来源不足|依据不足|信息不足|"
    r"检索到.{0,20}不足|上下文.{0,12}不足|无法根据|无法依据|无法回答|"
    r"not enough information|cannot answer",
    re.IGNORECASE,
)


async def ask_knowledge(req: KnowledgeAskRequest) -> KnowledgeAskResponse:
    question = req.question.strip()
    if not question:
        return KnowledgeAskResponse(ok=False, error="请输入问题")

    model_config = storage.get_model_config()
    if not model_config or not model_config.model or not model_config.baseURL or not model_config.apiKey:
        return KnowledgeAskResponse(ok=False, error="modelConfig 不完整,先在「模型 API」配置 LLM")

    requested_limit = max(1, min(int(req.limit or DEFAULT_ASK_LIMIT), 20))
    search_limit = max(requested_limit, EXPANDED_ASK_LIMIT)
    search_result = await search_knowledge(question, search_limit)
    if not search_result.items:
        return KnowledgeAskResponse(
            ok=False,
            error=search_result.error or "知识库里没有检索到相关内容",
            sourceMode=search_result.sourceMode,
        )

    session_id = db.ensure_session(req.sessionId, question)
    db.add_message(session_id, "user", question)
    all_citations = search_result.items
    expand_before_answer = (
        requested_limit < EXPANDED_ASK_LIMIT
        and should_expand_context(question, all_citations[:requested_limit])
    )
    answer_limit = EXPANDED_ASK_LIMIT if expand_before_answer else requested_limit
    citations = all_citations[:answer_limit]
    messages = build_rag_messages(question, citations)
    try:
        raw = await chat_completion(model_config, messages)
        answer = clean_llm_output(raw)
        if (
            len(citations) < EXPANDED_ASK_LIMIT
            and len(all_citations) > len(citations)
            and answer_signals_insufficient_context(answer)
        ):
            expanded_citations = all_citations[:EXPANDED_ASK_LIMIT]
            try:
                expanded_raw = await chat_completion(
                    model_config,
                    build_rag_messages(question, expanded_citations),
                )
                answer = clean_llm_output(expanded_raw)
                citations = expanded_citations
            except Exception as expansion_error:
                logger.warning(
                    "知识库问答扩展上下文失败，保留初始 K={} 的回答: {}",
                    len(citations),
                    type(expansion_error).__name__,
                )
        db.add_message(session_id, "assistant", answer)
        return KnowledgeAskResponse(
            ok=True,
            answer=answer,
            citations=citations,
            sessionId=session_id,
            sourceMode=search_result.sourceMode,
        )
    except Exception as exc:
        error = f"LLM 调用失败: {type(exc).__name__}: {exc}"
        db.add_message(session_id, "assistant", error)
        return KnowledgeAskResponse(
            ok=False,
            citations=search_result.items,
            sessionId=session_id,
            sourceMode=search_result.sourceMode,
            error=error,
        )


def should_expand_context(question: str, citations: list[KnowledgeCitation]) -> bool:
    """Expand to ten sources for multi-evidence queries or a weak rerank leader."""
    if len(citations) > 1 and _MULTI_EVIDENCE_QUERY_RE.search(question):
        return True
    if question.count("?") + question.count("？") > 1:
        return True
    top_score = citations[0].rerankScore if citations else None
    return top_score is not None and top_score < RERANK_EXPANSION_THRESHOLD


def answer_signals_insufficient_context(answer: str) -> bool:
    return bool(_INSUFFICIENT_CONTEXT_RE.search(answer or ""))


def build_rag_messages(question: str, citations: list[KnowledgeCitation]) -> list[dict[str, str]]:
    source_blocks: list[str] = []
    contexts = rag_contexts(citations)
    for index, (item, clipped) in enumerate(zip(citations, contexts, strict=False), start=1):
        location = item.url or item.path or item.documentId
        source_blocks.append(
            f"[来源 {index}]\n标题: {item.title}\n位置: {location}\n内容:\n{clipped}"
        )

    return [
        {
            "role": "system",
            "content": (
                "你是 TabKeep 本地知识库助手。只能基于用户提供的来源段落回答。"
                "如果来源段落不足以回答,请明确说没有足够依据。"
                "回答要用中文,条理清晰,并在关键结论后用 [来源 1] 这样的形式标注来源。"
            ),
        },
        {
            "role": "user",
            "content": f"问题:\n{question}\n\n可用来源:\n\n" + "\n\n".join(source_blocks),
        },
    ]


def rag_contexts(citations: list[KnowledgeCitation]) -> list[str]:
    contexts: list[str] = []
    used = 0
    for item in citations:
        remaining = MAX_CONTEXT_CHARS - used
        if remaining <= 0:
            break
        clipped = item.content.strip()[:remaining]
        contexts.append(clipped)
        used += len(clipped)
    return contexts


def clean_llm_output(raw: str) -> str:
    cleaned = _THINK_RE.sub("", raw or "").strip()
    return cleaned or "没有生成有效回答。"
