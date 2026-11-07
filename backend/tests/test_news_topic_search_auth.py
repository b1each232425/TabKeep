"""话题搜索扫码授权适配器的纯本地测试。"""

import asyncio
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.news import topic_search_auth, topic_search
from services.news.topic_search_auth import _normalize_tieba_qr_image_url, _read_tieba_channel


class TopicSearchQrAuthTests(unittest.TestCase):
    def test_baidu_qr_image_url_accepts_host_without_scheme(self) -> None:
        self.assertEqual(
            _normalize_tieba_qr_image_url("passport.baidu.com/v2/api/qrcode?sign=test"),
            "https://passport.baidu.com/v2/api/qrcode?sign=test",
        )

    def test_baidu_qr_image_url_accepts_protocol_relative_url(self) -> None:
        self.assertEqual(
            _normalize_tieba_qr_image_url("//passport.baidu.com/v2/api/qrcode?sign=test"),
            "https://passport.baidu.com/v2/api/qrcode?sign=test",
        )

    def test_baidu_qr_image_url_normalizes_absolute_scheme_case(self) -> None:
        self.assertEqual(
            _normalize_tieba_qr_image_url("HTTPS://passport.baidu.com/v2/api/qrcode?sign=test"),
            "https://passport.baidu.com/v2/api/qrcode?sign=test",
        )

    def test_baidu_qr_image_url_resolves_root_relative_path(self) -> None:
        self.assertEqual(
            _normalize_tieba_qr_image_url("/v2/api/qrcode?sign=test"),
            "https://passport.baidu.com/v2/api/qrcode?sign=test",
        )

    def test_baidu_qr_image_url_still_rejects_untrusted_host(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "不受支持的登录地址"):
            _normalize_tieba_qr_image_url("attacker.example/qrcode?sign=test")

    def test_tieba_channel_accepts_object_or_json_string(self) -> None:
        expected = {"status": 0, "v": "temporary"}
        self.assertEqual(_read_tieba_channel(expected), expected)
        self.assertEqual(_read_tieba_channel('{"status":0,"v":"temporary"}'), expected)

    def test_tieba_channel_rejects_invalid_json_and_other_types(self) -> None:
        self.assertIsNone(_read_tieba_channel("not-json"))
        self.assertIsNone(_read_tieba_channel([{"status": 0}]))

    def test_tieba_poll_confirms_json_string_channel_in_same_session(self) -> None:
        response_text = "callback(" + json.dumps({
            "errno": 0,
            "channel_v": json.dumps({"status": 0, "v": "temporary"}),
        }) + ")"
        response = SimpleNamespace(text=response_text, raise_for_status=MagicMock())
        login = topic_search_auth._PendingLogin(
            provider="tieba",
            client=MagicMock(),
            created_at=0,
            payload={"sign": "sign", "gid": "gid", "callback": "cb"},
            login_image="",
        )
        exchange = AsyncMock()

        with (
            patch.object(topic_search_auth, "_get_platform", new=AsyncMock(return_value=response)),
            patch.object(topic_search_auth.TopicSearchQrAuth, "_exchange_tieba_cookie", new=exchange),
        ):
            state, message = asyncio.run(topic_search_auth.TopicSearchQrAuth()._poll_tieba(login))

        self.assertEqual(state, "connected")
        self.assertIn("成功", message)
        exchange.assert_awaited_once_with(login, "temporary")

    def test_tieba_poll_marks_unknown_status_expired(self) -> None:
        response_text = "callback(" + json.dumps({
            "errno": 0,
            "channel_v": json.dumps({"status": -1}),
        }) + ")"
        response = SimpleNamespace(text=response_text, raise_for_status=MagicMock())
        login = topic_search_auth._PendingLogin(
            provider="tieba",
            client=MagicMock(),
            created_at=0,
            payload={"sign": "sign", "gid": "gid", "callback": "cb"},
            login_image="",
        )

        with patch.object(topic_search_auth, "_get_platform", new=AsyncMock(return_value=response)):
            state, message = asyncio.run(topic_search_auth.TopicSearchQrAuth()._poll_tieba(login))

        self.assertEqual(state, "expired")
        self.assertIn("重新生成", message)

    def test_authenticated_tieba_search_reports_http_403_before_reading_body(self) -> None:
        response = SimpleNamespace(status=403)
        page = SimpleNamespace(
            goto=AsyncMock(return_value=response),
            wait_for_timeout=AsyncMock(),
            locator=MagicMock(),
        )

        with (
            patch.object(topic_search.browser_sessions, "_is_connected", return_value=True),
            patch.object(
                topic_search.browser_sessions,
                "authenticated_page",
                new=AsyncMock(return_value=(object(), page)),
            ),
        ):
            result = asyncio.run(topic_search._search_provider("tieba", "测试", 1, True))

        self.assertEqual(result.state, "error")
        self.assertEqual(result.http_status, 403)
        self.assertEqual(result.diagnostic_stage, "http_response")
        self.assertEqual(result.request_mode, "authenticated")
        page.wait_for_timeout.assert_not_awaited()
        page.locator.assert_not_called()

    def test_authenticated_timeout_mentions_forbidden_anonymous_fallback(self) -> None:
        page = SimpleNamespace(
            goto=AsyncMock(side_effect=topic_search.PlaywrightTimeoutError("navigation timeout")),
        )
        fallback = topic_search.ProviderResult([], "error", "platform blocked", http_status=403)

        with (
            patch.object(topic_search.browser_sessions, "_is_connected", return_value=True),
            patch.object(
                topic_search.browser_sessions,
                "authenticated_page",
                new=AsyncMock(return_value=(object(), page)),
            ),
            patch.object(topic_search, "_anonymous_search", new=AsyncMock(return_value=fallback)),
        ):
            result = asyncio.run(topic_search._search_provider("tieba", "测试", 1, True))

        self.assertEqual(result.state, "timeout")
        self.assertIn("匿名回退同时收到 HTTP 403", result.message)
        self.assertEqual(result.diagnostic_stage, "authenticated_navigation_timeout_fallback")
        self.assertIsNone(result.authenticated_http_status)

    def test_authenticated_body_timeout_logs_auth_and_fallback_status_separately(self) -> None:
        response = SimpleNamespace(status=200)
        body_locator = SimpleNamespace(
            inner_text=AsyncMock(side_effect=topic_search.PlaywrightTimeoutError("body timeout")),
        )
        page = SimpleNamespace(
            goto=AsyncMock(return_value=response),
            wait_for_timeout=AsyncMock(),
            locator=MagicMock(return_value=body_locator),
        )
        fallback = topic_search.ProviderResult([], "error", "platform blocked", http_status=403)

        with (
            patch.object(topic_search.browser_sessions, "_is_connected", return_value=True),
            patch.object(
                topic_search.browser_sessions,
                "authenticated_page",
                new=AsyncMock(return_value=(object(), page)),
            ),
            patch.object(topic_search, "_anonymous_search", new=AsyncMock(return_value=fallback)),
        ):
            result = asyncio.run(topic_search._search_provider("tieba", "测试", 1, True))

        self.assertEqual(result.diagnostic_stage, "authenticated_body_read_timeout_fallback")
        self.assertEqual(result.authenticated_http_status, 200)
        self.assertEqual(result.http_status, 403)


if __name__ == "__main__":
    unittest.main()
