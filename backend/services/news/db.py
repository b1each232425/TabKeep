"""资讯订阅与条目的 SQLite 持久化。"""

import sqlite3
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from threading import Event

from services import storage
from services.news.tieba import parse_forum_name
from services.news.url_utils import canonicalize_url


def get_db_path() -> Path:
    """读取当前运行时的数据目录，便于源码、打包应用和测试共用。"""
    return storage.DATA_DIR / "news.sqlite3"


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    """打开独立连接并确保事务提交或回滚。"""
    path = get_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 10000")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def init_db() -> None:
    """创建资讯采集所需的本地表和索引。"""
    with connect() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS news_sources (
                id TEXT PRIMARY KEY,
                url TEXT NOT NULL UNIQUE,
                feed_url TEXT,
                title TEXT NOT NULL,
                icon_url TEXT,
                icon_asset TEXT,
                source_type TEXT NOT NULL DEFAULT 'rss',
                is_active INTEGER NOT NULL DEFAULT 1,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                etag TEXT,
                last_modified TEXT,
                created_at TEXT NOT NULL,
                last_checked_at TEXT,
                last_success_at TEXT,
                last_error TEXT
            );
            CREATE TABLE IF NOT EXISTS news_items (
                id TEXT PRIMARY KEY,
                source_id TEXT NOT NULL REFERENCES news_sources(id),
                dedupe_key TEXT NOT NULL,
                title TEXT NOT NULL,
                url TEXT,
                canonical_url TEXT,
                content TEXT NOT NULL DEFAULT '',
                image_url TEXT,
                image_asset TEXT,
                author TEXT,
                published_at TEXT,
                fetched_at TEXT NOT NULL,
                UNIQUE(source_id, dedupe_key)
            );
            CREATE INDEX IF NOT EXISTS idx_news_items_published
                ON news_items(published_at DESC, fetched_at DESC);
            CREATE INDEX IF NOT EXISTS idx_news_items_source
                ON news_items(source_id, published_at DESC, fetched_at DESC);
            CREATE INDEX IF NOT EXISTS idx_news_sources_active
                ON news_sources(is_active, last_checked_at);
            CREATE TABLE IF NOT EXISTS interest_import_batches (
                id TEXT PRIMARY KEY,
                browser TEXT NOT NULL,
                profile_id TEXT NOT NULL,
                range_start TEXT NOT NULL,
                range_end TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'running',
                visits_read INTEGER NOT NULL DEFAULT 0,
                events_added INTEGER NOT NULL DEFAULT 0,
                started_at TEXT NOT NULL,
                completed_at TEXT,
                error TEXT
            );
            CREATE TABLE IF NOT EXISTS interest_events (
                id TEXT PRIMARY KEY,
                origin TEXT NOT NULL,
                event_type TEXT NOT NULL,
                occurred_at TEXT NOT NULL,
                source_id TEXT REFERENCES news_sources(id) ON DELETE SET NULL,
                news_item_id TEXT REFERENCES news_items(id) ON DELETE SET NULL,
                canonical_url TEXT,
                title TEXT,
                topic_key TEXT,
                transition TEXT,
                duration_ms INTEGER,
                dedupe_key TEXT UNIQUE,
                import_batch_id TEXT REFERENCES interest_import_batches(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_interest_events_time
                ON interest_events(occurred_at DESC);
            CREATE INDEX IF NOT EXISTS idx_interest_events_item
                ON interest_events(news_item_id, occurred_at DESC);
            CREATE INDEX IF NOT EXISTS idx_interest_events_url
                ON interest_events(canonical_url, occurred_at DESC);
            CREATE INDEX IF NOT EXISTS idx_interest_events_topic
                ON interest_events(topic_key, occurred_at DESC);
            CREATE TABLE IF NOT EXISTS interest_profile_runs (
                id TEXT PRIMARY KEY,
                algorithm_version TEXT NOT NULL,
                window_start TEXT NOT NULL,
                window_end TEXT NOT NULL,
                generated_at TEXT NOT NULL,
                event_count INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS interest_topics (
                id TEXT PRIMARY KEY,
                profile_id TEXT NOT NULL REFERENCES interest_profile_runs(id) ON DELETE CASCADE,
                topic_key TEXT NOT NULL,
                label TEXT NOT NULL,
                score REAL NOT NULL,
                evidence_count INTEGER NOT NULL DEFAULT 0,
                last_seen_at TEXT,
                keywords_json TEXT NOT NULL DEFAULT '[]',
                UNIQUE(profile_id, topic_key)
            );
            CREATE INDEX IF NOT EXISTS idx_interest_topics_profile
                ON interest_topics(profile_id, score DESC);
            CREATE TABLE IF NOT EXISTS topic_suggestions (
                id TEXT PRIMARY KEY,
                profile_id TEXT NOT NULL REFERENCES interest_profile_runs(id) ON DELETE CASCADE,
                provider TEXT NOT NULL,
                platform_topic_id TEXT NOT NULL,
                title TEXT NOT NULL,
                topic_group TEXT NOT NULL DEFAULT '',
                score REAL NOT NULL,
                reason TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending',
                source_id TEXT REFERENCES news_sources(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(profile_id, provider, platform_topic_id)
            );
            CREATE INDEX IF NOT EXISTS idx_topic_suggestions_status
                ON topic_suggestions(status, score DESC);
            """
        )
        columns = {
            str(row["name"])
            for row in connection.execute("PRAGMA table_info(news_sources)").fetchall()
        }
        if "source_type" not in columns:
            connection.execute(
                "ALTER TABLE news_sources ADD COLUMN source_type TEXT NOT NULL DEFAULT 'rss'"
            )
        if "feed_url" not in columns:
            connection.execute("ALTER TABLE news_sources ADD COLUMN feed_url TEXT")
        if "icon_url" not in columns:
            connection.execute("ALTER TABLE news_sources ADD COLUMN icon_url TEXT")
        if "icon_asset" not in columns:
            connection.execute("ALTER TABLE news_sources ADD COLUMN icon_asset TEXT")
        if "is_deleted" not in columns:
            connection.execute(
                "ALTER TABLE news_sources ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0"
            )
        # 旧版的停用订阅按新的删除语义隐藏，但继续保留来源和历史文章。
        connection.execute(
            "UPDATE news_sources SET is_deleted = 1 WHERE is_active = 0 AND is_deleted = 0"
        )
        item_columns = {
            str(row["name"])
            for row in connection.execute("PRAGMA table_info(news_items)").fetchall()
        }
        if "image_url" not in item_columns:
            connection.execute("ALTER TABLE news_items ADD COLUMN image_url TEXT")
        if "image_asset" not in item_columns:
            connection.execute("ALTER TABLE news_items ADD COLUMN image_asset TEXT")
        if "canonical_url" not in item_columns:
            connection.execute("ALTER TABLE news_items ADD COLUMN canonical_url TEXT")
        event_columns = {
            str(row["name"])
            for row in connection.execute("PRAGMA table_info(interest_events)").fetchall()
        }
        if "transition" not in event_columns:
            connection.execute("ALTER TABLE interest_events ADD COLUMN transition TEXT")
        for item in connection.execute(
            "SELECT id, url FROM news_items WHERE canonical_url IS NULL AND url IS NOT NULL"
        ).fetchall():
            canonical_url = canonicalize_url(str(item["url"]))
            if canonical_url:
                connection.execute(
                    "UPDATE news_items SET canonical_url = ? WHERE id = ?",
                    (canonical_url, item["id"]),
                )
        legacy_sources = connection.execute(
            "SELECT id, url FROM news_sources WHERE source_type = 'rss'"
        ).fetchall()
        for source in legacy_sources:
            try:
                forum_name = parse_forum_name(str(source["url"]))
            except ValueError:
                continue
            if forum_name:
                connection.execute(
                    "UPDATE news_sources SET source_type = 'tieba', title = ? WHERE id = ?",
                    (forum_name, source["id"]),
                )
        # 把已有订阅作为低权重正向信号纳入首次兴趣分析。
        sources = connection.execute(
            "SELECT id, url, title, created_at FROM news_sources"
        ).fetchall()
        for source in sources:
            dedupe_key = f"migration:subscription:{source['id']}"
            existing_subscription_event = connection.execute(
                """
                SELECT 1 FROM interest_events
                WHERE source_id = ? AND event_type = 'subscription_added'
                LIMIT 1
                """,
                (source["id"],),
            ).fetchone()
            if existing_subscription_event:
                continue
            connection.execute(
                """
                INSERT OR IGNORE INTO interest_events (
                    id, origin, event_type, occurred_at, source_id,
                    canonical_url, title, dedupe_key, created_at
                ) VALUES (?, 'subscription', 'subscription_added', ?, ?, ?, ?, ?, ?)
                """,
                (
                    uuid.uuid4().hex,
                    source["created_at"],
                    source["id"],
                    canonicalize_url(str(source["url"])),
                    source["title"],
                    dedupe_key,
                    source["created_at"],
                ),
            )
        connection.execute(
            """
            UPDATE interest_import_batches
            SET status = 'cancelled', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                error = 'TabKeep 重启后取消了未完成的导入'
            WHERE status = 'running'
            """
        )


def get_source(source_id: str) -> dict[str, object] | None:
    """按 ID 查询订阅源及条目数。"""
    with connect() as connection:
        row = connection.execute(
            """
            SELECT s.*, COUNT(i.id) AS item_count
            FROM news_sources AS s
            LEFT JOIN news_items AS i ON i.source_id = s.id
            WHERE s.id = ?
            GROUP BY s.id
            """,
            (source_id,),
        ).fetchone()
    return dict(row) if row else None


def get_source_by_url(url: str) -> dict[str, object] | None:
    """按规范化地址查询订阅源。"""
    with connect() as connection:
        row = connection.execute("SELECT * FROM news_sources WHERE url = ?", (url,)).fetchone()
    return dict(row) if row else None


def create_source(
    source_id: str,
    url: str,
    title: str,
    created_at: str,
    source_type: str = "rss",
) -> None:
    """保存一个新订阅源。"""
    with connect() as connection:
        connection.execute(
            "INSERT INTO news_sources (id, url, title, created_at, source_type) VALUES (?, ?, ?, ?, ?)",
            (source_id, url, title, created_at, source_type),
        )


def delete_source_subscription(source_id: str) -> None:
    """从订阅列表移除来源并停止采集，保留来源记录和历史文章。"""
    with connect() as connection:
        connection.execute(
            "UPDATE news_sources SET is_active = 0, is_deleted = 1 WHERE id = ?",
            (source_id,),
        )


def restore_source_subscription(source_id: str) -> None:
    """重新订阅已移除的来源，并沿用原有历史记录。"""
    with connect() as connection:
        connection.execute(
            "UPDATE news_sources SET is_active = 1, is_deleted = 0 WHERE id = ?",
            (source_id,),
        )


def set_source_feed_url(source_id: str, feed_url: str) -> None:
    """缓存自动发现或重定向后的 RSS/Atom 地址。"""
    with connect() as connection:
        connection.execute(
            "UPDATE news_sources SET feed_url = ? WHERE id = ?",
            (feed_url, source_id),
        )


def set_source_icon(source_id: str, icon_url: str, icon_asset: str) -> None:
    """保存来源图标地址及其本地缓存文件名。"""
    with connect() as connection:
        connection.execute(
            "UPDATE news_sources SET icon_url = ?, icon_asset = ? WHERE id = ?",
            (icon_url, icon_asset, source_id),
        )


def list_sources() -> list[dict[str, object]]:
    """列出当前订阅源；已移除来源仍留在本地供历史资讯引用。"""
    with connect() as connection:
        rows = connection.execute(
            """
            SELECT s.*, COUNT(i.id) AS item_count
            FROM news_sources AS s
            LEFT JOIN news_items AS i ON i.source_id = s.id
            WHERE s.is_deleted = 0
            GROUP BY s.id
            ORDER BY s.is_active DESC, s.created_at DESC
            """
        ).fetchall()
    return [dict(row) for row in rows]


def count_items() -> int:
    """统计全部历史资讯，包含已移除订阅源的文章。"""
    with connect() as connection:
        row = connection.execute("SELECT COUNT(*) FROM news_items").fetchone()
    return int(row[0]) if row else 0


def list_due_source_ids(cutoff: str) -> list[str]:
    """读取从未检查或检查时间早于截止时间的启用源。"""
    with connect() as connection:
        rows = connection.execute(
            """
            SELECT id FROM news_sources
            WHERE is_active = 1 AND is_deleted = 0
                AND (last_checked_at IS NULL OR last_checked_at <= ?)
            ORDER BY created_at
            """,
            (cutoff,),
        ).fetchall()
    return [str(row["id"]) for row in rows]


def complete_fetch(
    source_id: str,
    title: str | None,
    etag: str | None,
    last_modified: str | None,
    timestamp: str,
    entries: list[dict[str, str | None]],
) -> int:
    """写入成功抓取的条目和 HTTP 缓存信息，返回新增条目数。"""
    inserted = 0
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            """
            UPDATE news_sources
            SET title = COALESCE(NULLIF(?, ''), title),
                etag = ?, last_modified = ?, last_checked_at = ?,
                last_success_at = ?, last_error = NULL
            WHERE id = ?
            """,
            (title, etag, last_modified, timestamp, timestamp, source_id),
        )
        for entry in entries:
            existing = connection.execute(
                "SELECT id FROM news_items WHERE source_id = ? AND dedupe_key = ?",
                (source_id, entry["dedupe_key"]),
            ).fetchone()
            values = (
                entry["title"],
                entry["url"],
                canonicalize_url(entry["url"]),
                entry["content"] or "",
                entry.get("image_url"),
                entry.get("image_asset"),
                entry["author"],
                entry["published_at"],
                timestamp,
            )
            if existing:
                connection.execute(
                    """
                    UPDATE news_items
                    SET title = ?, url = ?, canonical_url = ?, content = ?, author = ?,
                        published_at = ?, fetched_at = ?,
                        image_url = COALESCE(?, image_url),
                        image_asset = CASE
                            WHEN ? IS NULL THEN image_asset
                            WHEN ? = image_url THEN COALESCE(?, image_asset)
                            ELSE ?
                        END
                    WHERE source_id = ? AND dedupe_key = ?
                    """,
                    (
                        values[0], values[1], values[2], values[3], values[6], values[7], values[8],
                        values[4], values[4], values[5], values[5], values[5],
                        source_id, entry["dedupe_key"],
                    ),
                )
            else:
                connection.execute(
                    """
                    INSERT INTO news_items (
                        id, source_id, dedupe_key, title, url, canonical_url, content, author,
                        published_at, fetched_at, image_url, image_asset
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        entry["id"],
                        source_id,
                        entry["dedupe_key"],
                        values[0], values[1], values[2], values[3], values[6], values[7], values[8],
                        values[4], values[5],
                    ),
                )
                inserted += 1
    return inserted


def complete_unchanged(
    source_id: str,
    etag: str | None,
    last_modified: str | None,
    timestamp: str,
) -> None:
    """记录 304 未变化响应。"""
    with connect() as connection:
        connection.execute(
            """
            UPDATE news_sources
            SET etag = COALESCE(?, etag),
                last_modified = COALESCE(?, last_modified),
                last_checked_at = ?, last_success_at = ?, last_error = NULL
            WHERE id = ?
            """,
            (etag, last_modified, timestamp, timestamp, source_id),
        )


def record_failure(source_id: str, timestamp: str, message: str) -> None:
    """记录本次采集失败，同时保留上次成功条目。"""
    with connect() as connection:
        connection.execute(
            "UPDATE news_sources SET last_checked_at = ?, last_error = ? WHERE id = ?",
            (timestamp, message[:1000], source_id),
        )


def list_items(source_id: str | None, limit: int, offset: int) -> tuple[list[dict[str, object]], int]:
    """分页读取条目，可选按来源筛选。"""
    where_sql = "WHERE i.source_id = ?" if source_id else ""
    params: tuple[object, ...] = (source_id,) if source_id else ()
    with connect() as connection:
        total = int(
            connection.execute(
                f"SELECT COUNT(*) FROM news_items AS i {where_sql}", params
            ).fetchone()[0]
        )
        rows = connection.execute(
            f"""
            SELECT i.*, s.title AS source_title, s.icon_asset AS source_icon_asset,
                   (SELECT e.event_type FROM interest_events AS e
                    WHERE e.news_item_id = i.id AND e.event_type IN ('like', 'not_interested')
                    ORDER BY e.occurred_at DESC, e.created_at DESC, e.rowid DESC LIMIT 1)
                    AS user_feedback
            FROM news_items AS i
            JOIN news_sources AS s ON s.id = i.source_id
            {where_sql}
            ORDER BY COALESCE(i.published_at, i.fetched_at) DESC, i.fetched_at DESC
            LIMIT ? OFFSET ?
            """,
            (*params, limit, offset),
        ).fetchall()
    return [dict(row) for row in rows], total


def search_items(
    query: str,
    published_after: str | None,
    limit: int,
    offset: int,
) -> tuple[list[dict[str, object]], int]:
    """在本机已采集资讯标题、正文和来源名中按关键词检索。"""
    terms = [part.strip() for part in query.split() if part.strip()]
    conditions: list[str] = []
    params: list[object] = []
    for term in terms:
        escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        conditions.append("(i.title LIKE ? ESCAPE '\\' OR i.content LIKE ? ESCAPE '\\' OR s.title LIKE ? ESCAPE '\\')")
        pattern = f"%{escaped}%"
        params.extend((pattern, pattern, pattern))
    if published_after:
        conditions.append("COALESCE(i.published_at, i.fetched_at) >= ?")
        params.append(published_after)
    where_sql = "WHERE " + " AND ".join(conditions) if conditions else ""
    with connect() as connection:
        total = int(
            connection.execute(
                f"SELECT COUNT(*) FROM news_items AS i JOIN news_sources AS s ON s.id = i.source_id {where_sql}",
                tuple(params),
            ).fetchone()[0]
        )
        rows = connection.execute(
            f"""
            SELECT i.*, s.title AS source_title, s.icon_asset AS source_icon_asset
            FROM news_items AS i
            JOIN news_sources AS s ON s.id = i.source_id
            {where_sql}
            ORDER BY COALESCE(i.published_at, i.fetched_at) DESC, i.fetched_at DESC
            LIMIT ? OFFSET ?
            """,
            (*params, limit, offset),
        ).fetchall()
    return [dict(row) for row in rows], total


def list_recommendation_candidates(source_id: str | None = None) -> list[dict[str, object]]:
    """读取启用订阅源的资讯，供本地推荐排序使用。"""
    where_sql = "WHERE s.is_active = 1"
    params: tuple[object, ...] = ()
    if source_id:
        where_sql += " AND i.source_id = ?"
        params = (source_id,)
    with connect() as connection:
        rows = connection.execute(
            f"""
            SELECT i.*, s.title AS source_title, s.icon_asset AS source_icon_asset,
                   (SELECT e.event_type FROM interest_events AS e
                    WHERE e.news_item_id = i.id AND e.event_type IN ('like', 'not_interested')
                    ORDER BY e.occurred_at DESC, e.created_at DESC, e.rowid DESC LIMIT 1)
                    AS user_feedback
            FROM news_items AS i
            JOIN news_sources AS s ON s.id = i.source_id
            {where_sql}
            ORDER BY COALESCE(i.published_at, i.fetched_at) DESC, i.fetched_at DESC
            """,
            params,
        ).fetchall()
    return [dict(row) for row in rows]


def get_item(item_id: str) -> dict[str, object] | None:
    """读取单条资讯及其来源信息，供行为事件使用。"""
    with connect() as connection:
        row = connection.execute(
            """
            SELECT i.*, s.title AS source_title
            FROM news_items AS i
            JOIN news_sources AS s ON s.id = i.source_id
            WHERE i.id = ?
            """,
            (item_id,),
        ).fetchone()
    return dict(row) if row else None


def find_item_by_canonical_url(canonical_url: str) -> dict[str, object] | None:
    """按规范化地址关联最近采集到的资讯条目。"""
    with connect() as connection:
        row = connection.execute(
            """
            SELECT id, source_id, title
            FROM news_items
            WHERE canonical_url = ?
            ORDER BY fetched_at DESC
            LIMIT 1
            """,
            (canonical_url,),
        ).fetchone()
    return dict(row) if row else None


def find_items_by_canonical_urls(canonical_urls: list[str]) -> dict[str, dict[str, object]]:
    """批量匹配已采集资讯，供浏览历史导入减少 SQLite 连接次数。"""
    result: dict[str, dict[str, object]] = {}
    unique_urls = list(dict.fromkeys(url for url in canonical_urls if url))
    with connect() as connection:
        for offset in range(0, len(unique_urls), 500):
            chunk = unique_urls[offset:offset + 500]
            placeholders = ",".join("?" for _ in chunk)
            rows = connection.execute(
                f"""
                SELECT id, source_id, canonical_url, title
                FROM news_items
                WHERE canonical_url IN ({placeholders})
                ORDER BY fetched_at DESC
                """,
                chunk,
            ).fetchall()
            for row in rows:
                result.setdefault(str(row["canonical_url"]), dict(row))
    return result


def count_interest_events(window_start: str | None = None, window_end: str | None = None) -> int:
    """统计全部或指定时间范围内的本地行为事件数量。"""
    conditions: list[str] = []
    params: list[object] = []
    if window_start is not None:
        conditions.append("occurred_at >= ?")
        params.append(window_start)
    if window_end is not None:
        conditions.append("occurred_at <= ?")
        params.append(window_end)
    where_sql = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    with connect() as connection:
        row = connection.execute(
            f"SELECT COUNT(*) FROM interest_events {where_sql}", params
        ).fetchone()
    return int(row[0]) if row else 0


def insert_interest_event(event: dict[str, object]) -> bool:
    """追加一条兴趣事件；重复去重键返回 False。"""
    with connect() as connection:
        cursor = connection.execute(
            """
            INSERT OR IGNORE INTO interest_events (
                id, origin, event_type, occurred_at, source_id, news_item_id,
                canonical_url, title, topic_key, transition, duration_ms, dedupe_key,
                import_batch_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event["id"], event["origin"], event["event_type"], event["occurred_at"],
                event.get("source_id"), event.get("news_item_id"),
                event.get("canonical_url"), event.get("title"), event.get("topic_key"),
                event.get("transition"), event.get("duration_ms"), event.get("dedupe_key"),
                event.get("import_batch_id"), event["created_at"],
            ),
        )
    return cursor.rowcount > 0


def insert_interest_events(events: list[dict[str, object]], cancel_event: Event | None = None) -> int:
    """在一个事务中追加多条事件，返回实际新增数量。"""
    inserted = 0
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        for event in events:
            if cancel_event is not None and cancel_event.is_set():
                raise InterruptedError("浏览器历史导入已取消")
            cursor = connection.execute(
                """
                INSERT OR IGNORE INTO interest_events (
                    id, origin, event_type, occurred_at, source_id, news_item_id,
                    canonical_url, title, topic_key, transition, duration_ms, dedupe_key,
                    import_batch_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event["id"], event["origin"], event["event_type"], event["occurred_at"],
                    event.get("source_id"), event.get("news_item_id"),
                    event.get("canonical_url"), event.get("title"), event.get("topic_key"),
                    event.get("transition"), event.get("duration_ms"), event.get("dedupe_key"),
                    event.get("import_batch_id"), event["created_at"],
                ),
            )
            inserted += max(cursor.rowcount, 0)
    return inserted


def list_interest_events(window_start: str, window_end: str) -> list[dict[str, object]]:
    """读取画像时间范围内的兴趣事件。"""
    with connect() as connection:
        rows = connection.execute(
            """
            SELECT e.*, COALESCE(e.title, i.title, s.title, '') AS display_title,
                   i.title AS linked_item_title, i.content AS linked_item_content
            FROM interest_events AS e
            LEFT JOIN news_items AS i ON i.id = e.news_item_id
            LEFT JOIN news_sources AS s ON s.id = e.source_id
            WHERE e.occurred_at >= ? AND e.occurred_at <= ?
            ORDER BY e.occurred_at DESC, e.created_at DESC, e.rowid DESC
            """,
            (window_start, window_end),
        ).fetchall()
    return [dict(row) for row in rows]


def list_reading_history(limit: int, offset: int) -> tuple[list[dict[str, object]], int]:
    """按最近打开时间分页读取点击过“阅读原文”的资讯。"""
    with connect() as connection:
        total = int(
            connection.execute(
                """
                SELECT COUNT(DISTINCT news_item_id)
                FROM interest_events
                WHERE event_type = 'open_original' AND news_item_id IS NOT NULL
                """
            ).fetchone()[0]
        )
        rows = connection.execute(
            """
            SELECT i.*, s.title AS source_title, s.icon_asset AS source_icon_asset,
                   MAX(e.occurred_at) AS last_opened_at, COUNT(e.id) AS open_count,
                   (SELECT f.event_type FROM interest_events AS f
                    WHERE f.news_item_id = i.id AND f.event_type IN ('like', 'not_interested')
                    ORDER BY f.occurred_at DESC, f.created_at DESC, f.rowid DESC LIMIT 1)
                    AS user_feedback
            FROM interest_events AS e
            JOIN news_items AS i ON i.id = e.news_item_id
            JOIN news_sources AS s ON s.id = i.source_id
            WHERE e.event_type = 'open_original' AND e.news_item_id IS NOT NULL
            GROUP BY i.id
            ORDER BY last_opened_at DESC, i.id
            LIMIT ? OFFSET ?
            """,
            (limit, offset),
        ).fetchall()
    return [dict(row) for row in rows], total


def create_interest_import_batch(
    batch_id: str,
    browser: str,
    profile_id: str,
    range_start: str,
    range_end: str,
    started_at: str,
) -> None:
    """记录一次本机浏览器历史导入。"""
    with connect() as connection:
        connection.execute(
            """
            INSERT INTO interest_import_batches (
                id, browser, profile_id, range_start, range_end, started_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (batch_id, browser, profile_id, range_start, range_end, started_at),
        )


def finish_interest_import_batch(
    batch_id: str,
    status: str,
    visits_read: int,
    events_added: int,
    completed_at: str,
    error: str | None = None,
) -> None:
    """保存导入批次结果，错误文本限制长度且不包含历史内容。"""
    with connect() as connection:
        connection.execute(
            """
            UPDATE interest_import_batches
            SET status = ?, visits_read = ?, events_added = ?, completed_at = ?, error = ?
            WHERE id = ?
            """,
            (status, visits_read, events_added, completed_at, error[:500] if error else None, batch_id),
        )


def get_interest_import_batch(batch_id: str) -> dict[str, object] | None:
    """读取浏览器历史导入批次状态。"""
    with connect() as connection:
        row = connection.execute(
            "SELECT * FROM interest_import_batches WHERE id = ?",
            (batch_id,),
        ).fetchone()
    return dict(row) if row else None


def save_interest_profile(
    profile_id: str,
    algorithm_version: str,
    window_start: str,
    window_end: str,
    generated_at: str,
    event_count: int,
    topics: list[dict[str, object]],
) -> None:
    """保存一个可追溯的兴趣画像快照及其主题。"""
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            """
            INSERT INTO interest_profile_runs (
                id, algorithm_version, window_start, window_end, generated_at, event_count
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (profile_id, algorithm_version, window_start, window_end, generated_at, event_count),
        )
        connection.executemany(
            """
            INSERT INTO interest_topics (
                id, profile_id, topic_key, label, score, evidence_count,
                last_seen_at, keywords_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    topic["id"], profile_id, topic["topic_key"], topic["label"],
                    topic["score"], topic["evidence_count"], topic.get("last_seen_at"),
                    topic["keywords_json"],
                )
                for topic in topics
            ],
        )


def get_latest_interest_profile() -> dict[str, object] | None:
    """读取最近一次兴趣画像及主题列表。"""
    with connect() as connection:
        profile = connection.execute(
            "SELECT * FROM interest_profile_runs ORDER BY generated_at DESC LIMIT 1"
        ).fetchone()
        if profile is None:
            return None
        topics = connection.execute(
            "SELECT * FROM interest_topics WHERE profile_id = ? ORDER BY score DESC",
            (profile["id"],),
        ).fetchall()
    result = dict(profile)
    result["topics"] = [dict(row) for row in topics]
    return result


def save_topic_suggestions(
    profile_id: str,
    provider: str,
    suggestions: list[dict[str, object]],
    timestamp: str,
) -> None:
    """保存一次画像对应的话题候选；不覆盖用户已作出的决定。"""
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        for suggestion in suggestions:
            connection.execute(
                """
                INSERT INTO topic_suggestions (
                    id, profile_id, provider, platform_topic_id, title, topic_group,
                    score, reason, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                ON CONFLICT(profile_id, provider, platform_topic_id) DO UPDATE SET
                    title = excluded.title,
                    topic_group = excluded.topic_group,
                    score = excluded.score,
                    reason = excluded.reason,
                    updated_at = excluded.updated_at
                WHERE topic_suggestions.status = 'pending'
                """,
                (
                    suggestion["id"], profile_id, provider, suggestion["platform_topic_id"],
                    suggestion["title"], suggestion.get("topic_group", ""),
                    suggestion["score"], suggestion.get("reason", ""), timestamp, timestamp,
                ),
            )


def list_topic_suggestions(profile_id: str) -> list[dict[str, object]]:
    """列出指定画像的话题候选。"""
    with connect() as connection:
        rows = connection.execute(
            """
            SELECT * FROM topic_suggestions
            WHERE profile_id = ?
            ORDER BY score DESC, title
            """,
            (profile_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def get_topic_suggestion(suggestion_id: str) -> dict[str, object] | None:
    """按 ID 查询一个话题候选。"""
    with connect() as connection:
        row = connection.execute(
            "SELECT * FROM topic_suggestions WHERE id = ?",
            (suggestion_id,),
        ).fetchone()
    return dict(row) if row else None


def decide_topic_suggestion(
    suggestion_id: str,
    status: str,
    timestamp: str,
    source_id: str | None = None,
) -> bool:
    """更新话题候选状态；已处理的候选不会被重复改变。"""
    with connect() as connection:
        cursor = connection.execute(
            """
            UPDATE topic_suggestions
            SET status = ?, updated_at = ?, source_id = COALESCE(?, source_id)
            WHERE id = ? AND status = 'pending'
            """,
            (status, timestamp, source_id, suggestion_id),
        )
    return cursor.rowcount > 0


def clear_interest_data() -> dict[str, int]:
    """清除行为、导入批次和派生兴趣结果，不触碰订阅与资讯内容。"""
    with connect() as connection:
        counts = {
            "events": int(connection.execute("SELECT COUNT(*) FROM interest_events").fetchone()[0]),
            "batches": int(connection.execute("SELECT COUNT(*) FROM interest_import_batches").fetchone()[0]),
            "profiles": int(connection.execute("SELECT COUNT(*) FROM interest_profile_runs").fetchone()[0]),
            "suggestions": int(connection.execute("SELECT COUNT(*) FROM topic_suggestions").fetchone()[0]),
        }
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("DELETE FROM topic_suggestions")
        connection.execute("DELETE FROM interest_profile_runs")
        connection.execute("DELETE FROM interest_import_batches")
        connection.execute("DELETE FROM interest_events")
    return counts
