import asyncio
import math
import random
from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, datetime
from decimal import Decimal
from email.utils import parsedate_to_datetime
from functools import lru_cache

import httpx
import tiktoken
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from mailpilot_ai.config import Settings
from mailpilot_ai.embeddings.contracts import EmbeddingCost, EmbeddingResult, EmbeddingUsage
from mailpilot_ai.embeddings.errors import EmbeddingError

OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings"
MAX_INPUT_TOKENS = 8_192
MAX_ITEMS_PER_REQUEST = 64
MAX_TOKENS_PER_REQUEST = 100_000
MAX_INPUTS_PER_CALL = 512
MAX_TOKENS_PER_CALL = 300_000
MAX_INPUT_CHARACTERS = 32_768
TOKENS_PER_MILLION = Decimal(1_000_000)
COST_PRECISION = Decimal("0.0000000001")

AsyncSleep = Callable[[float], Awaitable[None]]
TokenCounter = Callable[[str], int]


class _OpenAIEmbeddingData(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, extra="ignore")

    index: int = Field(ge=0)
    embedding: list[float] = Field(min_length=1)


class _OpenAIUsage(BaseModel):
    model_config = ConfigDict(extra="ignore")

    prompt_tokens: int = Field(ge=0)
    total_tokens: int = Field(ge=0)


class _OpenAIEmbeddingResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    data: list[_OpenAIEmbeddingData] = Field(min_length=1)
    model: str = Field(min_length=1, max_length=128)
    usage: _OpenAIUsage


class OpenAIEmbeddingProvider:
    def __init__(
        self,
        settings: Settings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: AsyncSleep = asyncio.sleep,
        random_value: Callable[[], float] | None = None,
        token_counter: TokenCounter | None = None,
    ) -> None:
        if (
            settings.openai_api_key is None
            or not settings.openai_api_key.get_secret_value().strip()
        ):
            raise EmbeddingError(
                "EMBEDDING_CONFIGURATION_INVALID",
                "OPENAI_API_KEY is required to call the configured embedding provider",
            )
        self._settings = settings
        self._api_key = settings.openai_api_key.get_secret_value().strip()
        self._sleep = sleep
        self._random_value = random_value or random.random
        self._token_counter = token_counter or _count_tokens
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(settings.embedding_timeout_seconds),
            transport=transport,
        )

    async def embed(self, texts: Sequence[str]) -> EmbeddingResult:
        if isinstance(texts, (str, bytes)) or not isinstance(texts, Sequence):
            raise EmbeddingError(
                "EMBEDDING_INPUT_INVALID", "Embedding inputs must be a sequence of text"
            )
        if not texts:
            return EmbeddingResult(
                provider="openai",
                model_version=self._settings.embedding_model,
                dimensions=self._settings.embedding_dimensions,
                vectors=(),
                usage=EmbeddingUsage(
                    input_tokens=0,
                    total_tokens=0,
                    cost=self._estimate_cost(0),
                ),
            )
        if len(texts) > MAX_INPUTS_PER_CALL:
            raise EmbeddingError(
                "EMBEDDING_INPUT_TOO_LARGE",
                f"At most {MAX_INPUTS_PER_CALL} texts can be embedded in one call",
            )

        normalized_texts: list[str] = []
        token_counts: list[int] = []
        total_input_tokens = 0
        for text in texts:
            if not isinstance(text, str) or not text.strip():
                raise EmbeddingError(
                    "EMBEDDING_INPUT_INVALID", "Embedding inputs must contain non-empty text"
                )
            if len(text) > MAX_INPUT_CHARACTERS:
                raise EmbeddingError(
                    "EMBEDDING_INPUT_TOO_LARGE",
                    f"Each text must be at most {MAX_INPUT_CHARACTERS} characters",
                )
            try:
                token_count = self._token_counter(text)
            except Exception:
                raise EmbeddingError(
                    "EMBEDDING_TOKENIZER_UNAVAILABLE",
                    "The embedding input tokenizer is unavailable",
                ) from None
            if token_count < 1 or token_count > MAX_INPUT_TOKENS:
                raise EmbeddingError(
                    "EMBEDDING_INPUT_TOO_LARGE",
                    f"Each text must contain between 1 and {MAX_INPUT_TOKENS} tokens",
                )
            total_input_tokens += token_count
            if total_input_tokens > MAX_TOKENS_PER_CALL:
                raise EmbeddingError(
                    "EMBEDDING_INPUT_TOO_LARGE",
                    f"At most {MAX_TOKENS_PER_CALL} tokens can be embedded in one call",
                )
            normalized_texts.append(text)
            token_counts.append(token_count)

        batches = _make_batches(normalized_texts, token_counts)
        vectors: list[tuple[float, ...]] = []
        model_versions: set[str] = set()
        input_tokens = 0
        total_tokens = 0

        for batch_texts, _batch_token_count in batches:
            batch_vectors, model_version, usage = await self._embed_batch(batch_texts)
            vectors.extend(batch_vectors)
            model_versions.add(model_version)
            input_tokens += usage.prompt_tokens
            total_tokens += usage.total_tokens

        if len(model_versions) != 1:
            raise EmbeddingError(
                "EMBEDDING_MODEL_VERSION_CHANGED",
                "The embedding provider returned inconsistent model versions across batches",
            )

        return EmbeddingResult(
            provider="openai",
            model_version=next(iter(model_versions)),
            dimensions=self._settings.embedding_dimensions,
            vectors=tuple(vectors),
            usage=EmbeddingUsage(
                input_tokens=input_tokens,
                total_tokens=total_tokens,
                cost=self._estimate_cost(input_tokens),
            ),
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _embed_batch(
        self, texts: tuple[str, ...]
    ) -> tuple[tuple[tuple[float, ...], ...], str, _OpenAIUsage]:
        payload = {
            "model": self._settings.embedding_model,
            "input": list(texts),
            "dimensions": self._settings.embedding_dimensions,
            "encoding_format": "float",
        }
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

        for attempt in range(self._settings.embedding_max_retries + 1):
            try:
                response = await self._client.post(
                    OPENAI_EMBEDDINGS_URL, headers=headers, json=payload
                )
            except httpx.TimeoutException:
                if attempt < self._settings.embedding_max_retries:
                    await self._sleep(self._backoff_delay(attempt))
                    continue
                raise EmbeddingError(
                    "EMBEDDING_TIMEOUT", "The embedding provider request timed out", retryable=True
                ) from None
            except httpx.TransportError:
                if attempt < self._settings.embedding_max_retries:
                    await self._sleep(self._backoff_delay(attempt))
                    continue
                raise EmbeddingError(
                    "EMBEDDING_PROVIDER_UNAVAILABLE",
                    "The embedding provider could not be reached",
                    retryable=True,
                ) from None

            status_code = response.status_code
            if status_code == 429:
                retry_after = _parse_retry_after(response.headers.get("Retry-After"))
                if attempt < self._settings.embedding_max_retries and self._within_retry_delay(
                    retry_after
                ):
                    delay = retry_after if retry_after is not None else self._backoff_delay(attempt)
                    await self._sleep(delay)
                    continue
                raise EmbeddingError(
                    "EMBEDDING_RATE_LIMITED",
                    "The embedding provider rate limit was reached",
                    retryable=True,
                    retry_after_seconds=retry_after,
                )

            if status_code in {408, 409} or status_code >= 500:
                retry_after = _parse_retry_after(response.headers.get("Retry-After"))
                if attempt < self._settings.embedding_max_retries and self._within_retry_delay(
                    retry_after
                ):
                    delay = retry_after if retry_after is not None else self._backoff_delay(attempt)
                    await self._sleep(delay)
                    continue
                raise EmbeddingError(
                    "EMBEDDING_PROVIDER_UNAVAILABLE",
                    "The embedding provider returned a temporary error",
                    retryable=True,
                    retry_after_seconds=retry_after,
                )

            if status_code >= 400:
                code = (
                    "EMBEDDING_AUTHENTICATION_FAILED"
                    if status_code in {401, 403}
                    else "EMBEDDING_REQUEST_REJECTED"
                )
                message = (
                    "The embedding provider rejected the configured credentials"
                    if status_code in {401, 403}
                    else "The embedding provider rejected the request"
                )
                raise EmbeddingError(code, message)

            try:
                raw_response: object = response.json()
                parsed = _OpenAIEmbeddingResponse.model_validate(raw_response)
            except (ValueError, ValidationError):
                raise EmbeddingError(
                    "EMBEDDING_INVALID_RESPONSE",
                    "The embedding provider returned an invalid response",
                ) from None

            if parsed.usage.total_tokens < parsed.usage.prompt_tokens:
                raise EmbeddingError(
                    "EMBEDDING_INVALID_RESPONSE",
                    "The embedding provider returned invalid usage metadata",
                )
            indexed_vectors: dict[int, tuple[float, ...]] = {}
            for item in parsed.data:
                if item.index >= len(texts) or item.index in indexed_vectors:
                    raise EmbeddingError(
                        "EMBEDDING_INVALID_RESPONSE",
                        "The embedding provider returned an invalid vector index",
                    )
                if len(item.embedding) != self._settings.embedding_dimensions or any(
                    not math.isfinite(value) for value in item.embedding
                ):
                    raise EmbeddingError(
                        "EMBEDDING_INVALID_RESPONSE",
                        "The embedding provider returned an invalid vector shape",
                    )
                indexed_vectors[item.index] = tuple(item.embedding)

            if len(indexed_vectors) != len(texts):
                raise EmbeddingError(
                    "EMBEDDING_INVALID_RESPONSE",
                    "The embedding provider returned an incomplete vector batch",
                )
            ordered_vectors = tuple(indexed_vectors[index] for index in range(len(texts)))
            return ordered_vectors, parsed.model, parsed.usage

        raise EmbeddingError(
            "EMBEDDING_RETRIES_EXHAUSTED",
            "The embedding provider retry budget was exhausted",
            retryable=True,
        )

    def _within_retry_delay(self, retry_after: float | None) -> bool:
        return (
            retry_after is None or retry_after <= self._settings.embedding_max_retry_delay_seconds
        )

    def _backoff_delay(self, attempt: int) -> float:
        limit = self._settings.embedding_max_retry_delay_seconds
        base = min(limit, 0.5 * (2**attempt))
        sample = float(self._random_value())
        jitter = max(0.0, min(1.0, sample)) * min(0.25, limit - base)
        return float(base + jitter)

    def _estimate_cost(self, input_tokens: int) -> EmbeddingCost | None:
        input_rate = self._settings.embedding_input_price_usd_per_mtok
        pricing_version = self._settings.embedding_pricing_version
        if input_rate is None or pricing_version is None:
            return None
        cost = (input_rate * input_tokens / TOKENS_PER_MILLION).quantize(COST_PRECISION)
        return EmbeddingCost(estimated_cost_usd=cost, pricing_version=pricing_version)


def _make_batches(texts: list[str], token_counts: list[int]) -> list[tuple[tuple[str, ...], int]]:
    batches: list[tuple[tuple[str, ...], int]] = []
    current_texts: list[str] = []
    current_token_count = 0
    for text, token_count in zip(texts, token_counts, strict=True):
        should_flush = current_texts and (
            len(current_texts) >= MAX_ITEMS_PER_REQUEST
            or current_token_count + token_count > MAX_TOKENS_PER_REQUEST
        )
        if should_flush:
            batches.append((tuple(current_texts), current_token_count))
            current_texts = []
            current_token_count = 0
        current_texts.append(text)
        current_token_count += token_count
    if current_texts:
        batches.append((tuple(current_texts), current_token_count))
    return batches


@lru_cache(maxsize=1)
def _encoding() -> tiktoken.Encoding:
    return tiktoken.get_encoding("cl100k_base")


def _count_tokens(text: str) -> int:
    return len(_encoding().encode(text, disallowed_special=()))


def _parse_retry_after(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        seconds = float(value)
        return seconds if math.isfinite(seconds) and seconds >= 0 else None
    except ValueError:
        try:
            retry_at = parsedate_to_datetime(value)
        except (TypeError, ValueError, OverflowError):
            return None
        if retry_at.tzinfo is None:
            retry_at = retry_at.replace(tzinfo=UTC)
        return max(0.0, (retry_at - datetime.now(UTC)).total_seconds())
