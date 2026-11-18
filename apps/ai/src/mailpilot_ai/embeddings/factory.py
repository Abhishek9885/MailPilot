import asyncio
from collections.abc import Awaitable, Callable

import httpx

from mailpilot_ai.config import Settings
from mailpilot_ai.embeddings.contracts import EmbeddingProvider
from mailpilot_ai.embeddings.errors import EmbeddingError
from mailpilot_ai.embeddings.openai import OpenAIEmbeddingProvider

AsyncSleep = Callable[[float], Awaitable[None]]
TokenCounter = Callable[[str], int]


def create_embedding_provider(
    settings: Settings,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    sleep: AsyncSleep = asyncio.sleep,
    random_value: Callable[[], float] | None = None,
    token_counter: TokenCounter | None = None,
) -> EmbeddingProvider:
    if settings.embedding_provider != "openai":
        raise EmbeddingError(
            "EMBEDDING_PROVIDER_UNSUPPORTED", "The configured embedding provider is not supported"
        )
    if settings.openai_api_key is None or not settings.openai_api_key.get_secret_value().strip():
        raise EmbeddingError(
            "EMBEDDING_CONFIGURATION_INVALID",
            "OPENAI_API_KEY is required to call the configured embedding provider",
        )
    return OpenAIEmbeddingProvider(
        settings,
        transport=transport,
        sleep=sleep,
        random_value=random_value,
        token_counter=token_counter,
    )
