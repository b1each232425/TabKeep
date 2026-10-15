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


class KnowledgeDocumentIndexStatus(BaseModel):
    documentId: str
    sourceType: str
    title: str
    url: str | None = None
    path: str | None = None
    noteId: str | None = None
    contentHash: str
    contentBytes: int = 0
    paragraphCount: int = 0
    chunkCount: int = 0
    indexStatus: str = "ready"
    embeddingStatus: str = "disabled"
    lastError: str = ""
    updatedAt: str
    indexedAt: str
    lastSeenAt: str | None = None


class KnowledgeDocumentIndexListResponse(BaseModel):
    ok: bool
    total: int = 0
    items: list[KnowledgeDocumentIndexStatus] = []


class KnowledgeReindexResponse(BaseModel):
    ok: bool
    documentsIndexed: int = 0
    documentsSkipped: int = 0
    documentsDeleted: int = 0
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
    documentsDeleted: int = 0
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
    documentsDeleted: int = 0
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
    documentsDeleted: int = 0
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


class KnowledgeCitationSource(BaseModel):
    documentId: str
    paragraphId: str | None = None
    chunkId: str
    title: str
    paragraphTitle: str | None = None
    sourceType: str
    url: str | None = None
    path: str | None = None


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
    duplicateSources: list[KnowledgeCitationSource] = []
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


class KnowledgeSkillExportRequest(BaseModel):
    goal: str
    documentIds: list[str] = []
    paragraphIds: list[str] = []
    skillName: str = "tabkeep-knowledge-skill"
    displayName: str = "TabKeep 知识 Skill"
    description: str = ""
    skillVersion: str = "0.1.0"
    triggers: list[str] = []
    capabilities: list[str] = []


class KnowledgeSkillDraftRequest(BaseModel):
    goal: str
    documentIds: list[str] = []
    paragraphIds: list[str] = []


class KnowledgeSkillDraftResponse(BaseModel):
    ok: bool
    skillName: str = ""
    displayName: str = ""
    description: str = ""
    skillVersion: str = "0.1.0"
    triggers: list[str] = []
    capabilities: list[str] = []
    error: str | None = None


class KnowledgeSkillExportResponse(BaseModel):
    ok: bool
    fileName: str = ""
    archiveBase64: str = ""
    skillName: str = ""
    skillVersion: str = ""
    sourceCount: int = 0
    blockCount: int = 0
    contentHash: str = ""
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
    queryRewriteAttempted: bool = False
    queryRewriteUsed: bool = False
    error: str | None = None


class RgbEvalImportRequest(BaseModel):
    fileName: str
    content: str


class RgbEvalStatusResponse(BaseModel):
    ok: bool = True
    imported: bool = False
    dataset: str = "rgb-zh-refine"
    fileName: str = ""
    datasetVersion: str = ""
    importedAt: str | None = None
    caseCount: int = 0
    passageCount: int = 0
    vectorCount: int = 0
    embeddingConfigured: bool = False
    vectorAvailable: bool = False
    warning: str | None = None
    error: str | None = None


class RgbEvalRunRequest(BaseModel):
    caseLimit: int = Field(default=10, ge=0, le=10000)
    limit: int = Field(default=10, ge=1, le=50)
    searchMode: str = "hybrid"
    minScore: float = Field(default=0, ge=0)


class RgbEvalHit(KnowledgeHitTestItem):
    relevant: bool = False
    knownNegative: bool = False


class RgbEvalCaseResult(BaseModel):
    caseId: str
    question: str
    positiveCount: int = 0
    negativeCount: int = 0
    relevantRetrieved: int = 0
    negativeRetrieved: int = 0
    recallAtK: float = 0
    reciprocalRank: float = 0
    firstRelevantRank: int | None = None
    hits: list[RgbEvalHit] = []
    error: str | None = None


class RgbEvalRunResponse(BaseModel):
    ok: bool
    runId: str | None = None
    dataset: str = "rgb-zh-refine"
    datasetVersion: str = ""
    createdAt: str | None = None
    durationMs: int = 0
    totalCases: int = 0
    evaluated: int = 0
    caseLimit: int = 0
    passageCount: int = 0
    limit: int = 10
    searchMode: str = "hybrid"
    recallAtK: float = 0
    precisionAtK: float = 0
    mrr: float = 0
    top1Accuracy: float = 0
    negativeHitRateAtK: float = 0
    vectorAvailable: bool = False
    results: list[RgbEvalCaseResult] = []
    error: str | None = None


class RgbEvalRunSummary(BaseModel):
    runId: str
    createdAt: str
    durationMs: int = 0
    totalCases: int = 0
    evaluated: int = 0
    caseLimit: int = 0
    limit: int = 10
    searchMode: str = "hybrid"
    recallAtK: float = 0
    precisionAtK: float = 0
    mrr: float = 0
    top1Accuracy: float = 0


class RgbEvalRunRecord(BaseModel):
    runId: str
    createdAt: str
    durationMs: int = 0
    request: RgbEvalRunRequest
    result: RgbEvalRunResponse


class KnowledgeEvalRelevantTarget(BaseModel):
    text: str = ""
    path: str = ""
    title: str = ""
    documentId: str = ""
    paragraphId: str = ""


class KnowledgeEvalCaseRequest(BaseModel):
    question: str
    caseType: str = "keyword"
    expectedText: str = ""
    expectedPath: str = ""
    expectedTitle: str = ""
    expectedDocumentId: str = ""
    expectedParagraphId: str = ""
    additionalRelevantTargets: list[KnowledgeEvalRelevantTarget] = []
    expectedAnswer: str = ""
    answerKeywords: str = ""
    shouldRefuse: bool = False
    isCore: bool = False
    note: str = ""
    dataset: str = "tabkeep-mysql-notes-v2"


class KnowledgeEvalCase(BaseModel):
    id: str
    question: str
    caseType: str = "keyword"
    expectedText: str = ""
    expectedPath: str = ""
    expectedTitle: str = ""
    expectedDocumentId: str = ""
    expectedParagraphId: str = ""
    additionalRelevantTargets: list[KnowledgeEvalRelevantTarget] = []
    expectedAnswer: str = ""
    answerKeywords: str = ""
    shouldRefuse: bool = False
    isCore: bool = False
    note: str = ""
    dataset: str = "tabkeep-mysql-notes-v2"
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
    queryRewrite: bool = False
    evaluateAnswer: bool = False
    evaluateRagas: bool = False
    answerLimit: int = 56
    answerTimeoutSeconds: int = 45
    ragasTimeoutSeconds: int = 120


class KnowledgeEvalHit(KnowledgeHitTestItem):
    relevant: bool = False
    matchedExpectations: list[str] = []
    matchedTargetIndexes: list[int] = []


class KnowledgeEvalCaseResult(BaseModel):
    case: KnowledgeEvalCase
    ok: bool
    rank: int | None = None
    reciprocalRank: float = 0
    relevantHitCount: int = 0
    precisionAtK: float = 0
    retrievalDurationMs: int = 0
    queryRewriteAttempted: bool = False
    queryRewriteUsed: bool = False
    queryRewriteInput: str | None = None
    queryRewriteOutput: str | None = None
    queryRewriteVectorQueryBefore: str | None = None
    queryRewriteVectorQueryAfter: str | None = None
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
    ragasEvaluated: bool = False
    ragasFaithfulness: float | None = None
    ragasFactualCorrectness: float | None = None
    ragasContextPrecision: float | None = None
    ragasContextRecall: float | None = None
    ragasAnswerRelevance: float | None = None
    ragasError: str | None = None
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
    precisionAtK: float = 0
    mrr: float = 0
    top1Accuracy: float = 0
    rankDistribution: list[KnowledgeEvalRankBucket] = []


class KnowledgeEvalRunResponse(BaseModel):
    ok: bool
    runId: str | None = None
    dataset: str = ""
    datasetVersion: str = ""
    caseSetHash: str = ""
    indexStatus: dict = Field(default_factory=dict)
    total: int = 0
    evaluated: int = 0
    retrievalEvaluated: int = 0
    hitCount: int = 0
    recallAtK: float = 0
    precisionAtK: float = 0
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
    ragasRequested: bool = False
    ragasEligible: int = 0
    ragasEvaluated: int = 0
    ragasFailed: int = 0
    averageRagasFaithfulness: float | None = None
    averageRagasFactualCorrectness: float | None = None
    averageRagasContextPrecision: float | None = None
    averageRagasContextRecall: float | None = None
    averageRagasAnswerRelevance: float | None = None
    rankDistribution: list[KnowledgeEvalRankBucket] = []
    typeSummaries: list[KnowledgeEvalTypeSummary] = []
    limit: int = 8
    searchMode: str = "hybrid"
    queryRewriteEnabled: bool = False
    queryRewriteCalls: int = 0
    queryRewriteUses: int = 0
    averageRetrievalDurationMs: int = 0
    sourceModes: dict[str, int] = {}
    results: list[KnowledgeEvalCaseResult] = []
    error: str | None = None


class KnowledgeEvalRunSummary(BaseModel):
    runId: str
    createdAt: str
    dataset: str = ""
    datasetVersion: str = ""
    durationMs: int = 0
    total: int = 0
    evaluated: int = 0
    recallAtK: float = 0
    precisionAtK: float = 0
    mrr: float = 0
    top1Accuracy: float = 0
    answerEvaluated: int = 0
    ragasRequested: bool = False
    ragasEvaluated: int = 0
    ragasFailed: int = 0
    limit: int = 8
    searchMode: str = "hybrid"
    queryRewriteEnabled: bool = False
    queryRewriteCalls: int = 0
    queryRewriteUses: int = 0
    averageRetrievalDurationMs: int = 0
    evaluateAnswer: bool = False
    evaluateRagas: bool = False
    answerLimit: int = 0


class KnowledgeEvalRunRecord(BaseModel):
    runId: str
    createdAt: str
    durationMs: int = 0
    request: KnowledgeEvalRunRequest
    result: KnowledgeEvalRunResponse


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
    limit: int = 5


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
