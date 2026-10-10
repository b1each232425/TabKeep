"""Validate and transactionally sync the versioned MySQL note evaluation set.

Usage: python scripts/sync_mysql_eval_v2.py --validate | --import | --check
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATABASE = ROOT / "backend/data/knowledge.db"
DATASET_FILE = ROOT / "backend/evaluation/rag/tabkeep_mysql_notes_v2.json"
DATASET = "tabkeep-mysql-notes-v2"
FIELDS = ("question", "caseType", "expectedText", "expectedPath", "expectedTitle",
          "expectedDocumentId", "expectedParagraphId", "additionalRelevantTargets",
          "expectedAnswer", "answerKeywords", "shouldRefuse", "isCore", "note", "dataset")


def unsupported_fact_candidates(conn: sqlite3.Connection) -> dict[str, list[str]]:
    paragraphs = conn.execute("SELECT id,content FROM paragraphs").fetchall()
    checks = {
        "pagination-measured-ms": lambda text: "6000000" in text and bool(re.search(r"\d+\s*(?:ms|毫秒)", text, re.I)),
        "autoinc-current-mode": lambda text: "innodb_autoinc_lock_mode" in text and bool(re.search(r"(?:当前|本机|实例|配置为).{0,40}[012]", text)),
        "table-p95": lambda text: "订单表" in text and "p95" in text.casefold(),
        "locking-exact-keys": lambda text: "for update" in text.casefold() and "主键" in text and bool(re.search(r"(?:具体|实际).{0,25}\d", text)),
    }
    return {name: [row[0] for row in paragraphs if check(row[1])] for name, check in checks.items()}


def validate(conn: sqlite3.Connection, cases: list[dict]) -> None:
    if len(cases) != 56 or len({case.get("id") for case in cases}) != 56:
        raise ValueError("v2 requires 56 unique IDs")
    if sum(case.get("isCore") is True for case in cases) != 20:
        raise ValueError("v2 requires 20 core cases")
    if sum(case.get("shouldRefuse") is True for case in cases) != 4:
        raise ValueError("v2 requires four refusal cases")
    core = [case for case in cases if case["isCore"]]
    if sum(case["shouldRefuse"] for case in core) != 2:
        raise ValueError("core requires two refusals")
    source_documents: set[str] = set()
    core_documents: set[str] = set()
    for case in cases:
        if not case["id"].endswith("-v2") or case["dataset"] != DATASET:
            raise ValueError(f"invalid v2 identity: {case['id']}")
        if not case["question"].strip():
            raise ValueError(f"empty question: {case['id']}")
        targets = [{"documentId": case["expectedDocumentId"], "paragraphId": case["expectedParagraphId"]}, *case["additionalRelevantTargets"]]
        if case["shouldRefuse"]:
            if case["expectedAnswer"] or case["answerKeywords"] or any(target["paragraphId"] for target in targets):
                raise ValueError(f"refusal must not have gold answer or source: {case['id']}")
            continue
        if not case["expectedAnswer"].strip() or not case["answerKeywords"].strip():
            raise ValueError(f"answerable case missing answer: {case['id']}")
        seen: set[str] = set()
        hashes: dict[str, set[str]] = {}
        for target in targets:
            paragraph_id = target["paragraphId"]
            if paragraph_id in seen:
                raise ValueError(f"duplicate target {paragraph_id}")
            seen.add(paragraph_id)
            row = conn.execute(
                "SELECT p.document_id,d.content_hash,d.source_type FROM paragraphs p JOIN documents d ON d.id=p.document_id WHERE p.id=?",
                (paragraph_id,),
            ).fetchone()
            if row is None or row[0] != target["documentId"]:
                raise ValueError(f"missing gold paragraph {paragraph_id} in {case['id']}")
            hashes.setdefault(row[1], set()).add(row[2])
        evidence_text = " ".join(
            conn.execute("SELECT content FROM paragraphs WHERE id=?", (target["paragraphId"],)).fetchone()[0]
            for target in targets
        ).casefold()
        if any(word.strip().casefold() not in evidence_text or word.strip().casefold() not in case["expectedAnswer"].casefold()
               for word in case["answerKeywords"].split(",") if word.strip()):
            raise ValueError(f"answer keyword lacks direct evidence or reference answer: {case['id']}")
        if not all({"tabkeep_note", "markdown"}.issubset(types) for types in hashes.values()):
            raise ValueError(f"gold paragraph lacks duplicate-index copy: {case['id']}")
        source_documents.add(case["expectedDocumentId"])
        if case["isCore"]:
            core_documents.add(case["expectedDocumentId"])
    if len(source_documents) != 14 or len(core_documents) != 14:
        raise ValueError(f"expected all 14 source notes in full/core, got {len(source_documents)}/{len(core_documents)}")
    candidates = unsupported_fact_candidates(conn)
    if any(candidates.values()):
        raise ValueError(f"possible refusal answer in indexed corpus; manual review required: {candidates}")


def normalized_file_case(case: dict) -> dict:
    return {field: case.get(field) for field in FIELDS}


def normalized_db_case(row: sqlite3.Row) -> dict:
    return {
        "question": row["question"], "caseType": row["case_type"], "expectedText": row["expected_text"],
        "expectedPath": row["expected_path"], "expectedTitle": row["expected_title"],
        "expectedDocumentId": row["expected_document_id"], "expectedParagraphId": row["expected_paragraph_id"],
        "additionalRelevantTargets": json.loads(row["additional_relevant_targets_json"]),
        "expectedAnswer": row["expected_answer"], "answerKeywords": row["answer_keywords"],
        "shouldRefuse": bool(row["should_refuse"]), "isCore": bool(row["is_core"]),
        "note": row["note"], "dataset": row["dataset"],
    }


def check_parity(conn: sqlite3.Connection, cases: list[dict]) -> None:
    columns = {row[1] for row in conn.execute("PRAGMA table_info(rag_eval_cases)")}
    if "is_core" not in columns:
        raise ValueError("database has no is_core column; run --import")
    rows = conn.execute("SELECT * FROM rag_eval_cases WHERE dataset=?", (DATASET,)).fetchall()
    db_cases = {row["id"]: normalized_db_case(row) for row in rows}
    file_cases = {case["id"]: normalized_file_case(case) for case in cases}
    if db_cases != file_cases:
        missing = sorted(file_cases.keys() - db_cases.keys())
        extra = sorted(db_cases.keys() - file_cases.keys())
        changed = sorted(case_id for case_id in file_cases.keys() & db_cases.keys() if file_cases[case_id] != db_cases[case_id])
        raise ValueError(f"JSON/DB mismatch: missing={missing}, extra={extra}, changed={changed}")


def import_cases(conn: sqlite3.Connection, cases: list[dict]) -> None:
    backup = ROOT / ".tmp" / f"knowledge-before-mysql-v2-{datetime.now().strftime('%Y%m%dT%H%M%S%f')}.db"
    backup.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(backup) as destination:
        conn.backup(destination)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with conn:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(rag_eval_cases)")}
        if "is_core" not in columns:
            conn.execute("ALTER TABLE rag_eval_cases ADD COLUMN is_core INTEGER NOT NULL DEFAULT 0")
        existing_v2 = {row[0] for row in conn.execute("SELECT id FROM rag_eval_cases WHERE dataset=?", (DATASET,))}
        file_ids = {case["id"] for case in cases}
        if existing_v2 - file_ids:
            raise ValueError(f"unexpected existing v2 cases; refusing to remove: {sorted(existing_v2 - file_ids)}")
        for case in cases:
            conn.execute(
                """INSERT INTO rag_eval_cases (
                  id,question,case_type,expected_text,expected_path,expected_title,expected_document_id,
                  expected_paragraph_id,additional_relevant_targets_json,expected_answer,answer_keywords,
                  should_refuse,is_core,note,dataset,created_at,updated_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET
                  question=excluded.question,case_type=excluded.case_type,expected_text=excluded.expected_text,
                  expected_path=excluded.expected_path,expected_title=excluded.expected_title,
                  expected_document_id=excluded.expected_document_id,expected_paragraph_id=excluded.expected_paragraph_id,
                  additional_relevant_targets_json=excluded.additional_relevant_targets_json,
                  expected_answer=excluded.expected_answer,answer_keywords=excluded.answer_keywords,
                  should_refuse=excluded.should_refuse,is_core=excluded.is_core,note=excluded.note,
                  dataset=excluded.dataset,updated_at=excluded.updated_at""",
                (case["id"], case["question"], case["caseType"], case["expectedText"],
                 case["expectedPath"], case["expectedTitle"], case["expectedDocumentId"],
                 case["expectedParagraphId"], json.dumps(case["additionalRelevantTargets"], ensure_ascii=False),
                 case["expectedAnswer"], case["answerKeywords"], int(case["shouldRefuse"]),
                 int(case["isCore"]), case["note"], DATASET, now, now),
            )
        check_parity(conn, cases)
    print(f"Imported {len(cases)} v2 cases; backup: {backup}")


def main() -> None:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--validate", action="store_true", help="read-only dataset and corpus check")
    group.add_argument("--check", action="store_true", help="read-only dataset, corpus and DB parity check")
    group.add_argument("--import", dest="do_import", action="store_true", help="backup and transactionally upsert v2")
    args = parser.parse_args()
    cases = json.loads(DATASET_FILE.read_text(encoding="utf-8"))
    uri = f"file:{DATABASE.as_posix()}?mode={'ro' if not args.do_import else 'rw'}"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    try:
        validate(conn, cases)
        if args.do_import:
            import_cases(conn, cases)
        if args.check:
            check_parity(conn, cases)
        print(f"v2 validated: {len(cases)} unique; {sum(c['isCore'] for c in cases)} core; 14 sources; 4 refusals")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
