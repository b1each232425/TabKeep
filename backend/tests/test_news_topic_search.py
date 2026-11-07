"""话题搜索的数据安全、分页和部分失败测试。"""

import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services import storage
from services.news import db, topic_search
from main import app
from tests.helpers import IsolatedBackendState


class TopicSearchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = IsolatedBackendState(f"topic-search-{self._testMethodName}")
        self.workspace.setup()
        db.init_db()

    def tearDown(self) -> None:
        self.workspace.teardown()

    def seed_item(self, item_id: str, title: str, content: str, url: str, published_at: str) -> None:
        source_id = "topic-search-source"
        if db.get_source(source_id) is None:
            db.create_source(source_id, "https://example.test/feed", "测试来源", published_at)
        db.complete_fetch(
            source_id,
            None,
            None,
            None,
            published_at,
            [{
                "id": item_id,
                "dedupe_key": item_id,
                "title": title,
                "url": url,
                "content": content,
                "image_url": None,
                "image_asset": None,
                "author": "测试作者",
                "published_at": published_at,
            }],
        )

    def test_local_search_matches_title_and_body_and_escapes_wildcards(self) -> None:
        self.seed_item(
            "item-1",
            "TabKeep 话题搜索",
            "本地正文包含推荐算法",
            "https://example.test/post/1",
            "2026-10-29T08:00:00Z",
        )
        self.seed_item(
            "item-2",
            "完全不同",
            "包含 100% 的数据",
            "https://example.test/post/2",
            "2026-10-29T09:00:00Z",
        )

        rows, total = db.search_items("推荐算法", None, 20, 0)
        self.assertEqual(total, 1)
        self.assertEqual(rows[0]["id"], "item-1")

        rows, total = db.search_items("100%", None, 20, 0)
        self.assertEqual(total, 1)
        self.assertEqual(rows[0]["id"], "item-2")

    def test_topic_search_deduplicates_urls_and_keeps_provider_failures_isolated(self) -> None:
        self.seed_item(
            "local-1",
            "兴趣 推荐相关资讯",
            "本地摘要包含兴趣 推荐",
            "https://example.test/shared?utm_source=reader",
            "2026-10-29T08:00:00Z",
        )

        async def anonymous_result(provider: str, _query: str, _page: int) -> topic_search.ProviderResult:
            if provider == "tieba":
                return topic_search.ProviderResult(
                    [{
                        "providerId": "tieba-1",
                        "title": "贴吧重复结果",
                        "author": None,
                        "publishedAt": "2026-10-29T09:00:00Z",
                        "content": "公开搜索摘要",
                        "imageUrl": None,
                        "url": "https://example.test/shared?utm_medium=web",
                    }],
                    "success",
                )
            if provider == "zhihu":
                return topic_search.ProviderResult([], "timeout", "知乎超时")
            return topic_search.ProviderResult([], "empty", "没有结果")

        with patch("services.news.topic_search._anonymous_search", new=AsyncMock(side_effect=anonymous_result)):
            result = asyncio.run(topic_search.search_topics(
                "  兴趣   推荐 ",
                ["local", "tieba", "zhihu", "weibo", "xiaoheihe"],
                "all",
                None,
            ))

        self.assertEqual(result["query"], "兴趣 推荐")
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["items"][0]["provider"], "local")
        states = {state["provider"]: state for state in result["states"]}
        self.assertEqual(states["tieba"]["state"], "success")
        self.assertEqual(states["zhihu"]["state"], "timeout")
        self.assertEqual(states["xiaoheihe"]["state"], "unsupported")
        self.assertEqual(states["weibo"]["state"], "empty")

    def test_auth_search_preference_defaults_off_and_is_persisted_separately(self) -> None:
        self.assertEqual(storage.get_news_search_preferences(), {"zhihu": False, "weibo": False})
        preferences = storage.set_news_search_preference("zhihu", True)
        self.assertTrue(preferences["zhihu"])
        self.assertFalse(preferences["weibo"])
        self.assertTrue(storage.CONFIG_FILE.is_file())

    def test_unselected_authentication_never_opens_the_saved_browser_profile(self) -> None:
        anonymous = topic_search.ProviderResult([], "empty", "匿名搜索无结果")
        with (
            patch.object(topic_search.browser_sessions, "_is_connected", return_value=True),
            patch.object(topic_search, "_anonymous_search", new=AsyncMock(return_value=anonymous)) as anonymous_search,
            patch.object(topic_search.browser_sessions, "authenticated_page", new=AsyncMock()) as authenticated_page,
        ):
            result = asyncio.run(topic_search._search_provider("zhihu", "主题", 1, False))

        self.assertEqual(result.state, "empty")
        self.assertTrue(result.connected)
        anonymous_search.assert_awaited_once_with("zhihu", "主题", 1)
        authenticated_page.assert_not_awaited()

    def test_topic_search_api_requires_news_auth_and_marks_response_no_store(self) -> None:
        storage._state["apiToken"] = "topic-search-test-token"
        result = {
            "requestId": "a1b2c3d4",
            "query": "独立游戏",
            "items": [],
            "states": [{
                "provider": "local",
                "title": "本地资讯",
                "state": "empty",
                "message": "本地资讯中没有匹配结果。",
                "connected": False,
                "useAuthenticated": False,
            }],
            "nextCursor": None,
        }
        with patch("services.news.topic_search.search_topics", new=AsyncMock(return_value=result)):
            with TestClient(app) as client:
                denied = client.post("/news/topic-search", json={"query": "独立游戏", "providers": ["local"]})
                allowed = client.post(
                    "/news/topic-search",
                    headers={"X-TabKeep-Token": "topic-search-test-token"},
                    json={"query": "独立游戏", "providers": ["local"]},
                )
                defaults = client.get("/news/topic-search/preferences", headers={"X-TabKeep-Token": "topic-search-test-token"})
                enabled = client.post(
                    "/news/topic-search/preferences",
                    headers={"X-TabKeep-Token": "topic-search-test-token"},
                    json={"provider": "zhihu", "useAuthenticated": True},
                )
                account = client.get(
                    "/news/topic-search/auth/zhihu",
                    headers={"X-TabKeep-Token": "topic-search-test-token"},
                )

        self.assertEqual(denied.status_code, 401)
        self.assertEqual(allowed.status_code, 200, allowed.text)
        self.assertEqual(allowed.headers["cache-control"], "no-store")
        self.assertEqual(allowed.json()["query"], "独立游戏")
        self.assertEqual(allowed.json()["requestId"], "a1b2c3d4")
        self.assertFalse(defaults.json()["zhihu"])
        self.assertFalse(defaults.json()["weibo"])
        self.assertTrue(enabled.json()["preferences"]["zhihu"])
        self.assertFalse(account.json()["connected"])
        self.assertTrue(account.json()["useAuthenticated"])
        self.assertNotIn("cookie", " ".join(account.json().keys()).lower())

    def test_provider_diagnostics_include_stage_but_never_search_content(self) -> None:
        query = "private-query-that-must-not-be-logged"
        provider_result = topic_search.ProviderResult(
            [],
            "error",
            diagnostic_stage="http_response",
            http_status=403,
        )
        with (
            patch.object(topic_search, "_search_provider", new=AsyncMock(return_value=provider_result)),
            patch.object(topic_search.logger, "info") as log_info,
        ):
            result = asyncio.run(topic_search.search_topics(query, ["zhihu"], "all", None))

        self.assertRegex(result["requestId"], r"^[a-f0-9]{8}$")
        rendered_log_args = " ".join(
            str(value)
            for call in log_info.call_args_list
            for value in (*call.args, *call.kwargs.values())
        )
        self.assertIn(result["requestId"], rendered_log_args)
        self.assertIn("http_response", rendered_log_args)
        self.assertIn("403", rendered_log_args)
        self.assertNotIn(query, rendered_log_args)
        log_path = storage.DATA_DIR / "logs" / "topic-search.log"
        self.assertTrue(log_path.is_file())
        persisted_log = log_path.read_text(encoding="utf-8")
        self.assertIn(f"request_id={result['requestId']}", persisted_log)
        self.assertIn("provider=zhihu", persisted_log)
        self.assertIn("http_status=403", persisted_log)
        self.assertNotIn(query, persisted_log)

    def test_error_code_is_sanitized_and_browser_initialization_is_serialized(self) -> None:
        error = RuntimeError("Page.goto: net::ERR_NETWORK_ACCESS_DENIED at https://example.test/?q=private")
        self.assertEqual(topic_search._safe_error_code(error), "ERR_NETWORK_ACCESS_DENIED")
        self.assertNotIn("private", topic_search._safe_error_code(error))

        class FakeBrowser:
            def is_connected(self) -> bool:
                return True

        browser = FakeBrowser()
        launch = AsyncMock(return_value=browser)
        playwright = SimpleNamespace(chromium=SimpleNamespace(launch=launch))
        start = AsyncMock(return_value=playwright)
        factory = MagicMock(return_value=SimpleNamespace(start=start))
        manager = topic_search.TopicSearchBrowser()
        with patch.object(topic_search, "async_playwright", factory):
            async def resolve_browsers():
                return await asyncio.gather(*(manager._ensure_browser() for _ in range(3)))

            results = asyncio.run(resolve_browsers())

        self.assertTrue(all(result is browser for result in results))
        start.assert_awaited_once()
        launch.assert_awaited_once_with(channel="msedge", headless=True)

    def test_cursor_rejects_other_query_and_retains_seen_keys(self) -> None:
        digest = topic_search._query_hash("python", ["local", "tieba"], "7d")
        cursor = topic_search._SearchCursor(digest, {"local": 0, "tieba": 2, "weibo": 0}, 20, ["url:https://example.test/a"])
        encoded = topic_search._encode_cursor(cursor)
        decoded = topic_search._decode_cursor(encoded, digest)
        self.assertEqual(decoded.pages["tieba"], 2)
        self.assertEqual(decoded.pages["local"], 0)
        self.assertEqual(decoded.pages["weibo"], 0)
        self.assertEqual(decoded.local_offset, 20)
        self.assertEqual(decoded.seen_keys, ["url:https://example.test/a"])
        with self.assertRaises(ValueError):
            topic_search._decode_cursor(encoded, "different-query-hash")

    def test_public_result_time_labels_are_normalized(self) -> None:
        absolute = topic_search._normalize_page_time("2026-10-28 13:45")
        relative = topic_search._normalize_page_time("5 分钟前")
        self.assertEqual(absolute, "2026-10-28T05:45:00Z")
        self.assertIsNotNone(topic_search._published_datetime(relative))
        self.assertIsNone(topic_search._normalize_page_time("未知时间"))

    def test_load_more_advances_tieba_and_does_not_repeat_exhausted_providers(self) -> None:
        calls: list[tuple[str, int]] = []

        async def page_result(provider: str, _query: str, page: int) -> topic_search.ProviderResult:
            calls.append((provider, page))
            if provider == "tieba" and page == 1:
                items = [{
                    "providerId": f"tieba-{index}",
                    "title": f"话题结果 {index}",
                    "author": None,
                    "publishedAt": f"2026-10-29T09:{index:02d}:00Z",
                    "content": "摘要",
                    "imageUrl": None,
                    "url": f"https://tieba.baidu.com/p/{index + 1}",
                } for index in range(20)]
                return topic_search.ProviderResult(items, "success", has_more=True)
            return topic_search.ProviderResult([], "empty", "没有更多结果。")

        with patch("services.news.topic_search._anonymous_search", new=AsyncMock(side_effect=page_result)):
            first_page = asyncio.run(topic_search.search_topics("topic", ["tieba", "weibo"], "all", None))
            self.assertIsNotNone(first_page["nextCursor"])
            calls.clear()
            second_page = asyncio.run(topic_search.search_topics(
                "topic", ["tieba", "weibo"], "all", first_page["nextCursor"],
            ))

        self.assertEqual(calls, [("tieba", 2)])
        self.assertIsNone(second_page["nextCursor"])


if __name__ == "__main__":
    unittest.main()
