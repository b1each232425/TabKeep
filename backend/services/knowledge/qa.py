from __future__ import annotations

import re

from schemas.knowledge import KnowledgeAskRequest, KnowledgeAskResponse, KnowledgeCitation
from services import storage
from services.knowledge import db
from services.knowledge.retrieval import search_knowledge
from services.llm import chat_completion

MAX_CONTEXT_CHARS = 14_000
_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)


async def ask_knowledge(req: KnowledgeAskRequest) -> KnowledgeAskResponse:
    question = req.question.strip()
    if not question:
        return KnowledgeAskResponse(ok=False, error="请输入问题")

    model_config = storage.get_model_config()
    if not model_config or not model_config.model or not model_config.baseURL or not model_config.apiKey:
        return KnowledgeAskResponse(ok=False, error="modelConfig 不完整,先在「模型 API」配置 LLM")

    search_result = await search_knowledge(question, req.limit)
    if not search_result.items:
        return KnowledgeAskResponse(
            ok=False,
            error=search_result.error or "知识库里没有检索到相关内容",
            sourceMode=search_result.sourceMode,
        )

    session_id = db.ensure_session(req.sessionId, question)
    db.add_message(session_id, "user", question)
    messages = build_rag_messages(question, search_result.items)
    try:
        raw = await chat_completion(model_config, messages)
        answer = clean_llm_output(raw)
        db.add_message(session_id, "assistant", answer)
        return KnowledgeAskResponse(
            ok=True,
            answer=answer,
            citations=search_result.items,
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


def build_rag_messages(question: str, citations: list[KnowledgeCitation]) -> list[dict[str, str]]:
    source_blocks: list[str] = []
    used = 0
    for index, item in enumerate(citations, start=1):
        content = item.content.strip()
        remaining = MAX_CONTEXT_CHARS - used
        if remaining <= 0:
            break
        clipped = content[:remaining]
        used += len(clipped)
        location = item.url or item.path or item.documentId
        source_blocks.append(
            f"[来源 {index}]\n标题: {item.title}\n位置: {location}\n内容:\n{clipped}"
        )

    return [
        {
            "role": "system",
            "content": (
                "你是 TabKeep 本地知识库助手。只能基于用户提供的来源片段回答。"
                "如果来源片段不足以回答,请明确说没有足够依据。"
                "回答要用中文,条理清晰,并在关键结论后用 [来源 1] 这样的形式标注来源。"
            ),
        },
        {
            "role": "user",
            "content": f"问题:\n{question}\n\n可用来源:\n\n" + "\n\n".join(source_blocks),
        },
    ]


def clean_llm_output(raw: str) -> str:
    cleaned = _THINK_RE.sub("", raw or "").strip()
    return cleaned or "没有生成有效回答。"

