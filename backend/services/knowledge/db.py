from __future__ import annotations

import hashlib
import sqlite3
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable

from schemas.knowledge import (
    KnowledgeCitation,
    KnowledgeEvalCase,
    KnowledgeEvalCaseRequest,
    KnowledgeMessage,
    KnowledgeSession,
    KnowledgeStats,
)
from services import storage
from services.knowledge.chunking import split_paragraphs, chunk_text
from services.knowledge.cjk import build_fts_query, segment_for_fts

DB_PATH = storage.DATA_DIR / "knowledge.db"
EVAL_CASE_TYPES = {"keyword", "natural", "challenge", "negative"}


@dataclass
class IndexedChunk:
    id: str
    document_id: str
    paragraph_id: str | None
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
    paragraph_count: int = 0


@dataclass
class FtsSearchHit:
    citation: KnowledgeCitation
    raw_rank: float


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
                paragraph_id TEXT,
                chunk_index INTEGER NOT NULL,
                paragraph_chunk_index INTEGER NOT NULL DEFAULT 0,
                content TEXT NOT NULL,
                char_len INTEGER NOT NULL,
                embedding_status TEXT NOT NULL DEFAULT 'disabled',
                FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE,
                FOREIGN KEY(paragraph_id) REFERENCES paragraphs(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS paragraphs (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL,
                paragraph_index INTEGER NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                char_len INTEGER NOT NULL,
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

            CREATE TABLE IF NOT EXISTS rag_eval_cases (
                id TEXT PRIMARY KEY,
                question TEXT NOT NULL,
                case_type TEXT NOT NULL DEFAULT 'keyword',
                expected_text TEXT NOT NULL DEFAULT '',
                expected_path TEXT NOT NULL DEFAULT '',
                expected_title TEXT NOT NULL DEFAULT '',
                expected_document_id TEXT NOT NULL DEFAULT '',
                expected_paragraph_id TEXT NOT NULL DEFAULT '',
                expected_answer TEXT NOT NULL DEFAULT '',
                answer_keywords TEXT NOT NULL DEFAULT '',
                should_refuse INTEGER NOT NULL DEFAULT 0,
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        _ensure_column(conn, "chunks", "paragraph_id", "TEXT")
        _ensure_column(conn, "chunks", "paragraph_chunk_index", "INTEGER NOT NULL DEFAULT 0")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_paragraphs_document ON paragraphs(document_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_chunks_paragraph ON chunks(paragraph_id)")
        _ensure_column(conn, "knowledge_topic_documents", "anchor", "TEXT")
        _ensure_column(conn, "rag_eval_cases", "case_type", "TEXT NOT NULL DEFAULT 'keyword'")
        _ensure_column(conn, "rag_eval_cases", "expected_answer", "TEXT NOT NULL DEFAULT ''")
        _ensure_column(conn, "rag_eval_cases", "answer_keywords", "TEXT NOT NULL DEFAULT ''")
        _ensure_column(conn, "rag_eval_cases", "should_refuse", "INTEGER NOT NULL DEFAULT 0")


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
    paragraphs = split_paragraphs(content, default_title=title)

    with connection() as conn:
        old = conn.execute(
            "SELECT content_hash FROM documents WHERE id = ?",
            (document_id,),
        ).fetchone()
        has_paragraphs = (
            conn.execute(
                "SELECT 1 FROM paragraphs WHERE document_id = ? LIMIT 1",
                (document_id,),
            ).fetchone()
            is not None
        )
        if old and old["content_hash"] == content_hash and (has_paragraphs or not paragraphs):
            existing = load_chunks(conn, [row["id"] for row in conn.execute(
                "SELECT id FROM chunks WHERE document_id = ? ORDER BY chunk_index",
                (document_id,),
            ).fetchall()])
            return IndexResult(document_id, False, len(existing), count_paragraphs(conn, document_id)), existing

        conn.execute("DELETE FROM chunk_fts WHERE document_id = ?", (document_id,))
        conn.execute("DELETE FROM chunks WHERE document_id = ?", (document_id,))
        conn.execute("DELETE FROM paragraphs WHERE document_id = ?", (document_id,))
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
        for paragraph_index, paragraph in enumerate(paragraphs):
            paragraph_id = f"{document_id}:p{paragraph_index}"
            conn.execute(
                """
                INSERT INTO paragraphs (id, document_id, paragraph_index, title, content, char_len)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    paragraph_id,
                    document_id,
                    paragraph_index,
                    paragraph.title,
                    paragraph.content,
                    len(paragraph.content),
                ),
            )
            paragraph_chunks = chunk_text(paragraph.content)
            for paragraph_chunk_index, chunk in enumerate(paragraph_chunks):
                chunk_index = len(indexed_chunks)
                chunk_id = f"{paragraph_id}:c{paragraph_chunk_index}"
                display_title = display_paragraph_title(title, paragraph.title)
                fts_title = segment_for_fts(display_title)
                fts_content = segment_for_fts(f"{paragraph.title}\n{chunk}")
                conn.execute(
                    """
                    INSERT INTO chunks (
                        id,
                        document_id,
                        paragraph_id,
                        chunk_index,
                        paragraph_chunk_index,
                        content,
                        char_len,
                        embedding_status
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'disabled')
                    """,
                    (
                        chunk_id,
                        document_id,
                        paragraph_id,
                        chunk_index,
                        paragraph_chunk_index,
                        chunk,
                        len(chunk),
                    ),
                )
                conn.execute(
                    "INSERT INTO chunk_fts (chunk_id, document_id, title, content) VALUES (?, ?, ?, ?)",
                    (chunk_id, document_id, fts_title, fts_content),
                )
                indexed_chunks.append(
                    IndexedChunk(
                        chunk_id,
                        document_id,
                        paragraph_id,
                        display_title,
                        source_type,
                        url,
                        path,
                        chunk,
                    )
                )

        upsert_document_node(conn, document_id, title, now)
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('last_indexed_at', ?)",
            (now,),
        )
        return IndexResult(document_id, True, len(indexed_chunks), len(paragraphs)), indexed_chunks


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
    return [hit.citation for hit in search_fts_hits(query, limit)]


def search_fts_hits(query: str, limit: int) -> list[FtsSearchHit]:
    init_db()
    fts_query = build_fts_query(query)
    if not fts_query:
        return []
    with connection() as conn:
        rows = conn.execute(
            """
            SELECT
                c.id AS chunk_id,
                c.paragraph_id,
                c.document_id,
                c.content AS chunk_content,
                p.title AS paragraph_title,
                p.content AS paragraph_content,
                d.title AS document_title,
                d.source_type,
                d.url,
                d.path,
                bm25(chunk_fts) AS rank
            FROM chunk_fts
            JOIN chunks c ON c.id = chunk_fts.chunk_id
            JOIN documents d ON d.id = c.document_id
            LEFT JOIN paragraphs p ON p.id = c.paragraph_id
            WHERE chunk_fts MATCH ?
            ORDER BY rank
            LIMIT ?
            """,
            (fts_query, max(1, min(limit, 50))),
        ).fetchall()
    return [
        FtsSearchHit(
            citation=row_to_citation(row, score=1 / (1 + index)),
            raw_rank=float(row["rank"]),
        )
        for index, row in enumerate(rows)
    ]


def get_chunks_by_ids(chunk_ids: list[str]) -> dict[str, KnowledgeCitation]:
    if not chunk_ids:
        return {}
    placeholders = ",".join("?" for _ in chunk_ids)
    with connection() as conn:
        rows = conn.execute(
            f"""
            SELECT
                c.id AS chunk_id,
                c.paragraph_id,
                c.document_id,
                c.content AS chunk_content,
                p.title AS paragraph_title,
                p.content AS paragraph_content,
                d.title AS document_title,
                d.source_type,
                d.url,
                d.path
            FROM chunks c
            JOIN documents d ON d.id = c.document_id
            LEFT JOIN paragraphs p ON p.id = c.paragraph_id
            WHERE c.id IN ({placeholders})
            """,
            chunk_ids,
        ).fetchall()
    return {row["chunk_id"]: row_to_citation(row, score=0) for row in rows}


def get_vector_record_metadata(chunk_ids: list[str]) -> dict[str, dict]:
    ids = [chunk_id for chunk_id in dict.fromkeys(chunk_ids) if chunk_id]
    if not ids:
        return {}
    init_db()
    placeholders = ",".join("?" for _ in ids)
    with connection() as conn:
        rows = conn.execute(
            f"""
            SELECT
                c.id AS chunk_id,
                c.document_id,
                c.paragraph_id,
                d.title AS document_title,
                d.source_type,
                d.url,
                d.path,
                p.title AS paragraph_title,
                p.content AS paragraph_content,
                p.char_len AS paragraph_char_len
            FROM chunks c
            JOIN documents d ON d.id = c.document_id
            LEFT JOIN paragraphs p ON p.id = c.paragraph_id
            WHERE c.id IN ({placeholders})
            """,
            ids,
        ).fetchall()
    return {
        row["chunk_id"]: {
            "document_id": row["document_id"],
            "paragraph_id": row["paragraph_id"],
            "document_title": row["document_title"],
            "source_type": row["source_type"],
            "url": row["url"],
            "path": row["path"],
            "paragraph_title": row["paragraph_title"],
            "paragraph_content": row["paragraph_content"],
            "paragraph_char_len": row["paragraph_char_len"],
        }
        for row in rows
    }


def get_stats(vector_available: bool = False, vector_message: str | None = None) -> KnowledgeStats:
    init_db()
    with connection() as conn:
        documents = conn.execute("SELECT COUNT(*) AS count FROM documents").fetchone()["count"]
        paragraphs = conn.execute("SELECT COUNT(*) AS count FROM paragraphs").fetchone()["count"]
        chunks = conn.execute("SELECT COUNT(*) AS count FROM chunks").fetchone()["count"]
        sessions = conn.execute("SELECT COUNT(*) AS count FROM rag_sessions").fetchone()["count"]
        last = conn.execute("SELECT value FROM meta WHERE key = 'last_indexed_at'").fetchone()
    return KnowledgeStats(
        documents=documents,
        paragraphs=paragraphs,
        chunks=chunks,
        sessions=sessions,
        lastIndexedAt=last["value"] if last else None,
        vectorAvailable=vector_available,
        vectorMessage=vector_message,
    )


def inspect_index_health() -> dict:
    init_db()
    with connection() as conn:
        documents = conn.execute("SELECT COUNT(*) AS count FROM documents").fetchone()["count"]
        paragraphs = conn.execute("SELECT COUNT(*) AS count FROM paragraphs").fetchone()["count"]
        chunks = conn.execute("SELECT COUNT(*) AS count FROM chunks").fetchone()["count"]
        fts_rows = conn.execute("SELECT COUNT(*) AS count FROM chunk_fts").fetchone()["count"]
        orphan_chunks = conn.execute(
            """
            SELECT COUNT(*) AS count
            FROM chunks c
            LEFT JOIN documents d ON d.id = c.document_id
            WHERE d.id IS NULL
            """
        ).fetchone()["count"]
        orphan_paragraphs = conn.execute(
            """
            SELECT COUNT(*) AS count
            FROM paragraphs p
            LEFT JOIN documents d ON d.id = p.document_id
            WHERE d.id IS NULL
            """
        ).fetchone()["count"]
        orphan_fts_rows = conn.execute(
            """
            SELECT COUNT(*) AS count
            FROM chunk_fts f
            LEFT JOIN chunks c ON c.id = f.chunk_id
            WHERE c.id IS NULL
            """
        ).fetchone()["count"]
        missing_fts_rows = conn.execute(
            """
            SELECT COUNT(*) AS count
            FROM chunks c
            LEFT JOIN chunk_fts f ON f.chunk_id = c.id
            WHERE f.chunk_id IS NULL
            """
        ).fetchone()["count"]
        embedding_status_counts = {
            row["embedding_status"]: row["count"]
            for row in conn.execute(
                """
                SELECT embedding_status, COUNT(*) AS count
                FROM chunks
                GROUP BY embedding_status
                ORDER BY embedding_status
                """
            ).fetchall()
        }
        markdown_rows = conn.execute(
            """
            SELECT id, path
            FROM documents
            WHERE source_type = 'markdown' AND COALESCE(path, '') != ''
            """
        ).fetchall()

    stale_markdown_documents = sum(
        1 for row in markdown_rows if row["path"] and not Path(row["path"]).exists()
    )
    return {
        "documents": documents,
        "paragraphs": paragraphs,
        "chunks": chunks,
        "ftsRows": fts_rows,
        "orphanChunks": orphan_chunks,
        "orphanParagraphs": orphan_paragraphs,
        "orphanFtsRows": orphan_fts_rows,
        "missingFtsRows": missing_fts_rows,
        "staleMarkdownDocuments": stale_markdown_documents,
        "embeddingStatusCounts": embedding_status_counts,
    }


def repair_fts_index() -> dict[str, int]:
    init_db()
    with connection() as conn:
        orphan_deleted = conn.execute(
            """
            DELETE FROM chunk_fts
            WHERE chunk_id IN (
                SELECT f.chunk_id
                FROM chunk_fts f
                LEFT JOIN chunks c ON c.id = f.chunk_id
                WHERE c.id IS NULL
            )
            """
        ).rowcount
        missing_rows = conn.execute(
            """
            SELECT
                c.id AS chunk_id,
                c.document_id,
                c.content AS chunk_content,
                p.title AS paragraph_title,
                d.title AS document_title
            FROM chunks c
            JOIN documents d ON d.id = c.document_id
            LEFT JOIN paragraphs p ON p.id = c.paragraph_id
            LEFT JOIN chunk_fts f ON f.chunk_id = c.id
            WHERE f.chunk_id IS NULL
            ORDER BY c.document_id, c.chunk_index
            """
        ).fetchall()
        for row in missing_rows:
            display_title = display_paragraph_title(row["document_title"], row["paragraph_title"])
            fts_title = segment_for_fts(display_title)
            fts_content = segment_for_fts(f"{row['paragraph_title'] or ''}\n{row['chunk_content']}")
            conn.execute(
                "INSERT INTO chunk_fts (chunk_id, document_id, title, content) VALUES (?, ?, ?, ?)",
                (row["chunk_id"], row["document_id"], fts_title, fts_content),
            )
    return {
        "orphanFtsRowsDeleted": max(0, orphan_deleted),
        "missingFtsRowsInserted": len(missing_rows),
    }


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


def list_eval_cases() -> list[KnowledgeEvalCase]:
    init_db()
    with connection() as conn:
        rows = conn.execute(
            """
            SELECT id, question, case_type, expected_text, expected_path, expected_title,
                   expected_document_id, expected_paragraph_id, expected_answer, answer_keywords,
                   should_refuse, note, created_at, updated_at
            FROM rag_eval_cases
            ORDER BY updated_at DESC
            """
        ).fetchall()
    return [row_to_eval_case(row) for row in rows]


def get_eval_cases(case_ids: list[str]) -> list[KnowledgeEvalCase]:
    ids = [case_id for case_id in dict.fromkeys(case_ids) if case_id]
    if not ids:
        return []
    init_db()
    placeholders = ",".join("?" for _ in ids)
    with connection() as conn:
        rows = conn.execute(
            f"""
            SELECT id, question, case_type, expected_text, expected_path, expected_title,
                   expected_document_id, expected_paragraph_id, expected_answer, answer_keywords,
                   should_refuse, note, created_at, updated_at
            FROM rag_eval_cases
            WHERE id IN ({placeholders})
            """,
            ids,
        ).fetchall()
    by_id = {row["id"]: row_to_eval_case(row) for row in rows}
    return [by_id[case_id] for case_id in ids if case_id in by_id]


def save_eval_case(req: KnowledgeEvalCaseRequest, case_id: str | None = None) -> KnowledgeEvalCase:
    init_db()
    now = now_iso()
    clean_question = req.question.strip()
    clean_id = case_id or uuid.uuid4().hex
    with connection() as conn:
        existing = conn.execute(
            "SELECT created_at FROM rag_eval_cases WHERE id = ?",
            (clean_id,),
        ).fetchone()
        created_at = existing["created_at"] if existing else now
        conn.execute(
            """
            INSERT INTO rag_eval_cases (
                id, question, case_type, expected_text, expected_path, expected_title,
                expected_document_id, expected_paragraph_id, expected_answer, answer_keywords,
                should_refuse, note, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                question = excluded.question,
                case_type = excluded.case_type,
                expected_text = excluded.expected_text,
                expected_path = excluded.expected_path,
                expected_title = excluded.expected_title,
                expected_document_id = excluded.expected_document_id,
                expected_paragraph_id = excluded.expected_paragraph_id,
                expected_answer = excluded.expected_answer,
                answer_keywords = excluded.answer_keywords,
                should_refuse = excluded.should_refuse,
                note = excluded.note,
                updated_at = excluded.updated_at
            """,
            (
                clean_id,
                clean_question,
                normalize_eval_case_type(req.caseType),
                req.expectedText.strip(),
                req.expectedPath.strip(),
                req.expectedTitle.strip(),
                req.expectedDocumentId.strip(),
                req.expectedParagraphId.strip(),
                req.expectedAnswer.strip(),
                req.answerKeywords.strip(),
                1 if req.shouldRefuse else 0,
                req.note.strip(),
                created_at,
                now,
            ),
        )
        row = conn.execute(
            """
            SELECT id, question, case_type, expected_text, expected_path, expected_title,
                   expected_document_id, expected_paragraph_id, expected_answer, answer_keywords,
                   should_refuse, note, created_at, updated_at
            FROM rag_eval_cases
            WHERE id = ?
            """,
            (clean_id,),
        ).fetchone()
    return row_to_eval_case(row)


def delete_eval_case(case_id: str) -> bool:
    init_db()
    with connection() as conn:
        cursor = conn.execute("DELETE FROM rag_eval_cases WHERE id = ?", (case_id,))
        return cursor.rowcount > 0


def load_chunks(conn: sqlite3.Connection, chunk_ids: list[str]) -> list[IndexedChunk]:
    if not chunk_ids:
        return []
    placeholders = ",".join("?" for _ in chunk_ids)
    rows = conn.execute(
        f"""
        SELECT
            c.id AS chunk_id,
            c.paragraph_id,
            c.document_id,
            c.content AS chunk_content,
            p.title AS paragraph_title,
            p.content AS paragraph_content,
            d.title AS document_title,
            d.source_type,
            d.url,
            d.path
        FROM chunks c
        JOIN documents d ON d.id = c.document_id
        LEFT JOIN paragraphs p ON p.id = c.paragraph_id
        WHERE c.id IN ({placeholders})
        ORDER BY c.chunk_index
        """,
        chunk_ids,
    ).fetchall()
    return [
        IndexedChunk(
            id=row["chunk_id"],
            document_id=row["document_id"],
            paragraph_id=row["paragraph_id"],
            title=display_paragraph_title(row["document_title"], row["paragraph_title"]),
            source_type=row["source_type"],
            url=row["url"],
            path=row["path"],
            content=row["chunk_content"],
        )
        for row in rows
    ]


def row_to_citation(row: sqlite3.Row, score: float) -> KnowledgeCitation:
    document_title = row_value(row, "document_title", row_value(row, "title", "未命名文档"))
    paragraph_title = row_value(row, "paragraph_title")
    chunk_content = row_value(row, "chunk_content", row_value(row, "content", ""))
    paragraph_content = row_value(row, "paragraph_content", chunk_content)
    return KnowledgeCitation(
        documentId=row["document_id"],
        paragraphId=row_value(row, "paragraph_id"),
        chunkId=row["chunk_id"],
        title=display_paragraph_title(document_title, paragraph_title),
        paragraphTitle=paragraph_title,
        sourceType=row["source_type"],
        url=row["url"],
        path=row["path"],
        content=paragraph_content,
        matchedContent=chunk_content,
        score=score,
    )


def row_to_eval_case(row: sqlite3.Row) -> KnowledgeEvalCase:
    return KnowledgeEvalCase(
        id=row["id"],
        question=row["question"],
        caseType=normalize_eval_case_type(row_value(row, "case_type", "keyword")),
        expectedText=row["expected_text"],
        expectedPath=row["expected_path"],
        expectedTitle=row["expected_title"],
        expectedDocumentId=row["expected_document_id"],
        expectedParagraphId=row["expected_paragraph_id"],
        expectedAnswer=row_value(row, "expected_answer", ""),
        answerKeywords=row_value(row, "answer_keywords", ""),
        shouldRefuse=bool(row_value(row, "should_refuse", 0)),
        note=row["note"],
        createdAt=row["created_at"],
        updatedAt=row["updated_at"],
    )


def normalize_eval_case_type(value: str | None) -> str:
    normalized = (value or "keyword").strip().casefold()
    if normalized in EVAL_CASE_TYPES:
        return normalized
    return "keyword"


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


def count_paragraphs(conn: sqlite3.Connection, document_id: str) -> int:
    row = conn.execute(
        "SELECT COUNT(*) AS count FROM paragraphs WHERE document_id = ?",
        (document_id,),
    ).fetchone()
    return int(row["count"] if row else 0)


def display_paragraph_title(document_title: str | None, paragraph_title: str | None) -> str:
    doc = (document_title or "").strip() or "未命名文档"
    paragraph = (paragraph_title or "").strip()
    if not paragraph or paragraph == doc:
        return doc
    if paragraph.startswith(f"{doc} /"):
        return paragraph
    return f"{doc} / {paragraph}"


def row_value(row: sqlite3.Row, key: str, default: str | None = None) -> str | None:
    if key not in row.keys():
        return default
    value = row[key]
    return default if value is None else value


def make_document_id(source_type: str, stable_key: str) -> str:
    return hashlib.sha1(f"{source_type}:{stable_key}".encode("utf-8")).hexdigest()


def sha1_text(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")
