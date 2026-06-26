from pydantic import BaseModel, Field, model_validator


DEFAULT_EMBEDDING_BASE_URL = "https://api.siliconflow.cn/v1"
DEFAULT_EMBEDDING_MODEL = "BAAI/bge-m3"
DEFAULT_RERANK_MODEL = "BAAI/bge-reranker-v2-m3"


class EmbeddingConfig(BaseModel):
    enabled: bool = False
    baseURL: str = DEFAULT_EMBEDDING_BASE_URL
    apiKey: str = ""
    model: str = DEFAULT_EMBEDDING_MODEL

    @model_validator(mode="after")
    def fill_default_provider(self) -> "EmbeddingConfig":
        if not self.baseURL.strip():
            self.baseURL = DEFAULT_EMBEDDING_BASE_URL
        if not self.model.strip():
            self.model = DEFAULT_EMBEDDING_MODEL
        return self


class RerankConfig(BaseModel):
    enabled: bool = False
    baseURL: str = DEFAULT_EMBEDDING_BASE_URL
    apiKey: str = ""
    model: str = DEFAULT_RERANK_MODEL
    topN: int = 20


class KnowledgeConfig(BaseModel):
    enabled: bool = True
    markdownPaths: list[str] = []
    maxFileBytes: int = 1_000_000
    embedding: EmbeddingConfig = Field(default_factory=EmbeddingConfig)


class KnowledgeStats(BaseModel):
    documents: int = 0
    paragraphs: int = 0
    chunks: int = 0
    sessions: int = 0
    lastIndexedAt: str | None = None
    vectorAvailable: bool = False
    vectorMessage: str | None = None


class KnowledgeReindexResponse(BaseModel):
    ok: bool
    documentsIndexed: int = 0
    documentsSkipped: int = 0
    chunksIndexed: int = 0
    errors: list[str] = []
    stats: KnowledgeStats


class KnowledgeSiyuanSyncRequest(BaseModel):
    notebookId: str | None = None
    limit: int | None = None


class KnowledgeSiyuanPrecheckResponse(BaseModel):
    ok: bool
    provider: str | None = None
    endpoint: str | None = None
    notebooks: list[dict[str, str]] = []
    error: str | None = None


class KnowledgeSiyuanSyncResponse(BaseModel):
    ok: bool
    notebooksScanned: int = 0
    documentsFound: int = 0
    documentsIndexed: int = 0
    documentsSkipped: int = 0
    chunksIndexed: int = 0
    errors: list[str] = []
    stats: KnowledgeStats


class KnowledgeSyncSourceResult(BaseModel):
    source: str
    label: str
    ok: bool
    status: str = "success"
    skipped: bool = False
    reason: str | None = None
    startedAt: str | None = None
    endedAt: str | None = None
    durationMs: int = 0
    documentsFound: int = 0
    documentsIndexed: int = 0
    documentsSkipped: int = 0
    chunksIndexed: int = 0
    notebooksScanned: int = 0
    errors: list[str] = []


class KnowledgeSyncAllResponse(BaseModel):
    ok: bool
    runId: str = ""
    status: str = "success"
    startedAt: str | None = None
    endedAt: str | None = None
    durationMs: int = 0
    sources: list[KnowledgeSyncSourceResult] = []
    documentsFound: int = 0
    documentsIndexed: int = 0
    documentsSkipped: int = 0
    chunksIndexed: int = 0
    errors: list[str] = []
    stats: KnowledgeStats


class KnowledgeSyncLogResponse(BaseModel):
    items: list[KnowledgeSyncAllResponse] = []


class KnowledgeIndexHealthIssue(BaseModel):
    key: str
    label: str
    severity: str = "warning"
    count: int = 0
    message: str = ""
    repairable: bool = False


class KnowledgeIndexHealthResponse(BaseModel):
    ok: bool
    status: str = "healthy"
    checkedAt: str
    documents: int = 0
    paragraphs: int = 0
    chunks: int = 0
    ftsRows: int = 0
    vectorRows: int = 0
    orphanChunks: int = 0
    orphanParagraphs: int = 0
    orphanFtsRows: int = 0
    missingFtsRows: int = 0
    vectorMissingSqlRows: int = 0
    vectorMissingParagraphRows: int = 0
    staleMarkdownDocuments: int = 0
    embeddingStatusCounts: dict[str, int] = {}
    vectorAvailable: bool = False
    vectorMessage: str | None = None
    vectorSchemaReady: bool = False
    missingVectorColumns: list[str] = []
    issues: list[KnowledgeIndexHealthIssue] = []
    repairableIssues: list[str] = []
    stats: KnowledgeStats
    error: str | None = None


class KnowledgeIndexRepairResponse(BaseModel):
    ok: bool
    repaired: bool = False
    orphanFtsRowsDeleted: int = 0
    missingFtsRowsInserted: int = 0
    health: KnowledgeIndexHealthResponse
    errors: list[str] = []


class KnowledgeSearchRequest(BaseModel):
    query: str
    limit: int = 8


class KnowledgeHitTestRequest(BaseModel):
    query: str
    limit: int = 8
    searchMode: str = "hybrid"
    minScore: float = 0


class KnowledgeCitation(BaseModel):
    documentId: str
    paragraphId: str | None = None
    chunkId: str
    title: str
    paragraphTitle: str | None = None
    sourceType: str
    url: str | None = None
    path: str | None = None
    content: str
    matchedContent: str | None = None
    score: float = 0
    rerankScore: float | None = None


class KnowledgeSearchResponse(BaseModel):
    ok: bool
    query: str
    sourceMode: str
    items: list[KnowledgeCitation] = []
    rerankUsed: bool = False
    rerankMessage: str | None = None
    error: str | None = None


class KnowledgeHitTestItem(KnowledgeCitation):
    rank: int = 0
    matchedBy: list[str] = []
    ftsRank: int | None = None
    ftsScore: float | None = None
    ftsRawRank: float | None = None
    vectorRank: int | None = None
    vectorScore: float | None = None
    vectorDistance: float | None = None
    rrfScore: float = 0
    rrfRank: int | None = None


class KnowledgeHitTestResponse(BaseModel):
    ok: bool
    query: str
    searchMode: str
    sourceMode: str
    items: list[KnowledgeHitTestItem] = []
    vectorAvailable: bool = False
    vectorMessage: str | None = None
    rerankUsed: bool = False
    rerankMessage: str | None = None
    error: str | None = None


class KnowledgeEvalCaseRequest(BaseModel):
    question: str
    caseType: str = "keyword"
    expectedText: str = ""
    expectedPath: str = ""
    expectedTitle: str = ""
    expectedDocumentId: str = ""
    expectedParagraphId: str = ""
    expectedAnswer: str = ""
    answerKeywords: str = ""
    shouldRefuse: bool = False
    note: str = ""


class KnowledgeEvalCase(BaseModel):
    id: str
    question: str
    caseType: str = "keyword"
    expectedText: str = ""
    expectedPath: str = ""
    expectedTitle: str = ""
    expectedDocumentId: str = ""
    expectedParagraphId: str = ""
    expectedAnswer: str = ""
    answerKeywords: str = ""
    shouldRefuse: bool = False
    note: str = ""
    createdAt: str
    updatedAt: str


class KnowledgeEvalDeleteResponse(BaseModel):
    ok: bool
    deleted: bool = False
    error: str | None = None


class KnowledgeEvalRunRequest(BaseModel):
    caseIds: list[str] = []
    limit: int = 8
    searchMode: str = "hybrid"
    minScore: float = 0
    evaluateAnswer: bool = False
    answerLimit: int = 30
    answerTimeoutSeconds: int = 45


class KnowledgeEvalHit(KnowledgeHitTestItem):
    relevant: bool = False
    matchedExpectations: list[str] = []


class KnowledgeEvalCaseResult(BaseModel):
    case: KnowledgeEvalCase
    ok: bool
    rank: int | None = None
    reciprocalRank: float = 0
    hits: list[KnowledgeEvalHit] = []
    issueType: str = "ok"
    issueMessage: str = ""
    answerEvaluated: bool = False
    answerOk: bool | None = None
    answer: str = ""
    answerScore: float = 0
    answerKeywordCoverage: float = 0
    answerFaithfulness: float = 0
    answerRelevance: float = 0
    refusalOk: bool | None = None
    answerIssueType: str = "not_evaluated"
    answerIssueMessage: str = ""
    matchedAnswerKeywords: list[str] = []
    missingAnswerKeywords: list[str] = []
    error: str | None = None


class KnowledgeEvalRankBucket(BaseModel):
    rank: int
    count: int = 0


class KnowledgeEvalTypeSummary(BaseModel):
    caseType: str
    total: int = 0
    hitCount: int = 0
    recallAtK: float = 0
    mrr: float = 0
    top1Accuracy: float = 0
    rankDistribution: list[KnowledgeEvalRankBucket] = []


class KnowledgeEvalRunResponse(BaseModel):
    ok: bool
    total: int = 0
    evaluated: int = 0
    retrievalEvaluated: int = 0
    hitCount: int = 0
    recallAtK: float = 0
    mrr: float = 0
    top1Accuracy: float = 0
    answerEligible: int = 0
    answerLimit: int = 0
    answerEvaluated: int = 0
    answerPassCount: int = 0
    answerAccuracy: float = 0
    refusalEvaluated: int = 0
    refusalPassCount: int = 0
    refusalAccuracy: float = 0
    averageAnswerScore: float = 0
    averageFaithfulness: float = 0
    averageAnswerRelevance: float = 0
    rankDistribution: list[KnowledgeEvalRankBucket] = []
    typeSummaries: list[KnowledgeEvalTypeSummary] = []
    limit: int = 8
    searchMode: str = "hybrid"
    sourceModes: dict[str, int] = {}
    results: list[KnowledgeEvalCaseResult] = []
    error: str | None = None


class KnowledgeVectorColumn(BaseModel):
    name: str
    type: str


class KnowledgeVectorRecord(BaseModel):
    chunkId: str
    documentId: str
    paragraphId: str | None = None
    title: str = ""
    sourceType: str = ""
    path: str | None = None
    url: str | None = None
    content: str = ""
    contentPreview: str = ""
    vectorDims: int = 0
    vectorPreview: list[float] = []
    documentTitle: str | None = None
    paragraphTitle: str | None = None
    paragraphContentPreview: str | None = None
    paragraphCharLen: int | None = None


class KnowledgeVectorInspectResponse(BaseModel):
    ok: bool
    vectorAvailable: bool = False
    vectorMessage: str | None = None
    tableExists: bool = False
    tableName: str = ""
    path: str = ""
    rowCount: int = 0
    columns: list[KnowledgeVectorColumn] = []
    requiredColumns: list[str] = []
    missingColumns: list[str] = []
    schemaReady: bool = False
    query: str = ""
    limit: int = 100
    records: list[KnowledgeVectorRecord] = []
    error: str | None = None


class KnowledgeAskRequest(BaseModel):
    question: str
    sessionId: str | None = None
    limit: int = 8


class KnowledgeAskResponse(BaseModel):
    ok: bool
    answer: str = ""
    citations: list[KnowledgeCitation] = []
    sessionId: str | None = None
    sourceMode: str = "fts"
    error: str | None = None


class KnowledgeGraphNode(BaseModel):
    id: str
    kind: str
    label: str
    documentId: str | None = None
    sourceType: str | None = None
    url: str | None = None
    path: str | None = None
    noteId: str | None = None
    degree: int = 0


class KnowledgeGraphEdge(BaseModel):
    id: str
    source: str
    target: str
    kind: str
    weight: float = 1


class KnowledgeGraphStats(BaseModel):
    nodes: int = 0
    edges: int = 0
    totalNodes: int = 0
    totalEdges: int = 0


class KnowledgeGraphResponse(BaseModel):
    ok: bool
    layer: str = "all"
    nodes: list[KnowledgeGraphNode] = []
    edges: list[KnowledgeGraphEdge] = []
    stats: KnowledgeGraphStats = Field(default_factory=KnowledgeGraphStats)
    error: str | None = None


class KnowledgeGraphRebuildResponse(BaseModel):
    ok: bool
    nodes: int = 0
    edges: int = 0
    error: str | None = None


class KnowledgeTopicStats(BaseModel):
    topics: int = 0
    documents: int = 0
    relations: int = 0
    totalTopics: int = 0


class KnowledgeTopic(BaseModel):
    id: str
    title: str
    summary: str = ""
    keywords: list[str] = []
    sourceTypes: list[str] = []
    documentCount: int = 0
    evidenceCount: int = 0
    relationCount: int = 0
    confidence: float = 0
    aiEnhanced: bool = False
    updatedAt: str | None = None


class KnowledgeTopicDocument(BaseModel):
    documentId: str
    title: str
    sourceType: str
    url: str | None = None
    path: str | None = None
    noteId: str | None = None
    anchor: str | None = None
    score: float = 0
    reason: str = ""
    snippet: str = ""


class KnowledgeTopicEvidence(BaseModel):
    id: str
    kind: str
    label: str
    documentId: str | None = None
    weight: float = 1


class KnowledgeTopicRelation(BaseModel):
    id: str
    sourceTopicId: str
    targetTopicId: str
    kind: str
    label: str = ""
    weight: float = 1


class KnowledgeTopicListResponse(BaseModel):
    ok: bool
    topics: list[KnowledgeTopic] = []
    stats: KnowledgeTopicStats = Field(default_factory=KnowledgeTopicStats)
    error: str | None = None


class KnowledgeTopicDetailResponse(BaseModel):
    ok: bool
    topic: KnowledgeTopic | None = None
    documents: list[KnowledgeTopicDocument] = []
    evidence: list[KnowledgeTopicEvidence] = []
    relations: list[KnowledgeTopicRelation] = []
    error: str | None = None


class KnowledgeTopicRebuildResponse(BaseModel):
    ok: bool
    topics: int = 0
    topicDocuments: int = 0
    evidence: int = 0
    relations: int = 0
    error: str | None = None


class KnowledgeTopicEnrichRequest(BaseModel):
    topicId: str | None = None


class KnowledgeTopicEnrichResponse(BaseModel):
    ok: bool
    topics: int = 0
    error: str | None = None


class KnowledgeTopicExportResponse(BaseModel):
    ok: bool
    topicId: str
    noteId: str | None = None
    openTarget: str | None = None
    provider: str | None = None
    error: str | None = None


class KnowledgeSession(BaseModel):
    id: str
    title: str
    createdAt: str
    updatedAt: str


class KnowledgeMessage(BaseModel):
    id: str
    sessionId: str
    role: str
    content: str
    createdAt: str
