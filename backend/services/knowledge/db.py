from __future__ import annotations

import hashlib
import sqlite3
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable

from schemas.knowledge import KnowledgeCitation, KnowledgeMessage, KnowledgeSession, KnowledgeStats
from services import storage
from services.knowledge.chunking import chunk_text
from services.knowledge.cjk import build_fts_query, segment_for_fts

DB_PATH = storage.DATA_DIR / "knowledge.db"


@dataclass
class IndexedChunk:
    id: str
    document_id: str
    title: str
    source_type: str
    url: str | None
    path: str | None
    content: str


@dataclass
class IndexResult:
    document_id: str
    indexed: bool
    chunk_count: int


def init_db() -> None:
    storage.DATA_DIR.mkdir(parents=True, exist_ok=True)
    with connection() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                source_type TEXT NOT NULL,
                title TEXT NOT NULL,
                url TEXT,
                path TEXT,
                note_id TEXT,
                content_hash TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                indexed_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chunks (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                content TEXT NOT NULL,
                char_len INTEGER NOT NULL,
                embedding_status TEXT NOT NULL DEFAULT 'disabled',
                FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
                chunk_id UNINDEXED,
                document_id UNINDEXED,
                title,
                content
            );

            CREATE TABLE IF NOT EXISTS graph_nodes (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                label TEXT NOT NULL,
                document_id TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS graph_edges (
                id TEXT PRIMARY KEY,
                source_id TEXT NOT NULL,
                target_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                weight REAL NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS knowledge_topics (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                summary TEXT NOT NULL DEFAULT '',
                keywords_json TEXT NOT NULL DEFAULT '[]',
                source_types_json TEXT NOT NULL DEFAULT '[]',
                document_count INTEGER NOT NULL DEFAULT 0,
                evidence_count INTEGER NOT NULL DEFAULT 0,
                relation_count INTEGER NOT NULL DEFAULT 0,
                confidence REAL NOT NULL DEFAULT 0,
                ai_enhanced INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS knowledge_topic_documents (
                topic_id TEXT NOT NULL,
                document_id TEXT NOT NULL,
                score REAL NOT NULL DEFAULT 0,
                reason TEXT NOT NULL DEFAULT '',
                snippet TEXT NOT NULL DEFAULT '',
                anchor TEXT,
                PRIMARY KEY(topic_id, document_id),
                FOREIGN KEY(topic_id) REFERENCES knowledge_topics(id) ON DELETE CASCADE,
                FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS knowledge_topic_evidence (
                id TEXT PRIMARY KEY,
                topic_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                label TEXT NOT NULL,
                document_id TEXT,
                weight REAL NOT NULL DEFAULT 1,
                FOREIGN KEY(topic_id) REFERENCES knowledge_topics(id) ON DELETE CASCADE,
                FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS knowledge_topic_relations (
                id TEXT PRIMARY KEY,
                source_topic_id TEXT NOT NULL,
                target_topic_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                label TEXT NOT NULL DEFAULT '',
                weight REAL NOT NULL DEFAULT 1,
                FOREIGN KEY(source_topic_id) REFERENCES knowledge_topics(id) ON DELETE CASCADE,
                FOREIGN KEY(target_topic_id) REFERENCES knowledge_topics(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS rag_sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS rag_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES rag_sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        _ensure_column(conn, "knowledge_topic_documents", "anchor", "TEXT")


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    if any(row["name"] == column for row in rows):
        return
    conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


@contextmanager
def connection() -> Iterable[sqlite3.Connection]:
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def upsert_document(
    *,
    source_type: str,
    title: str,
    content: str,
    url: str | None = None,
    path: str | None = None,
    note_id: str | None = None,
) -> tuple[IndexResult, list[IndexedChunk]]:
    init_db()
    now = now_iso()
    document_id = make_document_id(source_type, note_id or path or url or title)
    content_hash = sha1_text(content)
    chunks = chunk_text(content)

    with connection() as conn:
        old = conn.execute(
            "SELECT content_hash FROM documents WHERE id = ?",
            (document_id,),
        ).fetchone()
        if old and old["content_hash"] == content_hash:
            existing = load_chunks(conn, [row["id"] for row in conn.execute(
                "SELECT id FROM chunks WHERE document_id = ? ORDER BY chunk_index",
                (document_id,),
            ).fetchall()])
            return IndexResult(document_id, False, len(existing)), existing

        conn.execute("DELETE FROM chunk_fts WHERE document_id = ?", (document_id,))
        conn.execute("DELETE FROM chunks WHERE document_id = ?", (document_id,))
        conn.execute(
            """
            INSERT INTO documents (id, source_type, title, url, path, note_id, content_hash, updated_at, indexed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                source_type = excluded.source_type,
                title = excluded.title,
                url = excluded.url,
                path = excluded.path,
                note_id = excluded.note_id,
                content_hash = excluded.content_hash,
                updated_at = excluded.updated_at,
                indexed_at = excluded.indexed_at
            """,
            (document_id, source_type, title, url, path, note_id, content_hash, now, now),
        )

        indexed_chunks: list[IndexedChunk] = []
        for index, chunk in enumerate(chunks):
            chunk_id = f"{document_id}:{index}"
            conn.execute(
                """
                INSERT INTO chunks (id, document_id, chunk_index, content, char_len, embedding_status)
                VALUES (?, ?, ?, ?, ?, 'disabled')
                """,
                (chunk_id, document_id, index, chunk, len(chunk)),
            )
            conn.execute(
                "INSERT INTO chunk_fts (chunk_id, document_id, title, content) VALUES (?, ?, ?, ?)",
                (chunk_id, document_id, segment_for_fts(title), segment_for_fts(chunk)),
            )
            indexed_chunks.append(
                IndexedChunk(chunk_id, document_id, title, source_type, url, path, chunk)
            )

        upsert_document_node(conn, document_id, title, now)
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('last_indexed_at', ?)",
            (now,),
        )
        return IndexResult(document_id, True, len(indexed_chunks)), indexed_chunks


def mark_embedding_status(chunk_ids: Iterable[str], status: str) -> None:
    ids = list(chunk_ids)
    if not ids:
        return
    with connection() as conn:
        conn.executemany(
            "UPDATE chunks SET embedding_status = ? WHERE id = ?",
            [(status, chunk_id) for chunk_id in ids],
        )


def search_fts(query: str, limit: int) -> list[KnowledgeCitation]:
    init_db()
    fts_query = build_fts_query(query)
    if not fts_query:
        return []
    with connection() as conn:
        rows = conn.execute(
            """
            SELECT
                c.id AS chunk_id,
                c.document_id,
                c.content,
                d.title,
                d.source_type,
                d.url,
                d.path,
                bm25(chunk_fts) AS rank
            FROM chunk_fts
            JOIN chunks c ON c.id = chunk_fts.chunk_id
            JOIN documents d ON d.id = c.document_id
            WHERE chunk_fts MATCH ?
            ORDER BY rank
            LIMIT ?
            """,
            (fts_query, max(1, min(limit, 50))),
        ).fetchall()
    return [row_to_citation(row, score=1 / (1 + index)) for index, row in enumerate(rows)]


def get_chunks_by_ids(chunk_ids: list[str]) -> dict[str, KnowledgeCitation]:
    if not chunk_ids:
        return {}
    placeholders = ",".join("?" for _ in chunk_ids)
    with connection() as conn:
        rows = conn.execute(
            f"""
            SELECT
                c.id AS chunk_id,
                c.document_id,
                c.content,
                d.title,
                d.source_type,
                d.url,
                d.path
            FROM chunks c
            JOIN documents d ON d.id = c.document_id
            WHERE c.id IN ({placeholders})
            """,
            chunk_ids,
        ).fetchall()
    return {row["chunk_id"]: row_to_citation(row, score=0) for row in rows}


def get_stats(vector_available: bool = False, vector_message: str | None = None) -> KnowledgeStats:
    init_db()
    with connection() as conn:
        documents = conn.execute("SELECT COUNT(*) AS count FROM documents").fetchone()["count"]
        chunks = conn.execute("SELECT COUNT(*) AS count FROM chunks").fetchone()["count"]
        sessions = conn.execute("SELECT COUNT(*) AS count FROM rag_sessions").fetchone()["count"]
        last = conn.execute("SELECT value FROM meta WHERE key = 'last_indexed_at'").fetchone()
    return KnowledgeStats(
        documents=documents,
        chunks=chunks,
        sessions=sessions,
        lastIndexedAt=last["value"] if last else None,
        vectorAvailable=vector_available,
        vectorMessage=vector_message,
    )


def ensure_session(session_id: str | None, title: str) -> str:
    init_db()
    now = now_iso()
    sid = session_id or uuid.uuid4().hex
    clean_title = title.strip()[:80] or "知识库问答"
    with connection() as conn:
        row = conn.execute("SELECT id FROM rag_sessions WHERE id = ?", (sid,)).fetchone()
        if row:
            conn.execute("UPDATE rag_sessions SET updated_at = ? WHERE id = ?", (now, sid))
        else:
            conn.execute(
                "INSERT INTO rag_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (sid, clean_title, now, now),
            )
    return sid


def add_message(session_id: str, role: str, content: str) -> None:
    now = now_iso()
    with connection() as conn:
        conn.execute(
            "INSERT INTO rag_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
            (uuid.uuid4().hex, session_id, role, content, now),
        )
        conn.execute("UPDATE rag_sessions SET updated_at = ? WHERE id = ?", (now, session_id))


def list_sessions() -> list[KnowledgeSession]:
    init_db()
    with connection() as conn:
        rows = conn.execute(
            "SELECT id, title, created_at, updated_at FROM rag_sessions ORDER BY updated_at DESC LIMIT 50"
        ).fetchall()
    return [
        KnowledgeSession(
            id=row["id"],
            title=row["title"],
            createdAt=row["created_at"],
            updatedAt=row["updated_at"],
        )
        for row in rows
    ]


def list_messages(session_id: str) -> list[KnowledgeMessage]:
    init_db()
    with connection() as conn:
        rows = conn.execute(
            """
            SELECT id, session_id, role, content, created_at
            FROM rag_messages
            WHERE session_id = ?
            ORDER BY created_at ASC
            """,
            (session_id,),
        ).fetchall()
    return [
        KnowledgeMessage(
            id=row["id"],
            sessionId=row["session_id"],
            role=row["role"],
            content=row["content"],
            createdAt=row["created_at"],
        )
        for row in rows
    ]


def load_chunks(conn: sqlite3.Connection, chunk_ids: list[str]) -> list[IndexedChunk]:
    if not chunk_ids:
        return []
    placeholders = ",".join("?" for _ in chunk_ids)
    rows = conn.execute(
        f"""
        SELECT
            c.id AS chunk_id,
            c.document_id,
            c.content,
            d.title,
            d.source_type,
            d.url,
            d.path
        FROM chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE c.id IN ({placeholders})
        ORDER BY c.chunk_index
        """,
        chunk_ids,
    ).fetchall()
    return [
        IndexedChunk(
            id=row["chunk_id"],
            document_id=row["document_id"],
            title=row["title"],
            source_type=row["source_type"],
            url=row["url"],
            path=row["path"],
            content=row["content"],
        )
        for row in rows
    ]


def row_to_citation(row: sqlite3.Row, score: float) -> KnowledgeCitation:
    return KnowledgeCitation(
        documentId=row["document_id"],
        chunkId=row["chunk_id"],
        title=row["title"],
        sourceType=row["source_type"],
        url=row["url"],
        path=row["path"],
        content=row["content"],
        score=score,
    )


def upsert_document_node(conn: sqlite3.Connection, document_id: str, title: str, now: str) -> None:
    node_id = f"document:{document_id}"
    conn.execute(
        """
        INSERT INTO graph_nodes (id, kind, label, document_id, created_at)
        VALUES (?, 'document', ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET label = excluded.label, document_id = excluded.document_id
        """,
        (node_id, title, document_id, now),
    )


def make_document_id(source_type: str, stable_key: str) -> str:
    return hashlib.sha1(f"{source_type}:{stable_key}".encode("utf-8")).hexdigest()


def sha1_text(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")
