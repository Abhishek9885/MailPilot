import asyncio
import math
import random
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from decimal import Decimal
from email.utils import parsedate_to_datetime

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from mailpilot_ai.config import Settings
from mailpilot_ai.llm.contracts import LLMCost, LLMRequest, LLMResponse, LLMUsage
from mailpilot_ai.llm.errors import LLMError

OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
_COST_PRECISION = Decimal("0.0000000001")
_TOKENS_PER_MILLION = Decimal(1_000_000)

AsyncSleep = Callable[[float], Awaitable[None]]


class _OutputText(BaseModel):
    model_config = ConfigDict(extra="ignore")

    type: str
    text: str | None = None


class _OutputItem(BaseModel):
    model_config = ConfigDict(extra="ignore")

    type: str
    content: list[_OutputText] = Field(default_factory=list)


class _UsageDetails(BaseModel):
    model_config = ConfigDict(extra="ignore")

    cached_tokens: int | None = Field(default=None, ge=0)
    reasoning_tokens: int | None = Field(default=None, ge=0)


class _OpenAIUsage(BaseModel):
    model_config = ConfigDict(extra="ignore")

    input_tokens: int | None = Field(default=None, ge=0)
    output_tokens: int | None = Field(default=None, ge=0)
    total_tokens: int | None = Field(default=None, ge=0)
    input_tokens_details: _UsageDetails | None = None
    output_tokens_details: _UsageDetails | None = None


class _OpenAIResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(min_length=1)
    model: str = Field(min_length=1)
    output: list[_OutputItem] = Field(default_factory=list)
    usage: _OpenAIUsage | None = None


class OpenAIResponsesProvider:
    def __init__(
        self,
        settings: Settings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: AsyncSleep = asyncio.sleep,
        random_value: Callable[[], float] | None = None,
    ) -> None:
        if (
            settings.openai_api_key is None
            or not settings.openai_api_key.get_secret_value().strip()
        ):
            raise LLMError(
                "LLM_CONFIGURATION_INVALID",
                "OPENAI_API_KEY is required to call the configured provider",
            )
        self._settings = settings
        self._api_key = settings.openai_api_key.get_secret_value().strip()
        self._sleep = sleep
        self._random_value = random_value or random.random
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(settings.llm_timeout_seconds),
            transport=transport,
        )

    async def generate(self, request: LLMRequest) -> LLMResponse:
        payload: dict[str, object] = {
            "model": self._settings.llm_model,
            "input": [
                {"role": message.role, "content": message.content} for message in request.messages
            ],
            "max_output_tokens": request.max_output_tokens,
            "store": False,
        }
        if request.output_schema is not None:
            payload["text"] = {
                "format": {
                    "type": "json_schema",
                    "name": request.output_schema.name,
                    "schema": request.output_schema.json_schema,
                    "strict": request.output_schema.strict,
                }
            }
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

        for attempt in range(self._settings.llm_max_retries + 1):
            try:
                response = await self._client.post(
                    OPENAI_RESPONSES_URL, headers=headers, json=payload
                )
            except httpx.TimeoutException:
                if attempt < self._settings.llm_max_retries:
                    await self._sleep(self._backoff_delay(attempt))
                    continue
                raise LLMError(
                    "LLM_TIMEOUT", "The LLM provider request timed out", retryable=True
                ) from None
            except httpx.TransportError:
                if attempt < self._settings.llm_max_retries:
                    await self._sleep(self._backoff_delay(attempt))
                    continue
                raise LLMError(
                    "LLM_PROVIDER_UNAVAILABLE",
                    "The LLM provider could not be reached",
                    retryable=True,
                ) from None

            status_code = response.status_code
            if status_code == 429:
                retry_after = _parse_retry_after(response.headers.get("Retry-After"))
                if attempt < self._settings.llm_max_retries and self._within_retry_delay(
                    retry_after
                ):
                    delay = retry_after if retry_after is not None else self._backoff_delay(attempt)
                    await self._sleep(delay)
                    continue
                raise LLMError(
                    "LLM_RATE_LIMITED",
                    "The LLM provider rate limit was reached",
                    retryable=True,
                    retry_after_seconds=retry_after,
                )

            if status_code in {408, 409} or status_code >= 500:
                retry_after = _parse_retry_after(response.headers.get("Retry-After"))
                if attempt < self._settings.llm_max_retries and self._within_retry_delay(
                    retry_after
                ):
                    delay = retry_after if retry_after is not None else self._backoff_delay(attempt)
                    await self._sleep(delay)
                    continue
                raise LLMError(
                    "LLM_PROVIDER_UNAVAILABLE",
                    "The LLM provider returned a temporary error",
                    retryable=True,
                    retry_after_seconds=retry_after,
                )

            if status_code >= 400:
                code = (
                    "LLM_AUTHENTICATION_FAILED"
                    if status_code in {401, 403}
                    else "LLM_REQUEST_REJECTED"
                )
                message = (
                    "The LLM provider rejected the configured credentials"
                    if status_code in {401, 403}
                    else "The LLM provider rejected the request"
                )
                raise LLMError(code, message)

            try:
                raw_response: object = response.json()
                parsed = _OpenAIResponse.model_validate(raw_response)
            except (ValueError, ValidationError):
                raise LLMError(
                    "LLM_INVALID_RESPONSE", "The LLM provider returned an invalid response"
                ) from None

            text = "\n".join(
                item.text
                for output in parsed.output
                if output.type == "message"
                for item in output.content
                if item.type == "output_text" and item.text is not None
            )
            if not text.strip():
                raise LLMError("LLM_EMPTY_RESPONSE", "The LLM provider returned no text output")

            return LLMResponse(
                text=text,
                provider="openai",
                model=parsed.model,
                response_id=parsed.id,
                provider_request_id=response.headers.get("x-request-id"),
                usage=self._map_usage(parsed.usage),
            )

        raise LLMError(
            "LLM_RETRIES_EXHAUSTED", "The LLM provider retry budget was exhausted", retryable=True
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    def _within_retry_delay(self, retry_after: float | None) -> bool:
        return retry_after is None or retry_after <= self._settings.llm_max_retry_delay_seconds

    def _backoff_delay(self, attempt: int) -> float:
        limit = self._settings.llm_max_retry_delay_seconds
        base = min(limit, 0.5 * (2**attempt))
        sample = float(self._random_value())
        jitter = max(0.0, min(1.0, sample)) * min(0.25, limit - base)
        return float(base + jitter)

    def _map_usage(self, usage: _OpenAIUsage | None) -> LLMUsage | None:
        if usage is None:
            return None
        cost = self._estimate_cost(usage)
        return LLMUsage(
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            total_tokens=usage.total_tokens,
            cached_input_tokens=usage.input_tokens_details.cached_tokens
            if usage.input_tokens_details
            else None,
            reasoning_output_tokens=(
                usage.output_tokens_details.reasoning_tokens
                if usage.output_tokens_details
                else None
            ),
            cost=cost,
        )

    def _estimate_cost(self, usage: _OpenAIUsage) -> LLMCost | None:
        input_rate = self._settings.llm_input_price_usd_per_mtok
        output_rate = self._settings.llm_output_price_usd_per_mtok
        pricing_version = self._settings.llm_pricing_version
        input_tokens = usage.input_tokens
        output_tokens = usage.output_tokens
        if (
            input_rate is None
            or output_rate is None
            or pricing_version is None
            or input_tokens is None
            or output_tokens is None
        ):
            return None
        cached_rate = self._settings.llm_cached_input_price_usd_per_mtok
        reported_cached_tokens = (
            usage.input_tokens_details.cached_tokens
            if usage.input_tokens_details is not None
            else None
        )
        cached_tokens = min(input_tokens, reported_cached_tokens or 0)
        input_cost = input_rate * input_tokens
        if cached_rate is not None:
            input_cost = input_rate * (input_tokens - cached_tokens) + cached_rate * cached_tokens
        estimated_cost = (input_cost + output_rate * output_tokens) / _TOKENS_PER_MILLION
        return LLMCost(
            estimated_cost_usd=estimated_cost.quantize(_COST_PRECISION),
            pricing_version=pricing_version,
        )


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
