from pydantic import BaseModel


class ModelConfig(BaseModel):
    model: str
    baseURL: str
    apiKey: str


class TabCategory(BaseModel):
    id: str
    name: str
    description: str | None = None


class SyncConfigRequest(BaseModel):
    modelConfig: ModelConfig | None = None
    tabCategories: list[TabCategory] = []
