from pydantic import BaseModel, Field


class EmbeddingConfig(BaseModel):
    enabled: bool = False
    baseURL: str = ""
    apiKey: str = ""
    model: str = ""


class KnowledgeConfig(BaseModel):
    enabled: bool = True
    markdownPaths: list[str] = []
    maxFileBytes: int = 1_000_000
    embedding: EmbeddingConfig = Field(default_factory=EmbeddingConfig)


class KnowledgeStats(BaseModel):
    documents: int = 0
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


class KnowledgeSearchRequest(BaseModel):
    query: str
    limit: int = 8


class KnowledgeCitation(BaseModel):
    documentId: str
    chunkId: str
    title: str
    sourceType: str
    url: str | None = None
    path: str | None = None
    content: str
    score: float = 0


class KnowledgeSearchResponse(BaseModel):
    ok: bool
    query: str
    sourceMode: str
    items: list[KnowledgeCitation] = []
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
