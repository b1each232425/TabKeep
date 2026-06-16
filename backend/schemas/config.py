"""
Pydantic 数据模型 — 三类配置。

1. ModelConfig   — LLM 调用所需(model / baseURL / apiKey)
2. TabCategory   — 用户自定义的标签分类(给 /classify 用)
3. NoteAdapterConfig — 笔记适配器(provider / endpoint / token / 默认目标)
4. SyncConfigRequest — 前端 POST /config/sync 的请求体,所有字段可选
"""
from pydantic import BaseModel

from schemas.knowledge import KnowledgeConfig


# ─────────────────────────────────────────────────────────────
# LLM 配置 — 每次调 chat_completion 都用这个
# ─────────────────────────────────────────────────────────────
class ModelConfig(BaseModel):
    model: str                       # 模型名,如 "gpt-4" / "MiniMax-M3"
    baseURL: str                     # OpenAI 兼容 API base URL
    apiKey: str                      # 鉴权 key


# ─────────────────────────────────────────────────────────────
# 标签分类 — /classify 用来把标签归到哪几类
# ─────────────────────────────────────────────────────────────
class TabCategory(BaseModel):
    id: str                          # 唯一 id(前端用 Date.now().toString() 生成)
    name: str                        # 显示名
    description: str | None = None   # 可选描述,帮 LLM 更好理解


# ─────────────────────────────────────────────────────────────
# 笔记适配器 — /notes/save 等路由读这个决定写到哪里
# ─────────────────────────────────────────────────────────────
class NoteAdapterConfig(BaseModel):
    provider: str                    # "siyuan" | "obsidian" | "local"
    endpoint: str | None = None      # SiYuan 时是 http://127.0.0.1:6806
    token: str | None = None         # SiYuan API token
    vault: str | None = None         # Obsidian/Markdown vault 或普通文件夹
    defaultFolder: str | None = None # Obsidian/Markdown 默认保存目录
    writeMode: str | None = None     # "new_file" | "append"
    defaultNotebook: str | None = None   # 留空则每次收藏时弹窗让用户选
    defaultTargetDoc: str | None = None  # 留空 = 每次新建; 填了 = 追加到该 doc


# ─────────────────────────────────────────────────────────────
# 配置同步请求体 — 四个字段都可以不传(用 model_fields_set 区分)
# ─────────────────────────────────────────────────────────────
class SyncConfigRequest(BaseModel):
    modelConfig: ModelConfig | None = None
    tabCategories: list[TabCategory] = []
    noteAdapter: NoteAdapterConfig | None = None
    knowledgeConfig: KnowledgeConfig | None = None
    apiToken: str | None = None
