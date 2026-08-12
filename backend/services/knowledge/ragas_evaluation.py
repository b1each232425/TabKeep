from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Awaitable

from openai import AsyncOpenAI

from schemas.config import ModelConfig
from schemas.knowledge import EmbeddingConfig
from services import storage


RAGAS_CACHE_DIR = storage.DATA_DIR / "ragas_cache"
RAGAS_METRIC_NAMES = {
    "ragasFaithfulness": "Faithfulness",
    "ragasFactualCorrectness": "Factual Correctness",
    "ragasContextPrecision": "Context Precision",
    "ragasAnswerRelevance": "Answer Relevancy",
}


@dataclass
class RagasEvaluationResult:
    evaluated: bool = False
    faithfulness: float | None = None
    factual_correctness: float | None = None
    context_precision: float | None = None
    answer_relevance: float | None = None
    error: str | None = None

    def as_eval_values(self) -> dict[str, bool | float | str | None]:
        return {
            "ragasEvaluated": self.evaluated,
            "ragasFaithfulness": self.faithfulness,
            "ragasFactualCorrectness": self.factual_correctness,
            "ragasContextPrecision": self.context_precision,
            "ragasAnswerRelevance": self.answer_relevance,
            "ragasError": self.error,
        }


async def evaluate_ragas_answer(
    *,
    question: str,
    response: str,
    contexts: list[str],
    reference: str,
    model_config: ModelConfig,
    embedding_config: EmbeddingConfig,
    timeout_seconds: int,
) -> dict[str, bool | float | str | None]:
    if not reference.strip():
        return RagasEvaluationResult(error="Ragas 评估需要预期答案。").as_eval_values()
    if not response.strip() or not contexts:
        return RagasEvaluationResult(error="缺少生成答案或检索上下文。").as_eval_values()

    llm_client = AsyncOpenAI(
        api_key=model_config.apiKey,
        base_url=model_config.baseURL,
    )
    embedding_client: AsyncOpenAI | None = None
    try:
        tasks, embedding_client = build_metric_tasks(
            question=question,
            response=response,
            contexts=contexts,
            reference=reference,
            model_config=model_config,
            embedding_config=embedding_config,
            llm_client=llm_client,
        )
        metric_results = await asyncio.wait_for(
            score_metric_tasks(tasks),
            timeout=max(5, timeout_seconds),
        )
        return build_ragas_result(metric_results).as_eval_values()
    except TimeoutError:
        return RagasEvaluationResult(
            error=f"Ragas 评估超过 {timeout_seconds} 秒。"
        ).as_eval_values()
    except Exception as exc:
        return RagasEvaluationResult(
            error=f"Ragas 初始化失败: {type(exc).__name__}: {exc}"
        ).as_eval_values()
    finally:
        await llm_client.close()
        if embedding_client is not None:
            await embedding_client.close()


def build_metric_tasks(
    *,
    question: str,
    response: str,
    contexts: list[str],
    reference: str,
    model_config: ModelConfig,
    embedding_config: EmbeddingConfig,
    llm_client: AsyncOpenAI,
) -> tuple[dict[str, Awaitable[object]], AsyncOpenAI | None]:
    try:
        from ragas.cache import DiskCacheBackend
        from ragas.embeddings import OpenAIEmbeddings
        from ragas.llms import llm_factory
        from ragas.metrics.collections import (
            AnswerRelevancy,
            ContextPrecision,
            FactualCorrectness,
            Faithfulness,
        )
    except ImportError as exc:
        raise RuntimeError(
            "未安装 Ragas 评估依赖，请安装 backend/requirements-eval.txt。"
        ) from exc

    RAGAS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache = DiskCacheBackend(str(RAGAS_CACHE_DIR))
    evaluator_llm = llm_factory(
        model_config.model,
        client=llm_client,
        cache=cache,
        temperature=0,
    )
    tasks: dict[str, Awaitable[object]] = {
        "ragasFaithfulness": Faithfulness(llm=evaluator_llm).ascore(
            user_input=question,
            response=response,
            retrieved_contexts=contexts,
        ),
        "ragasFactualCorrectness": FactualCorrectness(llm=evaluator_llm).ascore(
            response=response,
            reference=reference,
        ),
        "ragasContextPrecision": ContextPrecision(llm=evaluator_llm).ascore(
            user_input=question,
            reference=reference,
            retrieved_contexts=contexts,
        ),
    }

    embedding_client: AsyncOpenAI | None = None
    if (
        embedding_config.enabled
        and embedding_config.apiKey.strip()
        and embedding_config.baseURL.strip()
        and embedding_config.model.strip()
    ):
        embedding_client = AsyncOpenAI(
            api_key=embedding_config.apiKey,
            base_url=embedding_config.baseURL,
        )
        embeddings = OpenAIEmbeddings(
            client=embedding_client,
            model=embedding_config.model,
            cache=cache,
        )
        tasks["ragasAnswerRelevance"] = AnswerRelevancy(
            llm=evaluator_llm,
            embeddings=embeddings,
        ).ascore(
            user_input=question,
            response=response,
        )
    return tasks, embedding_client


async def score_metric_tasks(
    tasks: dict[str, Awaitable[object]],
) -> dict[str, object | Exception]:
    names = list(tasks)
    values = await asyncio.gather(
        *(tasks[name] for name in names),
        return_exceptions=True,
    )
    return dict(zip(names, values, strict=True))


def build_ragas_result(
    metric_results: dict[str, object | Exception],
) -> RagasEvaluationResult:
    scores: dict[str, float] = {}
    errors: list[str] = []
    for name, result in metric_results.items():
        if isinstance(result, Exception):
            errors.append(
                f"{RAGAS_METRIC_NAMES.get(name, name)}: {type(result).__name__}: {result}"
            )
            continue
        value = metric_value(result)
        if value is None:
            errors.append(f"{RAGAS_METRIC_NAMES.get(name, name)}: 未返回有效分数")
            continue
        scores[name] = value

    return RagasEvaluationResult(
        evaluated=bool(scores),
        faithfulness=scores.get("ragasFaithfulness"),
        factual_correctness=scores.get("ragasFactualCorrectness"),
        context_precision=scores.get("ragasContextPrecision"),
        answer_relevance=scores.get("ragasAnswerRelevance"),
        error="；".join(errors) if errors else None,
    )


def metric_value(result: object) -> float | None:
    raw = getattr(result, "value", result)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if value != value:
        return None
    return round(max(0.0, min(value, 1.0)), 6)
