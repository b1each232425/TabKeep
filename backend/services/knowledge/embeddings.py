from openai import AsyncOpenAI

from schemas.knowledge import EmbeddingConfig


def embedding_config_ready(config: EmbeddingConfig) -> bool:
    return bool(config.enabled and config.baseURL.strip() and config.apiKey.strip() and config.model.strip())


async def embed_texts(config: EmbeddingConfig, texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    client = AsyncOpenAI(api_key=config.apiKey, base_url=config.baseURL)
    response = await client.embeddings.create(model=config.model, input=texts)
    return [list(item.embedding) for item in response.data]

