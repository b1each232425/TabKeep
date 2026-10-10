from __future__ import annotations

import asyncio
import hashlib
import json
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import httpx
from logger import logger
from schemas.knowledge import (
    EmbeddingConfig,
    KnowledgeCitation,
    RgbEvalCaseResult,
    RgbEvalHit,
    RgbEvalImportRequest,
    RgbEvalRunRecord,
    RgbEvalRunRequest,
    RgbEvalRunResponse,
    RgbEvalRunSummary,
    RgbEvalStatusResponse,
)
from services import storage
from services.knowledge import db
from services.knowledge.cjk import build_fts_query, segment_for_fts
from services.knowledge.embeddings import embed_texts, embedding_config_ready

DATASET_ID = "rgb-zh-refine"
LANCE_TABLE = "rgb_passages"
MAX_IMPORT_BYTES = 50 * 1024 * 1024
EMBEDDING_BATCH_SIZE = 24
RUN_RETENTION_LIMIT = 20
OFFICIAL_DATASET_URL = "https://raw.githubusercontent.com/chen700564/RGB/master/data/zh_refine.json"
_OFFICIAL_IMPORT_LOCK = asyncio.Lock()
_SPACE_RE = re.compile(r"\s+")


@contextmanager
def _connection() -> Iterable[sqlite3.Connection]:
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _data_dir() -> Path:
    return storage.DATA_DIR / "evaluation" / "rgb-zh-refine"


def _db_path() -> Path:
    return _data_dir() / "benchmark.db"


def _lance_dir() -> Path:
    return _data_dir() / "vectors.lance"


def init_db() -> None:
    with _connection() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS rgb_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS rgb_cases (
                id TEXT PRIMARY KEY,
                sort_order INTEGER NOT NULL,
                question TEXT NOT NULL,
                positive_ids_json TEXT NOT NULL,
                negative_ids_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS rgb_passages (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                content TEXT NOT NULL
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS rgb_passage_fts USING fts5(
                passage_id UNINDEXED,
                title,
                content
            );
            CREATE TABLE IF NOT EXISTS rgb_eval_runs (
                id TEXT PRIMARY KEY,
                request_json TEXT NOT NULL,
                response_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                duration_ms INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_rgb_cases_order ON rgb_cases(sort_order);
            CREATE INDEX IF NOT EXISTS idx_rgb_eval_runs_time ON rgb_eval_runs(created_at DESC);
            """
        )


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_passage(value: str) -> str:
    return _SPACE_RE.sub(" ", value).strip()


def _passage_id(value: str) -> str:
    digest = hashlib.sha256(_normalize_passage(value).encode("utf-8")).hexdigest()
    return f"rgb-{digest}"


def _embedding_signature(config: EmbeddingConfig) -> str:
    if not embedding_config_ready(config):
        return ""
    provider = json.dumps(
        {"baseURL": config.baseURL.strip().rstrip("/"), "model": config.model.strip()},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(provider.encode("utf-8")).hexdigest()


def _as_text_list(value: Any, field: str, line_number: int, *, required: bool) -> list[str]:
    if value is None and not required:
        return []
    if isinstance(value, str):
        values = [value]
    elif isinstance(value, list):
        values = value
    else:
        raise ValueError(f"第 {line_number} 条的 {field} 必须是文本数组")
    result: list[str] = []
    for item in values:
        if not isinstance(item, str):
            raise ValueError(f"第 {line_number} 条的 {field} 中存在非文本段落")
        normalized = _normalize_passage(item)
        if normalized:
            result.append(normalized)
    if required and not result:
        raise ValueError(f"第 {line_number} 条缺少有效的 {field} 正例段落")
    return list(dict.fromkeys(result))


def _decode_records(content: str) -> list[dict[str, Any]]:
    source = content.lstrip("\ufeff").strip()
    if not source:
        raise ValueError("RGB 数据文件为空")
    try:
        payload = json.loads(source)
    except json.JSONDecodeError:
        payload = None

    if isinstance(payload, list):
        records = payload
    elif isinstance(payload, dict) and isinstance(payload.get("data"), list):
        records = payload["data"]
    elif isinstance(payload, dict):
        records = [payload]
    else:
        records = []
        for line_number, line in enumerate(source.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"第 {line_number} 行不是有效 JSON: {exc.msg}") from exc
            records.append(record)

    if not records:
        raise ValueError("没有找到 RGB 评估记录")
    if any(not isinstance(record, dict) for record in records):
        raise ValueError("RGB 数据必须由 JSON 对象记录组成")
    return records


def parse_zh_refine(content: str) -> tuple[list[dict[str, Any]], dict[str, dict[str, str]]]:
    """Normalize RGB zh_refine records and deduplicate passages by normalized text."""
    if len(content.encode("utf-8")) > MAX_IMPORT_BYTES:
        raise ValueError(f"文件超过 {MAX_IMPORT_BYTES // (1024 * 1024)} MB 限制")
    records = _decode_records(content)
    cases: list[dict[str, Any]] = []
    passages: dict[str, dict[str, str]] = {}
    seen_case_ids: set[str] = set()

    for index, record in enumerate(records):
        line_number = index + 1
        question = record.get("query")
        if not isinstance(question, str) or not question.strip():
            raise ValueError(f"第 {line_number} 条缺少 query")
        positive = _as_text_list(record.get("positive"), "positive", line_number, required=True)
        negative = _as_text_list(record.get("negative"), "negative", line_number, required=False)
        record_id = str(record.get("id", line_number)).strip() or str(line_number)
        case_id = f"zh_refine:{record_id}"
        if case_id in seen_case_ids:
            raise ValueError(f"RGB 数据存在重复 id: {record_id}")
        seen_case_ids.add(case_id)

        positive_ids: list[str] = []
        negative_ids: list[str] = []
        for label, values, target in (
            ("positive", positive, positive_ids),
            ("negative", negative, negative_ids),
        ):
            for passage in values:
                passage_id = _passage_id(passage)
                target.append(passage_id)
                passages.setdefault(
                    passage_id,
                    {
                        "id": passage_id,
                        "title": f"RGB zh_refine · {label} passage",
                        "content": passage,
                    },
                )

        cases.append(
            {
                "id": case_id,
                "sort_order": index,
                "question": question.strip(),
                "positive_ids": list(dict.fromkeys(positive_ids)),
                "negative_ids": list(dict.fromkeys(negative_ids)),
            }
        )

    return cases, passages


async def import_dataset(request: RgbEvalImportRequest) -> RgbEvalStatusResponse:
    file_name = Path(request.fileName.strip().replace("\\", "/")).name or "rgb-zh-refine.jsonl"
    if len(request.content.encode("utf-8")) > MAX_IMPORT_BYTES:
        raise ValueError(f"文件超过 {MAX_IMPORT_BYTES // (1024 * 1024)} MB 限制")
    cases, passages = parse_zh_refine(request.content)
    source_hash = hashlib.sha256(request.content.encode("utf-8")).hexdigest()
    config = storage.get_knowledge_config().embedding
    embedding_configured = embedding_config_ready(config)
    vectors: list[list[float]] = []
    warning: str | None = None

    if embedding_configured and passages:
        passage_texts = [item["content"] for item in passages.values()]
        try:
            for start in range(0, len(passage_texts), EMBEDDING_BATCH_SIZE):
                vectors.extend(
                    await embed_texts(
                        config,
                        passage_texts[start : start + EMBEDDING_BATCH_SIZE],
                    )
                )
            if len(vectors) != len(passages):
                raise RuntimeError("Embedding 返回数量与 RGB 段落数量不一致")
        except Exception as exc:
            vectors = []
            warning = f"向量索引未生成，将使用 FTS：{type(exc).__name__}: {exc}"
            logger.warning(f"RGB Embedding 失败，回退 FTS: {type(exc).__name__}: {exc}")
    elif not embedding_configured:
        warning = "Embedding 未配置；当前只建立 FTS 索引，Vector/Hybrid 将回退或不可用。"

    init_db()
    imported_at = _utc_now()
    with _connection() as conn:
        conn.execute("DELETE FROM rgb_passage_fts")
        conn.execute("DELETE FROM rgb_cases")
        conn.execute("DELETE FROM rgb_passages")
        conn.executemany(
            "INSERT INTO rgb_passages (id, title, content) VALUES (:id, :title, :content)",
            list(passages.values()),
        )
        conn.executemany(
            """
            INSERT INTO rgb_passage_fts (passage_id, title, content)
            VALUES (:id, :fts_title, :fts_content)
            """,
            [
                {
                    "id": item["id"],
                    "fts_title": segment_for_fts(item["title"]),
                    "fts_content": segment_for_fts(item["content"]),
                }
                for item in passages.values()
            ],
        )
        conn.executemany(
            """
            INSERT INTO rgb_cases (id, sort_order, question, positive_ids_json, negative_ids_json)
            VALUES (:id, :sort_order, :question, :positive_json, :negative_json)
            """,
            [
                {
                    **case,
                    "positive_json": json.dumps(case["positive_ids"], ensure_ascii=False),
                    "negative_json": json.dumps(case["negative_ids"], ensure_ascii=False),
                }
                for case in cases
            ],
        )
        metadata = {
            "dataset": DATASET_ID,
            "file_name": file_name,
            "source_hash": source_hash,
            "imported_at": imported_at,
            "case_count": str(len(cases)),
            "passage_count": str(len(passages)),
            "embedding_status": "ready" if vectors else "fts_only",
            "embedding_signature": _embedding_signature(config) if vectors else "",
            "embedding_error": warning or "",
        }
        conn.executemany(
            "INSERT INTO rgb_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            list(metadata.items()),
        )

    if vectors:
        try:
            _replace_vector_index(list(passages.values()), vectors)
        except Exception as exc:
            warning = f"FTS 已导入，但向量索引写入失败：{type(exc).__name__}: {exc}"
            logger.warning(f"RGB LanceDB 写入失败: {type(exc).__name__}: {exc}")
            _drop_vector_index()
    else:
        _drop_vector_index()

    with _connection() as conn:
        conn.execute(
            "UPDATE rgb_meta SET value = ? WHERE key = 'embedding_error'",
            (warning or "",),
        )
        conn.execute(
            "UPDATE rgb_meta SET value = ? WHERE key = 'embedding_status'",
            ("ready" if _vector_count() > 0 else "fts_only",),
        )
    return get_status()


async def _download_official_dataset() -> str:
    chunks: list[bytes] = []
    total_bytes = 0
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(90.0, connect=15.0),
            follow_redirects=True,
        ) as client:
            async with client.stream("GET", OFFICIAL_DATASET_URL) as response:
                response.raise_for_status()
                async for chunk in response.aiter_bytes():
                    total_bytes += len(chunk)
                    if total_bytes > MAX_IMPORT_BYTES:
                        raise ValueError(f"RGB 官方语料超过 {MAX_IMPORT_BYTES // (1024 * 1024)} MB 限制")
                    chunks.append(chunk)
    except httpx.HTTPStatusError as exc:
        raise ValueError(f"下载 RGB 官方语料失败：HTTP {exc.response.status_code}") from exc
    except httpx.HTTPError as exc:
        raise ValueError(f"下载 RGB 官方语料失败：{type(exc).__name__}") from exc

    try:
        return b"".join(chunks).decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError("RGB 官方语料不是有效的 UTF-8 文件") from exc


async def import_official_dataset() -> RgbEvalStatusResponse:
    """Download and index the official zh_refine corpus once on first use."""
    async with _OFFICIAL_IMPORT_LOCK:
        current = get_status()
        if current.imported:
            return current
        content = await _download_official_dataset()
        return await import_dataset(
            RgbEvalImportRequest(fileName="zh_refine.json", content=content)
        )


def _replace_vector_index(passages: list[dict[str, str]], vectors: list[list[float]]) -> None:
    import lancedb

    directory = _lance_dir()
    directory.mkdir(parents=True, exist_ok=True)
    lance = lancedb.connect(str(directory))
    if LANCE_TABLE in _table_names(lance):
        lance.drop_table(LANCE_TABLE)
    records = [
        {
            "chunk_id": passage["id"],
            "document_id": DATASET_ID,
            "paragraph_id": "",
            "title": passage["title"],
            "source_type": "rgb",
            "path": "",
            "url": "",
            "content": passage["content"],
            "vector": vector,
        }
        for passage, vector in zip(passages, vectors, strict=True)
    ]
    lance.create_table(LANCE_TABLE, data=records)


def _drop_vector_index() -> None:
    try:
        import lancedb

        directory = _lance_dir()
        if not directory.exists():
            return
        lance = lancedb.connect(str(directory))
        if LANCE_TABLE in _table_names(lance):
            lance.drop_table(LANCE_TABLE)
    except Exception as exc:
        logger.warning(f"清理 RGB 向量索引失败: {type(exc).__name__}: {exc}")


def _table_names(lance: Any) -> list[str]:
    result = lance.list_tables()
    if hasattr(result, "tables"):
        return list(result.tables)
    return list(result)


def _vector_count() -> int:
    try:
        import lancedb

        directory = _lance_dir()
        if not directory.exists():
            return 0
        lance = lancedb.connect(str(directory))
        if LANCE_TABLE not in _table_names(lance):
            return 0
        table = lance.open_table(LANCE_TABLE)
        return int(table.count_rows()) if hasattr(table, "count_rows") else len(table.to_list())
    except Exception:
        return 0


def vector_index_available() -> bool:
    if _vector_count() <= 0:
        return False
    current_signature = _embedding_signature(storage.get_knowledge_config().embedding)
    if not current_signature:
        return False
    init_db()
    with _connection() as conn:
        row = conn.execute(
            "SELECT value FROM rgb_meta WHERE key = 'embedding_signature'"
        ).fetchone()
    return bool(row and row["value"] == current_signature)


def search_vectors(vector: list[float], limit: int) -> list[dict[str, Any]]:
    import lancedb

    directory = _lance_dir()
    if not directory.exists():
        return []
    lance = lancedb.connect(str(directory))
    if LANCE_TABLE not in _table_names(lance):
        return []
    return [dict(row) for row in lance.open_table(LANCE_TABLE).search(vector).limit(limit).to_list()]


def search_fts_hits(query: str, limit: int) -> list[db.FtsSearchHit]:
    init_db()
    fts_query = build_fts_query(query)
    if not fts_query:
        return []
    with _connection() as conn:
        rows = conn.execute(
            """
            SELECT p.id AS passage_id, p.title, p.content,
                   bm25(rgb_passage_fts) AS rank
            FROM rgb_passage_fts
            JOIN rgb_passages p ON p.id = rgb_passage_fts.passage_id
            WHERE rgb_passage_fts MATCH ?
            ORDER BY rank
            LIMIT ?
            """,
            (fts_query, max(1, min(int(limit), 50))),
        ).fetchall()
    return [
        db.FtsSearchHit(
            citation=KnowledgeCitation(
                documentId=DATASET_ID,
                chunkId=row["passage_id"],
                title=row["title"],
                sourceType="rgb",
                path=None,
                url=None,
                content=row["content"],
                matchedContent=row["content"],
                score=1 / (1 + index),
            ),
            raw_rank=float(row["rank"]),
        )
        for index, row in enumerate(rows)
    ]


def vector_rows_to_citation_map(rows: list[dict[str, Any]]) -> dict[str, KnowledgeCitation]:
    ids = [str(row.get("chunk_id") or "") for row in rows if row.get("chunk_id")]
    if not ids:
        return {}
    placeholders = ",".join("?" for _ in ids)
    with _connection() as conn:
        current_ids = {
            row["id"]
            for row in conn.execute(
                f"SELECT id FROM rgb_passages WHERE id IN ({placeholders})",
                ids,
            ).fetchall()
        }
    result: dict[str, KnowledgeCitation] = {}
    for index, row in enumerate(rows):
        passage_id = str(row.get("chunk_id") or "")
        if not passage_id or passage_id not in current_ids:
            continue
        distance = row.get("_distance")
        result[passage_id] = KnowledgeCitation(
            documentId=DATASET_ID,
            chunkId=passage_id,
            title=str(row.get("title") or "RGB zh_refine passage"),
            sourceType="rgb",
            path=None,
            url=None,
            content=str(row.get("content") or ""),
            matchedContent=str(row.get("content") or ""),
            score=1 / (1 + float(distance)) if distance is not None else 1 / (1 + index),
        )
    return result


def get_status() -> RgbEvalStatusResponse:
    init_db()
    with _connection() as conn:
        metadata = {row["key"]: row["value"] for row in conn.execute("SELECT key, value FROM rgb_meta")}
        case_count = conn.execute("SELECT COUNT(*) FROM rgb_cases").fetchone()[0]
        passage_count = conn.execute("SELECT COUNT(*) FROM rgb_passages").fetchone()[0]
    vector_count = _vector_count()
    config: EmbeddingConfig = storage.get_knowledge_config().embedding
    current_signature = _embedding_signature(config)
    stored_signature = metadata.get("embedding_signature", "")
    vector_compatible = bool(vector_count and current_signature and stored_signature == current_signature)
    warning = metadata.get("embedding_error") or None
    if vector_count and not vector_compatible:
        warning = (
            "Embedding 配置已变化或未启用；RGB 向量索引已过期，请重新导入语料重建向量。"
        )
    return RgbEvalStatusResponse(
        imported=case_count > 0,
        dataset=DATASET_ID,
        fileName=metadata.get("file_name", ""),
        datasetVersion=metadata.get("source_hash", "")[:12],
        importedAt=metadata.get("imported_at"),
        caseCount=int(case_count),
        passageCount=int(passage_count),
        vectorCount=vector_count,
        embeddingConfigured=embedding_config_ready(config),
        vectorAvailable=vector_compatible,
        warning=warning,
    )


def _load_cases(case_limit: int) -> tuple[list[dict[str, Any]], int, str, int]:
    init_db()
    with _connection() as conn:
        total = int(conn.execute("SELECT COUNT(*) FROM rgb_cases").fetchone()[0])
        metadata = {row["key"]: row["value"] for row in conn.execute("SELECT key, value FROM rgb_meta")}
        query = """
            SELECT id, question, positive_ids_json, negative_ids_json
            FROM rgb_cases ORDER BY sort_order
        """
        params: tuple[int, ...] = ()
        if case_limit > 0:
            query += " LIMIT ?"
            params = (case_limit,)
        rows = conn.execute(query, params).fetchall()
    cases = []
    for row in rows:
        cases.append(
            {
                "id": row["id"],
                "question": row["question"],
                "positive_ids": json.loads(row["positive_ids_json"]),
                "negative_ids": json.loads(row["negative_ids_json"]),
            }
        )
    return cases, total, metadata.get("source_hash", "")[:12], int(metadata.get("passage_count", 0))


async def run_evaluation(request: RgbEvalRunRequest) -> RgbEvalRunResponse:
    started = time.perf_counter()
    cases, total_cases, dataset_version, passage_count = _load_cases(request.caseLimit)
    if not cases:
        raise ValueError("请先导入 RGB zh_refine JSONL 数据")

    from services.knowledge.retrieval import hit_test_knowledge, normalize_search_mode

    search_mode = normalize_search_mode(request.searchMode)
    limit = max(1, min(int(request.limit), 50))
    min_score = max(0, float(request.minScore or 0))
    results: list[RgbEvalCaseResult] = []
    for case in cases:
        positives = set(case["positive_ids"])
        negatives = set(case["negative_ids"])
        try:
            retrieved = await hit_test_knowledge(
                case["question"],
                limit=limit,
                search_mode=search_mode,
                min_score=min_score,
                corpus_profile="rgb",
            )
            if not retrieved.ok:
                results.append(
                    RgbEvalCaseResult(
                        caseId=case["id"],
                        question=case["question"],
                        positiveCount=len(positives),
                        negativeCount=len(negatives),
                        error=retrieved.error or retrieved.vectorMessage or "检索失败",
                    )
                )
                continue
            hits = [
                RgbEvalHit(
                    **item.model_dump(),
                    relevant=item.chunkId in positives,
                    knownNegative=item.chunkId in negatives,
                )
                for item in retrieved.items[:limit]
            ]
            relevant_count = sum(1 for item in hits if item.relevant)
            negative_count = sum(1 for item in hits if item.knownNegative)
            first_rank = next((item.rank for item in hits if item.relevant), None)
            results.append(
                RgbEvalCaseResult(
                    caseId=case["id"],
                    question=case["question"],
                    positiveCount=len(positives),
                    negativeCount=len(negatives),
                    relevantRetrieved=relevant_count,
                    negativeRetrieved=negative_count,
                    recallAtK=round(relevant_count / len(positives), 6) if positives else 0,
                    reciprocalRank=round(1 / first_rank, 6) if first_rank else 0,
                    firstRelevantRank=first_rank,
                    hits=hits,
                )
            )
        except Exception as exc:
            results.append(
                RgbEvalCaseResult(
                    caseId=case["id"],
                    question=case["question"],
                    positiveCount=len(positives),
                    negativeCount=len(negatives),
                    error=f"{type(exc).__name__}: {exc}",
                )
            )

    evaluated = [item for item in results if not item.error]
    successful = len(evaluated)
    vector_available = vector_index_available()
    response = RgbEvalRunResponse(
        ok=True,
        dataset=DATASET_ID,
        datasetVersion=dataset_version,
        durationMs=round((time.perf_counter() - started) * 1000),
        totalCases=total_cases,
        evaluated=successful,
        caseLimit=request.caseLimit,
        passageCount=passage_count,
        limit=limit,
        searchMode=search_mode,
        recallAtK=round(sum(item.recallAtK for item in evaluated) / successful, 6) if successful else 0,
        precisionAtK=(
            round(sum(item.relevantRetrieved / limit for item in evaluated) / successful, 6)
            if successful
            else 0
        ),
        mrr=round(sum(item.reciprocalRank for item in evaluated) / successful, 6) if successful else 0,
        top1Accuracy=round(sum(item.firstRelevantRank == 1 for item in evaluated) / successful, 6)
        if successful
        else 0,
        negativeHitRateAtK=round(sum(item.negativeRetrieved > 0 for item in evaluated) / successful, 6)
        if successful
        else 0,
        vectorAvailable=vector_available,
        results=results,
    )
    return _save_run(request, response)


def _save_run(request: RgbEvalRunRequest, response: RgbEvalRunResponse) -> RgbEvalRunResponse:
    run_id = uuid.uuid4().hex
    created_at = _utc_now()
    response.runId = run_id
    response.createdAt = created_at
    record = RgbEvalRunRecord(
        runId=run_id,
        createdAt=created_at,
        durationMs=response.durationMs,
        request=request,
        result=response,
    )
    init_db()
    with _connection() as conn:
        conn.execute(
            "INSERT INTO rgb_eval_runs (id, request_json, response_json, created_at, duration_ms) VALUES (?, ?, ?, ?, ?)",
            (
                run_id,
                request.model_dump_json(),
                response.model_dump_json(),
                created_at,
                record.durationMs,
            ),
        )
        conn.execute(
            """
            DELETE FROM rgb_eval_runs WHERE id NOT IN (
                SELECT id FROM rgb_eval_runs ORDER BY created_at DESC LIMIT ?
            )
            """,
            (RUN_RETENTION_LIMIT,),
        )
    return response


def list_run_summaries(limit: int = RUN_RETENTION_LIMIT) -> list[RgbEvalRunSummary]:
    init_db()
    safe_limit = max(1, min(int(limit or RUN_RETENTION_LIMIT), RUN_RETENTION_LIMIT))
    with _connection() as conn:
        rows = conn.execute(
            "SELECT id, response_json, created_at, duration_ms FROM rgb_eval_runs ORDER BY created_at DESC LIMIT ?",
            (safe_limit,),
        ).fetchall()
    summaries = []
    for row in rows:
        try:
            result = RgbEvalRunResponse.model_validate_json(row["response_json"])
            summaries.append(
                RgbEvalRunSummary(
                    runId=row["id"],
                    createdAt=row["created_at"],
                    durationMs=row["duration_ms"],
                    totalCases=result.totalCases,
                    evaluated=result.evaluated,
                    caseLimit=result.caseLimit,
                    limit=result.limit,
                    searchMode=result.searchMode,
                    recallAtK=result.recallAtK,
                    precisionAtK=result.precisionAtK,
                    mrr=result.mrr,
                    top1Accuracy=result.top1Accuracy,
                )
            )
        except (TypeError, ValueError):
            continue
    return summaries


def get_run(run_id: str | None = None) -> RgbEvalRunRecord | None:
    init_db()
    with _connection() as conn:
        if run_id:
            row = conn.execute(
                "SELECT id, request_json, response_json, created_at, duration_ms FROM rgb_eval_runs WHERE id = ?",
                (run_id,),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT id, request_json, response_json, created_at, duration_ms FROM rgb_eval_runs ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
    if not row:
        return None
    try:
        return RgbEvalRunRecord(
            runId=row["id"],
            createdAt=row["created_at"],
            durationMs=row["duration_ms"],
            request=RgbEvalRunRequest.model_validate_json(row["request_json"]),
            result=RgbEvalRunResponse.model_validate_json(row["response_json"]),
        )
    except (TypeError, ValueError):
        return None
