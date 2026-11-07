"""One-shot, read-only comment capability probe. Prints structure only."""

import asyncio
import sqlite3
import sys
from pathlib import Path
from urllib.parse import urlencode, urlsplit

import httpx
import aiohttp

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from services.news import xiaoheihe
from services.news.tieba import parse_forum_name
from services.news.xiaoheihe_auth import _WEB_CLIENT_PARAMS, _auth_request_json


DB = Path(__file__).resolve().parents[2] / "backend" / "data" / "news.sqlite3"


async def probe_tieba_transport() -> None:
    from aiotieba.config import ProxyConfig

    proxy = ProxyConfig.from_env()
    print("tieba proxy configured", bool(proxy.url))
    if not proxy.url:
        return
    print("tieba proxy scheme/port", proxy.url.scheme, proxy.url.port)
    timeout = aiohttp.ClientTimeout(total=12)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(
                "https://tiebac.baidu.com/",
                proxy=str(proxy.url),
                proxy_auth=proxy.auth,
                ssl=False,
            ) as response:
                print("tieba proxy root status", response.status)
    except Exception as error:
        print("tieba proxy root exception", type(error).__name__)


async def probe_tieba_websocket() -> None:
    import aiotieba

    url = sample_url("tieba")
    if not url:
        print("tieba websocket: no local sample")
        return
    try:
        tid = int(urlsplit(url).path.rstrip("/").split("/")[-1])
        async with aiotieba.Client(proxy=True, try_ws=True) as client:
            posts = await asyncio.wait_for(
                client.get_posts(
                    tid, pn=1, rn=5, with_comments=True,
                    comment_sort_by_agree=True, comment_rn=3,
                ),
                timeout=30,
            )
        error = getattr(posts, "err", None)
        if error is not None:
            print("tieba websocket: API error", type(error).__name__)
            return
        roots = list(getattr(posts, "objs", []) or [])
        print("tieba websocket: root posts", len(roots))
        print("tieba websocket: inline nested comments", sum(len(getattr(post, "comments", []) or []) for post in roots))
    except Exception as error:
        print("tieba websocket: request exception", type(error).__name__)


def sample_url(source_type: str) -> str | None:
    with sqlite3.connect(f"file:{DB.as_posix()}?mode=ro", uri=True) as connection:
        row = connection.execute(
            """SELECT i.url FROM news_items AS i
               JOIN news_sources AS s ON s.id = i.source_id
               WHERE s.source_type = ? AND i.url IS NOT NULL
               ORDER BY i.published_at DESC LIMIT 1""",
            (source_type,),
        ).fetchone()
    return str(row[0]) if row else None


def sample_forum_url() -> str | None:
    with sqlite3.connect(f"file:{DB.as_posix()}?mode=ro", uri=True) as connection:
        row = connection.execute(
            """SELECT url FROM news_sources
               WHERE source_type = 'tieba' AND is_active = 1 AND is_deleted = 0
               ORDER BY last_success_at DESC LIMIT 1"""
        ).fetchone()
    return str(row[0]) if row else None


async def probe_tieba() -> None:
    import aiotieba

    url = sample_forum_url()
    if not url:
        print("tieba: no active local forum")
        return
    try:
        forum_name = parse_forum_name(url)
    except (TypeError, ValueError):
        print("tieba: active forum URL is invalid")
        return
    if not forum_name:
        print("tieba: active forum URL has no forum name")
        return
    try:
        async with aiotieba.Client(proxy=True) as client:
            listing = await asyncio.wait_for(
                client.get_threads(
                    forum_name,
                    pn=1,
                    rn=5,
                    sort=aiotieba.ThreadSortType.HOT,
                ),
                timeout=25,
            )
            if getattr(listing, "err", None) is not None:
                print("tieba: get_threads returned error type", type(listing.err).__name__)
                return
            threads = list(getattr(listing, "objs", []) or [])
            print("tieba: fresh threads", len(threads))
            if not threads:
                return
            tid = int(getattr(threads[0], "tid", 0))
            if tid <= 0:
                print("tieba: fresh thread ID unavailable")
                return
            posts = await asyncio.wait_for(
                client.get_posts(
                    tid,
                    pn=1,
                    rn=10,
                    sort=aiotieba.PostSortType.HOT,
                    with_comments=True,
                    comment_sort_by_agree=True,
                    comment_rn=5,
                ),
                timeout=25,
            )
            if getattr(posts, "err", None) is not None:
                print("tieba: get_posts returned error type", type(posts.err).__name__)
                return
            roots = list(getattr(posts, "objs", []) or [])
            print("tieba: root posts", len(roots))
            print("tieba: roots with likes", sum(bool(getattr(post, "agree", 0)) for post in roots))
            print("tieba: roots with nested reply count", sum(bool(getattr(post, "reply_num", 0)) for post in roots))
            print("tieba: inline nested comments", sum(len(getattr(post, "comments", []) or []) for post in roots))
            eligible = next((post for post in roots if getattr(post, "pid", 0) and getattr(post, "reply_num", 0)), None)
            if eligible is None:
                print("tieba: no root with nested replies in this sample")
                return
            comments = await asyncio.wait_for(
                client.get_comments(tid, int(eligible.pid), pn=1), timeout=25
            )
            if getattr(comments, "err", None) is not None:
                print("tieba: get_comments returned error type", type(comments.err).__name__)
                return
            children = list(getattr(comments, "objs", []) or [])
            print("tieba: paged nested comments", len(children))
            if children:
                child = children[0]
                print("tieba: nested fields", ",".join(
                    field for field in ("pid", "reply_to_id", "agree", "disagree", "create_time", "text")
                    if hasattr(child, field)
                ))
    except Exception as error:
        print("tieba: request exception", type(error).__name__)


async def probe_xiaoheihe(page: int = 1) -> None:
    url = sample_url("xiaoheihe")
    if not url:
        print("xiaoheihe: no local sample")
        return
    link_id = urlsplit(url).path.rstrip("/").split("/")[-1]
    if not link_id or len(link_id) > 40:
        print("xiaoheihe: invalid sample URL")
        return
    params = {
        **_WEB_CLIENT_PARAMS,
        "heybox_id": "",
        "link_id": link_id,
        "is_first": "1" if page == 1 else "0",
        "page": str(page),
        "index": "1",
        "limit": "20",
        "owner_only": "0",
    }
    path = "/bbs/app/link/tree"
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
            payload = await _auth_request_json(
                client, f"{xiaoheihe.API_BASE_URL}{path}?{urlencode(params)}", ""
            )
        print("xiaoheihe: page", page, "HTTP 200; status", str(payload.get("status", payload.get("stat", "missing")))[:40])
        result = payload.get("result")
        if isinstance(result, dict):
            print("xiaoheihe: result keys", ",".join(sorted(result.keys())))
            comments = result.get("comments")
            if isinstance(comments, list):
                print("xiaoheihe: root comments", len(comments))
                groups = [group.get("comment") for group in comments if isinstance(group, dict)]
                roots = [group[0] for group in groups if isinstance(group, list) and group and isinstance(group[0], dict)]
                print("xiaoheihe: parsed root records", len(roots))
                print("xiaoheihe: roots with nonzero up", sum(isinstance(root.get("up"), int) and root["up"] > 0 for root in roots))
                print("xiaoheihe: roots with child_num", sum(isinstance(root.get("child_num"), int) and root["child_num"] > 0 for root in roots))
                print("xiaoheihe: inline child records", sum(max(0, len(group) - 1) for group in groups if isinstance(group, list)))
                if comments and isinstance(comments[0], dict):
                    print("xiaoheihe: comment keys", ",".join(sorted(comments[0].keys())))
                    nested = comments[0].get("comment")
                    print("xiaoheihe: nested comment type", type(nested).__name__)
                    if isinstance(nested, dict):
                        print("xiaoheihe: nested comment keys", ",".join(sorted(nested.keys())))
                        for key, value in sorted(nested.items()):
                            if isinstance(value, dict):
                                print(f"xiaoheihe: {key} keys", ",".join(sorted(value.keys())))
                    elif isinstance(nested, list):
                        print("xiaoheihe: nested comment entries", len(nested))
                        if nested and isinstance(nested[0], dict):
                            print("xiaoheihe: first nested entry keys", ",".join(sorted(nested[0].keys())))
                            for key, value in sorted(nested[0].items()):
                                if isinstance(value, dict):
                                    print(f"xiaoheihe: first nested {key} keys", ",".join(sorted(value.keys())))
            elif isinstance(comments, dict):
                print("xiaoheihe: comments container keys", ",".join(sorted(comments.keys())))
            sort_filter = result.get("sort_filter")
            if isinstance(sort_filter, dict):
                print("xiaoheihe: sort filter keys", ",".join(sorted(sort_filter.keys())))
            elif isinstance(sort_filter, list):
                print("xiaoheihe: sort filter entries", len(sort_filter))
                if sort_filter and isinstance(sort_filter[0], dict):
                    print("xiaoheihe: sort filter item keys", ",".join(sorted(sort_filter[0].keys())))
                    print("xiaoheihe: sort filters", [(str(item.get("key"))[:30], str(item.get("text"))[:30]) for item in sort_filter if isinstance(item, dict)])
            print("xiaoheihe: pagination", result.get("total_page"), result.get("has_more_floors"))
        else:
            print("xiaoheihe: result type", type(result).__name__)
    except httpx.HTTPStatusError as error:
        print("xiaoheihe: HTTP status", error.response.status_code)
    except Exception as error:
        print("xiaoheihe: request exception", type(error).__name__)


async def main() -> None:
    await probe_tieba()
    await probe_xiaoheihe()


if __name__ == "__main__":
    asyncio.run(main())
