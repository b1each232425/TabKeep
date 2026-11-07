"""仅供本机开发评估页面使用的资讯排序模型。"""

from typing import Literal

from pydantic import BaseModel, Field


EvaluationLabel = Literal["interested", "not_interested", "unsure"]
EvaluationRankingMode = Literal["keyword", "semantic", "hybrid", "rrf"]
EvaluationSampleSize = Literal[30, 100]


class NewsEvaluationItem(BaseModel):
    itemId: str
    title: str
    excerpt: str
    label: EvaluationLabel | None = None


class NewsEvaluationRunResponse(BaseModel):
    runId: str
    algorithmVersion: str
    sampleSize: int
    items: list[NewsEvaluationItem]


class NewsEvaluationPrepareResponse(BaseModel):
    runId: str
    algorithmVersion: str
    sampleSize: int


class NewsEvaluationPrepareRequest(BaseModel):
    sampleSize: EvaluationSampleSize = 100


class NewsEvaluationLabelsRequest(BaseModel):
    labels: dict[str, EvaluationLabel | None] = Field(min_length=1, max_length=100)


class NewsEvaluationLabelsResponse(BaseModel):
    labeledCount: int
    sampleSize: int
    readyToEvaluate: bool


class NewsEvaluationMetric(BaseModel):
    ndcgAll: float
    averagePrecision: float
    pairwiseAuc: float | None
    coverage: float
    rankedCount: int
    judgedCount: int


class NewsEvaluationRandomBaseline(BaseModel):
    ndcgAll: float
    averagePrecision: float
    pairwiseAuc: float | None


class NewsEvaluationRankedItem(BaseModel):
    itemId: str
    label: EvaluationLabel
    reason: str


class NewsEvaluationGroupSummary(BaseModel):
    sampleCount: int
    labeledCount: int
    judgedCount: int
    interestedCount: int
    notInterestedCount: int
    unsureCount: int
    randomBaseline: NewsEvaluationRandomBaseline
    metrics: dict[EvaluationRankingMode, NewsEvaluationMetric]


class NewsEvaluationSampleCoverage(BaseModel):
    sourceCount: int
    publicationMonthCount: int
    keywordRankBands: dict[str, int]


class NewsEvaluationReportResponse(BaseModel):
    runId: str
    algorithmVersion: str
    embeddingModel: str
    rrfRankConstant: int
    sampleSize: int
    judgedCount: int
    metricsSufficient: bool
    metrics: dict[EvaluationRankingMode, NewsEvaluationMetric]
    sampleCoverage: NewsEvaluationSampleCoverage
    sampleGroups: dict[str, NewsEvaluationGroupSummary]
    randomBaseline: NewsEvaluationRandomBaseline
    recommendation: str
    topItems: dict[EvaluationRankingMode, list[NewsEvaluationRankedItem]]
    reportPath: str
