from __future__ import annotations

import asyncio
import re
import unicodedata

from schemas.knowledge import (
    KnowledgeCitation,
    KnowledgeEvalCase,
    KnowledgeEvalCaseRequest,
    KnowledgeEvalCaseResult,
    KnowledgeEvalDeleteResponse,
    KnowledgeEvalHit,
    KnowledgeEvalRankBucket,
    KnowledgeEvalRunRequest,
    KnowledgeEvalRunResponse,
    KnowledgeEvalTypeSummary,
)
from services import storage
from services.knowledge import db
from services.knowledge.qa import build_rag_messages, clean_llm_output
from services.knowledge.retrieval import hit_test_knowledge, normalize_search_mode
from services.llm import chat_completion


ZERO_WIDTH_RE = re.compile(r"[\u200b-\u200f\u2060\ufeff]")
MARKDOWN_ESCAPE_RE = re.compile(r"\\([`*_{}\[\]()#+\-.!|>])")
MARKDOWN_INLINE_RE = re.compile(r"[`*_~]+")
WHITESPACE_RE = re.compile(r"\s+")
SEGMENT_SPLIT_RE = re.compile(r"[/\\>]+")
ANSWER_KEYWORD_SPLIT_RE = re.compile(r"[,，;；\n\r]+")
REFUSAL_PATTERNS = (
    "没有足够依据",
    "没有足够的信息",
    "没有任何信息表明",
    "没有任何资料表明",
    "没有资料显示",
    "无法根据",
    "无法依据",
    "无法断定",
    "不能根据",
    "不能断定",
    "知识库里没有",
    "没有检索到",
    "来源不足",
    "依据不足",
    "未涉及",
    "无法回答",
    "不知道",
    "not enough information",
    "cannot answer",
    "no relevant",
)
ANSWER_KEYWORD_ALIASES = {
    "不足时说明资料不足": (
        "没有足够依据",
        "来源不足",
        "资料不足",
        "来源片段不足",
        "不足以回答",
    ),
    "资料不足": ("没有足够依据", "来源不足", "没有足够的信息", "不足以回答"),
    "没有足够依据": ("资料不足", "来源不足", "无法依据"),
    "hit-test": ("hit test", "命中测试"),
    "selection": ("划词", "选中文本", "选择文本", "selection"),
    "translate": ("翻译", "translate"),
    "region": ("固定区域", "区域", "region"),
    "box": ("框", "翻译框", "box"),
    "paragraph": ("段落", "段落模式", "paragraph"),
    "vault": ("vault", "知识库", "笔记库", "mock vault"),
    "评估问题都直接照抄标题": ("直接照抄标题", "照抄标题"),
    "指标会虚高": ("指标虚高", "虚高"),
    "过滤过短段落": ("过滤过短段落", "过短段落"),
    "知识库文档要保持标题清晰": ("标题清晰", "文档标题"),
    "评估台应显示耗时": ("耗时", "评估耗时", "运行时间"),
    "开发者不仅关心准确率": ("关注准确率", "关心准确率", "准确率"),
    "也关心运行时间": ("关注运行时间", "关心运行时间", "运行时间"),
    "前端配置页要避免误导": ("配置页", "误导", "误操作", "错误入口"),
    "ocr 结果常有断行": ("ocr", "断行", "识别文本包含错误"),
    "划词翻译依赖快捷键": ("划词翻译", "快捷键"),
}
DEFAULT_ANSWER_EVAL_LIMIT = 30
DEFAULT_ANSWER_TIMEOUT_SECONDS = 45
MAX_ANSWER_EVAL_LIMIT = 260
MAX_ANSWER_TIMEOUT_SECONDS = 180


def list_eval_cases() -> list[KnowledgeEvalCase]:
    return db.list_eval_cases()


def save_eval_case(req: KnowledgeEvalCaseRequest, case_id: str | None = None) -> KnowledgeEvalCase:
    return db.save_eval_case(req, case_id)


def delete_eval_case(case_id: str) -> KnowledgeEvalDeleteResponse:
    return KnowledgeEvalDeleteResponse(ok=True, deleted=db.delete_eval_case(case_id))


async def run_eval(req: KnowledgeEvalRunRequest) -> KnowledgeEvalRunResponse:
    cases = db.get_eval_cases(req.caseIds) if req.caseIds else db.list_eval_cases()
    limit = max(1, min(req.limit, 50))
    search_mode = normalize_search_mode(req.searchMode)
    min_score = max(0, float(req.minScore or 0))
    answer_limit = normalized_answer_limit(req.answerLimit)
    answer_timeout = normalized_answer_timeout(req.answerTimeoutSeconds)
    answer_eval_ids = selected_answer_eval_case_ids(cases, answer_limit) if req.evaluateAnswer else set()
    results: list[KnowledgeEvalCaseResult] = []
    source_modes: dict[str, int] = {}

    for case in cases:
        try:
            search_result = await hit_test_knowledge(
                case.question,
                limit=limit,
                search_mode=search_mode,
                min_score=min_score,
            )
            source_modes[search_result.sourceMode] = source_modes.get(search_result.sourceMode, 0) + 1
            if not search_result.ok:
                issue_type, issue_message = explain_case_result(
                    rank=None,
                    hits=[],
                    error=search_result.error or search_result.vectorMessage or "检索失败",
                )
                results.append(
                    KnowledgeEvalCaseResult(
                        case=case,
                        ok=False,
                        issueType=issue_type,
                        issueMessage=issue_message,
                        error=issue_message,
                    )
                )
                continue

            first_rank: int | None = None
            eval_hits: list[KnowledgeEvalHit] = []
            for item in search_result.items:
                matches = matched_expectations(case, item)
                relevant = is_relevant(case, matches)
                if relevant and first_rank is None:
                    first_rank = item.rank
                eval_hits.append(
                    KnowledgeEvalHit(
                        **item.model_dump(),
                        relevant=relevant,
                        matchedExpectations=matches,
                    )
                )
            if not has_expectation(case):
                issue_type, issue_message = "not_evaluated", "未配置检索预期；此用例不参与 Recall/MRR。"
            else:
                issue_type, issue_message = explain_case_result(first_rank, eval_hits)
            result = KnowledgeEvalCaseResult(
                case=case,
                ok=True,
                rank=first_rank,
                reciprocalRank=round(1 / first_rank, 6) if first_rank else 0,
                hits=eval_hits,
                issueType=issue_type,
                issueMessage=issue_message,
            )
            if req.evaluateAnswer and case.id in answer_eval_ids:
                apply_answer_eval(result, await evaluate_answer(case, eval_hits, limit, answer_timeout))
            results.append(result)
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            issue_type, issue_message = explain_case_result(rank=None, hits=[], error=error)
            results.append(
                KnowledgeEvalCaseResult(
                    case=case,
                    ok=False,
                    issueType=issue_type,
                    issueMessage=issue_message,
                    error=error,
                )
            )

    evaluated = len(results)
    retrieval_results = [result for result in results if has_expectation(result.case)]
    retrieval_evaluated = len(retrieval_results)
    hit_count = sum(1 for result in retrieval_results if result.rank is not None)
    top1_count = sum(1 for result in retrieval_results if result.rank == 1)
    mrr = sum(result.reciprocalRank for result in retrieval_results) / retrieval_evaluated if retrieval_evaluated else 0
    answer_eligible_count = sum(1 for case in cases if should_evaluate_answer(case))
    answer_results = [result for result in results if result.answerEvaluated]
    answer_pass_count = sum(1 for result in answer_results if result.answerOk)
    refusal_results = [result for result in answer_results if result.case.shouldRefuse]
    refusal_pass_count = sum(1 for result in refusal_results if result.refusalOk)
    return KnowledgeEvalRunResponse(
        ok=True,
        total=len(cases),
        evaluated=evaluated,
        retrievalEvaluated=retrieval_evaluated,
        hitCount=hit_count,
        recallAtK=round(hit_count / retrieval_evaluated, 6) if retrieval_evaluated else 0,
        mrr=round(mrr, 6),
        top1Accuracy=round(top1_count / retrieval_evaluated, 6) if retrieval_evaluated else 0,
        answerEligible=answer_eligible_count,
        answerLimit=min(answer_limit, answer_eligible_count) if req.evaluateAnswer else 0,
        answerEvaluated=len(answer_results),
        answerPassCount=answer_pass_count,
        answerAccuracy=round(answer_pass_count / len(answer_results), 6) if answer_results else 0,
        refusalEvaluated=len(refusal_results),
        refusalPassCount=refusal_pass_count,
        refusalAccuracy=round(refusal_pass_count / len(refusal_results), 6) if refusal_results else 0,
        averageAnswerScore=average_result_field(answer_results, "answerScore"),
        averageFaithfulness=average_result_field(answer_results, "answerFaithfulness"),
        averageAnswerRelevance=average_result_field(answer_results, "answerRelevance"),
        rankDistribution=rank_distribution(retrieval_results),
        typeSummaries=type_summaries(results),
        limit=limit,
        searchMode=search_mode,
        sourceModes=source_modes,
        results=results,
    )


async def evaluate_answer(
    case: KnowledgeEvalCase,
    hits: list[KnowledgeEvalHit],
    limit: int,
    timeout_seconds: int = DEFAULT_ANSWER_TIMEOUT_SECONDS,
) -> dict:
    contexts = [hit for hit in hits[:limit]]
    if case.shouldRefuse and not contexts:
        return {
            "answerEvaluated": True,
            "answerOk": True,
            "answer": "",
            "answerScore": 1,
            "answerKeywordCoverage": 1,
            "answerFaithfulness": 1,
            "answerRelevance": 1,
            "refusalOk": True,
            "answerIssueType": "ok",
            "answerIssueMessage": "没有检索上下文，正确拒答。",
        }

    if not contexts:
        return {
            "answerEvaluated": True,
            "answerOk": False,
            "answerIssueType": "no_context",
            "answerIssueMessage": "没有检索上下文，无法评估答案质量。",
        }

    model_config = storage.get_model_config()
    if not model_config or not model_config.model or not model_config.baseURL or not model_config.apiKey:
        return {
            "answerEvaluated": True,
            "answerOk": False,
            "answerIssueType": "model_config",
            "answerIssueMessage": "modelConfig 不完整，无法运行答案评估。",
        }

    try:
        raw_answer = await asyncio.wait_for(
            chat_completion(model_config, build_rag_messages(case.question, contexts)),
            timeout=timeout_seconds,
        )
        answer = clean_llm_output(raw_answer)
    except TimeoutError:
        return {
            "answerEvaluated": True,
            "answerOk": False,
            "answerIssueType": "llm_error",
            "answerIssueMessage": f"LLM 调用超过 {timeout_seconds} 秒，已跳过此答案评估。",
        }
    except Exception as exc:
        return {
            "answerEvaluated": True,
            "answerOk": False,
            "answerIssueType": "llm_error",
            "answerIssueMessage": f"LLM 调用失败: {type(exc).__name__}: {exc}",
        }

    keywords = split_answer_keywords(case.answerKeywords)
    matched_keywords, missing_keywords = match_answer_keywords(answer, keywords)
    keyword_coverage = round(len(matched_keywords) / len(keywords), 6) if keywords else (
        1.0 if not case.expectedAnswer.strip() or contains_text(case.expectedAnswer, answer) else 0.0
    )
    context_text = "\n".join(hit.content for hit in contexts)
    faithfulness = score_answer_faithfulness(case, matched_keywords or keywords, context_text)
    relevance = score_answer_relevance(case, answer, keyword_coverage)
    answer_score = round((keyword_coverage + faithfulness + relevance) / 3, 6)

    if case.shouldRefuse:
        refusal_ok = is_refusal_answer(answer)
        return {
            "answerEvaluated": True,
            "answerOk": refusal_ok,
            "answer": answer,
            "answerScore": 1.0 if refusal_ok else 0.0,
            "answerKeywordCoverage": keyword_coverage,
            "answerFaithfulness": faithfulness,
            "answerRelevance": relevance,
            "refusalOk": refusal_ok,
            "answerIssueType": "ok" if refusal_ok else "refusal_failed",
            "answerIssueMessage": "正确拒答。" if refusal_ok else "应拒答的问题给出了实质性回答。",
            "matchedAnswerKeywords": matched_keywords,
            "missingAnswerKeywords": missing_keywords,
        }

    answer_ok = (
        keyword_coverage >= 0.8
        and faithfulness >= 0.6
        and relevance >= 0.6
    ) or (
        keyword_coverage >= 0.6
        and faithfulness >= 0.9
        and relevance >= 0.6
    )
    issue_type = "ok" if answer_ok else "answer_quality"
    issue_message = "答案覆盖预期关键词，且可由检索上下文支撑。" if answer_ok else build_answer_issue_message(
        keyword_coverage,
        faithfulness,
        relevance,
        missing_keywords,
    )
    return {
        "answerEvaluated": True,
        "answerOk": answer_ok,
        "answer": answer,
        "answerScore": answer_score,
        "answerKeywordCoverage": keyword_coverage,
        "answerFaithfulness": faithfulness,
        "answerRelevance": relevance,
        "refusalOk": None,
        "answerIssueType": issue_type,
        "answerIssueMessage": issue_message,
        "matchedAnswerKeywords": matched_keywords,
        "missingAnswerKeywords": missing_keywords,
    }


def apply_answer_eval(result: KnowledgeEvalCaseResult, values: dict) -> None:
    for key, value in values.items():
        setattr(result, key, value)


def should_evaluate_answer(case: KnowledgeEvalCase) -> bool:
    return bool(case.shouldRefuse or case.expectedAnswer.strip() or case.answerKeywords.strip())


def normalized_answer_limit(value: int | None) -> int:
    raw = value if value is not None else DEFAULT_ANSWER_EVAL_LIMIT
    return max(1, min(int(raw or DEFAULT_ANSWER_EVAL_LIMIT), MAX_ANSWER_EVAL_LIMIT))


def normalized_answer_timeout(value: int | None) -> int:
    raw = value if value is not None else DEFAULT_ANSWER_TIMEOUT_SECONDS
    return max(5, min(int(raw or DEFAULT_ANSWER_TIMEOUT_SECONDS), MAX_ANSWER_TIMEOUT_SECONDS))


def selected_answer_eval_case_ids(cases: list[KnowledgeEvalCase], answer_limit: int) -> set[str]:
    eligible = [case for case in cases if should_evaluate_answer(case)]
    priority = {"negative": 0, "challenge": 1, "natural": 2, "keyword": 3}
    selected = sorted(
        eligible,
        key=lambda case: (
            0 if case.shouldRefuse else priority.get((case.caseType or "keyword").strip(), 4),
            case.id,
        ),
    )[:answer_limit]
    return {case.id for case in selected}


def split_answer_keywords(value: str) -> list[str]:
    return [item.strip() for item in ANSWER_KEYWORD_SPLIT_RE.split(value or "") if item.strip()]


def match_answer_keywords(answer: str, keywords: list[str]) -> tuple[list[str], list[str]]:
    matched: list[str] = []
    missing: list[str] = []
    for keyword in keywords:
        if answer_keyword_matches(keyword, answer):
            matched.append(keyword)
        else:
            missing.append(keyword)
    return matched, missing


def score_answer_faithfulness(case: KnowledgeEvalCase, keywords: list[str], context_text: str) -> float:
    checks = keywords or split_answer_keywords(case.expectedAnswer)
    if checks:
        supported = sum(1 for item in checks if answer_keyword_matches(item, context_text))
        return round(supported / len(checks), 6)
    if case.expectedAnswer.strip():
        return 1.0 if contains_text(case.expectedAnswer, context_text) else 0.0
    return 1.0


def score_answer_relevance(case: KnowledgeEvalCase, answer: str, keyword_coverage: float) -> float:
    if case.expectedAnswer.strip() and contains_text(case.expectedAnswer, answer):
        return 1.0
    return round(keyword_coverage, 6)


def is_refusal_answer(answer: str) -> bool:
    normalized = normalize_eval_text(answer)
    return any(pattern in normalized for pattern in REFUSAL_PATTERNS)


def answer_keyword_matches(keyword: str, text: str) -> bool:
    if contains_text(keyword, text):
        return True
    return any(contains_text(variant, text) for variant in answer_keyword_variants(keyword))


def answer_keyword_variants(keyword: str) -> list[str]:
    normalized = normalize_eval_text(keyword)
    variants: list[str] = []
    for alias_key, alias_values in ANSWER_KEYWORD_ALIASES.items():
        normalized_key = normalize_eval_text(alias_key)
        if normalized == normalized_key or normalized_key in normalized or normalized in normalized_key:
            variants.extend(alias_values)
    return unique_strings(variants)


def unique_strings(values: list[str] | tuple[str, ...]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        normalized = normalize_eval_text(value)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(value)
    return result


def build_answer_issue_message(
    keyword_coverage: float,
    faithfulness: float,
    relevance: float,
    missing_keywords: list[str],
) -> str:
    parts = [
        f"关键词覆盖 {keyword_coverage:.0%}",
        f"上下文支撑 {faithfulness:.0%}",
        f"问题相关 {relevance:.0%}",
    ]
    if missing_keywords:
        parts.append("缺少: " + "、".join(missing_keywords[:5]))
    return "；".join(parts)


def average_result_field(results: list[KnowledgeEvalCaseResult], field: str) -> float:
    if not results:
        return 0
    return round(sum(float(getattr(result, field) or 0) for result in results) / len(results), 6)


def explain_case_result(
    rank: int | None,
    hits: list[KnowledgeEvalHit],
    error: str | None = None,
) -> tuple[str, str]:
    if error:
        return "error", error
    if not hits:
        return "no_results", "没有召回结果，优先检查索引是否同步、Embedding 是否可用、检索模式是否过窄。"
    if rank == 1:
        return "ok", "正确结果位于第一名。"
    if rank:
        return "late_hit", f"正确结果出现在第 {rank} 名，召回可用但排序仍有优化空间。"

    top = hits[0]
    matched = "、".join(format_expectation_name(value) for value in top.matchedExpectations) or "无预期锚点"
    return (
        "missed",
        f"TopK 内没有满足预期的结果；当前第一名只匹配：{matched}。可检查问题表达、切块边界、预期锚点或 rerank 语义判断。",
    )


def format_expectation_name(value: str) -> str:
    names = {
        "documentId": "文档 ID",
        "paragraphId": "段落 ID",
        "path": "路径",
        "title": "标题",
        "text": "文本",
    }
    return names.get(value, value)


def type_summaries(results: list[KnowledgeEvalCaseResult]) -> list[KnowledgeEvalTypeSummary]:
    grouped: dict[str, list[KnowledgeEvalCaseResult]] = {}
    for result in results:
        case_type = (result.case.caseType or "keyword").strip() or "keyword"
        grouped.setdefault(case_type, []).append(result)

    summaries: list[KnowledgeEvalTypeSummary] = []
    for case_type in sorted(grouped):
        items = [item for item in grouped[case_type] if has_expectation(item.case)]
        if not items:
            continue
        total = len(items)
        hit_count = sum(1 for item in items if item.rank is not None)
        top1_count = sum(1 for item in items if item.rank == 1)
        mrr = sum(item.reciprocalRank for item in items) / total if total else 0
        summaries.append(
            KnowledgeEvalTypeSummary(
                caseType=case_type,
                total=total,
                hitCount=hit_count,
                recallAtK=round(hit_count / total, 6) if total else 0,
                mrr=round(mrr, 6),
                top1Accuracy=round(top1_count / total, 6) if total else 0,
                rankDistribution=rank_distribution(items),
            )
        )
    return summaries


def rank_distribution(results: list[KnowledgeEvalCaseResult]) -> list[KnowledgeEvalRankBucket]:
    buckets: dict[int, int] = {}
    for result in results:
        if result.rank is None:
            continue
        buckets[result.rank] = buckets.get(result.rank, 0) + 1
    return [KnowledgeEvalRankBucket(rank=rank, count=buckets[rank]) for rank in sorted(buckets)]


def is_relevant(case: KnowledgeEvalCase, matches: list[str]) -> bool:
    if not has_expectation(case):
        return False
    match_set = set(matches)
    id_expectations = {
        key
        for key, value in {
            "documentId": case.expectedDocumentId,
            "paragraphId": case.expectedParagraphId,
        }.items()
        if value.strip()
    }
    if id_expectations:
        return bool(id_expectations & match_set)
    if case.expectedText.strip() and "text" in match_set:
        return True

    weak_expectations = {
        key
        for key, value in {
            "path": case.expectedPath,
            "title": case.expectedTitle,
        }.items()
        if value.strip()
    }
    if case.expectedText.strip():
        return len(weak_expectations) >= 2 and weak_expectations.issubset(match_set)
    return bool(weak_expectations and weak_expectations.issubset(match_set))


def has_expectation(case: KnowledgeEvalCase) -> bool:
    return any(
        value.strip()
        for value in (
            case.expectedDocumentId,
            case.expectedParagraphId,
            case.expectedPath,
            case.expectedTitle,
            case.expectedText,
        )
    )


def matched_expectations(case: KnowledgeEvalCase, item: KnowledgeCitation) -> list[str]:
    matches: list[str] = []
    if case.expectedDocumentId.strip() and item.documentId == case.expectedDocumentId.strip():
        matches.append("documentId")
    if case.expectedParagraphId.strip() and (item.paragraphId or "") == case.expectedParagraphId.strip():
        matches.append("paragraphId")
    if contains_metadata(case.expectedPath, item.path, item.url):
        matches.append("path")
    if contains_metadata(case.expectedTitle, item.title, item.paragraphTitle):
        matches.append("title")
    if contains_text(case.expectedText, item.content, item.matchedContent):
        matches.append("text")
    return matches


def contains_metadata(expected: str, *values: str | None) -> bool:
    needle = normalize_eval_text(expected)
    if not needle:
        return False
    segments = [
        normalize_eval_text(segment)
        for segment in SEGMENT_SPLIT_RE.split(expected)
        if normalize_eval_text(segment)
    ]
    for value in values:
        haystack = normalize_eval_text(value)
        if needle in haystack:
            return True
        if len(segments) > 1 and all(segment in haystack for segment in segments):
            return True
    return False


def contains_text(expected: str, *values: str | None) -> bool:
    needle = normalize_eval_text(expected)
    if not needle:
        return False
    compact_needle = compact_eval_text(needle)
    for value in values:
        haystack = normalize_eval_text(value)
        if needle in haystack:
            return True
        if compact_needle and compact_needle in compact_eval_text(haystack):
            return True
    return False


def normalize_eval_text(value: str | None) -> str:
    text = unicodedata.normalize("NFKC", value or "")
    text = ZERO_WIDTH_RE.sub("", text)
    text = MARKDOWN_ESCAPE_RE.sub(r"\1", text)
    text = MARKDOWN_INLINE_RE.sub("", text)
    text = WHITESPACE_RE.sub(" ", text)
    return text.strip().casefold()


def compact_eval_text(value: str) -> str:
    return WHITESPACE_RE.sub("", value)
