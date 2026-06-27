from fastapi import APIRouter, Depends, HTTPException

from schemas.knowledge import (
    KnowledgeAskRequest,
    KnowledgeAskResponse,
    KnowledgeConfig,
    KnowledgeDocumentIndexListResponse,
    KnowledgeEvalCase,
    KnowledgeEvalCaseRequest,
    KnowledgeEvalDeleteResponse,
    KnowledgeEvalRunRequest,
    KnowledgeEvalRunResponse,
    KnowledgeGraphRebuildResponse,
    KnowledgeGraphResponse,
    KnowledgeHitTestRequest,
    KnowledgeHitTestResponse,
    KnowledgeIndexHealthResponse,
    KnowledgeIndexRepairResponse,
    KnowledgeMessage,
    KnowledgeReindexResponse,
    KnowledgeSearchRequest,
    KnowledgeSearchResponse,
    KnowledgeSession,
    KnowledgeStats,
    KnowledgeSyncLogResponse,
    KnowledgeSiyuanPrecheckResponse,
    KnowledgeSiyuanSyncRequest,
    KnowledgeSiyuanSyncResponse,
    KnowledgeSyncAllResponse,
    KnowledgeTopicDetailResponse,
    KnowledgeTopicEnrichRequest,
    KnowledgeTopicEnrichResponse,
    KnowledgeTopicExportResponse,
    KnowledgeTopicListResponse,
    KnowledgeTopicRebuildResponse,
    KnowledgeVectorInspectResponse,
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


@router.get("/documents", response_model=KnowledgeDocumentIndexListResponse, summary="列出文档级索引状态")
def list_document_indexes(sourceType: str | None = None, limit: int = 200) -> KnowledgeDocumentIndexListResponse:
    return service.list_document_indexes(source_type=sourceType, limit=limit)


@router.post("/reindex", response_model=KnowledgeReindexResponse, summary="重建知识库索引")
async def reindex() -> KnowledgeReindexResponse:
    return await service.reindex_all()


@router.post("/sync/all", response_model=KnowledgeSyncAllResponse, summary="同步所有已配置知识来源")
async def sync_all() -> KnowledgeSyncAllResponse:
    return await service.sync_all_knowledge()


@router.get("/sync/logs", response_model=KnowledgeSyncLogResponse, summary="读取最近知识库同步记录")
def sync_logs() -> KnowledgeSyncLogResponse:
    return service.list_sync_logs()


@router.get("/index/health", response_model=KnowledgeIndexHealthResponse, summary="检查知识库索引健康")
def index_health() -> KnowledgeIndexHealthResponse:
    return service.inspect_index_health()


@router.post("/index/repair", response_model=KnowledgeIndexRepairResponse, summary="修复知识库索引轻量问题")
def repair_index() -> KnowledgeIndexRepairResponse:
    return service.repair_index()


@router.get("/sync/siyuan/precheck", response_model=KnowledgeSiyuanPrecheckResponse, summary="检查 SiYuan 同步条件")
async def precheck_siyuan() -> KnowledgeSiyuanPrecheckResponse:
    return await service.precheck_siyuan_sync()


@router.post("/sync/siyuan", response_model=KnowledgeSiyuanSyncResponse, summary="同步 SiYuan 到知识库")
async def sync_siyuan(req: KnowledgeSiyuanSyncRequest) -> KnowledgeSiyuanSyncResponse:
    return await service.sync_siyuan_notes(req)


@router.post("/search", response_model=KnowledgeSearchResponse, summary="搜索知识库")
async def search(req: KnowledgeSearchRequest) -> KnowledgeSearchResponse:
    return await service.search_knowledge(req.query, req.limit)


@router.post("/hit-test", response_model=KnowledgeHitTestResponse, summary="调试知识库检索")
async def hit_test(req: KnowledgeHitTestRequest) -> KnowledgeHitTestResponse:
    return await service.hit_test_knowledge(req.query, req.limit, req.searchMode, req.minScore)


@router.get("/eval/cases", response_model=list[KnowledgeEvalCase], summary="列出 RAG 评估用例")
def eval_cases() -> list[KnowledgeEvalCase]:
    return service.list_eval_cases()


@router.post("/eval/cases", response_model=KnowledgeEvalCase, summary="新增 RAG 评估用例")
def create_eval_case(req: KnowledgeEvalCaseRequest) -> KnowledgeEvalCase:
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="问题不能为空")
    return service.save_eval_case(req)


@router.post("/eval/cases/{case_id}", response_model=KnowledgeEvalCase, summary="更新 RAG 评估用例")
def update_eval_case(case_id: str, req: KnowledgeEvalCaseRequest) -> KnowledgeEvalCase:
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="问题不能为空")
    return service.save_eval_case(req, case_id)


@router.post("/eval/cases/{case_id}/delete", response_model=KnowledgeEvalDeleteResponse, summary="删除 RAG 评估用例")
def delete_eval_case(case_id: str) -> KnowledgeEvalDeleteResponse:
    return service.delete_eval_case(case_id)


@router.post("/eval/run", response_model=KnowledgeEvalRunResponse, summary="运行 RAG 检索评估")
async def run_eval(req: KnowledgeEvalRunRequest) -> KnowledgeEvalRunResponse:
    return await service.run_eval(req)


@router.post("/ask", response_model=KnowledgeAskResponse, summary="基于知识库问答")
async def ask(req: KnowledgeAskRequest) -> KnowledgeAskResponse:
    return await service.ask_knowledge(req)


@router.get("/vector/inspect", response_model=KnowledgeVectorInspectResponse, summary="查看 LanceDB 向量表")
def inspect_vector(query: str | None = None, limit: int = 100) -> KnowledgeVectorInspectResponse:
    return service.inspect_vector_store(query=query, limit=limit, migrate=False)


@router.post("/vector/migrate", response_model=KnowledgeVectorInspectResponse, summary="迁移 LanceDB 向量表 schema")
def migrate_vector_schema() -> KnowledgeVectorInspectResponse:
    return service.inspect_vector_store(migrate=True)


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
