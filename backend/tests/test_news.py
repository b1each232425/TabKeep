"""资讯订阅采集与 API 的回归测试。"""

import asyncio
import base64
import sqlite3
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from main import app
from services import storage
from services.news import collector, db, images, tieba, web_sessions, xiaoheihe
from services.news.tieba import parse_forum_name
from tests.helpers import IsolatedBackendState

RealAsyncClient = httpx.AsyncClient

RSS_FEED = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>社区热门</title>
    <link>https://example.test/</link>
    <description>测试订阅源</description>
    <item>
      <guid isPermaLink="false">post-001</guid>
      <title><![CDATA[今天的热门帖子]]></title>
      <link>https://example.test/posts/1</link>
      <description><![CDATA[<p>这是 feed 返回的<strong>摘要</strong>。</p>]]></description>
      <dc:creator>测试作者</dc:creator>
      <pubDate>Tue, 13 Oct 2026 09:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>""".encode("utf-8")

ATOM_FEED = """<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom 示例</title>
  <entry>
    <id>urn:entry:atom-1</id>
    <title>Atom 条目</title>
    <link href="/atom/1" />
    <summary type="html">&lt;p&gt;Atom 内容&lt;/p&gt;</summary>
    <updated>2026-10-13T10:30:00Z</updated>
  </entry>
</feed>""".encode("utf-8")

ATOM_IMAGE_FEED = """<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>图文示例</title>
  <link href="https://example.test/blog" />
  <logo>https://images.example.test/source.png</logo>
  <entry>
    <id>urn:entry:image-1</id>
    <title>带图条目</title>
    <link href="https://example.test/blog/image-1" />
    <content type="html">&lt;p&gt;图片摘要&lt;/p&gt;&lt;img src=&quot;https://images.example.test/article.png&quot; alt=&quot;配图&quot; /&gt;</content>
    <updated>2026-10-13T10:30:00Z</updated>
  </entry>
</feed>""".encode("utf-8")

PNG_IMAGE = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII="
)


class NewsTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = IsolatedBackendState(f"news-test-{self._testMethodName}")
        self.workspace.setup()
        db.init_db()
        collector.clear_source_locks()
        web_sessions.clear_sessions()

    def tearDown(self) -> None:
        collector.clear_source_locks()
        web_sessions.clear_sessions()
        self.workspace.teardown()

    def create_source(self, url: str = "https://example.test/feed") -> str:
        source_id = f"source-{self._testMethodName}"
        db.create_source(source_id, url, "测试来源", "2026-10-13T00:00:00Z")
        return source_id

    def patch_transport(
        self,
        handler: Callable[[httpx.Request], httpx.Response],
    ) -> Any:
        def create_client(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
            return RealAsyncClient(
                *args,
                transport=httpx.MockTransport(handler),
                **kwargs,
            )

        return patch("services.news.collector.httpx.AsyncClient", side_effect=create_client)

    def test_rss_items_are_saved_as_plain_text_and_deduplicated(self) -> None:
        source_id = self.create_source()

        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.url.path, "/feed")
            return httpx.Response(200, headers={"etag": '"v1"'}, content=RSS_FEED)

        with self.patch_transport(handler):
            first = asyncio.run(collector.refresh_source(source_id))
            second = asyncio.run(collector.refresh_source(source_id))

        rows, total = db.list_items(None, 10, 0)
        source = db.get_source(source_id)
        self.assertEqual(first["newItems"], 1)
        self.assertEqual(second["newItems"], 0)
        self.assertEqual(total, 1)
        self.assertEqual(source["title"], "社区热门")
        self.assertEqual(source["feed_url"], "https://example.test/feed")
        self.assertEqual(rows[0]["title"], "今天的热门帖子")
        self.assertEqual(rows[0]["content"], "这是 feed 返回的摘要。")
        self.assertEqual(rows[0]["author"], "测试作者")
        self.assertNotIn("<p>", str(rows[0]["content"]))

    def test_atom_feed_and_relative_link_are_normalized(self) -> None:
        source_id = self.create_source()

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=ATOM_FEED)

        with self.patch_transport(handler):
            result = asyncio.run(collector.refresh_source(source_id))

        rows, total = db.list_items(None, 10, 0)
        self.assertIsNone(result["error"])
        self.assertEqual(total, 1)
        self.assertEqual(rows[0]["url"], "https://example.test/atom/1")
        self.assertEqual(rows[0]["content"], "Atom 内容")

    def test_html_page_discovers_and_caches_declared_feed(self) -> None:
        source_id = self.create_source("https://example.test/blog")
        requests: list[tuple[str, str | None]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append((request.url.path, request.headers.get("if-none-match")))
            if request.url.path == "/blog":
                return httpx.Response(
                    200,
                    headers={"content-type": "text/html; charset=utf-8"},
                    content=(
                        '<html><head><link rel="alternate" '
                        'type="application/rss+xml" href="/feeds/main.xml"></head></html>'
                    ).encode("utf-8"),
                )
            if request.url.path == "/feeds/main.xml":
                if request.headers.get("if-none-match") == '"feed-v1"':
                    return httpx.Response(304, headers={"etag": '"feed-v1"'})
                return httpx.Response(200, headers={"etag": '"feed-v1"'}, content=RSS_FEED)
            self.fail(f"unexpected request: {request.url}")
            return httpx.Response(500)

        with self.patch_transport(handler):
            first = asyncio.run(collector.refresh_source(source_id))
            second = asyncio.run(collector.refresh_source(source_id))

        source = db.get_source(source_id)
        self.assertEqual(first["newItems"], 1)
        self.assertTrue(second["notModified"], second)
        self.assertEqual(
            requests,
            [("/blog", None), ("/feeds/main.xml", None), ("/feeds/main.xml", '"feed-v1"')],
        )
        self.assertEqual(source["url"], "https://example.test/blog")
        self.assertEqual(source["feed_url"], "https://example.test/feeds/main.xml")

    def test_html_page_without_feed_reports_discovery_guidance(self) -> None:
        source_id = self.create_source("https://example.test/blog")

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                headers={"content-type": "text/html"},
                content=b"<html><head><title>Example</title></head></html>",
            )

        with self.patch_transport(handler):
            result = asyncio.run(collector.refresh_source(source_id))

        self.assertIn("未声明 RSS/Atom", result["error"] or "")
        self.assertIn("RSSHub", result["error"] or "")

    def test_entry_images_are_extracted_and_normalized(self) -> None:
        entries = collector._normalize_entries(
            [
                {
                    "title": "相对地址图片",
                    "content": [{"value": '<p>摘要</p><img data-src="../images/post.webp" src="data:image/gif;base64,AA==">'}],
                }
            ],
            "https://example.test/feed/main.xml",
        )

        self.assertEqual(entries[0]["image_url"], "https://example.test/images/post.webp")
        media_entries = collector._normalize_entries(
            [{"title": "媒体缩略图", "link": "https://example.test/post", "media_thumbnail": [{"url": "../images/thumb.jpg"}]}],
            "https://example.test/feed/main.xml",
        )
        self.assertEqual(media_entries[0]["image_url"], "https://example.test/images/thumb.jpg")
        self.assertIsNone(
            collector._normalize_entries(
                [{"title": "不安全图片", "content": [{"value": '<img src="javascript:alert(1)">'}]}],
                "https://example.test/feed",
            )[0]["image_url"]
        )

        thread = SimpleNamespace(
            tid=321,
            title="贴吧图文帖",
            contents=SimpleNamespace(
                text="正文",
                imgs=[SimpleNamespace(src="http://img.example.test/small.jpg", big_src="https://img.example.test/big.jpg")],
            ),
        )
        tieba_entry = tieba._normalize_threads([thread], {})[0]
        self.assertEqual(tieba_entry["image_url"], "https://img.example.test/big.jpg")

    def test_article_images_are_cached_and_served_through_news_api(self) -> None:
        source_id = self.create_source()

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/feed":
                return httpx.Response(200, content=ATOM_IMAGE_FEED)
            if request.url.host == "images.example.test" and request.url.path in {"/source.png", "/article.png"}:
                return httpx.Response(200, headers={"content-type": "image/png"}, content=PNG_IMAGE)
            self.fail(f"unexpected request: {request.url}")
            return httpx.Response(500)

        with patch("services.news.images._resolve_public_addresses", return_value=True), self.patch_transport(handler):
            result = asyncio.run(collector.refresh_source(source_id))

        source = db.get_source(source_id)
        rows, total = db.list_items(source_id, 10, 0)
        self.assertIsNone(result["error"])
        self.assertEqual(total, 1)
        self.assertTrue(source["icon_asset"])
        self.assertTrue(rows[0]["image_asset"])
        self.assertEqual(images.asset_file(str(source["icon_asset"])).read_bytes(), PNG_IMAGE)
        self.assertEqual(images.asset_file(str(rows[0]["image_asset"])).read_bytes(), PNG_IMAGE)

        storage._state["apiToken"] = "news-image-test-token"
        with TestClient(app) as client:
            headers = {"X-TabKeep-Token": "news-image-test-token"}
            source_response = client.get("/news/sources", headers=headers)
            item_response = client.get(f"/news/items?sourceId={source_id}", headers=headers)
            source_icon_url = source_response.json()["items"][0]["iconUrl"]
            item = item_response.json()["items"][0]
            self.assertTrue(source_icon_url.startswith("/news/assets/"))
            self.assertTrue(item["imageUrl"].startswith("/news/assets/"))
            self.assertEqual(item["sourceIconUrl"], source_icon_url)
            self.assertEqual(client.get(item["imageUrl"]).status_code, 401)
            cached_image = client.get(item["imageUrl"], headers=headers)
            self.assertEqual(cached_image.status_code, 200)
            self.assertEqual(cached_image.headers["content-type"], "image/png")
            self.assertEqual(cached_image.content, PNG_IMAGE)
            self.assertEqual(
                client.get("/news/assets/not-a-cache-file.png", headers=headers).status_code,
                404,
            )

    def test_image_cache_does_not_follow_redirects_to_private_hosts(self) -> None:
        requests: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(str(request.url))
            return httpx.Response(302, headers={"location": "http://127.0.0.1/private.png"})

        async def cache_redirect() -> str | None:
            async with RealAsyncClient(transport=httpx.MockTransport(handler)) as client:
                return await images.cache_image(client, "https://images.example.test/redirect.png")

        with patch(
            "services.news.images._resolve_public_addresses",
            side_effect=lambda host, _port: host != "127.0.0.1",
        ):
            cached = asyncio.run(cache_redirect())

        self.assertIsNone(cached)
        self.assertEqual(len(requests), 1)

    def test_non_http_entry_link_is_not_saved_as_openable_url(self) -> None:
        entries = collector._normalize_entries(
            [{"title": "不安全链接", "link": "javascript:alert(1)"}],
            "https://example.test/feed",
        )
        self.assertIsNone(entries[0]["url"])

    def test_feed_html_is_plain_text_without_script_contents(self) -> None:
        self.assertEqual(
            collector._plain_text("<p>摘要</p><script>alert('x')</script><p>正文</p>"),
            "摘要\n\n正文",
        )

    def test_old_sources_are_migrated_and_existing_tieba_urls_are_detected(self) -> None:
        path = db.get_db_path()
        connection = sqlite3.connect(path)
        try:
            with connection:
                connection.execute("DROP TABLE news_items")
                connection.execute("DROP TABLE news_sources")
                connection.execute(
                    """
                    CREATE TABLE news_sources (
                        id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
                        is_active INTEGER NOT NULL DEFAULT 1, etag TEXT, last_modified TEXT,
                        created_at TEXT NOT NULL, last_checked_at TEXT, last_success_at TEXT,
                        last_error TEXT
                    )
                    """
                )
                connection.execute(
                    "INSERT INTO news_sources (id, url, title, created_at) VALUES (?, ?, ?, ?)",
                    (
                        "legacy-tieba",
                        "https://tieba.baidu.com/f?kw=%E6%8A%97%E5%8E%8B%E8%83%8C%E9%94%85",
                        "tieba.baidu.com",
                        "2026-10-13T00:00:00Z",
                    ),
                )
                connection.execute(
                    "INSERT INTO news_sources (id, url, title, created_at) VALUES (?, ?, ?, ?)",
                    ("legacy-rss", "https://example.test/feed", "example.test", "2026-10-13T00:00:00Z"),
                )
                connection.execute(
                    """INSERT INTO news_sources (id, url, title, is_active, created_at)
                    VALUES (?, ?, ?, 0, ?)""",
                    (
                        "legacy-disabled",
                        "https://disabled.example.test/feed",
                        "disabled.example.test",
                        "2026-10-13T00:00:00Z",
                    ),
                )
        finally:
            connection.close()

        db.init_db()

        self.assertEqual(db.get_source("legacy-tieba")["source_type"], "tieba")
        self.assertEqual(db.get_source("legacy-tieba")["title"], "抗压背锅")
        self.assertEqual(db.get_source("legacy-rss")["source_type"], "rss")
        self.assertIsNone(db.get_source("legacy-rss")["feed_url"])
        self.assertTrue(db.get_source("legacy-disabled")["is_deleted"])
        self.assertNotIn("legacy-disabled", {row["id"] for row in db.list_sources()})
        connection = sqlite3.connect(path)
        try:
            source_columns = {row[1] for row in connection.execute("PRAGMA table_info(news_sources)")}
            item_columns = {row[1] for row in connection.execute("PRAGMA table_info(news_items)")}
        finally:
            connection.close()
        self.assertIn("icon_asset", source_columns)
        self.assertIn("image_asset", item_columns)

    def test_tieba_forum_url_is_decoded_and_invalid_forum_url_is_rejected(self) -> None:
        self.assertEqual(
            parse_forum_name("https://tieba.baidu.com/f?kw=%E6%8A%97%E5%8E%8B%E8%83%8C%E9%94%85"),
            "抗压背锅",
        )
        self.assertIsNone(parse_forum_name("https://example.test/feed"))
        with self.assertRaisesRegex(ValueError, "缺少 kw"):
            parse_forum_name("https://tieba.baidu.com/f")
        with self.assertRaisesRegex(ValueError, "贴吧主页地址"):
            parse_forum_name("https://tieba.baidu.com/p/123")

    def test_tieba_api_collects_first_page_and_deduplicates_by_thread_id(self) -> None:
        thread = SimpleNamespace(
            tid=123456,
            title="贴吧测试主题",
            contents=SimpleNamespace(text="列表摘要"),
            user=SimpleNamespace(show_name="贴吧作者"),
            create_time=1790000000,
        )

        class FakeTiebaClient:
            async def __aenter__(self) -> "FakeTiebaClient":
                return self

            async def __aexit__(self, *_args: object) -> None:
                return None

            async def get_threads(self, forum_name: str, **kwargs: Any) -> Any:
                self_forum.assertEqual(forum_name, "抗压背锅")
                self_forum.assertEqual(kwargs["rn"], 10)
                self_forum.assertEqual(kwargs["sort"], "hot")
                return SimpleNamespace(err=None, objs=[thread])

            async def get_posts(self, thread_id: int, **kwargs: Any) -> Any:
                self_forum.assertEqual(thread_id, 123456)
                self_forum.assertEqual(kwargs["rn"], 10)
                return SimpleNamespace(
                    err=None,
                    objs=[
                        SimpleNamespace(contents=SimpleNamespace(text="首楼正文")),
                        SimpleNamespace(contents=SimpleNamespace(text="首屏回复")),
                    ],
                )

        self_forum = self
        fake_aiotieba = SimpleNamespace(
            Client=FakeTiebaClient,
            ThreadSortType=SimpleNamespace(HOT="hot"),
        )
        source_id = "tieba-source"
        db.create_source(
            source_id,
            "https://tieba.baidu.com/f?kw=%E6%8A%97%E5%8E%8B%E8%83%8C%E9%94%85",
            "抗压背锅",
            "2026-10-13T00:00:00Z",
            "tieba",
        )

        with (
            patch.dict(sys.modules, {"aiotieba": fake_aiotieba}),
            patch("services.news.collector._cache_source_icon", new_callable=AsyncMock),
        ):
            first = asyncio.run(collector.refresh_source(source_id))
            second = asyncio.run(collector.refresh_source(source_id))

        rows, total = db.list_items(source_id, 10, 0)
        self.assertEqual(first["newItems"], 1)
        self.assertEqual(second["newItems"], 0)
        self.assertEqual(total, 1)
        self.assertEqual(rows[0]["dedupe_key"], "tieba:tid:123456")
        self.assertEqual(rows[0]["url"], "https://tieba.baidu.com/p/123456")
        self.assertIn("首楼正文", str(rows[0]["content"]))
        self.assertIn("首屏回复", str(rows[0]["content"]))
        self.assertEqual(rows[0]["author"], "贴吧作者")

    def test_tieba_failure_keeps_previous_items(self) -> None:
        source_id = "tieba-failure-source"
        db.create_source(
            source_id,
            "https://tieba.baidu.com/f?kw=test",
            "test",
            "2026-10-13T00:00:00Z",
            "tieba",
        )
        db.complete_fetch(
            source_id,
            None,
            None,
            None,
            "2026-10-13T01:00:00Z",
            [
                {
                    "id": "old-tieba-item",
                    "dedupe_key": "tieba:tid:old",
                    "title": "之前采集的帖子",
                    "url": None,
                    "content": "要保留",
                    "author": None,
                    "published_at": None,
                }
            ],
        )

        async def fail_fetch(_forum_name: str) -> list[dict[str, Any]]:
            raise RuntimeError("贴吧接口暂时无法读取帖子列表")

        with patch("services.news.tieba.fetch_forum_with_timeout", side_effect=fail_fetch):
            result = asyncio.run(collector.refresh_source(source_id))

        rows, total = db.list_items(source_id, 10, 0)
        self.assertEqual(total, 1)
        self.assertEqual(rows[0]["title"], "之前采集的帖子")
        self.assertIn("无法读取", result["error"] or "")
        self.assertEqual(db.get_source(source_id)["last_error"], result["error"])

    def test_api_detects_tieba_source_and_exposes_source_type(self) -> None:
        thread = SimpleNamespace(
            tid=654321,
            title="API 贴吧主题",
            contents=SimpleNamespace(text="主题正文"),
            user=SimpleNamespace(show_name="作者"),
            create_time=1790000000,
        )

        class FakeTiebaClient:
            async def __aenter__(self) -> "FakeTiebaClient":
                return self

            async def __aexit__(self, *_args: object) -> None:
                return None

            async def get_threads(self, _forum_name: str, **_kwargs: Any) -> Any:
                return SimpleNamespace(err=None, objs=[thread])

            async def get_posts(self, _thread_id: int, **_kwargs: Any) -> Any:
                return SimpleNamespace(err=None, objs=[])

        storage._state["apiToken"] = "tieba-api-test-token"
        fake_aiotieba = SimpleNamespace(
            Client=FakeTiebaClient,
            ThreadSortType=SimpleNamespace(HOT="hot"),
        )
        with (
            patch.dict(sys.modules, {"aiotieba": fake_aiotieba}),
            patch("services.news.collector._cache_source_icon", new_callable=AsyncMock),
            TestClient(app) as client,
        ):
            added = client.post(
                "/news/sources",
                headers={"X-TabKeep-Token": "tieba-api-test-token"},
                json={"url": "https://tieba.baidu.com/f?kw=%E6%8A%97%E5%8E%8B%E8%83%8C%E9%94%85"},
            )
            self.assertEqual(added.status_code, 201, added.text)
            source_id = added.json()["source"]["id"]
            refreshed = client.post(
                f"/news/sources/{source_id}/refresh",
                headers={"X-TabKeep-Token": "tieba-api-test-token"},
            )

        self.assertEqual(added.json()["source"]["sourceType"], "tieba")
        self.assertEqual(added.json()["source"]["title"], "抗压背锅")
        self.assertEqual(added.json()["newItems"], 1)
        self.assertEqual(refreshed.status_code, 200, refreshed.text)
        self.assertEqual(refreshed.json()["newItems"], 0)

    def test_conditional_request_handles_304_without_duplicate_items(self) -> None:
        source_id = self.create_source()
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if calls == 1:
                return httpx.Response(200, headers={"etag": '"v2"'}, content=RSS_FEED)
            self.assertEqual(request.headers.get("if-none-match"), '"v2"')
            return httpx.Response(304, headers={"etag": '"v2"'})

        with self.patch_transport(handler):
            first = asyncio.run(collector.refresh_source(source_id))
            second = asyncio.run(collector.refresh_source(source_id))

        _, total = db.list_items(None, 10, 0)
        self.assertEqual(first["newItems"], 1)
        self.assertTrue(second["notModified"], second)
        self.assertEqual(total, 1)
        self.assertIsNone(db.get_source(source_id)["last_error"])

    def test_invalid_feed_records_error_without_deleting_history(self) -> None:
        source_id = self.create_source()
        db.complete_fetch(source_id, None, None, None, "2026-10-13T01:00:00Z", [
            {
                "id": "existing-item",
                "dedupe_key": "guid:existing",
                "title": "旧条目",
                "url": None,
                "content": "保留",
                "author": None,
                "published_at": None,
            }
        ])

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "text/html"}, content=b"<html>not a feed</html>")

        with self.patch_transport(handler):
            result = asyncio.run(collector.refresh_source(source_id))

        _, total = db.list_items(None, 10, 0)
        self.assertEqual(total, 1)
        self.assertIn("未声明 RSS/Atom", result["error"] or "")
        self.assertEqual(db.get_source(source_id)["last_error"], result["error"])

    def test_api_adds_webpage_url_and_uses_discovered_feed(self) -> None:
        storage._state["apiToken"] = "news-discovery-test-token"
        page_url = "https://example.test/blog"
        feed_url = "https://example.test/feeds/main.xml"

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url == httpx.URL(page_url):
                return httpx.Response(
                    200,
                    headers={"content-type": "text/html"},
                    content=(
                        '<link rel="alternate" type="application/atom+xml" '
                        'href="/feeds/main.xml">'
                    ).encode("utf-8"),
                )
            if request.url == httpx.URL(feed_url):
                return httpx.Response(200, content=ATOM_FEED)
            self.fail(f"unexpected request: {request.url}")
            return httpx.Response(500)

        with self.patch_transport(handler), TestClient(app) as client:
            added = client.post(
                "/news/sources",
                headers={"X-TabKeep-Token": "news-discovery-test-token"},
                json={"url": page_url},
            )

        self.assertEqual(added.status_code, 201, added.text)
        self.assertEqual(added.json()["source"]["url"], page_url)
        self.assertEqual(added.json()["source"]["title"], "Atom 示例")
        self.assertEqual(added.json()["newItems"], 1)
        self.assertEqual(db.get_source(added.json()["source"]["id"])["feed_url"], feed_url)

    def test_api_accepts_weibo_rsshub_route_as_generic_rss(self) -> None:
        storage._state["apiToken"] = "weibo-rsshub-test-token"
        route_url = "https://rsshub.example.test/weibo/user/1234567890"

        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.url, httpx.URL(route_url))
            return httpx.Response(200, content=RSS_FEED)

        with (
            self.patch_transport(handler),
            patch("services.news.collector._cache_source_icon", new_callable=AsyncMock),
            TestClient(app) as client,
        ):
            added = client.post(
                "/news/sources",
                headers={"X-TabKeep-Token": "weibo-rsshub-test-token"},
                json={"url": route_url},
            )

        self.assertEqual(added.status_code, 201, added.text)
        source = added.json()["source"]
        self.assertEqual(source["url"], route_url)
        self.assertEqual(source["sourceType"], "rss")
        self.assertEqual(source["title"], "社区热门")
        self.assertEqual(added.json()["newItems"], 1)
        rows, total = db.list_items(source["id"], 10, 0)
        self.assertEqual(total, 1)
        self.assertEqual(rows[0]["title"], "今天的热门帖子")
        self.assertEqual(rows[0]["url"], "https://example.test/posts/1")

    def test_xiaoheihe_url_uses_native_adapter_and_saves_feed_items(self) -> None:
        storage._state["apiToken"] = "xiaoheihe-test-token"
        requests: list[tuple[str, str | None]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            params = request.url.params
            requests.append((request.url.path, params.get("link_id")))
            self.assertTrue(params.get("hkey"))
            self.assertTrue(params.get("_time"))
            self.assertTrue(params.get("nonce"))
            self.assertEqual(request.headers.get("origin"), "https://www.xiaoheihe.cn")
            if request.url.path == xiaoheihe.NEWS_LIST_PATH:
                return httpx.Response(
                    200,
                    json={
                        "result": {
                            "links": [
                                {
                                    "linkid": "article-001",
                                    "title": "游戏新闻标题",
                                    "description": "<p>列表摘要</p>",
                                    "modify_at": 1792000000,
                                    "share_url": "https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?link_id=share-001",
                                    "imgs": ["https://images.example.test/post.jpg"],
                                    "user": {"show_name": "测试作者"},
                                }
                            ]
                        }
                    },
                )
            self.fail(f"unexpected request: {request.url}")
            return httpx.Response(500)

        with (
            self.patch_transport(handler),
            patch("services.news.collector._cache_source_icon", new_callable=AsyncMock),
            patch("services.news.images.cache_image", new_callable=AsyncMock, return_value="cached-post.jpg"),
            TestClient(app) as client,
        ):
            added = client.post(
                "/news/sources",
                headers={"X-TabKeep-Token": "xiaoheihe-test-token"},
                json={"url": "https://www.xiaoheihe.cn/"},
            )
            source_id = added.json()["source"]["id"]
            duplicate = client.post(
                "/news/sources",
                headers={"X-TabKeep-Token": "xiaoheihe-test-token"},
                json={"url": "https://xiaoheihe.cn"},
            )
            refreshed = client.post(
                f"/news/sources/{source_id}/refresh",
                headers={"X-TabKeep-Token": "xiaoheihe-test-token"},
            )

        self.assertEqual(added.status_code, 201, added.text)
        self.assertEqual(added.json()["source"]["sourceType"], "xiaoheihe")
        self.assertEqual(added.json()["source"]["title"], "小黑盒游戏新闻")
        self.assertEqual(added.json()["source"]["url"], xiaoheihe.HOMEPAGE_URL)
        self.assertEqual(duplicate.status_code, 409)
        self.assertEqual(added.json()["newItems"], 1)
        self.assertEqual(refreshed.status_code, 200, refreshed.text)
        self.assertEqual(refreshed.json()["newItems"], 0)
        self.assertEqual(
            requests,
            [
                (xiaoheihe.NEWS_LIST_PATH, None),
                (xiaoheihe.NEWS_LIST_PATH, None),
            ],
        )
        rows, total = db.list_items(source_id, 10, 0)
        self.assertEqual(total, 1)
        self.assertEqual(rows[0]["dedupe_key"], "xiaoheihe:link:article-001")
        self.assertEqual(rows[0]["title"], "游戏新闻标题")
        self.assertEqual(rows[0]["content"], "列表摘要")
        self.assertEqual(rows[0]["author"], "测试作者")
        self.assertEqual(rows[0]["url"], "https://www.xiaoheihe.cn/app/bbs/link/share-001")
        self.assertEqual(rows[0]["image_url"], "https://images.example.test/post.jpg")
        self.assertEqual(rows[0]["image_asset"], "cached-post.jpg")

    def test_xiaoheihe_signer_is_deterministic_and_preserves_query(self) -> None:
        signed = xiaoheihe.build_signed_url(
            "https://api.xiaoheihe.cn/bbs/app/feeds/news?offset=0&limit=20",
            1_700_000_000,
            "AB12CD34",
        )
        params = httpx.URL(signed).params

        self.assertEqual(params.get("offset"), "0")
        self.assertEqual(params.get("limit"), "20")
        self.assertEqual(params.get("_time"), "1700000000")
        self.assertEqual(params.get("nonce"), "AB12CD34")
        self.assertEqual(params.get("hkey"), "XNMJP66")
        self.assertTrue(xiaoheihe.is_xiaoheihe_url("https://www.xiaoheihe.cn/"))
        self.assertFalse(xiaoheihe.is_xiaoheihe_url("https://www.xiaoheihe.cn/app/bbs/link/post-1"))

    def test_api_requires_token_and_deleting_source_keeps_history(self) -> None:
        storage._state["apiToken"] = "news-test-token"

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=RSS_FEED)

        with self.patch_transport(handler), TestClient(app) as client:
            self.assertEqual(client.get("/news/sources").status_code, 401)
            headers = {"X-TabKeep-Token": "news-test-token"}
            invalid = client.post(
                "/news/sources",
                headers=headers,
                json={"url": "ftp://example.test/feed"},
            )
            self.assertEqual(invalid.status_code, 422)
            invalid_tieba = client.post(
                "/news/sources",
                headers=headers,
                json={"url": "https://tieba.baidu.com/p/123"},
            )
            self.assertEqual(invalid_tieba.status_code, 422)
            added = client.post(
                "/news/sources",
                headers=headers,
                json={"url": "https://example.test/feed"},
            )
            self.assertEqual(added.status_code, 201, added.text)
            source_id = added.json()["source"]["id"]
            duplicate = client.post(
                "/news/sources",
                headers=headers,
                json={"url": "https://example.test/feed"},
            )
            self.assertEqual(duplicate.status_code, 409)
            refreshed = client.post("/news/refresh", headers=headers)
            filtered_history = client.get(
                f"/news/items?sourceId={source_id}",
                headers=headers,
            )
            removed = client.delete(f"/news/sources/{source_id}", headers=headers)
            sources_after_delete = client.get("/news/sources", headers=headers)
            history_after_delete = client.get("/news/items", headers=headers)
            refresh_deleted = client.post(
                f"/news/sources/{source_id}/refresh",
                headers=headers,
            )
            restored = client.post(
                "/news/sources",
                headers=headers,
                json={"url": "https://example.test/feed"},
            )
            history = client.get("/news/items", headers=headers)
            sources = client.get("/news/sources", headers=headers)

        self.assertEqual(removed.status_code, 200)
        self.assertEqual(removed.json(), {"ok": True})
        self.assertEqual(sources_after_delete.json()["items"], [])
        self.assertEqual(sources_after_delete.json()["totalItemCount"], 1)
        self.assertEqual(history_after_delete.json()["total"], 1)
        self.assertEqual(refresh_deleted.status_code, 404)
        self.assertEqual(restored.status_code, 201, restored.text)
        self.assertEqual(refreshed.status_code, 200, refreshed.text)
        self.assertEqual(filtered_history.json()["total"], 1)
        self.assertEqual(restored.json()["source"]["id"], source_id)
        self.assertTrue(sources.json()["items"][0]["isActive"])
        self.assertEqual(history.json()["total"], 1)

    def test_browser_session_ticket_is_one_time_and_cookie_is_limited_to_news(self) -> None:
        storage._state["apiToken"] = "news-session-test-token"
        headers = {"X-TabKeep-Token": "news-session-test-token"}

        with TestClient(app) as client:
            self.assertEqual(client.post("/news/browser-session").status_code, 401)
            issued = client.post("/news/browser-session", headers=headers)
            self.assertEqual(issued.status_code, 200, issued.text)
            ticket = issued.json()["ticket"]

            exchanged = client.post(
                "/news/browser-session/exchange",
                headers={"Origin": "http://testserver"},
                json={"ticket": ticket},
            )
            self.assertEqual(exchanged.status_code, 200, exchanged.text)
            self.assertIn("httponly", exchanged.headers["set-cookie"].lower())
            self.assertIn("samesite=strict", exchanged.headers["set-cookie"].lower())
            self.assertEqual(client.get("/news/sources").status_code, 200)
            self.assertEqual(
                client.get(
                    "/tabs",
                    headers={"Cookie": "tabkeep_news_session=" + client.cookies.get("tabkeep_news_session", "")},
                ).status_code,
                401,
            )

            replay = client.post(
                "/news/browser-session/exchange",
                headers={"Origin": "http://testserver"},
                json={"ticket": ticket},
            )

        self.assertEqual(replay.status_code, 401)

    def test_browser_session_rejects_expired_ticket_and_untrusted_origin(self) -> None:
        storage._state["apiToken"] = "news-session-test-token"
        headers = {"X-TabKeep-Token": "news-session-test-token"}

        with TestClient(app) as client:
            issued = client.post("/news/browser-session", headers=headers)
            self.assertEqual(issued.status_code, 200, issued.text)
            ticket = issued.json()["ticket"]

            rejected_origin = client.post(
                "/news/browser-session/exchange",
                headers={"Origin": "https://attacker.example"},
                json={"ticket": ticket},
            )
            accepted_origin = client.post(
                "/news/browser-session/exchange",
                headers={"Origin": "http://testserver"},
                json={"ticket": ticket},
            )

        self.assertEqual(rejected_origin.status_code, 403)
        self.assertEqual(accepted_origin.status_code, 200, accepted_origin.text)

        with patch("services.news.web_sessions.time.monotonic", return_value=100.0):
            expired_ticket = web_sessions.create_ticket()
        with patch("services.news.web_sessions.time.monotonic", return_value=161.0):
            self.assertIsNone(web_sessions.exchange_ticket(expired_ticket))


if __name__ == "__main__":
    unittest.main()
