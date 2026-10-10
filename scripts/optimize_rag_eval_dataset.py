"""Ground the formal TabKeep RAG evaluation set in source paragraphs.

This utility updates only the ``tabkeep-mysql-notes`` dataset.  It keeps the
legacy evaluation rows untouched, writes a recoverable backup, and validates
that every reference keyword is present in its expected answer.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sqlite3
import unicodedata
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EVAL_PATH = ROOT / "backend" / "evaluation" / "rag" / "tabkeep_mysql_notes_20260906.json"
DB_PATH = ROOT / "backend" / "data" / "knowledge.db"
BACKUP_DIR = ROOT.parent / "tmp" / "tabkeep-rag-eval-backups"
DATASET = "tabkeep-mysql-notes"


# The paragraph is the strong retrieval target.  Text is expanded from the
# old short anchor below, so the dataset remains compatible with the current
# evaluator while becoming much less ambiguous.
PARAGRAPH_INDEX: dict[str, int] = {
    "mysql-note-data-page-01": 4,
    "mysql-note-data-page-02": 4,
    "mysql-note-transaction-isolation-01": 4,
    "mysql-note-transaction-isolation-02": 4,
    "mysql-note-index-interview-01": 4,
    "mysql-note-index-interview-02": 4,
    "mysql-note-index-loss-01": 3,
    "mysql-note-index-loss-02": 6,
    "mysql-note-intro-01": 2,
    "mysql-note-intro-02": 3,
    "mysql-note-btree-01": 3,
    "mysql-note-btree-02": 4,
    "mysql-note-select-01": 3,
    "mysql-note-select-02": 3,
    "mysql-note-count-01": 3,
    "mysql-note-count-02": 9,
    "mysql-note-20m-01": 8,
    "mysql-note-20m-02": 7,
    "mysql-note-pagination-01": 2,
    "mysql-note-pagination-02": 6,
    "mysql-note-row-format-01": 4,
    "mysql-note-row-format-02": 3,
    "mysql-note-phantom-01": 4,
    "mysql-note-phantom-02": 4,
    "mysql-note-locking-01": 4,
    "mysql-note-locking-02": 5,
    "mysql-note-locks-01": 3,
    "mysql-note-locks-02": 4,
    "mysql-note-data-page-03": 4,
    "mysql-note-data-page-04": 4,
    "mysql-note-transaction-isolation-03": 4,
    "mysql-note-transaction-isolation-04": 4,
    "mysql-note-index-interview-03": 4,
    "mysql-note-index-interview-04": 4,
    "mysql-note-index-loss-03": 4,
    "mysql-note-index-loss-04": 8,
    "mysql-note-intro-03": 2,
    "mysql-note-intro-04": 5,
    "mysql-note-btree-03": 3,
    "mysql-note-btree-04": 4,
    "mysql-note-select-03": 4,
    "mysql-note-select-04": 4,
    "mysql-note-count-03": 8,
    "mysql-note-count-04": 9,
    "mysql-note-20m-03": 7,
    "mysql-note-20m-04": 7,
    "mysql-note-pagination-03": 3,
    "mysql-note-pagination-04": 8,
    "mysql-note-row-format-03": 4,
    "mysql-note-row-format-04": 4,
    "mysql-note-phantom-03": 4,
    "mysql-note-phantom-04": 3,
    "mysql-note-locking-03": 5,
    "mysql-note-locking-04": 5,
    "mysql-note-locks-03": 5,
    "mysql-note-locks-04": 3,
}


ANSWER_KEYWORDS: dict[str, str] = {
    "mysql-note-data-page-01": "16KB,File Header,双向链表,范围查询",
    "mysql-note-data-page-02": "主键顺序,页目录,槽,二分定位,顺序扫描",
    "mysql-note-transaction-isolation-01": "读提交（RC）,每个语句执行前,Read View,可重复读（RR）,第一次一致性读",
    "mysql-note-transaction-isolation-02": "trx_id,roll_pointer,undo log,Read View,可见版本",
    "mysql-note-index-interview-01": "二级索引叶子节点,主键,回表,聚簇索引,覆盖索引",
    "mysql-note-index-interview-02": "联合索引,最左列,连续匹配,范围条件,执行计划",
    "mysql-note-index-loss-01": "B+Tree 索引,前置通配符,确定前缀,索引树,全表扫描",
    "mysql-note-index-loss-02": "字符串索引列,数字比较,CAST(phone AS signed int),逐行转换,类型一致",
    "mysql-note-intro-01": "后端开发者,DBA,SQL,索引,事务",
    "mysql-note-intro-02": "查询如何执行,数据如何定位,并发如何隔离,修改如何持久化,存储引擎机制",
    "mysql-note-btree-01": "磁盘 I/O,多叉 B+ 树,降低树高,扇出,范围查询",
    "mysql-note-btree-02": "聚簇索引,完整行记录,二级索引,主键值,回到聚簇索引",
    "mysql-note-select-01": "连接器,认证,解析,优化,存储引擎",
    "mysql-note-select-02": "key,type,Extra,回表,实际使用的索引",
    "mysql-note-count-01": "COUNT(表达式),COUNT(1),COUNT(*),COUNT(字段),NULL",
    "mysql-note-count-02": "事务,MVCC,可见记录,SHOW TABLE STATUS,计数表",
    "mysql-note-20m-01": "硬性限制,2000 万行,经验性的推荐值,Buffer Pool,执行计划",
    "mysql-note-20m-02": "索引和数据,Buffer Pool,磁盘 I/O,行大小,索引层级",
    "mysql-note-pagination-01": "前 offset 行,丢弃,返回 size 行,扫描,回表",
    "mysql-note-pagination-02": "递增主键,游标,主键范围查询,固定条数,深页",
    "mysql-note-row-format-01": "表空间,段,区,64 个页,16KB",
    "mysql-note-row-format-02": "65535 字节,ASCII VARCHAR,NULL 值列表,变长字段长度列表,65532",
    "mysql-note-phantom-01": "完全解决,快照一致,MVCC,当前读,next-key lock",
    "mysql-note-phantom-02": "SELECT ... FOR UPDATE,当前读,next-key lock,记录锁加间隙锁,范围插入",
    "mysql-note-locking-01": "普通一致性读,行锁,SELECT ... FOR UPDATE,排他锁,隔离级别",
    "mysql-note-locking-02": "performance_schema.data_locks,INDEX_NAME,LOCK_TYPE,LOCK_MODE,LOCK_DATA",
    "mysql-note-locks-01": "全局锁,表级锁,行级锁,一致性逻辑备份,--single-transaction",
    "mysql-note-locks-02": "元数据锁（MDL）,事务结束,DDL,MDL 写锁,锁等待",
    "mysql-note-data-page-03": "物理连续,File Header,上一页和下一页,逻辑连续性,链表顺序",
    "mysql-note-data-page-04": "二级索引叶子节点,回到聚簇索引,完整行,回表,索引覆盖",
    "mysql-note-transaction-isolation-03": "可重复读（RR）,普通快照读,事务期间复用,Read View,MVCC",
    "mysql-note-transaction-isolation-04": "m_ids,min_trx_id,max_trx_id,creator_trx_id,roll_pointer",
    "mysql-note-index-interview-03": "索引下推,联合索引,过滤记录,回表,聚簇索引",
    "mysql-note-index-interview-04": "额外空间,创建,维护,增删改成本,优化和写入负担",
    "mysql-note-index-loss-03": "length(name)=6,函数运算,逐行计算,索引顺序,索引定位",
    "mysql-note-index-loss-04": "OR,没有索引,高效合并,index merge,执行计划",
    "mysql-note-intro-03": "接触过 MySQL,知识点之间联系还不够系统,后端开发者,DBA,整体理解",
    "mysql-note-intro-04": "不必严格线性阅读,按目录,检索,SQL,锁",
    "mysql-note-btree-03": "叶子节点,索引键有序,双向链表,范围起点,顺序遍历",
    "mysql-note-btree-04": "非叶子节点,索引键和指针,数据页,扇出,磁盘页",
    "mysql-note-select-03": "MySQL 8.0,移除了查询缓存,解析,优化,存储引擎",
    "mysql-note-select-04": "连接器,客户端,身份认证,权限校验,维护连接",
    "mysql-note-count-03": "二级索引,优化器,键长度最小,扫描成本更低,聚簇索引",
    "mysql-note-count-04": "MyISAM,元数据,WHERE,InnoDB,可见行",
    "mysql-note-20m-03": "1280,15,z 为 3,24576000,2457.6 万行",
    "mysql-note-20m-04": "叶子页大小有限,单行占用空间越大,每页能放的行数 y 越少,Total=x^(z-1)×y,行大小",
    "mysql-note-pagination-03": "LIMIT 6000000,10,前 600 万条记录,丢弃,返回 10 条,回表成本",
    "mysql-note-pagination-04": "offset,递增主键,上次位置,主键范围查询,固定批次",
    "mysql-note-row-format-03": "trx_id,roll_pointer,undo log,旧版本记录,版本链",
    "mysql-note-row-format-04": "Compact,20 字节指针,溢出页,Dynamic,Compressed",
    "mysql-note-phantom-03": "普通快照读,MVCC,Read View,当前读,next-key lock",
    "mysql-note-phantom-04": "BEGIN,第一次一致性读,建立快照,WITH CONSISTENT SNAPSHOT,立即建立事务快照",
    "mysql-note-locking-03": "唯一索引等值条件,一条存在的记录,记录锁,间隙,未命中",
    "mysql-note-locking-04": "二级索引叶子节点,主键值,聚簇索引,完整记录,加锁",
    "mysql-note-locks-03": "--single-transaction,一致性读,Read View,全局读锁,业务写入",
    "mysql-note-locks-04": "自增锁模式 2,并发插入,statement 格式复制,主库和从库,row 格式 binlog",
}


ANCHOR_OVERRIDES: dict[tuple[str, int], str] = {
    (
        "mysql-note-count-01",
        3,
    ): "count() 是一个聚合函数，函数的参数不仅可以是字段名，也可以是其他任意表达式",
    (
        "mysql-note-count-01",
        6,
    ): "count(*) 执行过程跟 count(1) 执行过程基本一样的，性能没有什么差异",
    (
        "mysql-note-count-01",
        7,
    ): "count(字段) 的执行效率相比前面的 count(1)、 count(*)、 count(主键字段) 执行效率是最差的",
    (
        "mysql-note-btree-04",
        4,
    ): "B+ 树的非叶子节点不存放实际的记录数据，仅存放索引，因此数据量相同的情况下",
    (
        "mysql-note-index-interview-04",
        4,
    ): "索引最大的好处是提高查询速度，但是索引也是有缺点的，比如：需要占用物理空间",
    (
        "mysql-note-count-02",
        11,
    ): "可以使用 show table status 或者 explain 命令来表进行估算",
    (
        "mysql-note-count-02",
        12,
    ): "将这个计数值保存到单独的一张计数表中",
    (
        "mysql-note-pagination-02",
        7,
    ): "如果因为各种原因，必须使用mysql。那同样，也需要控制下返回结果数量，比如数量1k以内",
    (
        "mysql-note-pagination-02",
        6,
    ): "我们可以将所有的数据根据id主键进行排序，然后分批次取，将当前批次的最大id作为下次筛选的条件进行查询",
}


ADDITIONAL_TARGETS: dict[str, list[tuple[int, str]]] = {
    "mysql-note-count-01": [(6, ""), (7, "")],
    "mysql-note-count-02": [(11, ""), (12, "")],
    "mysql-note-pagination-02": [(7, "")],
}


MARKDOWN_ESCAPE_RE = re.compile(r"\\([`*_{}\[\]()#+\-.!|>])")
MARKDOWN_INLINE_RE = re.compile(r"[`*_~]+")
MARKDOWN_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
MARKDOWN_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]*\)")
BLOCKQUOTE_RE = re.compile(r"(?:^|\s)>+(?=\s)")
WHITESPACE_RE = re.compile(r"\s+")


def normalize(value: str) -> str:
    return clean_anchor_source(value).casefold()


def clean_anchor_source(value: str) -> str:
    value = unicodedata.normalize("NFKC", value or "")
    value = MARKDOWN_IMAGE_RE.sub(r"\1", value)
    value = MARKDOWN_LINK_RE.sub(r"\1", value)
    value = BLOCKQUOTE_RE.sub(" ", value)
    value = MARKDOWN_ESCAPE_RE.sub(r"\1", value)
    value = MARKDOWN_INLINE_RE.sub("", value)
    return WHITESPACE_RE.sub(" ", value).strip()


def compact(value: str) -> str:
    return WHITESPACE_RE.sub("", normalize(value))


def contains(needle: str, haystack: str) -> bool:
    compact_needle = compact(needle)
    return bool(compact_needle) and compact_needle in compact(haystack)


def split_keywords(value: str) -> list[str]:
    return [item.strip() for item in re.split(r"[,，;；\n\r]+", value) if item.strip()]


def paragraph_anchor(case_id: str, paragraph_index: int, source: str, old_anchor: str) -> str:
    override = ANCHOR_OVERRIDES.get((case_id, paragraph_index))
    if override:
        return override

    # Make repeated runs stable.  The first optimization already stores a
    # sufficiently informative source snippet; expanding that snippet again
    # would gradually pull in unrelated neighboring text.
    existing = clean_anchor_source(old_anchor)
    if len(compact(existing)) >= 35 and contains(existing, source):
        return existing

    clean_source = clean_anchor_source(source)
    needle = compact(old_anchor)
    compact_source = compact(clean_source)
    start = compact_source.find(needle)
    if start < 0:
        raise ValueError(
            f"{case_id}: expectedText is not present in paragraph {paragraph_index}: {old_anchor!r}"
        )

    # Map the compact match back to the whitespace-preserving normalized text.
    compact_positions = [index for index, char in enumerate(clean_source) if not char.isspace()]
    source_start = compact_positions[start]
    source_end = compact_positions[start + len(needle) - 1] + 1
    window_start = max(0, source_start - 30)
    window_end = min(len(clean_source), source_end + 64)
    anchor = clean_source[window_start:window_end].strip(" -—:;，。")
    if len(compact(anchor)) < 20:
        window_end = min(len(clean_source), source_end + 96)
        anchor = clean_source[window_start:window_end].strip(" -—:;，。")
    return anchor


def target(case: dict, paragraph_index: int, source: str, old_anchor: str) -> dict[str, str]:
    return {
        "text": paragraph_anchor(case["id"], paragraph_index, source, old_anchor),
        "path": "",
        "title": "",
        "documentId": case["expectedDocumentId"],
        "paragraphId": f'{case["expectedDocumentId"]}:p{paragraph_index}',
    }


def load_cases() -> list[dict]:
    cases = json.loads(EVAL_PATH.read_text(encoding="utf-8"))
    if not isinstance(cases, list) or len(cases) != 56:
        raise ValueError(f"expected exactly 56 formal cases, got {len(cases) if isinstance(cases, list) else 'non-list'}")
    ids = [case.get("id", "") for case in cases]
    if len(set(ids)) != len(ids):
        raise ValueError("formal dataset contains duplicate case IDs")
    missing = set(PARAGRAPH_INDEX) - set(ids)
    if missing:
        raise ValueError(f"paragraph mapping misses cases: {sorted(missing)}")
    missing = set(ids) - set(ANSWER_KEYWORDS)
    if missing:
        raise ValueError(f"keyword mapping misses cases: {sorted(missing)}")
    return cases


def prepare_cases(cases: list[dict], conn: sqlite3.Connection) -> tuple[list[dict], dict[str, dict]]:
    prepared: list[dict] = []
    paragraph_cache: dict[str, dict] = {}
    for case in cases:
        case_id = case["id"]
        doc_id = case["expectedDocumentId"]
        paragraph_index = PARAGRAPH_INDEX[case_id]
        rows = conn.execute(
            "SELECT id, paragraph_index, content FROM paragraphs WHERE document_id=? ORDER BY paragraph_index",
            (doc_id,),
        ).fetchall()
        by_index = {row["paragraph_index"]: dict(row) for row in rows}
        if paragraph_index not in by_index:
            raise ValueError(f"{case_id}: paragraph p{paragraph_index} does not exist for document {doc_id}")

        primary_row = by_index[paragraph_index]
        updated = dict(case)
        updated["expectedText"] = paragraph_anchor(
            case_id,
            paragraph_index,
            primary_row["content"],
            case.get("expectedText", ""),
        )
        updated["expectedParagraphId"] = primary_row["id"]
        updated["answerKeywords"] = ANSWER_KEYWORDS[case_id]
        updated["additionalRelevantTargets"] = []
        for additional_index, additional_old_anchor in ADDITIONAL_TARGETS.get(case_id, []):
            row = by_index.get(additional_index)
            if not row:
                raise ValueError(f"{case_id}: additional paragraph p{additional_index} does not exist")
            old_anchor = additional_old_anchor or case.get("expectedText", "")
            if not old_anchor:
                old_anchor = row["content"][:30]
            additional = target(case, additional_index, row["content"], old_anchor)
            updated["additionalRelevantTargets"].append(additional)

        keyword_missing = [
            keyword
            for keyword in split_keywords(updated["answerKeywords"])
            if not contains(keyword, updated["expectedAnswer"])
        ]
        if keyword_missing:
            raise ValueError(f"{case_id}: keywords absent from expectedAnswer: {keyword_missing}")
        if len(split_keywords(updated["answerKeywords"])) < 3:
            raise ValueError(f"{case_id}: too few answer keywords")
        if len(compact(updated["expectedText"])) < 20:
            raise ValueError(f"{case_id}: expectedText anchor is too short: {updated['expectedText']!r}")
        if not contains(updated["expectedText"], primary_row["content"]):
            raise ValueError(f"{case_id}: expanded expectedText no longer matches primary paragraph")
        for additional in updated["additionalRelevantTargets"]:
            row = by_index[int(additional["paragraphId"].rsplit(":p", 1)[1])]
            if not contains(additional["text"], row["content"]):
                raise ValueError(f"{case_id}: additional anchor does not match paragraph")

        old_note = case.get("note", "")
        base_note = old_note.split("; status=", 1)[0].rstrip("; ")
        updated["note"] = (
            f"{base_note}; status=source-grounded-reviewed-v2; "
            "anchors=paragraph; keywords=reference-literal"
        )
        prepared.append(updated)
        paragraph_cache[case_id] = {
            "primary": primary_row,
            "additional": [
                by_index[int(item["paragraphId"].rsplit(":p", 1)[1])]
                for item in updated["additionalRelevantTargets"]
            ],
        }
    return prepared, paragraph_cache


def write_changes(prepared: list[dict], conn: sqlite3.Connection, dry_run: bool) -> None:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    for case in prepared:
        case["updatedAt"] = now

    if dry_run:
        print(f"dry-run: prepared {len(prepared)} cases; no files changed")
        return

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    json_backup = BACKUP_DIR / f"{EVAL_PATH.stem}.before-optimize-{stamp}.json"
    db_backup = BACKUP_DIR / f"knowledge.before-eval-optimize-{stamp}.db"
    shutil.copy2(EVAL_PATH, json_backup)
    shutil.copy2(DB_PATH, db_backup)

    EVAL_PATH.write_text(json.dumps(prepared, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    try:
        with conn:
            for case in prepared:
                cursor = conn.execute(
                    """
                    UPDATE rag_eval_cases
                    SET expected_text=?, expected_paragraph_id=?, additional_relevant_targets_json=?,
                        answer_keywords=?, note=?, updated_at=?
                    WHERE id=? AND dataset=?
                    """,
                    (
                        case["expectedText"],
                        case["expectedParagraphId"],
                        json.dumps(case["additionalRelevantTargets"], ensure_ascii=False, separators=(",", ":")),
                        case["answerKeywords"],
                        case["note"],
                        case["updatedAt"],
                        case["id"],
                        DATASET,
                    ),
                )
                if cursor.rowcount != 1:
                    raise ValueError(f"database row missing or not in formal dataset: {case['id']}")
    except Exception:
        # Restore both artifacts if the transaction or JSON write fails.
        shutil.copy2(json_backup, EVAL_PATH)
        shutil.copy2(db_backup, DB_PATH)
        raise
    print(f"updated JSON: {EVAL_PATH}")
    print(f"updated DB: {DB_PATH}")
    print(f"backups: {json_backup}, {db_backup}")


def validate_database(prepared: list[dict], conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        "SELECT id, expected_text, expected_paragraph_id, additional_relevant_targets_json, answer_keywords, note "
        "FROM rag_eval_cases WHERE dataset=? ORDER BY id",
        (DATASET,),
    ).fetchall()
    if len(rows) != 56:
        raise ValueError(f"formal database dataset has {len(rows)} rows, expected 56")
    by_id = {row["id"]: row for row in rows}
    for case in prepared:
        row = by_id.get(case["id"])
        if not row:
            raise ValueError(f"formal database dataset missing {case['id']}")
        if row["expected_text"] != case["expectedText"]:
            raise ValueError(f"DB expected_text mismatch: {case['id']}")
        if row["expected_paragraph_id"] != case["expectedParagraphId"]:
            raise ValueError(f"DB expected_paragraph_id mismatch: {case['id']}")
        if row["answer_keywords"] != case["answerKeywords"]:
            raise ValueError(f"DB answer_keywords mismatch: {case['id']}")
        if json.loads(row["additional_relevant_targets_json"] or "[]") != case["additionalRelevantTargets"]:
            raise ValueError(f"DB additional targets mismatch: {case['id']}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    cases = load_cases()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        formal_before = conn.execute(
            "SELECT COUNT(*) FROM rag_eval_cases WHERE dataset=?", (DATASET,)
        ).fetchone()[0]
        legacy_before = conn.execute(
            "SELECT COUNT(*) FROM rag_eval_cases WHERE dataset='legacy'"
        ).fetchone()[0]
        if formal_before != 56:
            raise ValueError(f"formal database dataset has {formal_before} rows before update")
        prepared, _ = prepare_cases(cases, conn)
        write_changes(prepared, conn, args.dry_run)
        if not args.dry_run:
            validate_database(prepared, conn)
            legacy_after = conn.execute(
                "SELECT COUNT(*) FROM rag_eval_cases WHERE dataset='legacy'"
            ).fetchone()[0]
            if legacy_after != legacy_before:
                raise ValueError("legacy evaluation row count changed")
            print(f"validated formal rows: {len(prepared)}")
            print(f"validated legacy rows unchanged: {legacy_after}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
