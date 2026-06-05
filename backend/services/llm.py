import json
import time

from loguru import logger
from openai import APIConnectionError, APIError, AsyncOpenAI, AuthenticationError, RateLimitError

from schemas.config import ModelConfig


async def chat_completion(config: ModelConfig, messages: list[dict]) -> str:
    logger.info(f"LLM input:\n{json.dumps(messages, ensure_ascii=False, indent=2)}")
    client = AsyncOpenAI(
        api_key=config.apiKey,
        base_url=config.baseURL,
    )
    start = time.time()
    try:
        resp = await client.chat.completions.create(
            model=config.model,
            messages=messages,
            temperature=0,
            extra_body={"thinking": {"type": "adaptive"}},
        )
    except AuthenticationError as e:
        logger.error(f"LLM 鉴权失败: {e.message}")
        raise
    except RateLimitError as e:
        logger.error(f"LLM 限流: {e.message}")
        raise
    except APIConnectionError as e:
        logger.exception(f"LLM 网络异常: {e}")
        raise
    except APIError as e:
        logger.error(f"LLM API 错误 status={e.status_code} body={str(e.body)[:200]}")
        raise

    duration = time.time() - start
    content = resp.choices[0].message.content or ""
    usage = resp.usage
    logger.info(
        f"LLM 调用成功 model={config.model} {duration:.2f}s "
        f"tokens={usage.prompt_tokens if usage else '?'}+{usage.completion_tokens if usage else '?'}"
    )
    return content
