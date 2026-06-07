"""
LLM 调用统一封装。

整个后端所有需要调大模型的地方(分类 / 摘要)都通过这一个 chat_completion() 走。
- 用 OpenAI 兼容协议,所以 modelConfig.baseURL 可以指向 OpenAI / DeepSeek / MiniMax 等
- 默认 temperature=0(确定性输出,适合分类/摘要)
- 启用 thinking mode(adapteive):让模型先生成 <think> 块再正式回答
  - 上游 caller 需要在解析前用 _THINK_RE 去除 <think> 部分
- 统一捕获鉴权 / 限流 / 网络 / API 错误,让上层用 try/except 处理
"""
import json
import time

from loguru import logger
from openai import APIConnectionError, APIError, AsyncOpenAI, AuthenticationError, RateLimitError

from schemas.config import ModelConfig


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
        resp = await client.chat.completions.create(
            model=config.model,
            messages=messages,
            temperature=0,
            # 让模型走"先思考再回答"模式;上游解析时要去掉 <think> 块
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
