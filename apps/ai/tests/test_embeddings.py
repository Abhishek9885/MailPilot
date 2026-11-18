from collections.abc import Awaitable, Callable
from decimal import Decimal

import httpx
import pytest
from pydantic import SecretStr, TypeAdapter

from mailpilot_ai.config import Settings
from mailpilot_ai.embeddings.contracts import EmbeddingResult, EmbeddingUsage
from mailpilot_ai.embeddings.errors import EmbeddingError
from mailpilot_ai.embeddings.factory import create_embedding_provider

AsyncSleep = Callable[[float], Awaitable[None]]


def make_settings(
    *,
    api_key: str | None = "mock-openai-key",
    dimensions: int = 3,
    max_retries: int = 2,
    max_retry_delay_seconds: float = 1.0,
    input_price: Decimal | None = Decimal("0.02"),
    pricing_version: str | None = "2026-11-06-test-rate-card",
) -> Settings:
    return Settings(
        _env_file=None,
        database_url="postgresql://mailpilot:local_dev_only@localhost:55432/mailpilot",
        openai_api_key=SecretStr(api_key) if api_key is not None else None,
        embedding_dimensions=dimensions,
        embedding_max_retries=max_retries,
        embedding_max_retry_delay_seconds=max_retry_delay_seconds,
        embedding_input_price_usd_per_mtok=input_price,
        embedding_pricing_version=pricing_version,
    )


def embedding_payload(
    *,
    dimensions: int = 3,
    model: str = "text-embedding-3-small-2026-10-01",
    input_tokens: int = 1,
) -> dict[str, object]:
    return {
        "data": [{"index": 0, "embedding": [0.25] * dimensions}],
        "model": model,
        "usage": {"prompt_tokens": input_tokens, "total_tokens": input_tokens},
    }


@pytest.mark.anyio
async def test_embeddings_preserve_order_shape_usage_and_model_version() -> None:
    captured_requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured_requests.append(request)
        return httpx.Response(
            200,
            json={
                "data": [
                    {"index": 1, "embedding": [0.0, 1.0, 0.0]},
                    {"index": 0, "embedding": [1.0, 0.0, 0.0]},
                ],
                "model": "text-embedding-3-small-2026-10-01",
                "usage": {"prompt_tokens": 11, "total_tokens": 11},
            },
        )

    provider = create_embedding_provider(
        make_settings(),
        transport=httpx.MockTransport(handler),
        token_counter=len,
    )
    try:
        result = await provider.embed(["first", "second"])
    finally:
        await provider.aclose()

    assert result.provider == "openai"
    assert result.model_version == "text-embedding-3-small-2026-10-01"
    assert result.dimensions == 3
    assert result.vectors == ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0))
    assert result.usage.input_tokens == 11
    assert result.usage.total_tokens == 11
    assert result.usage.cost is not None
    assert result.usage.cost.estimated_cost_usd == Decimal("0.0000002200")
    assert result.usage.cost.pricing_version == "2026-11-06-test-rate-card"

    request_payload = TypeAdapter(dict[str, object]).validate_json(captured_requests[0].content)
    assert captured_requests[0].url == "https://api.openai.com/v1/embeddings"
    assert captured_requests[0].headers["authorization"] == "Bearer mock-openai-key"
    assert request_payload["model"] == "text-embedding-3-small"
    assert request_payload["dimensions"] == 3
    assert request_payload["input"] == ["first", "second"]


@pytest.mark.anyio
async def test_empty_input_returns_empty_result_without_provider_request() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("empty input must not call the provider")

    provider = create_embedding_provider(
        make_settings(),
        transport=httpx.MockTransport(handler),
        token_counter=len,
    )
    try:
        result = await provider.embed([])
    finally:
        await provider.aclose()

    assert result.vectors == ()
    assert result.model_version == "text-embedding-3-small"
    assert result.usage.input_tokens == 0
    assert result.usage.cost is not None
    assert result.usage.cost.estimated_cost_usd == Decimal("0E-10")


@pytest.mark.anyio
async def test_provider_errors_are_safe_and_not_retried_for_invalid_requests() -> None:
    call_count = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(400, json={"error": "private provider response body"})

    provider = create_embedding_provider(
        make_settings(max_retries=3),
        transport=httpx.MockTransport(handler),
        token_counter=len,
    )
    try:
        with pytest.raises(EmbeddingError, match="provider rejected the request") as raised:
            await provider.embed(["sample"])
    finally:
        await provider.aclose()

    assert raised.value.code == "EMBEDDING_REQUEST_REJECTED"
    assert "private provider response body" not in str(raised.value)
    assert call_count == 1


@pytest.mark.anyio
async def test_rate_limit_retries_with_retry_after_and_returns_metadata() -> None:
    call_count = 0
    sleep_delays: list[float] = []

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return httpx.Response(429, headers={"Retry-After": "0.25"})
        return httpx.Response(200, json=embedding_payload(input_tokens=1))

    async def record_sleep(delay: float) -> None:
        sleep_delays.append(delay)

    provider = create_embedding_provider(
        make_settings(max_retries=1),
        transport=httpx.MockTransport(handler),
        sleep=record_sleep,
        token_counter=lambda _text: 1,
    )
    try:
        result = await provider.embed(["sample"])
    finally:
        await provider.aclose()

    assert call_count == 2
    assert sleep_delays == [0.25]
    assert result.model_version == "text-embedding-3-small-2026-10-01"


@pytest.mark.anyio
async def test_batches_inputs_and_rejects_oversized_text_before_sending() -> None:
    captured_batches: list[list[str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = TypeAdapter(dict[str, object]).validate_json(request.content)
        inputs = TypeAdapter(list[str]).validate_python(payload["input"])
        captured_batches.append(inputs)
        return httpx.Response(
            200,
            json={
                "data": [
                    {"index": index, "embedding": [0.5, 0.5, 0.5]} for index in range(len(inputs))
                ],
                "model": "text-embedding-3-small-2026-10-01",
                "usage": {"prompt_tokens": len(inputs), "total_tokens": len(inputs)},
            },
        )

    provider = create_embedding_provider(
        make_settings(input_price=None, pricing_version=None),
        transport=httpx.MockTransport(handler),
        token_counter=lambda text: 8_193 if text == "too many tokens" else 1,
    )
    try:
        result = await provider.embed([f"text-{index}" for index in range(65)])
        assert len(result.vectors) == 65
        assert [len(batch) for batch in captured_batches] == [64, 1]
        assert result.usage.cost is None

        with pytest.raises(EmbeddingError) as raised:
            await provider.embed(["too many tokens"])
        assert raised.value.code == "EMBEDDING_INPUT_TOO_LARGE"
        assert [len(batch) for batch in captured_batches] == [64, 1]
    finally:
        await provider.aclose()


def test_embedding_result_rejects_wrong_vector_dimensions() -> None:
    with pytest.raises(ValueError, match="do not match"):
        EmbeddingResult(
            provider="openai",
            model_version="text-embedding-3-small-test",
            dimensions=3,
            vectors=((0.1, 0.2),),
            usage=EmbeddingUsage(input_tokens=2, total_tokens=2),
        )
