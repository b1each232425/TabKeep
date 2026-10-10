"""Run a controlled A/B/C comparison for the standalone MySQL Skill package."""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

from openai import APIError, AsyncOpenAI

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BENCHMARK = ROOT / "backend/evaluation/skill/mysql_skill_eval_v0.2.0.json"
DEFAULT_PACKAGE = ROOT / "skill-exports/mysql-interview-notes-v0.2.0"
DEFAULT_CONFIG = ROOT / "backend/data/config.json"
DEFAULT_RESULTS_DIR = ROOT / "backend/evaluation/skill/results"
MAX_COMPLETION_TOKENS = 700

BASE_PROMPT = (
    "你正在参加一个 MySQL 问答对照评估。用中文简洁回答，只处理问题要求的内容。"
    "不能猜测用户本地实例配置或未提供的实测数据；证据不足时明确说明。"
)
EVIDENCE_PROMPT = (
    BASE_PROMPT
    + "\n回答只能依据本轮提供的笔记证据，不要用模型常识补齐为笔记结论。"
    "如证据不足，明确回答资料不足。引用笔记时至少写出 paragraph_id 和 block_id。"
)
REFUSAL_RE = re.compile(
    r"(当前\s*Skill\s*资料不足|笔记(?:资料|中)?(?:不足|未提及|没有|未找到)|"
    r"未提供(?:相关)?(?:数据|信息|证据)|没有(?:足够)?(?:相关)?(?:证据|资料)|"
    r"无法(?:从|根据)(?:现有|提供的)?(?:笔记|资料|证据)|不能确定(?:该|当前|实际))",
    re.IGNORECASE,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="MySQL standalone Skill A/B/C evaluation")
    parser.add_argument("--benchmark", type=Path, default=DEFAULT_BENCHMARK)
    parser.add_argument("--package", type=Path, default=DEFAULT_PACKAGE)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--results-dir", type=Path, default=DEFAULT_RESULTS_DIR)
    parser.add_argument("--limit", type=int, default=20, help="运行前 N 个用例；默认 20")
    parser.add_argument("--model-override", help="仅对本次评估覆盖 modelConfig.model，不写回本地配置")
    parser.add_argument("--timeout-seconds", type=int, default=180, help="单次请求超时；默认 180 秒")
    parser.add_argument("--disable-thinking", action="store_true", help="仅对本次评估关闭 thinking，不写回本地配置")
    parser.add_argument("--resume", type=Path, help="从已有结果 JSON 续跑未完成的 case/arm，不重跑已完成项")
    parser.add_argument("--run", action="store_true", help="实际发送 API 请求；默认只做本地 dry-run")
    parser.add_argument(
        "--confirm-rotated-key",
        action="store_true",
        help="确认本地模型 API Key 已在服务商处轮换后，才允许发送请求",
    )
    return parser.parse_args()


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def extract_block(package_dir: Path, block: dict) -> str:
    source = (package_dir / block["file"]).read_text(encoding="utf-8")
    marker = f"<!-- knowledge-block: {block['id']} -->"
    start = source.find(marker)
    if start < 0:
        raise ValueError(f"知识块未在来源文件中找到: {block['id']}")
    next_start = source.find("<!-- knowledge-block:", start + len(marker))
    if next_start < 0:
        next_start = len(source)
    return source[start:next_start].strip()


def prepare_cases(benchmark: dict, package_dir: Path, limit: int) -> tuple[list[dict], int]:
    index = load_json(package_dir / "index.json")
    blocks = {block["id"]: block for block in index["blocks"]}
    cases = benchmark["cases"][:limit]
    evidence_chars = 0
    for case in cases:
        selected = []
        for expected in case["expectedSources"]:
            block = blocks.get(expected["blockId"])
            if not block:
                raise ValueError(f"评估用例引用的知识块不存在: {expected['blockId']}")
            if block["documentId"] != expected["documentId"] or block["paragraphId"] != expected["paragraphId"]:
                raise ValueError(f"用例来源与 Skill 索引不一致: {case['id']}")
            content = extract_block(package_dir, block)
            selected.append(content)
            evidence_chars += len(content)
        case["_evidence"] = selected
    return cases, evidence_chars


def response_contains_expected_source(text: str, case: dict) -> bool | None:
    if case["shouldRefuse"]:
        return None
    return any(
        source["blockId"] in text and source["paragraphId"] in text
        for source in case["expectedSources"]
    )


def build_messages(arm: str, case: dict, skill_text: str) -> list[dict[str, str]]:
    if arm == "A":
        system = BASE_PROMPT
        user = f"问题：{case['question']}"
    else:
        system = EVIDENCE_PROMPT
        if arm == "C":
            system += "\n\n以下是本次评估的 Skill 操作说明：\n" + skill_text
        evidence = "\n\n".join(case["_evidence"]) if case["_evidence"] else "（本轮没有检索到相关来源段落。）"
        user = f"可用笔记证据：\n{evidence}\n\n问题：{case['question']}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def save_checkpoint(path: Path, result: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


async def run() -> int:
    args = parse_args()
    if args.limit < 1 or args.timeout_seconds < 1:
        raise ValueError("--limit 与 --timeout-seconds 必须大于 0")
    benchmark = load_json(args.benchmark)
    cases, evidence_chars = prepare_cases(benchmark, args.package, args.limit)
    skill_text = (args.package / "SKILL.md").read_text(encoding="utf-8")

    config = load_json(args.config)
    model_config = config.get("modelConfig") or {}
    if args.model_override:
        model_config["model"] = args.model_override
    if args.disable_thinking:
        model_config["enableThinking"] = False
    model = str(model_config.get("model") or "").strip()
    base_url = str(model_config.get("baseURL") or "").strip()
    api_key = str(model_config.get("apiKey") or "").strip()
    if not model or not base_url:
        raise ValueError("本地配置缺少 modelConfig.model 或 modelConfig.baseURL")

    planned = {
        "benchmarkId": benchmark["benchmarkId"],
        "model": model,
        "apiHost": urlparse(base_url).netloc,
        "caseCount": len(cases),
        "requestCount": len(cases) * 3,
        "selectedEvidenceCharactersAcrossBC": evidence_chars * 2,
        "thinkingEnabled": bool(model_config.get("enableThinking", False)),
        "maxCompletionTokens": MAX_COMPLETION_TOKENS,
        "arms": ["A", "B", "C"],
        "dryRun": not args.run,
    }
    if not args.run:
        print(json.dumps(planned, ensure_ascii=False, indent=2))
        return 0
    if not args.confirm_rotated_key:
        raise ValueError("安全确认缺失：轮换本地配置中的 API Key 后，再附加 --confirm-rotated-key")
    if not api_key:
        raise ValueError("本地配置中未设置 modelConfig.apiKey")

    if args.resume:
        result_path = args.resume
        result = load_json(result_path)
        if result.get("benchmarkId") != benchmark["benchmarkId"]:
            raise ValueError("续跑文件的 benchmarkId 与当前评估集不一致")
        if result.get("model") != model or result.get("apiHost") != urlparse(base_url).netloc:
            raise ValueError("续跑文件的模型或 API host 与当前配置不一致")
        if result.get("complete"):
            raise ValueError("该评估记录已完成，无需续跑")
    else:
        args.results_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
        result_path = args.results_dir / f"mysql_skill_ab_v0.2.0_{timestamp}.json"
        if result_path.exists():
            raise FileExistsError(f"拒绝覆盖已有评估记录: {result_path}")
        result = {
            "schemaVersion": 1,
            "benchmarkId": benchmark["benchmarkId"],
            "skillVersion": "0.2.0",
            "model": model,
            "apiHost": urlparse(base_url).netloc,
            "thinkingEnabled": bool(model_config.get("enableThinking", False)),
            "maxCompletionTokens": MAX_COMPLETION_TOKENS,
            "createdAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "protocol": benchmark["protocol"],
            "records": [],
            "failures": [],
            "complete": False,
        }
        save_checkpoint(result_path, result)

    backend_path = str(ROOT / "backend")
    if backend_path not in sys.path:
        sys.path.insert(0, backend_path)

    from schemas.config import ModelConfig
    from services.llm import build_chat_completion_kwargs

    client = AsyncOpenAI(api_key=api_key, base_url=base_url, timeout=float(args.timeout_seconds), max_retries=0)
    skill_config = ModelConfig(**model_config)
    skill_config.apiKey = api_key
    completed = {(record["caseId"], record["arm"]) for record in result["records"]}
    try:
        for case in cases:
            for arm in ("A", "B", "C"):
                if (case["id"], arm) in completed:
                    continue
                messages = build_messages(arm, case, skill_text)
                started = time.perf_counter()
                try:
                    response = await client.chat.completions.create(
                        **build_chat_completion_kwargs(skill_config, messages),
                        max_tokens=MAX_COMPLETION_TOKENS,
                    )
                    content = response.choices[0].message.content or ""
                    usage = response.usage
                    result["records"].append(
                        {
                            "caseId": case["id"],
                            "arm": arm,
                            "output": content,
                            "latencySeconds": round(time.perf_counter() - started, 3),
                            "promptTokens": usage.prompt_tokens if usage else None,
                            "completionTokens": usage.completion_tokens if usage else None,
                            "refusalDetected": bool(REFUSAL_RE.search(content)),
                            "expectedSourceCitationMatched": response_contains_expected_source(content, case),
                        }
                    )
                    completed.add((case["id"], arm))
                    result["failures"] = [
                        failure
                        for failure in result["failures"]
                        if (failure.get("caseId"), failure.get("arm")) != (case["id"], arm)
                    ]
                    save_checkpoint(result_path, result)
                    print(f"completed {len(result['records'])}/{len(cases) * 3}: {case['id']} [{arm}]")
                    await asyncio.sleep(0.15)
                except APIError as exc:
                    result["failures"] = [
                        failure
                        for failure in result["failures"]
                        if (failure.get("caseId"), failure.get("arm")) != (case["id"], arm)
                    ]
                    result["failures"].append(
                        {
                            "caseId": case["id"],
                            "arm": arm,
                            "errorType": type(exc).__name__,
                            "statusCode": getattr(exc, "status_code", None),
                        }
                    )
                    save_checkpoint(result_path, result)
                    print(f"API 请求失败，已保存当前进度至 {result_path}", file=sys.stderr)
                    return 2
    finally:
        await client.close()

    result["complete"] = len(result["records"]) == len(cases) * 3 and not result["failures"]
    result["finishedAt"] = datetime.now().astimezone().isoformat(timespec="seconds")
    save_checkpoint(result_path, result)
    print(json.dumps({**planned, "resultPath": str(result_path), "complete": result["complete"]}, ensure_ascii=False))
    return 0 if result["complete"] else 2


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run()))
