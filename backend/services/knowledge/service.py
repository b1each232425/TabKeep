"""知识库服务门面。

路由层只依赖这个模块；具体实现分散在 indexing / retrieval / qa / siyuan_sync。
这样后续继续扩展知识图谱、来源打开、增量同步时，不会把单个文件堆成一团。
"""

from services.knowledge.indexing import index_document, index_saved_note, reindex_all
from services.knowledge.qa import ask_knowledge
from services.knowledge.retrieval import search_knowledge
from services.knowledge.siyuan_sync import precheck_siyuan_sync, sync_siyuan_notes

__all__ = [
    "ask_knowledge",
    "index_document",
    "index_saved_note",
    "precheck_siyuan_sync",
    "reindex_all",
    "search_knowledge",
    "sync_siyuan_notes",
]
