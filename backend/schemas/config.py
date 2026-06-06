from pydantic import BaseModel


class ModelConfig(BaseModel):
    model: str
    baseURL: str
    apiKey: str


class TabCategory(BaseModel):
    id: str
    name: str
    description: str | None = None


class NoteAdapterConfig(BaseModel):
    provider: str  # "siyuan" | "obsidian" | "local"
    endpoint: str | None = None
    token: str | None = None
    vault: str | None = None
    defaultNotebook: str | None = None
    defaultTargetDoc: str | None = None


class SyncConfigRequest(BaseModel):
    modelConfig: ModelConfig | None = None
    tabCategories: list[TabCategory] = []
    noteAdapter: NoteAdapterConfig | None = None
