"""本地兴趣数据层和浏览器历史导入测试。"""

import asyncio
import json
import os
import sqlite3
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient
from main import app
from services import storage
from services.news import browser_history, db, interest
from tests.helpers import IsolatedBackendState


class NewsInterestTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = IsolatedBackendState(f"news-interest-{self._testMethodName}")
        self.workspace.setup()
        db.init_db()
        storage._state["apiToken"] = "interest-test-token"
        self.headers = {"X-TabKeep-Token": "interest-test-token"}

    def tearDown(self) -> None:
        self.workspace.teardown()

    def test_chinese_tokenizer_keeps_words_instead_of_overlapping_ngrams(self) -> None:
        tokens = interest._tokens("人工智能领域的深度学习模型")

        self.assertIn("人工智能", tokens)
        self.assertIn("深度学习", tokens)
        self.assertNotIn("工智能", tokens)

    def test_browser_history_domain_and_generic_page_titles_are_not_interest_terms(self) -> None:
        self.assertTrue(
            interest._is_non_content_history_title(
                "www.bilibili.com", "https://www.bilibili.com/"
            )
        )
        self.assertTrue(
            interest._is_non_content_history_title(
                "https://www.bilibili.com/video/BV123", "https://www.bilibili.com/"
            )
        )
        self.assertTrue(
            interest._is_non_content_history_title(
                "哔哩哔哩", "https://www.bilibili.com/"
            )
        )
        self.assertTrue(
            interest._is_non_content_history_title(
                "热门视频", "https://www.bilibili.com/v/popular"
            )
        )
        self.assertFalse(
            interest._is_non_content_history_title(
                "Bilibili 上的深度学习课程", "https://www.bilibili.com/video/BV123"
            )
        )
        self.assertEqual(
            interest._clean_history_title(
                "深度学习模型教程 - 哔哩哔哩", "https://www.bilibili.com/video/BV123"
            ),
            "深度学习模型教程",
        )
        self.assertEqual(
            interest._clean_history_title(
                "热门视频 - 哔哩哔哩", "https://www.bilibili.com/v/popular"
            ),
            "",
        )
        self.assertEqual(
            interest._clean_history_title(
                "pixiv - 作品收藏", "https://www.pixiv.net/"
            ),
            "作品收藏",
        )
        self.assertEqual(
            interest._clean_history_title(
                "哔哩哔哩上的深度学习教程", "https://www.bilibili.com/video/BV123"
            ),
            "哔哩哔哩上的深度学习教程",
        )
        site_tokens = interest._history_site_tokens("https://www.bilibili.com/video/BV123")
        self.assertIn("bilibili", site_tokens)
        self.assertIn("哔哩哔哩", site_tokens)
        self.assertIn("哔哩", site_tokens)

    def test_profile_uses_linked_news_title_and_ignores_unmatched_history_noise(self) -> None:
        _source_id, item_id = self.create_item(
            "深度学习模型实践", "https://www.bilibili.com/video/BV-test"
        )
        timestamp = interest._iso(datetime.now(timezone.utc))
        db.insert_interest_events([
            {
                "id": "history-domain-noise",
                "origin": "browser_extension",
                "event_type": "history_visit",
                "occurred_at": timestamp,
                "canonical_url": "https://www.bilibili.com/",
                "title": "www.bilibili.com",
                "dedupe_key": "test:history-domain-noise",
                "created_at": timestamp,
            },
            {
                "id": "history-generic-noise",
                "origin": "browser_history",
                "event_type": "history_visit",
                "occurred_at": timestamp,
                "canonical_url": "https://www.bilibili.com/v/popular",
                "title": "热门视频",
                "dedupe_key": "test:history-generic-noise",
                "created_at": timestamp,
            },
            {
                "id": "history-page-title",
                "origin": "browser_extension",
                "event_type": "history_visit",
                "occurred_at": timestamp,
                "canonical_url": "https://www.bilibili.com/video/BV-another",
                "title": "深度学习模型教程 - 哔哩哔哩",
                "dedupe_key": "test:history-page-title",
                "created_at": timestamp,
            },
            {
                "id": "history-site-brand-in-title",
                "origin": "browser_extension",
                "event_type": "history_visit",
                "occurred_at": timestamp,
                "canonical_url": "https://www.bilibili.com/video/BV-brand",
                "title": "哔哩哔哩上的深度学习教程",
                "dedupe_key": "test:history-site-brand-in-title",
                "created_at": timestamp,
            },
            {
                "id": "history-linked-news",
                "origin": "browser_extension",
                "event_type": "history_visit",
                "occurred_at": timestamp,
                "news_item_id": item_id,
                "canonical_url": "https://www.bilibili.com/video/BV-test",
                "title": "www.bilibili.com",
                "dedupe_key": "test:history-linked-news",
                "created_at": timestamp,
            },
        ])

        profile = interest.rebuild_profile()
        labels = {str(topic["label"]) for topic in profile["topics"]}

        self.assertIn("深度学习", labels)
        self.assertNotIn("bilibili", labels)
        self.assertNotIn("热门", labels)
        self.assertNotIn("哔哩哔哩", labels)
        self.assertNotIn("哔哩", labels)
        self.assertNotIn("pixiv", labels)

    def test_idf_suppresses_generic_terms_and_preserves_specific_terms(self) -> None:
        weights = interest._idf_weights([
            {"开始", "rust", "编程"},
            {"开始", "烘焙", "面包"},
            {"开始", "政策", "新闻"},
            *[{"开始", f"主题{i}"} for i in range(17)],
        ])

        self.assertEqual(weights["开始"], 0.0)
        self.assertGreater(weights["rust"], 0.0)

    def test_generic_profile_term_cannot_match_when_candidate_idf_is_zero(self) -> None:
        contribution = interest._topic_match_strength(
            {"score": 1.0, "keywords": ["开始"]},
            {"开始"},
            set(),
            {"开始": 0.0},
        )

        self.assertEqual(contribution, 0.0)

    def test_body_match_dominates_and_title_alone_cannot_trigger_recommendation(self) -> None:
        topic = {"score": 1.0, "keywords": ["rust"]}
        idf_weights = {"rust": 1.0}

        title_only_score = interest._topic_match_strength(topic, {"rust"}, set(), idf_weights)
        body_score = interest._topic_match_strength(topic, set(), {"rust"}, idf_weights)
        title_and_body_score = interest._topic_match_strength(
            topic, {"rust"}, {"rust"}, idf_weights
        )

        self.assertEqual(title_only_score, 0.0)
        self.assertGreater(body_score, 0.0)
        self.assertGreater(title_and_body_score, body_score)

    def test_recommendation_tokenizes_body_beyond_previous_preview_limit(self) -> None:
        rows = [{
            "id": f"body-limit-{self._testMethodName}",
            "title": "无关标题",
            "content": ("padding " * 300) + "DistinctiveBodyTerm appears here.",
            "source_id": "source-body-limit",
        }]

        tokenized, _documents = interest._tokenize_recommendation_candidates(rows, None)

        self.assertIn("distinctive", tokenized[0][2])

    def create_item(self, title: str, url: str, content: str = "测试摘要") -> tuple[str, str]:
        source_id = f"source-{self._testMethodName}"
        db.create_source(source_id, "https://feed.example.test/rss", "测试订阅", "2026-10-16T00:00:00Z")
        interest.record_subscription_added(source_id)
        db.complete_fetch(
            source_id,
            None,
            None,
            None,
            "2026-10-16T00:00:00Z",
            [
                {
                    "id": f"item-{self._testMethodName}",
                    "dedupe_key": "article-1",
                    "title": title,
                    "url": url,
                    "content": content,
                    "author": None,
                    "published_at": "2026-10-16T00:00:00Z",
                    "image_url": None,
                    "image_asset": None,
                }
            ],
        )
        return source_id, f"item-{self._testMethodName}"

    def create_edge_history(self, root: Path, visited_at: datetime, url: str, title: str) -> str:
        profile_dir = root / "Microsoft" / "Edge" / "User Data" / "Default"
        profile_dir.mkdir(parents=True)
        (profile_dir.parent / "Local State").write_text(
            json.dumps({"profile": {"info_cache": {"Default": {"name": "个人"}}}}),
            encoding="utf-8",
        )
        history_path = profile_dir / "History"
        connection = sqlite3.connect(history_path)
        connection.executescript(
            """
            CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT);
            CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER);
            """
        )
        connection.execute("INSERT INTO urls (id, url, title) VALUES (1, ?, ?)", (url, title))
        chromium_time = int((visited_at.timestamp() + 11_644_473_600) * 1_000_000)
        connection.execute("INSERT INTO visits (id, url, visit_time) VALUES (123, 1, ?)", (chromium_time,))
        connection.commit()
        connection.close()
        return str(root)

    def test_browser_history_import_is_read_only_idempotent_and_matches_news_item(self) -> None:
        source_id, item_id = self.create_item(
            "本地测试标题",
            "https://article.example.test/post/1?utm_source=rss",
        )
        root = Path(self.workspace.tmp_dir) / "browser"
        visited_at = datetime.now(timezone.utc) - timedelta(days=1)
        local_app_data = self.create_edge_history(
            root,
            visited_at,
            "https://article.example.test/post/1?utm_source=browser#section",
            "本地浏览器页面标题",
        )
        before = (Path(local_app_data) / "Microsoft/Edge/User Data/Default/History").stat().st_mtime_ns
        with patch.dict(os.environ, {"LOCALAPPDATA": local_app_data}):
            start = visited_at - timedelta(hours=1)
            end = visited_at + timedelta(hours=1)
            with TestClient(app) as client:
                profile_response = client.get("/news/interests/browser-profiles", headers=self.headers)
                profile = profile_response.json()["items"][0]
                first_start = client.post(
                    "/news/interests/browser-import",
                    headers=self.headers,
                    json={"profileId": profile["id"], "rangeStart": start.isoformat(), "rangeEnd": end.isoformat()},
                )
                first = client.get(
                    f"/news/interests/browser-import/{first_start.json()['batchId']}",
                    headers=self.headers,
                ).json()
                second_start = client.post(
                    "/news/interests/browser-import",
                    headers=self.headers,
                    json={"profileId": profile["id"], "rangeStart": start.isoformat(), "rangeEnd": end.isoformat()},
                )
                second = client.get(
                    f"/news/interests/browser-import/{second_start.json()['batchId']}",
                    headers=self.headers,
                ).json()
        after = (Path(local_app_data) / "Microsoft/Edge/User Data/Default/History").stat().st_mtime_ns

        events = db.list_interest_events("0001-01-01T00:00:00Z", "9999-12-31T23:59:59Z")
        imported = [event for event in events if event["origin"] == "browser_history"]
        self.assertEqual(profile_response.status_code, 200)
        self.assertEqual(first_start.status_code, 200)
        self.assertEqual(first["visitsRead"], 1)
        self.assertEqual(first["eventsAdded"], 1, first)
        self.assertEqual(first["status"], "completed")
        self.assertEqual(second["eventsAdded"], 0)
        self.assertEqual(len(imported), 1)
        self.assertEqual(imported[0]["news_item_id"], item_id)
        self.assertEqual(imported[0]["source_id"], source_id)
        self.assertEqual(before, after)

    def test_reader_event_api_and_interest_clear_preserve_subscriptions_and_items(self) -> None:
        _source_id, item_id = self.create_item("英雄联盟全球总决赛", "https://article.example.test/lol")
        with TestClient(app) as client:
            unauthenticated = client.post(
                "/news/interests/events",
                json={"events": [{"eventKey": "event-key-unauth", "eventType": "open_original", "itemId": item_id}]},
            )
            accepted = client.post(
                "/news/interests/events",
                headers=self.headers,
                json={"events": [
                    {"eventKey": "event-key-open-01", "eventType": "open_original", "itemId": item_id},
                    {"eventKey": "event-key-open-01", "eventType": "open_original", "itemId": item_id},
                    {"eventKey": "event-key-negative-1", "eventType": "not_interested", "itemId": item_id},
                ]},
            )
            profile = client.post("/news/interests/profile/rebuild", headers=self.headers)
            cleared = client.delete("/news/interests/data", headers=self.headers)
            items = client.get("/news/items", headers=self.headers)
            sources = client.get("/news/sources", headers=self.headers)

        self.assertEqual(unauthenticated.status_code, 401)
        self.assertEqual(accepted.status_code, 200, accepted.text)
        self.assertEqual(accepted.json()["accepted"], 2)
        self.assertEqual(profile.status_code, 200, profile.text)
        self.assertGreater(profile.json()["profile"]["eventCount"], 0)
        alliance_topic = next(
            topic for topic in profile.json()["profile"]["topics"] if topic["label"] == "联盟"
        )
        self.assertLess(alliance_topic["score"], 0)
        self.assertEqual(cleared.status_code, 200, cleared.text)
        self.assertEqual(cleared.json()["events"], 3)
        self.assertEqual(items.json()["total"], 1)
        self.assertEqual(sources.json()["items"][0]["id"], _source_id)

    def test_reading_history_shows_unique_opened_items_in_recent_open_order(self) -> None:
        source_id, item_id = self.create_item("英雄联盟全球总决赛", "https://article.example.test/lol")
        db.delete_source_subscription(source_id)
        db.insert_interest_events([
            {
                "id": "reading-history-open-old",
                "origin": "reader",
                "event_type": "open_original",
                "occurred_at": "2026-10-17T10:00:00Z",
                "source_id": source_id,
                "news_item_id": item_id,
                "canonical_url": "https://article.example.test/lol",
                "title": "英雄联盟全球总决赛",
                "dedupe_key": "reader:reading-history-open-old",
                "created_at": "2026-10-17T10:00:00Z",
            },
            {
                "id": "reading-history-open-new",
                "origin": "reader",
                "event_type": "open_original",
                "occurred_at": "2026-10-18T10:00:00Z",
                "source_id": source_id,
                "news_item_id": item_id,
                "canonical_url": "https://article.example.test/lol",
                "title": "英雄联盟全球总决赛",
                "dedupe_key": "reader:reading-history-open-new",
                "created_at": "2026-10-18T10:00:00Z",
            },
            {
                "id": "reading-history-impression",
                "origin": "reader",
                "event_type": "reader_impression",
                "occurred_at": "2026-10-19T10:00:00Z",
                "source_id": source_id,
                "news_item_id": item_id,
                "canonical_url": "https://article.example.test/lol",
                "title": "英雄联盟全球总决赛",
                "dedupe_key": "reader:reading-history-impression",
                "created_at": "2026-10-19T10:00:00Z",
            },
        ])

        with TestClient(app) as client:
            unauthorized = client.get("/news/reading-history")
            response = client.get("/news/reading-history?limit=10&offset=0", headers=self.headers)

        self.assertEqual(unauthorized.status_code, 401)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["cache-control"], "no-store")
        payload = response.json()
        self.assertEqual(payload["total"], 1)
        self.assertEqual(len(payload["items"]), 1)
        self.assertEqual(payload["items"][0]["id"], item_id)
        self.assertEqual(payload["items"][0]["lastOpenedAt"], "2026-10-18T10:00:00Z")
        self.assertEqual(payload["items"][0]["openCount"], 2)

    def test_article_feedback_is_saved_and_latest_choice_drives_interest(self) -> None:
        _source_id, item_id = self.create_item(
            "英雄联盟全球总决赛精彩对局", "https://article.example.test/lol-feedback"
        )
        with TestClient(app) as client:
            liked = client.post(
                "/news/interests/events",
                headers=self.headers,
                json={"events": [{"eventKey": "article-like-event", "eventType": "like", "itemId": item_id}]},
            )
            disliked = client.post(
                "/news/interests/events",
                headers=self.headers,
                json={"events": [{"eventKey": "article-dislike-event", "eventType": "not_interested", "itemId": item_id}]},
            )
            disliked_item = client.get("/news/items", headers=self.headers).json()["items"][0]
            liked_again = client.post(
                "/news/interests/events",
                headers=self.headers,
                json={"events": [{"eventKey": "article-like-again", "eventType": "like", "itemId": item_id}]},
            )
            profile = interest.rebuild_profile()
            liked_item = client.get("/news/items", headers=self.headers).json()["items"][0]

        self.assertEqual(liked.status_code, 200, liked.text)
        self.assertEqual(disliked.status_code, 200, disliked.text)
        self.assertEqual(disliked_item["userFeedback"], "not_interested")
        self.assertEqual(liked_again.status_code, 200, liked_again.text)
        self.assertEqual(liked_item["userFeedback"], "like")
        self.assertTrue(any(float(topic["score"]) > 0 for topic in profile["topics"]))

    def test_recommended_items_rank_opened_topics_and_report_reason(self) -> None:
        with TestClient(app) as client:
            timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
            source_id = f"source-{self._testMethodName}"
            db.create_source(source_id, "https://feed.example.test/recommendations", "测试来源", timestamp)
            db.complete_fetch(
                source_id,
                None,
                None,
                None,
                timestamp,
                [
                    {
                        "id": "item-rust-topic",
                        "dedupe_key": "rust-article",
                        "title": "Rust 编程语言的所有权实践",
                        "url": "https://article.example.test/rust",
                        "content": "Rust 开发中的所有权和生命周期入门。",
                        "author": None,
                        "published_at": timestamp,
                        "image_url": None,
                        "image_asset": None,
                    },
                    {
                        "id": "item-cooking-topic",
                        "dedupe_key": "cooking-article",
                        "title": "家常烘焙与面包制作",
                        "url": "https://article.example.test/bread",
                        "content": "烤箱温度和面团发酵技巧。",
                        "author": None,
                        "published_at": timestamp,
                        "image_url": None,
                        "image_asset": None,
                    },
                    {
                        "id": "item-rust-title-only",
                        "dedupe_key": "rust-title-only",
                        "title": "Rust 新产品发布",
                        "url": "https://article.example.test/rust-title-only",
                        "content": "烤箱温度和面团发酵技巧。",
                        "author": None,
                        "published_at": timestamp,
                        "image_url": None,
                        "image_asset": None,
                    },
                ],
            )
            latest = client.get("/news/items?view=latest", headers=self.headers)
            warming_up = client.get("/news/items?view=recommended", headers=self.headers)
            self.assertEqual(
                interest.record_reader_events(
                    [{"event_key": "opened-rust", "event_type": "open_original", "item_id": "item-rust-topic"}]
                ),
                1,
            )
            interest.rebuild_profile()
            with patch.object(
                interest.semantic,
                "scores_for_candidates",
                new=AsyncMock(),
            ) as semantic_scores:
                recommended = client.get("/news/items?view=recommended", headers=self.headers)
            semantic_scores.assert_not_awaited()
            invalid_view = client.get("/news/items?view=unknown", headers=self.headers)

        self.assertEqual(latest.status_code, 200, latest.text)
        self.assertEqual(warming_up.status_code, 200, warming_up.text)
        self.assertEqual(recommended.status_code, 200, recommended.text)
        self.assertEqual(invalid_view.status_code, 422)
        self.assertEqual(latest.json()["view"], "latest")
        self.assertEqual(warming_up.json()["recommendationState"], "warming_up")
        self.assertEqual(warming_up.json()["total"], 3)
        self.assertEqual(recommended.json()["view"], "recommended")
        self.assertEqual(recommended.json()["recommendationState"], "keyword_fallback")
        self.assertEqual(recommended.json()["items"][0]["id"], "item-rust-topic")
        self.assertIn("匹配兴趣", recommended.json()["items"][0]["recommendationReason"])
        self.assertNotIn("item-cooking-topic", [item["id"] for item in recommended.json()["items"]])
        self.assertNotIn("item-rust-title-only", [item["id"] for item in recommended.json()["items"]])

    def test_recommended_items_use_rrf_when_embedding_is_configured(self) -> None:
        timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        source_id = f"source-{self._testMethodName}"
        db.create_source(source_id, "https://feed.example.test/rrf", "测试来源", timestamp)
        db.complete_fetch(
            source_id,
            None,
            None,
            None,
            timestamp,
            [
                {
                    "id": "item-rrf-keyword",
                    "dedupe_key": "rrf-keyword",
                    "title": "Rust 所有权实践",
                    "url": "https://article.example.test/rrf-keyword",
                    "content": "Rust 编程中的生命周期管理。",
                    "author": None,
                    "published_at": timestamp,
                    "image_url": None,
                    "image_asset": None,
                },
                {
                    "id": "item-rrf-semantic",
                    "dedupe_key": "rrf-semantic",
                    "title": "开发者经验分享",
                    "url": "https://article.example.test/rrf-semantic",
                    "content": "一个完全不含 Rust 关键词的正文。",
                    "author": None,
                    "published_at": timestamp,
                    "image_url": None,
                    "image_asset": None,
                },
            ],
        )
        interest.record_reader_events([
            {"event_key": "rrf-topic-seed", "event_type": "open_original", "item_id": "item-rrf-keyword"}
        ])
        interest.rebuild_profile()
        storage._state["knowledgeConfig"] = {
            "embedding": {
                "enabled": True,
                "baseURL": "https://embedding.example.test/v1",
                "apiKey": "private-test-key",
                "model": "test-embedding-v1",
            }
        }

        semantic_scores = {
            "item-rrf-semantic": {
                "positive_score": 1.0,
                "negative_penalty": 0.0,
                "positive_labels": ["rust"],
                "negative_labels": [],
            }
        }
        with patch.object(
            interest.semantic,
            "scores_for_candidates",
            new=AsyncMock(return_value=semantic_scores),
        ) as score_candidates:
            result = asyncio.run(interest.recommended_items(None, 10, 0))

        result_by_id = {str(item["id"]): item for item in result["items"]}
        self.assertEqual(result["recommendation_state"], "ready")
        self.assertIn("item-rrf-semantic", result_by_id)
        self.assertTrue(str(result_by_id["item-rrf-semantic"]["recommendation_reason"]).startswith("RRF 融合："))
        self.assertIn("未进入关键词榜单", result_by_id["item-rrf-semantic"]["recommendation_reason"])
        score_candidates.assert_awaited_once()

    def test_like_feedback_learns_topics_from_article_body(self) -> None:
        _source_id, item_id = self.create_item(
            "本周开发动态汇总",
            "https://article.example.test/body-feedback",
            "Rust 所有权与生命周期实践，重点讲解异步运行时和内存安全。",
        )
        inserted = interest.record_reader_events([
            {"event_key": "like-body-feedback", "event_type": "like", "item_id": item_id}
        ])

        profile = interest.rebuild_profile()
        labels = {str(topic["label"]) for topic in profile["topics"]}

        self.assertEqual(inserted, 1)
        self.assertIn("rust", labels)
        self.assertTrue({"所有权", "生命周期", "异步", "运行时", "内存安全"} & labels)

    def test_subscription_and_impression_do_not_create_content_interest(self) -> None:
        _source_id, item_id = self.create_item(
            "Rust 编程语言的所有权实践",
            "https://article.example.test/rust-signal-strength",
        )
        interest.record_reader_events([
            {"event_key": "impression-only", "event_type": "reader_impression", "item_id": item_id}
        ])

        profile = interest.rebuild_profile()

        self.assertEqual(profile["topics"], [])
        self.assertEqual(profile["algorithmVersion"], "local-keywords-v5")

        interest.record_reader_events([
            {"event_key": "open-is-weak", "event_type": "open_original", "item_id": item_id}
        ])
        profile_after_open = interest.rebuild_profile()
        self.assertTrue(profile_after_open["topics"])

    def test_source_affinity_and_freshness_are_bounded_signals(self) -> None:
        now = datetime.now(timezone.utc)
        timestamp = now.isoformat(timespec="seconds").replace("+00:00", "Z")
        source_scores = interest._source_affinity_scores(
            [
                {"source_id": "preferred", "event_type": "open_original", "occurred_at": timestamp},
                {"source_id": "preferred", "event_type": "open_original", "occurred_at": timestamp},
                {"source_id": "avoided", "event_type": "not_interested", "occurred_at": timestamp},
            ],
            now,
        )
        fresh = interest._freshness_score({"published_at": timestamp}, now)
        old = interest._freshness_score(
            {"published_at": (now - timedelta(days=7)).isoformat(timespec="seconds")}, now
        )

        self.assertGreater(source_scores["preferred"], 0)
        self.assertLess(source_scores["avoided"], 0)
        self.assertLessEqual(abs(source_scores["preferred"]), interest._SOURCE_SCORE_LIMIT)
        self.assertGreater(fresh, old)
        self.assertLessEqual(fresh, interest._FRESHNESS_SCORE_LIMIT)

    def test_source_affinity_uses_latest_like_or_dislike_per_article(self) -> None:
        now = datetime.now(timezone.utc)
        older = (now - timedelta(minutes=1)).isoformat(timespec="seconds").replace("+00:00", "Z")
        current = now.isoformat(timespec="seconds").replace("+00:00", "Z")
        source_scores = interest._source_affinity_scores(
            [
                {
                    "source_id": "changed-to-like",
                    "news_item_id": "item-1",
                    "event_type": "not_interested",
                    "occurred_at": older,
                    "created_at": older,
                },
                {
                    "source_id": "changed-to-dislike",
                    "news_item_id": "item-2",
                    "event_type": "like",
                    "occurred_at": older,
                    "created_at": older,
                },
                {
                    "source_id": "changed-to-like",
                    "news_item_id": "item-1",
                    "event_type": "like",
                    "occurred_at": current,
                    "created_at": current,
                },
                {
                    "source_id": "changed-to-dislike",
                    "news_item_id": "item-2",
                    "event_type": "not_interested",
                    "occurred_at": current,
                    "created_at": current,
                },
            ],
            now,
        )

        self.assertGreater(source_scores["changed-to-like"], 0.0)
        self.assertLess(source_scores["changed-to-dislike"], 0.0)
        self.assertAlmostEqual(
            source_scores["changed-to-like"],
            -source_scores["changed-to-dislike"],
            places=4,
        )

    def test_diversification_spreads_nearby_scores_across_sources(self) -> None:
        ranked = [
            {"score": 1.0, "source_id": "source-a", "base_rank": 0, "reason": "A1"},
            {"score": 0.98, "source_id": "source-a", "base_rank": 1, "reason": "A2"},
            {"score": 0.95, "source_id": "source-b", "base_rank": 2, "reason": "B1"},
        ]

        diversified = interest._diversify_recommendations(ranked, None)

        self.assertEqual(
            [str(item["source_id"]) for item in diversified],
            ["source-a", "source-b", "source-a"],
        )
        self.assertIn("来源分布调整", str(diversified[1]["reason"]))

    def test_negative_interest_lowers_matching_article(self) -> None:
        timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        source_id = f"source-{self._testMethodName}"
        db.create_source(source_id, "https://feed.example.test/negative", "测试来源", timestamp)
        db.complete_fetch(
            source_id,
            None,
            None,
            None,
            timestamp,
            [
                {
                    "id": "item-positive-rust",
                    "dedupe_key": "positive-rust",
                    "title": "Rust 生命周期与所有权",
                    "url": "https://article.example.test/rust-interest",
                    "content": "Rust 程序开发和所有权实践。",
                    "author": None,
                    "published_at": timestamp,
                    "image_url": None,
                    "image_asset": None,
                },
                {
                    "id": "item-negative-seed",
                    "dedupe_key": "negative-seed",
                    "title": "手游广告推送观察",
                    "url": "https://article.example.test/mobile-ad-seed",
                    "content": "手游弹窗和广告推荐。",
                    "author": None,
                    "published_at": timestamp,
                    "image_url": None,
                    "image_asset": None,
                },
                {
                    "id": "item-mixed-rust-ad",
                    "dedupe_key": "mixed-rust-ad",
                    "title": "Rust 手游广告推送",
                    "url": "https://article.example.test/rust-ad",
                    "content": "Rust 游戏内容与手游弹窗广告。",
                    "author": None,
                    "published_at": timestamp,
                    "image_url": None,
                    "image_asset": None,
                },
            ],
        )
        interest.record_reader_events([
            {"event_key": "positive-rust-open", "event_type": "open_original", "item_id": "item-positive-rust"},
            {"event_key": "negative-mobile-ad", "event_type": "not_interested", "item_id": "item-negative-seed"},
        ])
        interest.rebuild_profile()

        result = asyncio.run(interest.recommended_items(None, 10, 0))
        result_ids = [str(item["id"]) for item in result["items"]]

        self.assertIn("item-positive-rust", result_ids)
        self.assertNotIn("item-mixed-rust-ad", result_ids)

    def test_extension_history_api_is_authenticated_deduplicated_and_links_news_items(self) -> None:
        source_id, item_id = self.create_item(
            "TabKeep 浏览器历史关联测试",
            "https://article.example.test/history?id=5",
        )
        visit = {
            "clientId": "0123456789abcdef0123456789abcdef",
            "visitId": "visit-9001",
            "url": "https://article.example.test/history?id=5#section",
            "title": "浏览器里的本地标题",
            "visitedAt": "2026-10-15T09:30:00+00:00",
            "transition": "link",
        }
        with TestClient(app) as client:
            denied = client.post("/news/interests/history-visits", json={"visits": [visit]})
            invalid_url = client.post(
                "/news/interests/history-visits",
                headers=self.headers,
                json={"visits": [{**visit, "url": "file:///private/path"}]},
            )
            first = client.post(
                "/news/interests/history-visits",
                headers=self.headers,
                json={"visits": [visit, visit]},
            )
            second = client.post(
                "/news/interests/history-visits",
                headers=self.headers,
                json={"visits": [visit]},
            )
        events = db.list_interest_events("2026-10-15T00:00:00Z", "2026-10-16T00:00:00Z")
        history_events = [event for event in events if event["origin"] == "browser_extension"]

        self.assertEqual(denied.status_code, 401)
        self.assertEqual(invalid_url.status_code, 422)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["accepted"], 1)
        self.assertEqual(second.json()["accepted"], 0)
        self.assertEqual(len(history_events), 1)
        self.assertEqual(history_events[0]["source_id"], source_id)
        self.assertEqual(history_events[0]["news_item_id"], item_id)
        self.assertEqual(history_events[0]["transition"], "link")
        self.assertEqual(history_events[0]["event_type"], "history_visit")

    def test_interest_transition_column_migrates_existing_database(self) -> None:
        legacy_path = Path(self.workspace.tmp_dir) / "legacy-news.sqlite3"
        connection = sqlite3.connect(legacy_path)
        try:
            connection.execute(
                """
                CREATE TABLE interest_events (
                    id TEXT PRIMARY KEY,
                    origin TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    occurred_at TEXT NOT NULL,
                    source_id TEXT,
                    news_item_id TEXT,
                    canonical_url TEXT,
                    title TEXT,
                    topic_key TEXT,
                    duration_ms INTEGER,
                    dedupe_key TEXT UNIQUE,
                    import_batch_id TEXT,
                    created_at TEXT NOT NULL
                )
                """
            )
            connection.commit()
        finally:
            connection.close()

        with patch.object(db, "get_db_path", return_value=legacy_path):
            db.init_db()
            inserted = db.insert_interest_event(
                {
                    "id": "legacy-event-1",
                    "origin": "browser_extension",
                    "event_type": "history_visit",
                    "occurred_at": "2026-10-15T09:30:00Z",
                    "title": "迁移后事件",
                    "transition": "typed",
                    "dedupe_key": "extension:client:visit-1",
                    "created_at": "2026-10-16T00:00:00Z",
                }
            )
            events = db.list_interest_events("2026-10-15T00:00:00Z", "2026-10-16T00:00:00Z")

        self.assertTrue(inserted)
        self.assertEqual(events[0]["transition"], "typed")

    def test_browser_history_import_can_be_cancelled_before_it_reads(self) -> None:
        local_app_data = self.create_edge_history(
            Path(self.workspace.tmp_dir) / "browser",
            datetime.now(timezone.utc) - timedelta(days=1),
            "https://article.example.test/cancelled",
            "不应保存的浏览标题",
        )
        with patch.dict(os.environ, {"LOCALAPPDATA": local_app_data}):
            profile = browser_history.list_profiles()[0]
            start = datetime.now(timezone.utc) - timedelta(days=2)
            end = datetime.now(timezone.utc)
            batch = interest.start_browser_history_import(profile["id"], start, end)
            interest.cancel_browser_history_import(str(batch["batchId"]))
            interest.run_browser_history_import(str(batch["batchId"]), profile["id"], start, end)
            status = interest.get_browser_history_import(str(batch["batchId"]))

        self.assertIsNotNone(status)
        self.assertEqual(status["status"], "cancelled")
        events = db.list_interest_events("0001-01-01T00:00:00Z", "9999-12-31T23:59:59Z")
        self.assertFalse(any(event["origin"] == "browser_history" for event in events))

    def test_model_suggestions_only_send_aggregated_keywords_and_public_catalog(self) -> None:
        _source_id, item_id = self.create_item(
            "SecretPrivatePageTitle-9917",
            "https://private.example.test/path/should-not-leak",
        )
        interest.record_reader_events([
            {"event_key": "activity-key-001", "event_type": "open_original", "item_id": item_id}
        ])
        storage._state["modelConfig"] = {
            "model": "mock-model",
            "baseURL": "https://model.example.test/v1",
            "apiKey": "test-key",
        }
        mock_completion = AsyncMock(return_value='{"topics":[{"id":"77","reason":"匹配近期主题"}]}')
        mock_refresh = AsyncMock(return_value={"newItems": 2, "notModified": False, "error": None})
        with patch("services.news.xiaoheihe_auth.auth_service.list_topics", new=AsyncMock(return_value=[
            {"id": "77", "name": "游戏硬件", "group": "游戏"},
        ])), patch("services.news.interest.llm.chat_completion", new=mock_completion), patch(
            "services.news.collector.refresh_source", new=mock_refresh
        ), TestClient(app) as client:
            response = client.post(
                "/news/interests/suggestions",
                headers=self.headers,
                json={"useModel": True},
            )
            suggestion_id = response.json()["suggestions"][0]["id"]
            subscribed = client.post(
                f"/news/interests/suggestions/{suggestion_id}/decision",
                headers=self.headers,
                json={"action": "accept"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["suggestions"][0]["platformTopicId"], "77")
        self.assertEqual(subscribed.status_code, 200, subscribed.text)
        self.assertEqual(subscribed.json()["source"]["xiaoheiheTopicId"], "77")
        self.assertEqual(subscribed.json()["newItems"], 2)
        self.assertGreaterEqual(mock_refresh.await_count, 1)
        sent_messages = json.dumps(mock_completion.await_args.args[1], ensure_ascii=False)
        self.assertNotIn("https://private.example.test/path/should-not-leak", sent_messages)
        self.assertNotIn("SecretPrivatePageTitle-9917", sent_messages)
        self.assertIn("interestSummary", sent_messages)
        self.assertIn("candidateTopics", sent_messages)


if __name__ == "__main__":
    unittest.main()
