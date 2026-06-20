from fastapi import APIRouter, Depends

from schemas.knowledge import (
    KnowledgeAskRequest,
    KnowledgeAskResponse,
    KnowledgeConfig,
    KnowledgeGraphRebuildResponse,
    KnowledgeGraphResponse,
    KnowledgeMessage,
    KnowledgeReindexResponse,
    KnowledgeSearchRequest,
    KnowledgeSearchResponse,
    KnowledgeSession,
    KnowledgeStats,
    KnowledgeSiyuanPrecheckResponse,
    KnowledgeSiyuanSyncRequest,
    KnowledgeSiyuanSyncResponse,
    KnowledgeTopicDetailResponse,
    KnowledgeTopicEnrichRequest,
    KnowledgeTopicEnrichResponse,
    KnowledgeTopicExportResponse,
    KnowledgeTopicListResponse,
    KnowledgeTopicRebuildResponse,
)
from services import storage
from services.auth import require_api_token
from services.knowledge import db, service, vector_store

router = APIRouter(prefix="/knowledge", tags=["知识库"], dependencies=[Depends(require_api_token)])


@router.get("/config", response_model=KnowledgeConfig, summary="读取知识库配置")
def get_config() -> KnowledgeConfig:
    return storage.get_knowledge_config()


@router.post("/config", response_model=KnowledgeConfig, summary="保存知识库配置")
def set_config(config: KnowledgeConfig) -> KnowledgeConfig:
    storage.set_knowledge_config(config)
    return storage.get_knowledge_config()


@router.get("/stats", response_model=KnowledgeStats, summary="读取知识库统计")
def get_stats() -> KnowledgeStats:
    vector_ok, vector_message = vector_store.availability()
    return db.get_stats(vector_ok, vector_message)


@router.post("/reindex", response_model=KnowledgeReindexResponse, summary="重建知识库索引")
async def reindex() -> KnowledgeReindexResponse:
    return await service.reindex_all()


@router.get("/sync/siyuan/precheck", response_model=KnowledgeSiyuanPrecheckResponse, summary="检查 SiYuan 同步条件")
async def precheck_siyuan() -> KnowledgeSiyuanPrecheckResponse:
    return await service.precheck_siyuan_sync()


@router.post("/sync/siyuan", response_model=KnowledgeSiyuanSyncResponse, summary="同步 SiYuan 到知识库")
async def sync_siyuan(req: KnowledgeSiyuanSyncRequest) -> KnowledgeSiyuanSyncResponse:
    return await service.sync_siyuan_notes(req)


@router.post("/search", response_model=KnowledgeSearchResponse, summary="搜索知识库")
async def search(req: KnowledgeSearchRequest) -> KnowledgeSearchResponse:
    return await service.search_knowledge(req.query, req.limit)


@router.post("/ask", response_model=KnowledgeAskResponse, summary="基于知识库问答")
async def ask(req: KnowledgeAskRequest) -> KnowledgeAskResponse:
    return await service.ask_knowledge(req)


@router.get("/graph", response_model=KnowledgeGraphResponse, summary="读取知识图谱")
def graph(
    layer: str = "all",
    query: str | None = None,
    sourceType: str | None = None,
    limit: int = 300,
) -> KnowledgeGraphResponse:
    return service.get_graph(layer=layer, query=query, source_type=sourceType, limit=limit)


@router.post("/graph/rebuild", response_model=KnowledgeGraphRebuildResponse, summary="重建知识图谱")
def rebuild_graph() -> KnowledgeGraphRebuildResponse:
    return service.rebuild_graph()


@router.get("/topics", response_model=KnowledgeTopicListResponse, summary="读取主题知识地图")
def topics(
    query: str | None = None,
    sourceType: str | None = None,
    limit: int = 80,
) -> KnowledgeTopicListResponse:
    return service.list_topics(query=query, source_type=sourceType, limit=limit)


@router.post("/topics/rebuild", response_model=KnowledgeTopicRebuildResponse, summary="重建主题知识地图")
def rebuild_topics() -> KnowledgeTopicRebuildResponse:
    return service.rebuild_topics()


@router.post("/topics/enrich", response_model=KnowledgeTopicEnrichResponse, summary="AI 整理主题知识地图")
async def enrich_topics(req: KnowledgeTopicEnrichRequest) -> KnowledgeTopicEnrichResponse:
    return await service.enrich_topics(req.topicId)


@router.post("/topics/{topic_id}/export", response_model=KnowledgeTopicExportResponse, summary="导出主题目录页到笔记软件")
async def export_topic(topic_id: str) -> KnowledgeTopicExportResponse:
    return await service.export_topic(topic_id)


@router.get("/topics/{topic_id}", response_model=KnowledgeTopicDetailResponse, summary="读取主题详情")
def topic_detail(topic_id: str) -> KnowledgeTopicDetailResponse:
    return service.get_topic_detail(topic_id)


@router.get("/sessions", response_model=list[KnowledgeSession], summary="列出 RAG 问答会话")
def sessions() -> list[KnowledgeSession]:
    return db.list_sessions()


@router.get("/sessions/{session_id}/messages", response_model=list[KnowledgeMessage], summary="读取 RAG 会话消息")
def messages(session_id: str) -> list[KnowledgeMessage]:
    return db.list_messages(session_id)
