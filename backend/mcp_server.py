"""TabKeep 按需本地 MCP 服务。

该入口使用 MCP 的 JSON-RPC stdio 传输，只提供只读知识库工具。它不会启动
FastAPI，也不会读取或转发 TabKeep API token；外部 AI 客户端主动启动进程后，
服务加载本地索引并在 stdin/stdout 上完成一次会话。
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

from services import storage
from services.knowledge import db, retrieval, topics

SERVER_NAME = "tabkeep"
SERVER_VERSION = "0.1.0"
SUPPORTED_PROTOCOL_VERSIONS = {"2024-11-05", "2025-03-26", "2025-06-18"}
DEFAULT_PROTOCOL_VERSION = "2024-11-05"
MAX_SEARCH_LIMIT = 20
MAX_TOPIC_LIMIT = 100
MAX_SOURCE_CHARS = 20_000

TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "name": "tabkeep_search",
        "description": "在 TabKeep 当前本地知识库中检索相关笔记片段。返回标题、来源标识、段落标识和可直接引用的文本；需要更完整内容时调用 tabkeep_get_source。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "要检索的问题或关键词"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 20, "default": 8},
                "search_mode": {
                    "type": "string",
                    "enum": ["hybrid", "fts", "vector"],
                    "default": "hybrid",
                    "description": "检索模式，默认复用 TabKeep 的混合检索",
                },
                "min_score": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1,
                    "default": 0,
                    "description": "可选最低匹配分数",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "tabkeep_get_source",
        "description": "读取一个检索结果对应的来源。只传 document_id 时返回文档元数据和段落目录；再传 paragraph_id 才返回该段落的完整内容。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "document_id": {"type": "string", "description": "tabkeep_search 返回的 documentId"},
                "paragraph_id": {"type": "string", "description": "tabkeep_search 返回的 paragraphId，可选"},
                "max_chars": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 20000,
                    "default": 12000,
                    "description": "段落内容最多返回的字符数",
                },
                "offset": {
                    "type": "integer",
                    "minimum": 0,
                    "default": 0,
                    "description": "从段落内容的第几个字符开始读取，用于分段读取长段落",
                },
            },
            "required": ["document_id"],
        },
    },
    {
        "name": "tabkeep_list_topics",
        "description": "列出 TabKeep 已构建的主题知识地图，用于发现知识库中可复用的主题、关键词和来源规模。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 50},
                "query": {"type": "string", "description": "可选主题名称或关键词过滤"},
            },
        },
    },
]


def _json_response(request_id: object, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _json_error(request_id: object, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def _text_result(payload: object, *, is_error: bool = False) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False, indent=2)}],
        "isError": is_error,
    }


def _bounded_int(value: object, *, name: str, default: int, maximum: int) -> int:
    if value is None:
        return default
    if isinstance(value, bool):
        raise ValueError(f"{name} 必须是整数")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} 必须是整数") from exc
    return max(1, min(parsed, maximum))


def _bounded_float(value: object, *, name: str, default: float) -> float:
    if value is None:
        return default
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} 必须是数字") from exc
    if parsed < 0 or parsed > 1:
        raise ValueError(f"{name} 必须在 0 到 1 之间")
    return parsed


def _required_text(arguments: dict[str, Any], name: str) -> str:
    value = arguments.get(name)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} 不能为空")
    return value.strip()


def _truncate(value: object, max_chars: int) -> tuple[str, bool]:
    text = str(value or "")
    if len(text) <= max_chars:
        return text, False
    return f"{text[:max_chars]}\n...[内容已截断，请缩小范围或分段读取]", True


def _serialize_hit(item: Any) -> dict[str, Any]:
    snippet, truncated = _truncate(item.matchedContent or item.content, 6_000)
    return {
        "rank": item.rank,
        "text": snippet,
        "textTruncated": truncated,
        "title": item.title,
        "documentId": item.documentId,
        "paragraphId": item.paragraphId,
        "chunkId": item.chunkId,
        "paragraphTitle": item.paragraphTitle,
        "sourceType": item.sourceType,
        "path": item.path,
        "url": item.url,
        "score": item.score,
        "rerankScore": item.rerankScore,
        "matchedBy": item.matchedBy,
    }


def _serialize_topics(response: Any) -> dict[str, Any]:
    return {
        "ok": response.ok,
        "stats": response.stats.model_dump(),
        "topics": [topic.model_dump() for topic in response.topics],
        "error": response.error,
    }


def _nonnegative_int(value: object, *, name: str, default: int = 0) -> int:
    if value is None:
        return default
    if isinstance(value, bool):
        raise ValueError(f"{name} 必须是非负整数")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} 必须是非负整数") from exc
    if parsed < 0:
        raise ValueError(f"{name} 必须是非负整数")
    return parsed


def _slice_text(value: object, *, offset: int, max_chars: int) -> tuple[str, bool, int]:
    text = str(value or "")
    start = min(offset, len(text))
    end = min(start + max_chars, len(text))
    truncated = end < len(text)
    return text[start:end], truncated, end


def _source_payload(source: dict[str, object], max_chars: int, offset: int) -> dict[str, object]:
    payload = dict(source)
    paragraph = payload.get("paragraph")
    if isinstance(paragraph, dict) and "content" in paragraph:
        paragraph_payload = dict(paragraph)
        content, truncated, next_offset = _slice_text(
            paragraph_payload["content"], offset=offset, max_chars=max_chars
        )
        paragraph_payload["content"] = content
        paragraph_payload["contentOffset"] = offset
        paragraph_payload["contentTotalChars"] = len(str(paragraph.get("content") or ""))
        paragraph_payload["contentTruncated"] = truncated
        paragraph_payload["nextOffset"] = next_offset if truncated else None
        payload["paragraph"] = paragraph_payload
    return payload


async def call_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """执行一个只读 MCP 工具并返回 MCP tool result。"""
    if name == "tabkeep_search":
        query = _required_text(arguments, "query")
        limit = _bounded_int(arguments.get("limit"), name="limit", default=8, maximum=MAX_SEARCH_LIMIT)
        search_mode = arguments.get("search_mode", arguments.get("searchMode", "hybrid"))
        if not isinstance(search_mode, str):
            raise ValueError("search_mode 必须是字符串")
        min_score = _bounded_float(arguments.get("min_score", arguments.get("minScore")), name="min_score", default=0)
        response = await retrieval.hit_test_knowledge(query, limit, search_mode, min_score)
        return _text_result(
            {
                "ok": response.ok,
                "query": response.query,
                "searchMode": response.searchMode,
                "sourceMode": response.sourceMode,
                "vectorAvailable": response.vectorAvailable,
                "rerankUsed": response.rerankUsed,
                "rerankMessage": response.rerankMessage,
                "items": [_serialize_hit(item) for item in response.items],
                "error": response.error,
            }
        )

    if name == "tabkeep_get_source":
        document_id = _required_text(arguments, "document_id")
        paragraph_id = arguments.get("paragraph_id", arguments.get("paragraphId"))
        if paragraph_id is not None and (not isinstance(paragraph_id, str) or not paragraph_id.strip()):
            raise ValueError("paragraph_id 必须是非空字符串")
        max_chars = _bounded_int(
            arguments.get("max_chars", arguments.get("maxChars")),
            name="max_chars",
            default=12_000,
            maximum=MAX_SOURCE_CHARS,
        )
        offset = _nonnegative_int(
            arguments.get("offset"),
            name="offset",
        )
        source = db.get_source_record(document_id, paragraph_id)
        if source is None:
            raise ValueError("来源或段落不存在，请先使用 tabkeep_search 获取有效标识")
        return _text_result(_source_payload(source, max_chars, offset))

    if name == "tabkeep_list_topics":
        limit = _bounded_int(arguments.get("limit"), name="limit", default=50, maximum=MAX_TOPIC_LIMIT)
        query = arguments.get("query")
        if query is not None and not isinstance(query, str):
            raise ValueError("query 必须是字符串")
        response = topics.list_topics(query=query, limit=limit)
        return _text_result(_serialize_topics(response))

    raise ValueError(f"未知工具: {name}")


async def handle_message(message: dict[str, Any]) -> dict[str, Any] | None:
    """处理一条 MCP JSON-RPC 消息；通知不返回响应。"""
    method = message.get("method")
    request_id = message.get("id")
    has_id = "id" in message
    params = message.get("params")
    if not isinstance(params, dict):
        params = {}

    if method == "initialize":
        requested = params.get("protocolVersion")
        protocol_version = requested if requested in SUPPORTED_PROTOCOL_VERSIONS else DEFAULT_PROTOCOL_VERSION
        return _json_response(
            request_id,
            {
                "protocolVersion": protocol_version,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                "instructions": "只读访问 TabKeep 当前本地知识库；需要完整段落时使用 tabkeep_get_source。",
            },
        )

    if method == "notifications/initialized":
        return None

    if method == "ping":
        return _json_response(request_id, {}) if has_id else None

    if method == "tools/list":
        return _json_response(request_id, {"tools": TOOL_DEFINITIONS}) if has_id else None

    if method == "tools/call":
        name = params.get("name")
        arguments = params.get("arguments") or {}
        if not isinstance(name, str) or not name:
            return _json_error(request_id, -32602, "tools/call 缺少工具名") if has_id else None
        if not isinstance(arguments, dict):
            return _json_error(request_id, -32602, "工具参数必须是对象") if has_id else None
        try:
            result = await call_tool(name, arguments)
        except Exception as exc:
            result = _text_result({"ok": False, "error": str(exc)}, is_error=True)
        return _json_response(request_id, result) if has_id else None

    if not has_id:
        return None
    return _json_error(request_id, -32601, f"方法不存在: {method}")


def _write_message(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def serve() -> None:
    """从 stdin 读取换行分隔 JSON-RPC，并将响应写回 stdout。"""
    storage.init()
    db.init_db()
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise ValueError("JSON-RPC 消息必须是对象")
        except (json.JSONDecodeError, ValueError) as exc:
            _write_message(_json_error(None, -32700, f"无法解析 JSON-RPC: {exc}"))
            continue
        try:
            response = asyncio.run(handle_message(message))
        except Exception as exc:  # noqa: BLE001 - stdio 进程必须把异常转成协议响应
            if "id" in message:
                response = _json_error(message.get("id"), -32603, f"内部错误: {type(exc).__name__}: {exc}")
            else:
                response = None
            print(f"TabKeep MCP error: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        if response is not None:
            _write_message(response)


if __name__ == "__main__":
    serve()
