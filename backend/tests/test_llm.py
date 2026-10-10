import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from schemas.config import ModelConfig
from services.llm import build_chat_completion_kwargs


class LlmConfigTestCase(unittest.TestCase):
    def test_standard_model_request_omits_thinking_extension_by_default(self) -> None:
        config = ModelConfig(
            model="gpt-4o-mini",
            baseURL="https://api.openai.com/v1",
            apiKey="test-key",
        )

        kwargs = build_chat_completion_kwargs(config, [{"role": "user", "content": "hi"}])

        self.assertEqual(kwargs["model"], "gpt-4o-mini")
        self.assertNotIn("temperature", kwargs)
        self.assertNotIn("extra_body", kwargs)

    def test_compatible_provider_can_opt_into_thinking_extension(self) -> None:
        config = ModelConfig(
            model="reasoning-model",
            baseURL="https://example.test/v1",
            apiKey="test-key",
            enableThinking=True,
        )

        kwargs = build_chat_completion_kwargs(config, [])

        self.assertEqual(kwargs["extra_body"], {"thinking": {"type": "adaptive"}})

    def test_siliconflow_uses_native_thinking_extension(self) -> None:
        config = ModelConfig(
            model="Qwen/Qwen3.5-4B",
            baseURL="https://api.siliconflow.cn/v1",
            apiKey="test-key",
            enableThinking=True,
        )

        kwargs = build_chat_completion_kwargs(config, [])

        self.assertEqual(kwargs["extra_body"], {"enable_thinking": True})


if __name__ == "__main__":
    unittest.main()
