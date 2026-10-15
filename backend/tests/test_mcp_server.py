import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from mcp_server import TOOL_DEFINITIONS, handle_message
from schemas.knowledge import KnowledgeHitTestItem, KnowledgeHitTestResponse, KnowledgeTopicListResponse, KnowledgeTopicStats


class McpServerTestCase(unittest.IsolatedAsyncioTestCase):
    async def test_initialize_and_tools_list(self) -> None:
        initialized = await handle_message(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": "2025-06-18"},
            }
        )
        self.assertIsNotNone(initialized)
        self.assertEqual(initialized["result"]["protocolVersion"], "2025-06-18")
        self.assertEqual(initialized["result"]["serverInfo"]["name"], "tabkeep")

        listed = await handle_message({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        self.assertEqual([tool["name"] for tool in listed["result"]["tools"]], [tool["name"] for tool in TOOL_DEFINITIONS])

    async def test_initialized_notification_has_no_response(self) -> None:
        response = await handle_message({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.assertIsNone(response)

    async def test_search_tool_returns_compact_source_metadata(self) -> None:
        item = KnowledgeHitTestItem(
            documentId="doc-1",
            paragraphId="para-1",
            chunkId="chunk-1",
            title="MySQL / 锁",
            paragraphTitle="锁",
            sourceType="markdown",
            path="notes/mysql.md",
            content="完整段落内容",
            matchedContent="命中片段",
            score=0.12,
            rank=1,
            matchedBy=["fts"],
        )
        response = KnowledgeHitTestResponse(
            ok=True,
            query="锁",
            searchMode="hybrid",
            sourceMode="fts",
            items=[item],
        )
        with patch("mcp_server.retrieval.hit_test_knowledge", new=AsyncMock(return_value=response)) as search:
            result = await handle_message(
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {"name": "tabkeep_search", "arguments": {"query": "锁", "limit": 3}},
                }
            )
        search.assert_awaited_once_with("锁", 3, "hybrid", 0)
        payload = json.loads(result["result"]["content"][0]["text"])
        self.assertEqual(payload["items"][0]["documentId"], "doc-1")
        self.assertEqual(payload["items"][0]["text"], "命中片段")

    async def test_source_tool_and_topic_tool_are_read_only_adapters(self) -> None:
        source = {"document": {"id": "doc-1"}, "paragraph": {"content": "来源内容"}}
        topic_response = KnowledgeTopicListResponse(
            ok=True,
            topics=[],
            stats=KnowledgeTopicStats(totalTopics=0),
        )
        with (
            patch("mcp_server.db.get_source_record", return_value=source) as get_source,
            patch("mcp_server.topics.list_topics", return_value=topic_response) as list_topics,
        ):
            source_result = await handle_message(
                {
                    "jsonrpc": "2.0",
                    "id": 4,
                    "method": "tools/call",
                    "params": {
                        "name": "tabkeep_get_source",
                        "arguments": {"document_id": "doc-1", "paragraph_id": "p-1", "offset": 0},
                    },
                }
            )
            topic_result = await handle_message(
                {
                    "jsonrpc": "2.0",
                    "id": 5,
                    "method": "tools/call",
                    "params": {"name": "tabkeep_list_topics", "arguments": {"limit": 10}},
                }
            )
        get_source.assert_called_once_with("doc-1", "p-1")
        list_topics.assert_called_once_with(query=None, limit=10)
        self.assertEqual(json.loads(source_result["result"]["content"][0]["text"])["paragraph"]["content"], "来源内容")
        self.assertEqual(json.loads(topic_result["result"]["content"][0]["text"])["stats"]["totalTopics"], 0)

    async def test_tool_validation_returns_error_result(self) -> None:
        result = await handle_message(
            {
                "jsonrpc": "2.0",
                "id": 6,
                "method": "tools/call",
                "params": {"name": "tabkeep_search", "arguments": {}},
            }
        )
        self.assertTrue(result["result"]["isError"])
        self.assertIn("query", result["result"]["content"][0]["text"])


if __name__ == "__main__":
    unittest.main()
