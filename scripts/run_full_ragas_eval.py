"""Run and persist one complete local TabKeep Ragas evaluation.

The runner starts a development backend in its own child process when the
configured local port is not already serving TabKeep. It deliberately uses a
proxy-free opener for localhost because this workstation's HTTP proxy returns
502 for local ports. The backend keeps its normal proxy environment for
SiliconFlow requests.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, ProxyHandler, build_opener


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
DATASET = ROOT / "backend" / "evaluation" / "rag" / "tabkeep_mysql_notes_v2.json"
OUTPUT_DIR = ROOT / "backend" / "evaluation" / "rag" / "runs"
LOCAL_OPENER = build_opener(ProxyHandler({}))


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def request_json(url: str, *, method: str = "GET", payload: dict[str, Any] | None = None, timeout: int = 30) -> Any:
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = Request(url, data=body, headers=headers, method=method)
    with LOCAL_OPENER.open(request, timeout=timeout) as response:
        raw = response.read()
    return json.loads(raw.decode("utf-8"))


def try_local_root(base_url: str) -> bool:
    try:
        response = request_json(f"{base_url}/", timeout=5)
        return response.get("message") == "TabKeep API Running"
    except Exception:
        return False


def wait_for_backend(base_url: str, process: subprocess.Popen[bytes] | None) -> None:
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        if try_local_root(base_url):
            return
        if process is not None and process.poll() is not None:
            raise RuntimeError(f"backend exited before ready with code {process.returncode}")
        time.sleep(2)
    raise TimeoutError("backend did not become ready within 90 seconds")


def start_backend(base_url: str) -> tuple[subprocess.Popen[bytes] | None, bool]:
    if try_local_root(base_url):
        return None, False

    env = os.environ.copy()
    env["TABKEEP_DISABLE_AUTH"] = "1"
    env["TABKEEP_BACKEND_PORT"] = str(base_url.rsplit(":", 1)[-1])
    log_dir = ROOT / ".tmp"
    log_dir.mkdir(parents=True, exist_ok=True)
    stdout = (log_dir / "full-ragas-backend.out.log").open("wb")
    stderr = (log_dir / "full-ragas-backend.err.log").open("wb")
    process = subprocess.Popen(
        [sys.executable, "-u", "main.py"],
        cwd=BACKEND,
        env=env,
        stdout=stdout,
        stderr=stderr,
    )
    # The file handles are inherited by the child and can be closed in the parent.
    stdout.close()
    stderr.close()
    wait_for_backend(base_url, process)
    return process, True


def stop_backend(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)


def dataset_metadata(raw: bytes) -> dict[str, Any]:
    cases = json.loads(raw.decode("utf-8"))
    return {
        "path": str(DATASET.relative_to(ROOT)).replace("\\", "/"),
        "caseCount": len(cases),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


def verify_remote_cases(local_cases: list[dict[str, Any]], remote_cases: list[dict[str, Any]]) -> None:
    fields = (
        "id", "question", "caseType", "expectedText", "expectedPath", "expectedTitle",
        "expectedDocumentId", "expectedParagraphId", "additionalRelevantTargets",
        "expectedAnswer", "answerKeywords", "shouldRefuse", "isCore", "note", "dataset",
    )
    local = {case["id"]: {field: case.get(field) for field in fields} for case in local_cases}
    remote = {case["id"]: {field: case.get(field) for field in fields} for case in remote_cases}
    if len(local) != 56 or len(remote) != 56 or local != remote:
        raise RuntimeError("v2 JSON 与后端数据库用例不一致；先运行 scripts/sync_mysql_eval_v2.py --check/--import 并重启后端")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the complete TabKeep Ragas evaluation")
    parser.add_argument("--base-url", default="http://127.0.0.1:38471")
    parser.add_argument("--answer-timeout", type=int, default=120)
    parser.add_argument("--ragas-timeout", type=int, default=180)
    parser.add_argument("--core", action="store_true", help="evaluate the 20-case core subset first")
    parser.add_argument("--retrieval-only", action="store_true", help="run retrieval metrics without answer/Ragas model calls")
    args = parser.parse_args()

    base_url = args.base_url.rstrip("/")
    run_id = datetime.now().strftime("%Y%m%dT%H%M%S%f")
    started_at = utc_now()
    dataset_bytes = DATASET.read_bytes()
    local_cases = json.loads(dataset_bytes.decode("utf-8"))
    selected_cases = [case for case in local_cases if case["isCore"]] if args.core else local_cases
    request_payload: dict[str, Any] = {
        "caseIds": [case["id"] for case in selected_cases],
        "limit": 10,
        "searchMode": "hybrid",
        "minScore": 0,
        "evaluateAnswer": not args.retrieval_only,
        "evaluateRagas": not args.retrieval_only,
        "answerLimit": len(selected_cases),
        "answerTimeoutSeconds": max(5, min(args.answer_timeout, 180)),
        "ragasTimeoutSeconds": max(10, min(args.ragas_timeout, 300)),
    }

    process: subprocess.Popen[bytes] | None = None
    started_backend = False
    try:
        print("[1/4] 检查并启动本地后端...")
        process, started_backend = start_backend(base_url)
        print("[2/4] 校验评估集和索引健康状态...")
        cases = request_json(f"{base_url}/knowledge/eval/cases")
        verify_remote_cases(local_cases, cases)
        index_health = request_json(f"{base_url}/knowledge/index/health")
        print(f"v2 评估集={len(cases)}，本次={len(selected_cases)}，索引状态={index_health.get('status', 'unknown')}")
        print(f"[3/4] 检索金标={sum(not c['shouldRefuse'] for c in selected_cases)}，答案={0 if args.retrieval_only else len(selected_cases)}，Ragas 上限={0 if args.retrieval_only else sum(not c['shouldRefuse'] for c in selected_cases)}，拒答={sum(c['shouldRefuse'] for c in selected_cases)}；可能需要较长时间...")
        result = request_json(
            f"{base_url}/knowledge/eval/run",
            method="POST",
            payload=request_payload,
            timeout=3600,
        )
        finished_at = utc_now()
        record = {
            "runId": run_id,
            "startedAt": started_at,
            "finishedAt": finished_at,
            "runner": "scripts/run_full_ragas_eval.py",
            "backendStartedByRunner": started_backend,
            "dataset": dataset_metadata(dataset_bytes),
            "request": request_payload,
            "indexHealth": index_health,
            "result": result,
        }
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        output_path = OUTPUT_DIR / f"{run_id}.json"
        output_path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("[4/4] 评估完成并已保存：" + str(output_path))
        print(json.dumps({
            "runId": run_id,
            "total": result.get("total"),
            "evaluated": result.get("evaluated"),
            "retrievalEvaluated": result.get("retrievalEvaluated"),
            "answerEvaluated": result.get("answerEvaluated"),
            "ragasEligible": result.get("ragasEligible"),
            "ragasEvaluated": result.get("ragasEvaluated"),
            "ragasFailed": result.get("ragasFailed"),
            "refusalEvaluated": result.get("refusalEvaluated"),
            "refusalPassCount": result.get("refusalPassCount"),
            "output": str(output_path),
        }, ensure_ascii=False))
        return 0
    except (HTTPError, URLError, TimeoutError, RuntimeError, json.JSONDecodeError) as exc:
        print(f"评估失败：{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    finally:
        if started_backend:
            stop_backend(process)


if __name__ == "__main__":
    raise SystemExit(main())
