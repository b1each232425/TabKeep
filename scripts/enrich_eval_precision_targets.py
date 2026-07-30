from __future__ import annotations

import argparse
import json
import re
import shutil
import sqlite3
import unicodedata
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


ZERO_WIDTH_RE = re.compile(r"[\u200b-\u200f\u2060\ufeff]")
MARKDOWN_ESCAPE_RE = re.compile(r"\\([`*_{}\[\]()#+\-.!|>])")
MARKDOWN_INLINE_RE = re.compile(r"[`*_~]+")
WHITESPACE_RE = re.compile(r"\s+")
SEGMENT_SPLIT_RE = re.compile(r"[/\\>]+")


@dataclass(frozen=True)
class ParagraphCandidate:
    paragraph_id: str
    document_id: str
    paragraph_title: str
    document_title: str
    path: str
    content: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="将旧 RAG 评估锚点升级为支持 Precision@K 的精确段落标注。",
    )
    parser.add_argument(
        "--database",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "backend" / "data" / "knowledge.db",
    )
    parser.add_argument("--dry-run", action="store_true", help="只统计，不修改数据库。")
    parser.add_argument("--no-backup", action="store_true", help="修改前不创建数据库备份。")
    parser.add_argument(
        "--replace-existing",
        action="store_true",
        help="用本次解析结果替换已有额外相关目标。",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    database = args.database.resolve()
    if not database.exists():
        raise FileNotFoundError(f"知识库不存在: {database}")

    if not args.dry_run and not args.no_backup:
        timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
        backup = database.with_name(f"{database.stem}.before-precision-{timestamp}.bak")
        shutil.copy2(database, backup)
        print(f"backup={backup}")

    conn = sqlite3.connect(database)
    conn.row_factory = sqlite3.Row
    try:
        has_target_column = column_exists(conn, "rag_eval_cases", "additional_relevant_targets_json")
        if not has_target_column and not args.dry_run:
            conn.execute(
                "ALTER TABLE rag_eval_cases "
                "ADD COLUMN additional_relevant_targets_json TEXT NOT NULL DEFAULT '[]'"
            )
            has_target_column = True

        paragraphs = load_paragraphs(conn)
        cases = load_cases(conn, has_target_column)
        updated = 0
        precise = 0
        multi_target = 0
        unmatched = 0

        for case in cases:
            candidates = find_candidates(case, paragraphs)
            if not candidates:
                unmatched += 1
                continue

            primary, *additional = candidates[:6]
            precise += 1
            if additional:
                multi_target += 1
            targets = merge_additional_targets(
                (
                    []
                    if args.replace_existing
                    else parse_targets(case["additional_relevant_targets_json"])
                ),
                additional,
                primary,
            )
            if (
                case["expected_document_id"] == primary.document_id
                and case["expected_paragraph_id"] == primary.paragraph_id
                and parse_targets(case["additional_relevant_targets_json"]) == targets
            ):
                continue
            updated += 1
            if not args.dry_run:
                conn.execute(
                    """
                    UPDATE rag_eval_cases
                    SET expected_document_id = ?,
                        expected_paragraph_id = ?,
                        additional_relevant_targets_json = ?
                    WHERE id = ?
                    """,
                    (
                        primary.document_id,
                        primary.paragraph_id,
                        json.dumps(targets, ensure_ascii=False, separators=(",", ":")),
                        case["id"],
                    ),
                )

        if args.dry_run:
            conn.rollback()
        else:
            conn.commit()
        print(
            f"cases={len(cases)} precise={precise} multi_target={multi_target} "
            f"unmatched={unmatched} updated={updated} dry_run={args.dry_run}"
        )
        return 0
    finally:
        conn.close()


def column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    return any(row["name"] == column for row in conn.execute(f"PRAGMA table_info({table})"))


def load_cases(conn: sqlite3.Connection, has_target_column: bool) -> list[sqlite3.Row]:
    target_column = (
        "additional_relevant_targets_json"
        if has_target_column
        else "'[]' AS additional_relevant_targets_json"
    )
    return conn.execute(
        f"""
        SELECT id, expected_text, expected_path, expected_title,
               expected_document_id, expected_paragraph_id, {target_column}
        FROM rag_eval_cases
        ORDER BY created_at
        """
    ).fetchall()


def load_paragraphs(conn: sqlite3.Connection) -> list[ParagraphCandidate]:
    rows = conn.execute(
        """
        SELECT p.id AS paragraph_id, p.document_id, p.title AS paragraph_title,
               p.content, d.title AS document_title, COALESCE(d.path, d.url, '') AS path
        FROM paragraphs p
        JOIN documents d ON d.id = p.document_id
        """
    ).fetchall()
    return [
        ParagraphCandidate(
            paragraph_id=row["paragraph_id"],
            document_id=row["document_id"],
            paragraph_title=row["paragraph_title"] or "",
            document_title=row["document_title"] or "",
            path=row["path"] or "",
            content=row["content"] or "",
        )
        for row in rows
    ]


def find_candidates(
    case: sqlite3.Row,
    paragraphs: list[ParagraphCandidate],
) -> list[ParagraphCandidate]:
    expected_text = case["expected_text"] or ""
    expected_path = case["expected_path"] or ""
    expected_title = case["expected_title"] or ""
    text_matches = [
        paragraph
        for paragraph in paragraphs
        if expected_text and contains_text(expected_text, paragraph.content)
        and not (
            is_evaluation_artifact(paragraph)
            and not (
                metadata_matches(expected_path, paragraph.path)
                or metadata_matches(
                    expected_title,
                    paragraph.paragraph_title,
                    paragraph.document_title,
                )
            )
        )
    ]
    candidates = text_matches
    if not candidates:
        candidates = [
            paragraph
            for paragraph in paragraphs
            if metadata_matches(expected_path, paragraph.path)
            and metadata_matches(
                expected_title,
                paragraph.paragraph_title,
                paragraph.document_title,
            )
        ]
    return sorted(
        candidates,
        key=lambda paragraph: (
            not metadata_matches(expected_path, paragraph.path),
            not metadata_matches(
                expected_title,
                paragraph.paragraph_title,
                paragraph.document_title,
            ),
            paragraph.path,
            paragraph.paragraph_title,
            paragraph.paragraph_id,
        ),
    )


def is_evaluation_artifact(paragraph: ParagraphCandidate) -> bool:
    metadata = normalize_text(
        " ".join((paragraph.document_title, paragraph.paragraph_title, paragraph.path))
    )
    return any(
        marker in metadata
        for marker in (
            "rag评估",
            "evaluation optimization report",
            "评估结果",
            "评估用例",
        )
    )


def merge_additional_targets(
    existing: list[dict[str, str]],
    candidates: list[ParagraphCandidate],
    primary: ParagraphCandidate,
) -> list[dict[str, str]]:
    targets = list(existing)
    seen_paragraphs = {
        target.get("paragraphId", "")
        for target in targets
        if target.get("paragraphId", "")
    }
    seen_paragraphs.add(primary.paragraph_id)
    for candidate in candidates:
        if candidate.paragraph_id in seen_paragraphs:
            continue
        targets.append(
            {
                "text": "",
                "path": candidate.path,
                "title": candidate.paragraph_title or candidate.document_title,
                "documentId": candidate.document_id,
                "paragraphId": candidate.paragraph_id,
            }
        )
        seen_paragraphs.add(candidate.paragraph_id)
    return targets


def parse_targets(value: str | None) -> list[dict[str, str]]:
    try:
        payload = json.loads(value or "[]")
    except json.JSONDecodeError:
        return []
    if not isinstance(payload, list):
        return []
    return [
        {
            "text": str(item.get("text", "")).strip(),
            "path": str(item.get("path", "")).strip(),
            "title": str(item.get("title", "")).strip(),
            "documentId": str(item.get("documentId", "")).strip(),
            "paragraphId": str(item.get("paragraphId", "")).strip(),
        }
        for item in payload
        if isinstance(item, dict)
    ]


def contains_text(expected: str, value: str) -> bool:
    needle = normalize_text(expected)
    haystack = normalize_text(value)
    if not needle:
        return False
    return needle in haystack or compact_text(needle) in compact_text(haystack)


def metadata_matches(expected: str, *values: str) -> bool:
    needle = normalize_text(expected)
    if not needle:
        return False
    segments = [
        normalize_text(segment)
        for segment in SEGMENT_SPLIT_RE.split(expected)
        if normalize_text(segment)
    ]
    return any(
        needle in normalize_text(value)
        or (len(segments) > 1 and all(segment in normalize_text(value) for segment in segments))
        for value in values
    )


def normalize_text(value: str | None) -> str:
    text = unicodedata.normalize("NFKC", value or "")
    text = ZERO_WIDTH_RE.sub("", text)
    text = MARKDOWN_ESCAPE_RE.sub(r"\1", text)
    text = MARKDOWN_INLINE_RE.sub("", text)
    return WHITESPACE_RE.sub(" ", text).strip().casefold()


def compact_text(value: str) -> str:
    return WHITESPACE_RE.sub("", value)


if __name__ == "__main__":
    raise SystemExit(main())
