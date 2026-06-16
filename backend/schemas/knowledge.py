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
