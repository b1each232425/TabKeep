"""本机资讯推荐评估工具测试。"""

import asyncio
import json
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from schemas.knowledge import EmbeddingConfig
from schemas.news_evaluation import NewsEvaluationReportResponse
from services import storage
from services.news import db, interest, recommendation_evaluation as evaluation
from tests.helpers import IsolatedBackendState


class NewsRecommendationEvaluationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = IsolatedBackendState(f"news-recommendation-eval-{self._testMethodName}")
        self.workspace.setup()
        db.init_db()
        self.created_items = self._create_items()

    def tearDown(self) -> None:
        self.workspace.teardown()

    def _create_items(self) -> list[str]:
        timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        item_ids: list[str] = []
        for source_number in range(7):
            source_id = f"eval-source-{source_number}"
            db.create_source(
                source_id,
                f"https://feed-{source_number}.example.test/rss",
                f"测试来源 {source_number}",
                timestamp,
            )
            entries: list[dict[str, str | None]] = []
            for item_number in range(15):
                item_id = f"eval-item-{source_number}-{item_number}"
                if item_number < 6:
                    title = f"深度学习 GPU 推理实践 {source_number}-{item_number}"
                    content = "深度学习模型使用 GPU 加速推理，讨论显存优化与训练部署。"
                else:
                    title = f"城市园艺与旅行见闻 {source_number}-{item_number}"
                    content = f"城市园艺、植物养护和旅行记录，独立样本编号 {source_number}-{item_number}。"
                entries.append(
                    {
                        "id": item_id,
                        "dedupe_key": item_id,
                        "title": title,
                        "url": f"https://article-{item_id}.example.test/story",
                        "content": content,
                        "author": None,
                        "published_at": (
                            datetime.now(timezone.utc) - timedelta(days=source_number * 7 + (item_number // 5) * 35)
                        ).isoformat(timespec="seconds").replace("+00:00", "Z"),
                        "image_url": None,
                        "image_asset": None,
                    }
                )
                item_ids.append(item_id)
            db.complete_fetch(source_id, None, None, None, timestamp, entries)

        interest.record_reader_events(
            [
                {
                    "event_key": f"eval-open-{item_id}",
                    "event_type": "open_original",
                    "item_id": item_id,
                }
                for item_id in item_ids[:6]
            ]
        )
        return item_ids

    def test_prepare_creates_local_blind_sample_without_interest_events_or_article_text(self) -> None:
        event_count_before = db.count_interest_events()

        with patch.object(evaluation, "embed_texts", new=AsyncMock()) as mock_embed:
            result = evaluation.prepare_evaluation()

        mock_embed.assert_not_awaited()

        self.assertEqual(result["sampleSize"], 30)
        manifest_path = Path(str(result["path"]))
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        records = manifest["items"]
        self.assertEqual(len({record["itemId"] for record in records}), 30)
        self.assertEqual(len({record["contentFingerprint"] for record in records}), 30)
        self.assertEqual(manifest["labels"], {})
        self.assertTrue(all("title" not in record and "content" not in record for record in records))
        self.assertGreaterEqual(len({record["sourceId"] for record in records}), 4)
        self.assertGreaterEqual(len({record["publishedMonth"] for record in records if record["publishedMonth"] != "undated"}), 2)
        self.assertTrue({"top", "middle", "tail", "unranked"}.issuperset(
            record["keywordRankBand"] for record in records
        ))
        self.assertEqual(db.count_interest_events(), event_count_before)
        self.assertTrue(any(record["sampleGroup"] == "keyword_recommendations" for record in records))
        self.assertTrue(any(
            record["sampleGroup"] == "recent_not_ranked" and record["keywordRank"] is None
            for record in records
        ))
        self.assertTrue(any(record["sampleGroup"] == "source_time_balanced_random" for record in records))
        keyword_group_bands = {
            record["keywordRankBand"]
            for record in records
            if record["sampleGroup"] == "keyword_recommendations"
        }
        self.assertGreaterEqual(len(keyword_group_bands), 2)

    def test_new_batches_exclude_prior_ids_and_content_fingerprints(self) -> None:
        first = evaluation.prepare_evaluation(sample_size=30, seed=11)
        second = evaluation.prepare_evaluation(sample_size=30, seed=11)
        first_items = evaluation._read_run(str(first["runId"]))["items"]
        second_items = evaluation._read_run(str(second["runId"]))["items"]

        self.assertFalse({item["itemId"] for item in first_items} & {item["itemId"] for item in second_items})
        self.assertFalse(
            {item["contentFingerprint"] for item in first_items}
            & {item["contentFingerprint"] for item in second_items}
        )

    def test_batch_skips_duplicate_content_from_another_source(self) -> None:
        original = db.get_item(self.created_items[0])
        self.assertIsNotNone(original)
        timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        source_id = "eval-duplicate-source"
        db.create_source(source_id, "https://duplicate.example.test/rss", "重复来源", timestamp)
        db.complete_fetch(
            source_id,
            None,
            None,
            None,
            timestamp,
            [{
                "id": "eval-duplicate-content",
                "dedupe_key": "eval-duplicate-content",
                "title": str(original["title"]),
                "url": "https://duplicate.example.test/story",
                "content": str(original["content"]),
                "author": None,
                "published_at": timestamp,
                "image_url": None,
                "image_asset": None,
            }],
        )

        prepared = evaluation.prepare_evaluation(sample_size=100)
        records = evaluation._read_run(str(prepared["runId"]))["items"]

        self.assertNotIn("eval-duplicate-content", {str(record["itemId"]) for record in records})
        self.assertEqual(len({str(record["contentFingerprint"]) for record in records}), len(records))

    def test_insufficient_unseen_candidates_stops_instead_of_reusing_old_items(self) -> None:
        evaluation.prepare_evaluation(sample_size=100)
        used_before = evaluation._previously_evaluated_items()

        with self.assertRaisesRegex(ValueError, "等新资讯积累"):
            evaluation.prepare_evaluation(sample_size=30)

        self.assertEqual(evaluation._previously_evaluated_items(), used_before)

    def test_terminal_labels_are_saved_locally_and_do_not_change_interest_profile_events(self) -> None:
        result = evaluation.prepare_evaluation()
        event_count_before = db.count_interest_events()
        answers = iter(["1", "0", "?", "q"])
        output: list[str] = []

        count = evaluation.label_evaluation(
            str(result["runId"]),
            input_fn=lambda _prompt: next(answers),
            output_fn=output.append,
        )

        manifest = evaluation._read_run(str(result["runId"]))
        self.assertEqual(count, 3)
        self.assertEqual(set(manifest["labels"].values()), {
            evaluation.LABEL_INTERESTED,
            evaluation.LABEL_NOT_INTERESTED,
            evaluation.LABEL_UNSURE,
        })
        self.assertEqual(db.count_interest_events(), event_count_before)
        self.assertTrue(all("https://" not in line for line in output))

    def test_interactive_batch_exposes_blind_content_only_and_saves_label_outside_interest_events(self) -> None:
        result = evaluation.prepare_evaluation()
        batch = evaluation.get_evaluation_batch(str(result["runId"]))
        first_item = batch["items"][0]
        self.assertEqual(set(first_item), {"itemId", "title", "excerpt", "label"})
        self.assertNotIn("https://", str(first_item))
        self.assertNotIn("source", str(first_item).lower())

        event_count_before = db.count_interest_events()
        saved = evaluation.save_evaluation_labels(
            str(result["runId"]),
            {str(first_item["itemId"]): evaluation.LABEL_INTERESTED},
        )

        self.assertEqual(saved["labeledCount"], 1)
        self.assertFalse(saved["readyToEvaluate"])
        self.assertEqual(evaluation.get_evaluation_batch(str(result["runId"]))["items"][0]["label"], evaluation.LABEL_INTERESTED)
        self.assertEqual(db.count_interest_events(), event_count_before)

    def test_evaluation_router_requires_both_explicit_development_flags(self) -> None:
        from fastapi import FastAPI
        from main import register_news_evaluation_router

        for enable_value, auth_value in (("0", "1"), ("1", "0")):
            with self.subTest(enable=enable_value, auth=auth_value):
                application = FastAPI()
                with patch.dict(
                    "os.environ",
                    {
                        "TABKEEP_ENABLE_NEWS_EVALUATION": enable_value,
                        "TABKEEP_DISABLE_AUTH": auth_value,
                    },
                ):
                    self.assertFalse(register_news_evaluation_router(application))
                paths = {route.path for route in application.routes}
                self.assertFalse(any(path.startswith("/news/dev/recommendation-evaluation") for path in paths))

        application = FastAPI()
        with patch.dict(
            "os.environ",
            {"TABKEEP_ENABLE_NEWS_EVALUATION": "1", "TABKEEP_DISABLE_AUTH": "1"},
        ):
            self.assertTrue(register_news_evaluation_router(application))
        paths = {route.path for route in application.routes}
        self.assertIn("/news/dev/recommendation-evaluation/runs", paths)
        self.assertIn("/news/dev/recommendation-evaluation/runs/{run_id}", paths)

    def test_interactive_evaluation_api_prepares_reads_and_saves_blind_labels(self) -> None:
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from routers.news_recommendation_evaluation import router

        application = FastAPI()
        application.include_router(router)
        with patch.dict("os.environ", {"TABKEEP_DISABLE_AUTH": "1"}), TestClient(application) as client:
            prepared = client.post("/news/dev/recommendation-evaluation/runs", json={})
            self.assertEqual(prepared.status_code, 200, prepared.text)
            self.assertEqual(prepared.json()["sampleSize"], 100)
            run_id = prepared.json()["runId"]

            loaded = client.get(f"/news/dev/recommendation-evaluation/runs/{run_id}")
            self.assertEqual(loaded.status_code, 200, loaded.text)
            item = loaded.json()["items"][0]
            self.assertEqual(set(item), {"itemId", "title", "excerpt", "label"})

            saved = client.put(
                f"/news/dev/recommendation-evaluation/runs/{run_id}/labels",
                json={"labels": {item["itemId"]: evaluation.LABEL_UNSURE}},
            )
            self.assertEqual(saved.status_code, 200, saved.text)
            self.assertEqual(saved.json()["labeledCount"], 1)
            self.assertEqual(client.get(f"/news/dev/recommendation-evaluation/runs/{run_id}").json()["items"][0]["label"], evaluation.LABEL_UNSURE)

            unsupported_label = client.put(
                f"/news/dev/recommendation-evaluation/runs/{run_id}/labels",
                json={"labels": {item["itemId"]: "source-hidden"}},
            )
            self.assertEqual(unsupported_label.status_code, 422)

            unsupported_sample_size = client.post(
                "/news/dev/recommendation-evaluation/runs",
                json={"sampleSize": 50},
            )
            self.assertEqual(unsupported_sample_size.status_code, 422)

    def test_embedding_cache_is_local_keyed_by_model_and_text_hash_without_storing_text_or_key(self) -> None:
        config = EmbeddingConfig(
            enabled=True,
            baseURL="https://embedding.example.test/v1",
            apiKey="private-test-key",
            model="test-embedding-v1",
        )
        mock_embed = AsyncMock(side_effect=lambda _config, texts: [[1.0, 0.0] for _ in texts])

        with patch.object(evaluation, "embed_texts", new=mock_embed):
            first = asyncio.run(evaluation._embed_cached(config, ["body one"]))
            again = asyncio.run(evaluation._embed_cached(config, ["body one"]))
            changed_text = asyncio.run(evaluation._embed_cached(config, ["body two"]))
            changed_model = asyncio.run(
                evaluation._embed_cached(config.model_copy(update={"model": "test-embedding-v2"}), ["body one"])
            )

        self.assertEqual(first, again)
        self.assertEqual(changed_text, first)
        self.assertEqual(changed_model, first)
        self.assertEqual(mock_embed.await_count, 3)
        cache_text = evaluation._embedding_cache_path().read_text(encoding="utf-8")
        self.assertNotIn("body one", cache_text)
        self.assertNotIn("private-test-key", cache_text)

    def test_embedding_input_uses_body_only_and_strips_url_and_html(self) -> None:
        text = evaluation._body_embedding_text(
            {
                "title": "标题不应发给服务",
                "url": "https://private.example.test/item",
                "content": "<p>深度学习正文</p> https://private.example.test/path",
            }
        )

        self.assertEqual(text, "深度学习正文")
        self.assertNotIn("private.example.test", text)
        self.assertNotIn("标题不应发给服务", text)

    def test_semantic_scores_keep_positive_and_negative_topics_separate(self) -> None:
        topics = [
            {"label": "深度学习", "score": 2.0},
            {"label": "明星八卦", "score": -2.0},
        ]
        scores = evaluation._semantic_scores(
            topics,
            [[1.0, 0.0], [0.0, 1.0]],
            {"relevant": [0.9, 0.1], "negative": [0.1, 0.9]},
        )

        self.assertGreater(scores["relevant"]["positive_score"], scores["negative"]["positive_score"])
        self.assertGreater(scores["negative"]["negative_penalty"], scores["relevant"]["negative_penalty"])
        self.assertEqual(scores["relevant"]["positive_labels"][0], "深度学习")
        self.assertEqual(scores["negative"]["negative_labels"][0], "明星八卦")

    def test_metrics_evaluate_full_ranking_and_candidate_coverage(self) -> None:
        ranked = [
            {"row": {"id": "negative-a"}},
            {"row": {"id": "positive-a"}},
            {"row": {"id": "positive-b"}},
        ]
        metrics = evaluation._ranking_metrics(
            ranked,
            {
                "negative-a": evaluation.LABEL_NOT_INTERESTED,
                "negative-b": evaluation.LABEL_NOT_INTERESTED,
                "positive-a": evaluation.LABEL_INTERESTED,
                "positive-b": evaluation.LABEL_INTERESTED,
                "omitted-positive": evaluation.LABEL_INTERESTED,
            },
        )

        self.assertEqual(metrics["judgedCount"], 5)
        self.assertEqual(metrics["rankedCount"], 3)
        self.assertAlmostEqual(metrics["coverage"], 3 / 5)
        self.assertAlmostEqual(metrics["averagePrecision"], (1 / 2 + 2 / 3) / 3)
        self.assertAlmostEqual(metrics["pairwiseAuc"], 2.5 / 6)
        expected_ndcg = evaluation._dcg([0, 1, 1], 5) / evaluation._dcg([1, 1, 1, 0, 0], 5)
        self.assertAlmostEqual(metrics["ndcgAll"], expected_ndcg)

    def test_pairwise_auc_is_undefined_without_both_label_classes(self) -> None:
        ranked = [{"row": {"id": "negative"}}]

        metrics = evaluation._ranking_metrics(
            ranked,
            {"negative": evaluation.LABEL_NOT_INTERESTED},
        )

        self.assertEqual(metrics["ndcgAll"], 0.0)
        self.assertEqual(metrics["averagePrecision"], 0.0)
        self.assertIsNone(metrics["pairwiseAuc"])
        self.assertEqual(metrics["coverage"], 1.0)

    def test_random_baseline_matches_the_sample_label_distribution(self) -> None:
        baseline = evaluation._random_ranking_baseline(
            {
                "positive-a": evaluation.LABEL_INTERESTED,
                "positive-b": evaluation.LABEL_INTERESTED,
                "negative-a": evaluation.LABEL_NOT_INTERESTED,
                "unsure": evaluation.LABEL_UNSURE,
            }
        )

        self.assertGreater(baseline["ndcgAll"], 0.0)
        self.assertGreater(baseline["averagePrecision"], 0.0)
        self.assertEqual(baseline["pairwiseAuc"], 0.5)

    def test_reciprocal_rank_fusion_combines_positions_without_comparing_raw_scores(self) -> None:
        def ranked(*item_ids: str) -> list[dict[str, object]]:
            return [
                {
                    "score": float(100 - index),
                    "timestamp": "2026-10-20T00:00:00Z",
                    "row": {"id": item_id},
                    "reason": "base",
                    "source_id": "source",
                    "base_rank": index,
                }
                for index, item_id in enumerate(item_ids)
            ]

        fused = evaluation._reciprocal_rank_fusion(
            ranked("keyword-first", "shared", "keyword-third"),
            ranked("shared", "semantic-second", "keyword-first"),
        )

        self.assertEqual(
            [item["row"]["id"] for item in fused],
            ["shared", "keyword-first", "semantic-second", "keyword-third"],
        )
        self.assertIn("关键词第 2 位", fused[0]["reason"])
        self.assertIn("语义第 1 位", fused[0]["reason"])
        self.assertIn("未进入语义榜单", fused[3]["reason"])

    def test_evaluation_sends_only_body_and_aggregated_topics_and_never_records_labels_as_events(self) -> None:
        result = evaluation.prepare_evaluation()
        manifest = evaluation._read_run(str(result["runId"]))
        records = manifest["items"]
        manifest["labels"] = {
            str(record["itemId"]): (
                evaluation.LABEL_INTERESTED
                if index % 2 == 0
                else evaluation.LABEL_NOT_INTERESTED
            )
            for index, record in enumerate(records[:20])
        }
        evaluation._write_json(evaluation._run_path(str(result["runId"])), manifest)
        storage._state["knowledgeConfig"] = {
            "embedding": {
                "enabled": True,
                "baseURL": "https://embedding.example.test/v1",
                "apiKey": "private-test-key",
                "model": "test-embedding-v1",
            }
        }
        event_count_before = db.count_interest_events()
        sent_texts: list[str] = []

        async def fake_embed(_config: EmbeddingConfig, texts: list[str]) -> list[list[float]]:
            sent_texts.extend(texts)
            return [
                [1.0, 0.0] if "深度学习" in text or "GPU" in text else [0.0, 1.0]
                for text in texts
            ]

        with patch.object(evaluation, "embed_texts", new=AsyncMock(side_effect=fake_embed)):
            evaluated = asyncio.run(evaluation.evaluate_run(str(result["runId"])))

        report = NewsEvaluationReportResponse(**evaluated)
        serialized_inputs = json.dumps(sent_texts, ensure_ascii=False)
        self.assertTrue(evaluated["metricsSufficient"])
        self.assertEqual(set(evaluated["metrics"]), {"keyword", "semantic", "hybrid", "rrf"})
        self.assertGreaterEqual(report.sampleCoverage.sourceCount, 1)
        self.assertEqual(
            set(report.sampleGroups),
            {str(record["sampleGroup"]) for record in records},
        )
        self.assertEqual(sum(group.sampleCount for group in report.sampleGroups.values()), len(records))
        self.assertEqual(sum(group.judgedCount for group in report.sampleGroups.values()), 20)
        self.assertTrue(all(
            set(group.metrics) == {"keyword", "semantic", "hybrid", "rrf"}
            for group in report.sampleGroups.values()
        ))
        self.assertTrue(all(
            group.randomBaseline.ndcgAll >= 0
            and group.randomBaseline.averagePrecision >= 0
            for group in report.sampleGroups.values()
        ))
        self.assertNotIn("https://", serialized_inputs)
        self.assertNotIn("article-eval-item", serialized_inputs)
        self.assertNotIn("private-test-key", serialized_inputs)
        self.assertTrue(any("深度学习" in text for text in sent_texts))
        self.assertEqual(db.count_interest_events(), event_count_before)

    def test_disabled_embedding_configuration_stops_before_provider_call(self) -> None:
        result = evaluation.prepare_evaluation()
        manifest = evaluation._read_run(str(result["runId"]))
        manifest["labels"] = {
            str(record["itemId"]): (
                evaluation.LABEL_INTERESTED
                if index % 2 == 0
                else evaluation.LABEL_NOT_INTERESTED
            )
            for index, record in enumerate(manifest["items"][:20])
        }
        evaluation._write_json(evaluation._run_path(str(result["runId"])), manifest)

        with patch.object(evaluation, "embed_texts", new=AsyncMock()) as mock_embed:
            with self.assertRaisesRegex(ValueError, "启用并配置 embedding 模型"):
                asyncio.run(evaluation.evaluate_run(str(result["runId"])))

        mock_embed.assert_not_awaited()

    def test_embedding_provider_error_does_not_change_keyword_recommendations(self) -> None:
        result = evaluation.prepare_evaluation()
        manifest = evaluation._read_run(str(result["runId"]))
        manifest["labels"] = {
            str(record["itemId"]): (
                evaluation.LABEL_INTERESTED
                if index % 2 == 0
                else evaluation.LABEL_NOT_INTERESTED
            )
            for index, record in enumerate(manifest["items"][:20])
        }
        evaluation._write_json(evaluation._run_path(str(result["runId"])), manifest)
        storage._state["knowledgeConfig"] = {
            "embedding": {
                "enabled": True,
                "baseURL": "https://embedding.example.test/v1",
                "apiKey": "private-test-key",
                "model": "test-embedding-v1",
            }
        }
        before_ids = [
            str(item["id"])
            for item in interest.keyword_recommended_items(None, 20, 0)["items"]
        ]

        async def fail_provider(_config: EmbeddingConfig, _texts: list[str]) -> list[list[float]]:
            raise RuntimeError("provider error containing private request details")

        with patch.object(
            interest.semantic,
            "embed_texts",
            new=AsyncMock(side_effect=fail_provider),
        ):
            fallback = asyncio.run(interest.recommended_items(None, 20, 0))

        after_ids = [
            str(item["id"])
            for item in fallback["items"]
        ]
        self.assertEqual(fallback["recommendation_state"], "keyword_fallback")
        self.assertEqual(after_ids, before_ids)


if __name__ == "__main__":
    unittest.main()
