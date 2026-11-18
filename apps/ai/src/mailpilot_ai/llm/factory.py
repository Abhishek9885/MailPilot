import asyncio
from collections.abc import Awaitable, Callable

import httpx

from mailpilot_ai.config import Settings
from mailpilot_ai.llm.contracts import LLMProvider
from mailpilot_ai.llm.errors import LLMError
from mailpilot_ai.llm.openai_responses import OpenAIResponsesProvider

AsyncSleep = Callable[[float], Awaitable[None]]


def create_llm_provider(
    settings: Settings,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    sleep: AsyncSleep = asyncio.sleep,
    random_value: Callable[[], float] | None = None,
) -> LLMProvider:
    if settings.llm_provider != "openai":
        raise LLMError("LLM_PROVIDER_UNSUPPORTED", "The configured LLM provider is not supported")
    if settings.openai_api_key is None or not settings.openai_api_key.get_secret_value().strip():
        raise LLMError(
            "LLM_CONFIGURATION_INVALID",
            "OPENAI_API_KEY is required to call the configured provider",
        )
    return OpenAIResponsesProvider(
        settings,
        transport=transport,
        sleep=sleep,
        random_value=random_value,
    )
