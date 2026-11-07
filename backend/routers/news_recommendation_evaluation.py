"""仅在本机开发模式启用的资讯推荐评估 API。"""

from fastapi import APIRouter, Depends, HTTPException, Response, status

from schemas.news_evaluation import (
    NewsEvaluationLabelsRequest,
    NewsEvaluationLabelsResponse,
    NewsEvaluationPrepareRequest,
    NewsEvaluationPrepareResponse,
    NewsEvaluationReportResponse,
    NewsEvaluationRunResponse,
)
from services.news import recommendation_evaluation as evaluation
from services.news.web_auth import require_news_access


router = APIRouter(
    prefix="/news/dev/recommendation-evaluation",
    tags=["开发评估"],
    dependencies=[Depends(require_news_access)],
)


def _disable_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"


def _bad_request(error: ValueError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error))


@router.post("/runs", response_model=NewsEvaluationPrepareResponse)
def prepare_evaluation(
    body: NewsEvaluationPrepareRequest,
    response: Response,
) -> dict[str, object]:
    """生成指定大小的盲测批次。"""
    _disable_cache(response)
    try:
        run = evaluation.prepare_evaluation(sample_size=body.sampleSize)
    except ValueError as error:
        raise _bad_request(error) from error
    return {
        "runId": run["runId"],
        "algorithmVersion": run["algorithmVersion"],
        "sampleSize": run["sampleSize"],
    }


@router.get("/runs/{run_id}", response_model=NewsEvaluationRunResponse)
def get_evaluation_run(run_id: str, response: Response) -> dict[str, object]:
    """读取盲测卡片及本机已有标签。"""
    _disable_cache(response)
    try:
        return evaluation.get_evaluation_batch(run_id)
    except ValueError as error:
        raise _bad_request(error) from error


@router.put("/runs/{run_id}/labels", response_model=NewsEvaluationLabelsResponse)
def save_evaluation_labels(
    run_id: str,
    body: NewsEvaluationLabelsRequest,
    response: Response,
) -> dict[str, object]:
    """保存评估标签，不把它们写进兴趣画像事件。"""
    _disable_cache(response)
    try:
        return evaluation.save_evaluation_labels(run_id, body.labels)
    except ValueError as error:
        raise _bad_request(error) from error


@router.post("/runs/{run_id}/evaluate", response_model=NewsEvaluationReportResponse)
async def evaluate_recommendations(run_id: str, response: Response) -> dict[str, object]:
    """用户显式触发后，调用已配置的 embedding 服务进行排序对照。"""
    _disable_cache(response)
    try:
        return await evaluation.evaluate_run(run_id)
    except ValueError as error:
        raise _bad_request(error) from error
    except Exception as error:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Embedding 服务调用失败；本次对照未完成，线上关键词推荐不受影响。",
        ) from error
