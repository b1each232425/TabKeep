"""资讯订阅与条目的 SQLite 持久化。"""

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from services import storage
from services.news.tieba import parse_forum_name


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
                    SET title = ?, url = ?, content = ?, author = ?,
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
                        values[0], values[1], values[2], values[5], values[6], values[7],
                        values[3], values[3], values[4], values[4], values[4],
                        source_id, entry["dedupe_key"],
                    ),
                )
            else:
                connection.execute(
                    """
                    INSERT INTO news_items (
                        id, source_id, dedupe_key, title, url, content, author,
                        published_at, fetched_at, image_url, image_asset
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        entry["id"],
                        source_id,
                        entry["dedupe_key"],
                        values[0], values[1], values[2], values[5], values[6], values[7],
                        values[3], values[4],
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
