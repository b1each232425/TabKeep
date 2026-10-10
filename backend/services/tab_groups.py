from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from threading import Lock
from urllib.parse import urlparse

from schemas.tab_group import (
    TabGroupArchive,
    TabGroupSnapshotRequest,
    TabGroupTab,
)
from services import storage

_init_lock = Lock()


@contextmanager
def _connection() -> Iterator[sqlite3.Connection]:
    data_dir = storage.DATA_DIR
    data_dir.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(data_dir / "tab_groups.sqlite3", timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with _init_lock:
        with _connection() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS tab_group_archives (
                    id TEXT PRIMARY KEY,
                    browser_instance_id TEXT NOT NULL,
                    browser TEXT NOT NULL,
                    title TEXT NOT NULL,
                    color TEXT NOT NULL,
                    collapsed INTEGER NOT NULL,
                    tabs_json TEXT NOT NULL,
                    fingerprint TEXT NOT NULL,
                    source_session_id TEXT NOT NULL,
                    native_group_id INTEGER NOT NULL,
                    native_window_id INTEGER,
                    is_open INTEGER NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_tab_group_archives_source
                    ON tab_group_archives(browser_instance_id, is_open);
                CREATE INDEX IF NOT EXISTS idx_tab_group_archives_fingerprint
                    ON tab_group_archives(browser_instance_id, fingerprint);

                CREATE TABLE IF NOT EXISTS tab_group_instances (
                    browser_instance_id TEXT PRIMARY KEY,
                    browser TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    is_online INTEGER NOT NULL,
                    inventory_complete INTEGER NOT NULL DEFAULT 0,
                    last_seen_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS tab_group_commands (
                    id TEXT PRIMARY KEY,
                    browser_instance_id TEXT NOT NULL,
                    archive_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    target TEXT,
                    payload_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    last_error TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_tab_group_commands_pending
                    ON tab_group_commands(browser_instance_id, status, created_at);

                CREATE TABLE IF NOT EXISTS tab_group_tombstones (
                    id TEXT PRIMARY KEY,
                    archive_id TEXT NOT NULL DEFAULT '',
                    browser_instance_id TEXT NOT NULL,
                    fingerprint TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    native_group_id INTEGER NOT NULL,
                    created_at TEXT NOT NULL
                );
                """
            )
            tombstone_columns = {
                str(row["name"])
                for row in conn.execute("PRAGMA table_info(tab_group_tombstones)").fetchall()
            }
            if "archive_id" not in tombstone_columns:
                conn.execute(
                    "ALTER TABLE tab_group_tombstones "
                    "ADD COLUMN archive_id TEXT NOT NULL DEFAULT ''"
                )
            instance_columns = {
                str(row["name"])
                for row in conn.execute("PRAGMA table_info(tab_group_instances)").fetchall()
            }
            if "inventory_complete" not in instance_columns:
                conn.execute(
                    "ALTER TABLE tab_group_instances "
                    "ADD COLUMN inventory_complete INTEGER NOT NULL DEFAULT 0"
                )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _restorable_tabs(tabs: list[TabGroupTab]) -> list[dict[str, object]]:
    result: list[dict[str, object]] = []
    for tab in sorted(tabs, key=lambda item: item.index):
        parsed = urlparse(tab.url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            continue
        result.append(tab.model_dump(mode="json"))
    return result


def _fingerprint(
    title: str,
    color: str,
    tabs: list[dict[str, object]],
) -> str:
    value = json.dumps(
        {
            "title": title,
            "color": color,
            "urls": [tab["url"] for tab in tabs],
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _archive_payload(row: sqlite3.Row) -> dict[str, object]:
    return {
        "id": row["id"],
        "browserInstanceId": row["browser_instance_id"],
        "browser": row["browser"],
        "title": row["title"],
        "color": row["color"],
        "collapsed": bool(row["collapsed"]),
        "tabs": json.loads(row["tabs_json"]),
        "isOpen": bool(row["is_open"]),
        "browserOnline": False,
        "browserReady": bool(row["browser_inventory_complete"])
        if "browser_inventory_complete" in row.keys()
        else False,
        "updatedAt": row["updated_at"],
        "sourceSessionId": row["source_session_id"],
        "nativeGroupId": row["native_group_id"],
    }


def _queue_tombstone_delete(
    conn: sqlite3.Connection,
    *,
    archive_id: str,
    browser_instance_id: str,
    now: str,
) -> None:
    if not archive_id:
        return
    pending = conn.execute(
        """
        SELECT 1 FROM tab_group_commands
        WHERE archive_id = ? AND kind = 'delete' AND status IN ('queued', 'sent')
        LIMIT 1
        """,
        (archive_id,),
    ).fetchone()
    if pending:
        return
    previous = conn.execute(
        """
        SELECT payload_json FROM tab_group_commands
        WHERE archive_id = ? AND kind = 'delete'
        ORDER BY created_at DESC, id DESC LIMIT 1
        """,
        (archive_id,),
    ).fetchone()
    if previous is None:
        return
    conn.execute(
        """
        INSERT INTO tab_group_commands (
            id, browser_instance_id, archive_id, kind, target,
            payload_json, status, created_at
        ) VALUES (?, ?, ?, 'delete', NULL, ?, 'queued', ?)
        """,
        (
            str(uuid.uuid4()),
            browser_instance_id,
            archive_id,
            previous["payload_json"],
            now,
        ),
    )


def sync_snapshot(req: TabGroupSnapshotRequest) -> list[dict[str, object]]:
    if not req.complete:
        return [
            {
                "nativeGroupId": group.nativeGroupId,
                "archiveId": None,
                "suppressed": False,
            }
            for group in req.groups
        ]
    init_db()
    now = _now()
    assignments: list[dict[str, object]] = []
    seen_archive_ids: set[str] = set()
    fingerprint_counts: dict[str, int] = {}
    for group in req.groups:
        restorable = _restorable_tabs(group.tabs)
        if restorable:
            fingerprint = _fingerprint(group.title or "未命名标签组", group.color, restorable)
            fingerprint_counts[fingerprint] = fingerprint_counts.get(fingerprint, 0) + 1

    with _connection() as conn:
        conn.execute(
            """
            INSERT INTO tab_group_instances (
                browser_instance_id, browser, session_id, is_online,
                inventory_complete, last_seen_at
            ) VALUES (?, ?, ?, 0, 0, ?)
            ON CONFLICT(browser_instance_id) DO UPDATE SET
                browser = excluded.browser,
                session_id = excluded.session_id,
                last_seen_at = excluded.last_seen_at
            """,
            (req.browserInstanceId, req.browser, req.browserSessionId, now),
        )

        tombstones = conn.execute(
            "SELECT id, archive_id, fingerprint, session_id, native_group_id "
            "FROM tab_group_tombstones WHERE browser_instance_id = ?",
            (req.browserInstanceId,),
        ).fetchall()
        tombstone_fingerprint_counts: dict[str, int] = {}
        for tombstone in tombstones:
            tombstone_fingerprint_counts[str(tombstone["fingerprint"])] = (
                tombstone_fingerprint_counts.get(str(tombstone["fingerprint"]), 0) + 1
        )
        for group in req.groups:
            tabs = _restorable_tabs(group.tabs)
            if not tabs:
                tombstone = next(
                    (
                        candidate
                        for candidate in tombstones
                        if (
                            bool(group.archiveId)
                            and candidate["archive_id"] == group.archiveId
                        )
                        or (
                            candidate["session_id"] == req.browserSessionId
                            and candidate["native_group_id"] == group.nativeGroupId
                        )
                    ),
                    None,
                )
                if tombstone:
                    conn.execute(
                        "UPDATE tab_group_tombstones SET session_id = ?, native_group_id = ? "
                        "WHERE id = ?",
                        (req.browserSessionId, group.nativeGroupId, tombstone["id"]),
                    )
                    _queue_tombstone_delete(
                        conn,
                        archive_id=str(tombstone["archive_id"]),
                        browser_instance_id=req.browserInstanceId,
                        now=now,
                    )
                    assignments.append(
                        {
                            "nativeGroupId": group.nativeGroupId,
                            "archiveId": None,
                            "suppressed": True,
                        }
                    )
                    continue

                row: sqlite3.Row | None = None
                if group.archiveId:
                    row = conn.execute(
                        "SELECT * FROM tab_group_archives "
                        "WHERE id = ? AND browser_instance_id = ?",
                        (group.archiveId, req.browserInstanceId),
                    ).fetchone()
                if row is None:
                    row = conn.execute(
                        "SELECT * FROM tab_group_archives "
                        "WHERE browser_instance_id = ? AND source_session_id = ? "
                        "AND native_group_id = ?",
                        (
                            req.browserInstanceId,
                            req.browserSessionId,
                            group.nativeGroupId,
                        ),
                    ).fetchone()
                if row is not None and row["id"] in seen_archive_ids:
                    row = None
                if row is not None:
                    archive_id = str(row["id"])
                    conn.execute(
                        """
                        UPDATE tab_group_archives SET
                            browser = ?, source_session_id = ?, native_group_id = ?,
                            native_window_id = ?, is_open = 1, updated_at = ?
                        WHERE id = ?
                        """,
                        (
                            req.browser,
                            req.browserSessionId,
                            group.nativeGroupId,
                            group.windowId,
                            now,
                            archive_id,
                        ),
                    )
                    seen_archive_ids.add(archive_id)
                    assignments.append(
                        {
                            "nativeGroupId": group.nativeGroupId,
                            "archiveId": archive_id,
                            "suppressed": False,
                        }
                    )
                else:
                    assignments.append(
                        {
                            "nativeGroupId": group.nativeGroupId,
                            "archiveId": None,
                            "suppressed": False,
                        }
                    )
                continue
            title = group.title or "未命名标签组"
            fingerprint = _fingerprint(title, group.color, tabs)
            tombstone = None
            for candidate in tombstones:
                matches_archive = bool(group.archiveId) and candidate["archive_id"] == group.archiveId
                matches_runtime_group = (
                    candidate["session_id"] == req.browserSessionId
                    and candidate["native_group_id"] == group.nativeGroupId
                )
                matches_unique_restart_group = (
                    req.complete
                    and candidate["session_id"] != req.browserSessionId
                    and candidate["fingerprint"] == fingerprint
                    and fingerprint_counts.get(fingerprint, 0) == 1
                    and tombstone_fingerprint_counts.get(fingerprint, 0) == 1
                )
                if matches_archive or matches_runtime_group or matches_unique_restart_group:
                    tombstone = candidate
                    break
            if tombstone:
                conn.execute(
                    """
                    UPDATE tab_group_tombstones
                    SET session_id = ?, native_group_id = ?
                    WHERE id = ?
                    """,
                    (req.browserSessionId, group.nativeGroupId, tombstone["id"]),
                )
                _queue_tombstone_delete(
                    conn,
                    archive_id=str(tombstone["archive_id"]),
                    browser_instance_id=req.browserInstanceId,
                    now=now,
                )
                assignments.append(
                    {
                        "nativeGroupId": group.nativeGroupId,
                        "archiveId": None,
                        "suppressed": True,
                    }
                )
                continue

            row: sqlite3.Row | None = None
            if group.archiveId:
                row = conn.execute(
                    """
                    SELECT * FROM tab_group_archives
                    WHERE id = ? AND browser_instance_id = ?
                    """,
                    (group.archiveId, req.browserInstanceId),
                ).fetchone()
            if row is None:
                row = conn.execute(
                    """
                    SELECT * FROM tab_group_archives
                    WHERE browser_instance_id = ? AND source_session_id = ?
                      AND native_group_id = ?
                    """,
                    (req.browserInstanceId, req.browserSessionId, group.nativeGroupId),
                ).fetchone()
            if row is not None and row["id"] in seen_archive_ids:
                row = None
            if row is None:
                if fingerprint_counts.get(fingerprint, 0) == 1:
                    candidates = conn.execute(
                        """
                        SELECT * FROM tab_group_archives
                        WHERE browser_instance_id = ? AND fingerprint = ?
                          AND source_session_id != ?
                          AND (
                              is_open = 1
                              OR EXISTS (
                                  SELECT 1 FROM tab_group_commands c
                                  WHERE c.archive_id = tab_group_archives.id
                                    AND c.kind = 'restore'
                                    AND c.status IN ('queued', 'sent')
                              )
                          )
                        ORDER BY updated_at DESC
                        """,
                        (req.browserInstanceId, fingerprint, req.browserSessionId),
                    ).fetchall()
                    unused = [
                        candidate for candidate in candidates
                        if candidate["id"] not in seen_archive_ids
                    ]
                    if len(unused) == 1:
                        row = unused[0]

            if row is None:
                archive_id = str(uuid.uuid4())
                conn.execute(
                    """
                    INSERT INTO tab_group_archives (
                        id, browser_instance_id, browser, title, color, collapsed,
                        tabs_json, fingerprint, source_session_id, native_group_id,
                        native_window_id, is_open, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
                    """,
                    (
                        archive_id,
                        req.browserInstanceId,
                        req.browser,
                        title,
                        group.color,
                        int(group.collapsed),
                        json.dumps(tabs, ensure_ascii=False),
                        fingerprint,
                        req.browserSessionId,
                        group.nativeGroupId,
                        group.windowId,
                        now,
                    ),
                )
            else:
                archive_id = str(row["id"])
                conn.execute(
                    """
                    UPDATE tab_group_archives SET
                        browser = ?, title = ?, color = ?, collapsed = ?, tabs_json = ?,
                        fingerprint = ?, source_session_id = ?, native_group_id = ?,
                        native_window_id = ?, is_open = 1, updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        req.browser,
                        title,
                        group.color,
                        int(group.collapsed),
                        json.dumps(tabs, ensure_ascii=False),
                        fingerprint,
                        req.browserSessionId,
                        group.nativeGroupId,
                        group.windowId,
                        now,
                        archive_id,
                    ),
                )
            seen_archive_ids.add(archive_id)
            assignments.append(
                {
                    "nativeGroupId": group.nativeGroupId,
                    "archiveId": archive_id,
                    "suppressed": False,
                }
            )

        if req.complete:
            current_rows = conn.execute(
                """
                SELECT id, native_group_id, fingerprint FROM tab_group_archives
                WHERE browser_instance_id = ? AND is_open = 1
                """,
                (req.browserInstanceId,),
            ).fetchall()
            for row in current_rows:
                if row["id"] not in seen_archive_ids:
                    conn.execute(
                        "UPDATE tab_group_archives SET is_open = 0 WHERE id = ?",
                        (row["id"],),
                    )

        current_native_ids = {group.nativeGroupId for group in req.groups}
        current_archive_ids = {
            group.archiveId for group in req.groups if group.archiveId
        }
        current_tombstones = conn.execute(
            """
            SELECT id, archive_id, fingerprint, session_id, native_group_id
            FROM tab_group_tombstones WHERE browser_instance_id = ?
            """,
            (req.browserInstanceId,),
        ).fetchall()
        for tombstone in current_tombstones:
            same_session = tombstone["session_id"] == req.browserSessionId
            still_present = (
                tombstone["native_group_id"] in current_native_ids
                or tombstone["archive_id"] in current_archive_ids
                if same_session
                else False
            )
            if not still_present and req.complete:
                conn.execute("DELETE FROM tab_group_tombstones WHERE id = ?", (tombstone["id"],))

    return assignments


def list_archives() -> list[TabGroupArchive]:
    init_db()
    with _connection() as conn:
        rows = conn.execute(
            """
            SELECT a.*, COALESCE(i.is_online, 0) AS browser_online,
                   i.last_seen_at AS browser_last_seen_at,
                   COALESCE(i.inventory_complete, 0) AS browser_inventory_complete
            FROM tab_group_archives a
            LEFT JOIN tab_group_instances i USING (browser_instance_id)
            ORDER BY a.updated_at DESC, a.title COLLATE NOCASE
            """
        ).fetchall()
    result: list[TabGroupArchive] = []
    now = datetime.now(timezone.utc)
    for row in rows:
        last_seen = row["browser_last_seen_at"]
        online = False
        if row["browser_online"] and last_seen:
            try:
                seen_at = datetime.fromisoformat(str(last_seen))
                online = (now - seen_at).total_seconds() <= 65
            except ValueError:
                online = False
        result.append(
            TabGroupArchive.model_validate(
                {
                    **_archive_payload(row),
                    "browserOnline": online,
                    "browserReady": online and bool(row["browser_inventory_complete"]),
                }
            )
        )
    return result


def get_archive(archive_id: str) -> dict[str, object] | None:
    init_db()
    with _connection() as conn:
        row = conn.execute(
            "SELECT * FROM tab_group_archives WHERE id = ?",
            (archive_id,),
        ).fetchone()
    return _archive_payload(row) if row else None


def create_command(
    *,
    browser_instance_id: str,
    archive_id: str,
    kind: str,
    target: str | None,
    payload: dict[str, object],
) -> str:
    init_db()
    command_id = str(uuid.uuid4())
    with _connection() as conn:
        conn.execute(
            """
            INSERT INTO tab_group_commands (
                id, browser_instance_id, archive_id, kind, target,
                payload_json, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)
            """,
            (
                command_id,
                browser_instance_id,
                archive_id,
                kind,
                target,
                json.dumps(payload, ensure_ascii=False),
                _now(),
            ),
        )
    return command_id


def delete_archive(archive_id: str) -> tuple[bool, str | None, str | None]:
    init_db()
    now = _now()
    with _connection() as conn:
        row = conn.execute(
            "SELECT * FROM tab_group_archives WHERE id = ?",
            (archive_id,),
        ).fetchone()
        if row is None:
            return False, None, None

        pending_restores = conn.execute(
            """
            SELECT id FROM tab_group_commands
            WHERE archive_id = ? AND kind = 'restore' AND status IN ('queued', 'sent')
            """,
            (archive_id,),
        ).fetchall()
        conn.execute(
            """
            UPDATE tab_group_commands SET status = 'cancelled', last_error = ?
            WHERE archive_id = ? AND kind = 'restore' AND status IN ('queued', 'sent')
            """,
            ("标签归档已删除", archive_id),
        )

        command_id: str | None = None
        status = "deleted"
        if row["is_open"] or pending_restores:
            snapshot = {
                "archiveId": archive_id,
                "nativeGroupId": row["native_group_id"],
                "browserSessionId": row["source_session_id"],
                "title": row["title"],
                "color": row["color"],
                "tabs": json.loads(row["tabs_json"]),
                "fingerprint": row["fingerprint"],
            }
            command_id = str(uuid.uuid4())
            conn.execute(
                """
                INSERT INTO tab_group_tombstones (
                    id, archive_id, browser_instance_id, fingerprint, session_id,
                    native_group_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    archive_id,
                    row["browser_instance_id"],
                    row["fingerprint"],
                    row["source_session_id"],
                    row["native_group_id"],
                    now,
                ),
            )
            conn.execute(
                """
                INSERT INTO tab_group_commands (
                    id, browser_instance_id, archive_id, kind, target,
                    payload_json, status, created_at
                ) VALUES (?, ?, ?, 'delete', NULL, ?, 'queued', ?)
                """,
                (
                    command_id,
                    row["browser_instance_id"],
                    archive_id,
                    json.dumps(snapshot, ensure_ascii=False),
                    now,
                ),
            )
            status = "queued"
        conn.execute("DELETE FROM tab_group_archives WHERE id = ?", (archive_id,))
        return True, status, command_id


def set_instance_state(
    browser_instance_id: str,
    browser: str,
    session_id: str,
    is_online: bool,
) -> None:
    init_db()
    now = _now()
    with _connection() as conn:
        conn.execute(
            """
            INSERT INTO tab_group_instances (
                browser_instance_id, browser, session_id, is_online,
                inventory_complete, last_seen_at
            ) VALUES (?, ?, ?, ?, 0, ?)
            ON CONFLICT(browser_instance_id) DO UPDATE SET
                browser = excluded.browser,
                session_id = excluded.session_id,
                is_online = excluded.is_online,
                inventory_complete = 0,
                last_seen_at = excluded.last_seen_at
            """,
            (browser_instance_id, browser, session_id, int(is_online), now),
        )


def touch_instance(browser_instance_id: str) -> None:
    init_db()
    with _connection() as conn:
        conn.execute(
            """
            UPDATE tab_group_instances SET is_online = 1, last_seen_at = ?
            WHERE browser_instance_id = ?
            """,
            (_now(), browser_instance_id),
        )


def set_instance_inventory_complete(browser_instance_id: str, complete: bool) -> None:
    init_db()
    with _connection() as conn:
        conn.execute(
            "UPDATE tab_group_instances SET inventory_complete = ? "
            "WHERE browser_instance_id = ?",
            (int(complete), browser_instance_id),
        )


def mark_instance_offline(browser_instance_id: str) -> None:
    init_db()
    with _connection() as conn:
        conn.execute(
            "UPDATE tab_group_instances "
            "SET is_online = 0, last_seen_at = ?, inventory_complete = 0 "
            "WHERE browser_instance_id = ?",
            (_now(), browser_instance_id),
        )


def instance_is_online(browser_instance_id: str) -> bool:
    init_db()
    now = datetime.now(timezone.utc)
    with _connection() as conn:
        row = conn.execute(
            "SELECT is_online, last_seen_at FROM tab_group_instances WHERE browser_instance_id = ?",
            (browser_instance_id,),
        ).fetchone()
    if not row or not row["is_online"]:
        return False
    try:
        return (now - datetime.fromisoformat(str(row["last_seen_at"]))).total_seconds() <= 65
    except ValueError:
        return False


def pending_commands(
    browser_instance_id: str,
    *,
    browser_session_id: str | None = None,
    inventory_complete: bool = True,
) -> list[dict[str, object]]:
    init_db()
    with _connection() as conn:
        rows = conn.execute(
            """
            SELECT * FROM tab_group_commands
            WHERE browser_instance_id = ? AND status IN ('queued', 'sent')
            ORDER BY created_at, id
            """,
            (browser_instance_id,),
        ).fetchall()
        commands = []
        for row in rows:
            payload = json.loads(row["payload_json"])
            if not inventory_complete and not (
                row["kind"] == "delete"
                and browser_session_id is not None
                and payload.get("browserSessionId") == browser_session_id
            ):
                continue
            commands.append((row, payload))
        conn.executemany(
            "UPDATE tab_group_commands SET status = 'sent' WHERE id = ?",
            [(row["id"],) for row, _payload in commands],
        )
    return [
        {
            "id": row["id"],
            "kind": row["kind"],
            "archiveId": row["archive_id"],
            "target": row["target"],
            "payload": payload,
        }
        for row, payload in commands
    ]


def complete_command(
    command_id: str,
    *,
    browser_instance_id: str,
    ok: bool,
    error: str | None = None,
) -> bool:
    init_db()
    with _connection() as conn:
        row = conn.execute(
            "SELECT kind, browser_instance_id, archive_id, payload_json, status "
            "FROM tab_group_commands "
            "WHERE id = ? AND browser_instance_id = ?",
            (command_id, browser_instance_id),
        ).fetchone()
        if row is None:
            return False
        if row["status"] == "cancelled":
            return False
        if ok:
            conn.execute(
                "UPDATE tab_group_commands SET status = 'completed', last_error = NULL WHERE id = ?",
                (command_id,),
            )
            if row["kind"] == "restore":
                conn.execute(
                    "UPDATE tab_group_archives SET is_open = 1 WHERE id = ?",
                    (row["archive_id"],),
                )
            return True
        conn.execute(
            "UPDATE tab_group_commands SET status = 'queued', last_error = ? WHERE id = ?",
            ((error or "命令执行失败")[:500], command_id),
        )
        return True


def browser_for_archive(archive_id: str) -> str | None:
    archive = get_archive(archive_id)
    return str(archive["browserInstanceId"]) if archive else None


def browser_instance_id_for_command(command_id: str) -> str | None:
    init_db()
    with _connection() as conn:
        row = conn.execute(
            "SELECT browser_instance_id FROM tab_group_commands WHERE id = ?",
            (command_id,),
        ).fetchone()
    return str(row["browser_instance_id"]) if row else None


def archive_to_command_payload(archive: dict[str, object]) -> dict[str, object]:
    return {
        "archiveId": archive["id"],
        "browserSessionId": archive["sourceSessionId"],
        "nativeGroupId": archive["nativeGroupId"],
        "title": archive["title"],
        "color": archive["color"],
        "collapsed": archive["collapsed"],
        "tabs": archive["tabs"],
    }
