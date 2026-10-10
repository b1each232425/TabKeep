"""Build the versioned personal-note evaluation set from v1 and indexed notes.

The review ledger contains one evidence excerpt and edit rationale per case.
Run again after reindexing to detect changed or missing source paragraphs.
"""

from __future__ import annotations

import json
import math
import re
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "backend/evaluation/rag/tabkeep_mysql_notes_20260906.json"
OUTPUT = ROOT / "backend/evaluation/rag/tabkeep_mysql_notes_v2.json"
LEDGER = ROOT / "backend/evaluation/rag/tabkeep_mysql_notes_v2_review.md"
DATABASE = ROOT / "backend/data/knowledge.db"
DATASET = "tabkeep-mysql-notes-v2"
V2_UPDATED_AT = "2026-09-29T00:00:00Z"
DROP = {"intro-02", "intro-03", "intro-04", "pagination-03"}
CORE = {
    "data-page-02", "data-page-01", "transaction-isolation-02", "index-interview-01",
    "index-loss-01", "intro-01", "btree-03", "select-01", "count-04", "count-01",
    "20m-01", "pagination-01", "pagination-02", "row-format-02", "phantom-01",
    "locking-01", "locking-02", "locks-02",
}
REFUSALS = [
    ("pagination-measured-ms", "这组笔记对 LIMIT 6000000,10 深分页实际测得多少毫秒？", True,
     "资料讨论了深分页原理，但未给出该语句的实测耗时。"),
    ("autoinc-current-mode", "当前运行的 MySQL 实例 innodb_autoinc_lock_mode 配置值是多少？", False,
     "资料解释配置模式，不记录当前实例的运行时配置。"),
    ("table-p95", "笔记里那张订单表最近一次查询的实际 P95 延迟是多少毫秒？", False,
     "资料没有订单表的真实监控 P95。"),
    ("locking-exact-keys", "那次 SELECT ... FOR UPDATE 实际锁住了哪些具体主键值？", True,
     "资料解释加锁规则，没有该次执行的主键值清单。"),
]
ANSWER_FIXES = {
    "btree-01": "多叉 B+ 树层高较低，查询时磁盘 I/O 更少；非叶子节点主要保存索引信息，叶子节点有序且相连，有利于范围查询。",
    "select-02": "优化器基于成本选择索引和执行计划；可以通过 EXPLAIN 查看 key、type、Extra 等字段来观察其选择。",
    "locking-04": "使用二级索引进行锁定读时，除了二级索引上的锁，还可能对对应的主键索引记录加锁；应同时检查两侧的锁。",
    "index-interview-02": "联合索引先按最左列排序，在相同前缀内再按后续列排序，因此遵循最左匹配原则。遇到一般范围查询后，后面的列不能继续用于确定扫描范围；笔记说明 >=、<=、BETWEEN 和前缀 LIKE 是例外。",
    "index-loss-01": "LIKE 以通配符开头时不能按索引有序前缀定位，可能导致索引失效，最后转为全表扫描。",
    "locks-04": "笔记指出 innodb_autoinc_lock_mode=2 应配合 row 格式 binlog；若搭配 statement 格式，可能发生主从数据不一致。",
    "transaction-isolation-03": "InnoDB 默认隔离级别是可重复读（RR）。普通一致性读通过 MVCC 与 Read View 判断可见版本；Read View 通常在第一次一致性读时建立并复用。",
    "20m-01": "不是硬性限制。笔记把 2000W 行作为推荐值；超过这个值可能使 B+ 树层级升高，影响查询性能，并非对所有表都适用的硬上限。",
    "20m-02": "笔记示例中查询 id=6 依次访问三层 B+ 树的三个页；如果这些页都在磁盘且未提前加载到内存，最多需要三次磁盘 IO。",
    "20m-04": "笔记用 Total=x^(z-1)×y 估算容量；叶子节点中的每行数据占用空间变大时，单页可容纳的行数 y 变少，相同层数下估算总行数也会下降。",
    "pagination-02": "批量取出数据时可按 id 主键排序，记下本批最大 id 作为下一批筛选条件，通过主键索引定位后继续分批读取，避免 offset 不断增大的深分页。",
    "pagination-04": "持续增大 offset 会重复扫描前面的数据。笔记建议按 id 主键排序，记下本批最大 id 作为下一批筛选条件，通过主键索引继续分批读取。",
}
QUESTION_FIXES = {
    "20m-02": "按笔记里的三层 B+ 树示例，查询 id=6 最多访问几个页？如果这些页都未加载到内存会怎样？",
    "select-02": "SELECT 执行流程里，优化器负责什么？可以通过什么查看它选择的索引和计划？",
}
KEYWORD_FIXES = {
    "btree-01": "B+ 树,磁盘 I/O,范围查询",
    "select-02": "优化器,EXPLAIN,key,type,Extra",
    "locking-04": "二级索引,主键索引,锁",
    "locks-04": "innodb_autoinc_lock_mode=2,row,statement,主从数据不一致",
    "transaction-isolation-03": "可重复读,Read View,MVCC",
    "transaction-isolation-02": "trx_id,roll_pointer,undo log,Read View",
    "index-interview-01": "回表,二级索引,覆盖索引",
    "row-format-02": "65535,65532,NULL,变长字段长度",
    "index-interview-02": "联合索引,最左匹配,范围查询",
    "index-loss-01": "索引失效,全表扫描",
    "20m-01": "2000W,B+ 树,层级,查询性能",
    "20m-02": "id=6,三个页,磁盘,三次",
    "20m-04": "叶子节点,每行数据,Total",
    "pagination-01": "offset,limit,回表",
    "pagination-02": "id,主键,分批,offset",
    "pagination-04": "offset,id,主键",
    "data-page-03": "File Header,数据页,指针",
    "index-interview-04": "索引,创建,维护",
    "index-loss-03": "length(name)=6,函数,索引",
    "select-04": "连接器,客户端,解析",
    "locking-03": "记录锁,间隙,唯一索引",
    "locking-04": "二级索引,主键索引,锁",
    "phantom-04": "START TRANSACTION,WITH CONSISTENT SNAPSHOT,Read View",
}
PRIMARY_ANCHOR_OVERRIDES = {
    "phantom-04": ("ee091486687dc5e183189283c54111c774aca43d", 4),
    "pagination-04": ("9f40ec38a8370bb90b6d566ad81941d261a6d912", 6),
}
EXTRA_SOURCE_ANCHORS: dict[str, list[tuple[str, int]]] = {
    "phantom-01": [
        ("ac2d457c4639c42bf053e579f11323469cfd3fbf", 3),
        ("0833231526f29e9098a7ebb20f67b31f2b2ccd45", 1),
        ("0833231526f29e9098a7ebb20f67b31f2b2ccd45", 11),
    ],
    "count-03": [
        ("1d9db0915ba669d566356de2d8b04585a0da28ff", 4),
        ("1d9db0915ba669d566356de2d8b04585a0da28ff", 5),
    ],
}


def paragraph_rows(conn: sqlite3.Connection, document_id: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT id, document_id, paragraph_index, content FROM paragraphs WHERE document_id=? ORDER BY paragraph_index",
        (document_id,),
    ).fetchall()


def target_for(conn: sqlite3.Connection, document_id: str, paragraph_index: int) -> dict[str, str]:
    row = conn.execute(
        "SELECT id,content FROM paragraphs WHERE document_id=? AND paragraph_index=?",
        (document_id, paragraph_index),
    ).fetchone()
    if row is None:
        raise ValueError(f"missing paragraph {document_id}:p{paragraph_index}")
    return {"text": "", "path": "", "title": "", "documentId": document_id, "paragraphId": row["id"]}


def duplicate_targets(conn: sqlite3.Connection, document_id: str, paragraph_index: int) -> list[dict[str, str]]:
    source = conn.execute("SELECT content_hash FROM documents WHERE id=?", (document_id,)).fetchone()
    if source is None:
        raise ValueError(f"missing document {document_id}")
    original = conn.execute(
        "SELECT content FROM paragraphs WHERE document_id=? AND paragraph_index=?", (document_id, paragraph_index)
    ).fetchone()
    if original is None:
        raise ValueError(f"missing source paragraph {document_id}:p{paragraph_index}")
    duplicates = conn.execute(
        "SELECT id FROM documents WHERE content_hash=? AND id<>? ORDER BY id", (source["content_hash"], document_id)
    ).fetchall()
    targets: list[dict[str, str]] = []
    for duplicate in duplicates:
        counterpart = conn.execute(
            "SELECT id,content FROM paragraphs WHERE document_id=? AND paragraph_index=?",
            (duplicate["id"], paragraph_index),
        ).fetchone()
        if counterpart is not None and counterpart["content"] == original["content"]:
            targets.append(target_for(conn, duplicate["id"], paragraph_index))
    return targets


def related_paragraph_indices(conn: sqlite3.Connection, document_id: str, case: dict) -> list[int]:
    """Include only content paragraphs with multiple answer-keyword hits."""
    keywords = [word.strip().casefold() for word in case["answerKeywords"].split(",") if len(word.strip()) >= 3]
    primary = int(case["expectedParagraphId"].rsplit(":p", 1)[1])
    matches: list[int] = []
    for row in paragraph_rows(conn, document_id):
        index = row["paragraph_index"]
        if index not in {3, 4, 5} or index == primary:
            continue
        content = row["content"].casefold()
        if sum(word in content for word in keywords) >= max(2, math.ceil(len(keywords) * 0.75)):
            matches.append(index)
    return matches


def build() -> tuple[list[dict], list[str]]:
    source_cases = json.loads(SOURCE.read_text(encoding="utf-8"))
    conn = sqlite3.connect(f"file:{DATABASE.as_posix()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    now = V2_UPDATED_AT
    result: list[dict] = []
    ledger = ["# MySQL 笔记评估集 v2 审计记录", "", "源语料：当前知识库中 14 篇笔记的两份相同内容索引。每题列出一个支持摘录；其余精确金标见 JSON。", ""]
    for old in source_cases:
        suffix = old["id"].removeprefix("mysql-note-")
        if suffix in DROP:
            ledger.extend([f"## {old['id']} → 替换", "", f"原题：{old['question']}", "原因：与同来源题高度重复；改用拒答边界测试。", ""])
            continue
        case = dict(old)
        case["id"] = old["id"] + "-v2"
        case["dataset"] = DATASET
        case["isCore"] = suffix in CORE
        case["updatedAt"] = now
        case["question"] = QUESTION_FIXES.get(suffix, old["question"])
        case["expectedAnswer"] = ANSWER_FIXES.get(suffix, old["expectedAnswer"])
        case["answerKeywords"] = KEYWORD_FIXES.get(suffix, old["answerKeywords"])
        primary_doc = case["expectedDocumentId"]
        primary_idx = int(case["expectedParagraphId"].rsplit(":p", 1)[1])
        primary_doc, primary_idx = PRIMARY_ANCHOR_OVERRIDES.get(suffix, (primary_doc, primary_idx))
        related = related_paragraph_indices(conn, primary_doc, case)
        anchors = [(primary_doc, primary_idx), *[(primary_doc, index) for index in related]]
        anchors.extend(EXTRA_SOURCE_ANCHORS.get(suffix, []))
        for target in old.get("additionalRelevantTargets", []):
            paragraph_id = target.get("paragraphId", "")
            if ":p" in paragraph_id:
                anchors.append((paragraph_id.rsplit(":p", 1)[0], int(paragraph_id.rsplit(":p", 1)[1])))
        targets: list[dict[str, str]] = []
        for document_id, index in anchors:
            targets.append(target_for(conn, document_id, index))
            targets.extend(duplicate_targets(conn, document_id, index))
        unique = list({target["paragraphId"]: target for target in targets}.values())
        case["expectedText"] = ""
        case["expectedPath"] = ""
        case["expectedTitle"] = ""
        case["expectedDocumentId"] = unique[0]["documentId"]
        case["expectedParagraphId"] = unique[0]["paragraphId"]
        case["additionalRelevantTargets"] = unique[1:]
        evidence_text = " ".join(
            conn.execute("SELECT content FROM paragraphs WHERE id=?", (target["paragraphId"],)).fetchone()["content"]
            for target in unique
        ).casefold()
        supported_keywords = [
            word.strip() for word in case["answerKeywords"].split(",")
            if word.strip() and word.strip().casefold() in evidence_text
            and word.strip().casefold() in case["expectedAnswer"].casefold()
        ]
        if len(supported_keywords) < 2:
            raise ValueError(f"fewer than two evidence-grounded answer concepts: {case['id']} {supported_keywords}")
        case["answerKeywords"] = ",".join(supported_keywords[:5])
        source_label = old["note"].split("source=", 1)[-1].split(";", 1)[0]
        if primary_doc != old["expectedDocumentId"]:
            source_label = conn.execute("SELECT title FROM documents WHERE id=?", (primary_doc,)).fetchone()["title"]
        case["note"] = f"dataset={DATASET}; source={source_label}; evidence=paragraph-id; audit=v2"
        excerpt = conn.execute("SELECT content FROM paragraphs WHERE id=?", (unique[0]["paragraphId"],)).fetchone()["content"]
        focus = case["answerKeywords"].split(",")[0].strip()
        location = excerpt.casefold().find(focus.casefold()) if focus else -1
        if location < 0:
            location = 0
        snippet = re.sub(r"\s+", " ", excerpt[max(0, location - 65):location + 220]).strip()
        reason = "重标注两份同内容来源和直接支持段落"
        if suffix in ANSWER_FIXES:
            reason += "；收窄超出原文的答案"
        if suffix in QUESTION_FIXES:
            reason += "；改写为来源可回答的问题"
        if suffix in EXTRA_SOURCE_ANCHORS:
            reason += "；修正跨笔记来源锚点"
        ledger.extend([f"## {case['id']} · {'核心' if case['isCore'] else '全量'}", "", f"问题：{case['question']}", f"处理：{reason}。", f"参考答案：{case['expectedAnswer']}", f"证据：`{unique[0]['paragraphId']}` — {snippet}", f"金标段落：{', '.join(target['paragraphId'] for target in unique)}", ""])
        result.append(case)
    for suffix, question, core, reason in REFUSALS:
        case = {
            "id": f"mysql-note-{suffix}-v2", "question": question, "caseType": "negative",
            "expectedText": "", "expectedPath": "", "expectedTitle": "", "expectedDocumentId": "",
            "expectedParagraphId": "", "additionalRelevantTargets": [], "expectedAnswer": "",
            "answerKeywords": "", "shouldRefuse": True, "isCore": core,
            "note": f"dataset={DATASET}; unsupported={reason}", "dataset": DATASET, "updatedAt": now,
        }
        result.append(case)
        ledger.extend([f"## {case['id']} · {'核心' if core else '全量'}", "", f"问题：{question}", f"处理：替换旧重复题；{reason}", "证据：整个被测索引中无所问的运行时事实，导入前由校验器再次检查。", ""])
    conn.close()
    if len(result) != 56 or sum(case["isCore"] for case in result) != 20 or sum(case["shouldRefuse"] for case in result) != 4:
        raise AssertionError("unexpected v2 composition")
    return result, ledger


def main() -> None:
    cases, ledger = build()
    OUTPUT.write_text(json.dumps(cases, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    LEDGER.write_text("\n".join(ledger) + "\n", encoding="utf-8")
    print(f"Built {len(cases)} cases, {sum(case['isCore'] for case in cases)} core: {OUTPUT}")


if __name__ == "__main__":
    main()
