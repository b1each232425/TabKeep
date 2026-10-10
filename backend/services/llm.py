"""
LLM 调用统一封装。

整个后端所有需要调大模型的地方(分类 / 摘要)都通过这一个 chat_completion() 走。
- 用 OpenAI 兼容协议,所以 modelConfig.baseURL 可以指向 OpenAI / DeepSeek / MiniMax 等
- 不主动发送 temperature,让模型使用自己的默认值(兼容仅支持默认温度的推理模型)
- 启用 thinking mode:按上游平台协议让模型先思考再正式回答
  - 上游 caller 需要在解析前用 _THINK_RE 去除 <think> 部分
- 统一捕获鉴权 / 限流 / 网络 / API 错误,让上层用 try/except 处理
"""
import json
import time
from urllib.parse import urlparse

from loguru import logger
from openai import APIConnectionError, APIError, AsyncOpenAI, AuthenticationError, RateLimitError

from schemas.config import ModelConfig


def _is_siliconflow_base_url(base_url: str) -> bool:
    """判断是否为 SiliconFlow OpenAI 兼容端点。"""
    return urlparse(base_url.strip()).netloc.lower() in {
        "api.siliconflow.cn",
        "api.siliconflow.com",
    }


def build_chat_completion_kwargs(
    config: ModelConfig,
    messages: list[dict],
) -> dict[str, object]:
    """构造标准 Chat Completions 参数,按配置选择性启用 thinking 扩展。

    不强行发送 ``temperature=0``。部分较新的推理模型只接受默认值
    ``temperature=1``;省略该字段可以同时兼容这类模型和 OpenAI 兼容服务。
    """
    kwargs: dict[str, object] = {
        "model": config.model,
        "messages": messages,
    }
    if config.enableThinking:
        # 不同 OpenAI 兼容平台的 thinking 扩展字段并不统一，按端点自动适配。
        # 官方 GPT 默认不发送任何 thinking 扩展，避免未知字段导致 400。
        if _is_siliconflow_base_url(config.baseURL):
            kwargs["extra_body"] = {"enable_thinking": True}
        else:
            kwargs["extra_body"] = {"thinking": {"type": "adaptive"}}
    return kwargs


# ─────────────────────────────────────────────────────────────
# 唯一公开函数:所有 LLM 调用的入口
# ─────────────────────────────────────────────────────────────
async def chat_completion(config: ModelConfig, messages: list[dict]) -> str:
    """
    给定 LLM 配置和消息列表,返回模型输出的 content 字符串。

    错误处理:
    - AuthenticationError → 401 / key 无效,直接 raise(调用方应 catch)
    - RateLimitError → 限流,直接 raise
    - APIConnectionError / APIError → 网络或服务端问题,直接 raise
    """
    logger.info(f"LLM input:\n{json.dumps(messages, ensure_ascii=False, indent=2)}")
    client = AsyncOpenAI(
        api_key=config.apiKey,
        base_url=config.baseURL,
    )
    start = time.time()
    try:
        resp = await client.chat.completions.create(**build_chat_completion_kwargs(config, messages))
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
