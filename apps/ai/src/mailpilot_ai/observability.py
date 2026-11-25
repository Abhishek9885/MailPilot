"""Content-free operational instrumentation for model and embedding calls."""

from __future__ import annotations

import re
from collections.abc import Sequence
from time import perf_counter
from typing import TYPE_CHECKING

import structlog

if TYPE_CHECKING:
    from mailpilot_ai.embeddings.contracts import EmbeddingProvider, EmbeddingResult
    from mailpilot_ai.llm.contracts import LLMProvider, LLMRequest, LLMResponse

_logger = structlog.get_logger().bind(service="ai")
_SAFE_ERROR_CODE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")


class InstrumentedLLMProvider:
    """Log timing and available usage without retaining prompts or completions."""

    def __init__(self, provider: LLMProvider) -> None:
        self._provider = provider

    async def generate(self, request: LLMRequest) -> LLMResponse:
        started_at = perf_counter()
        operation = (
            request.output_schema.name if request.output_schema is not None else "text_generation"
        )
        try:
            response = await self._provider.generate(request)
        except Exception as error:
            _logger.warning(
                "llm.call.failed",
                operation=operation,
                errorCode=_safe_error_code(error),
                errorType=type(error).__name__,
                durationMs=round((perf_counter() - started_at) * 1_000, 2),
            )
            raise

        fields: dict[str, object] = {
            "operation": operation,
            "provider": response.provider,
            "model": response.model,
            "durationMs": round((perf_counter() - started_at) * 1_000, 2),
        }
        if response.usage is not None:
            usage = response.usage
            fields.update(
                inputTokens=usage.input_tokens,
                outputTokens=usage.output_tokens,
                totalTokens=usage.total_tokens,
                cachedInputTokens=usage.cached_input_tokens,
                reasoningOutputTokens=usage.reasoning_output_tokens,
            )
            if usage.cost is not None:
                fields.update(
                    estimatedCostUsd=str(usage.cost.estimated_cost_usd),
                    pricingVersion=usage.cost.pricing_version,
                    costBasis=usage.cost.basis,
                )
        _logger.info("llm.call.completed", **fields)
        return response

    async def aclose(self) -> None:
        await self._provider.aclose()


class InstrumentedEmbeddingProvider:
    """Log embedding call metrics while keeping source strings out of logs."""

    def __init__(self, provider: EmbeddingProvider) -> None:
        self._provider = provider

    async def embed(self, texts: Sequence[str]) -> EmbeddingResult:
        started_at = perf_counter()
        try:
            result = await self._provider.embed(texts)
        except Exception as error:
            _logger.warning(
                "embedding.call.failed",
                errorCode=_safe_error_code(error),
                errorType=type(error).__name__,
                inputCount=len(texts) if isinstance(texts, Sequence) else None,
                durationMs=round((perf_counter() - started_at) * 1_000, 2),
            )
            raise

        fields: dict[str, object] = {
            "provider": result.provider,
            "model": result.model_version,
            "dimensions": result.dimensions,
            "vectorCount": len(result.vectors),
            "inputTokens": result.usage.input_tokens,
            "totalTokens": result.usage.total_tokens,
            "durationMs": round((perf_counter() - started_at) * 1_000, 2),
        }
        if result.usage.cost is not None:
            fields.update(
                estimatedCostUsd=str(result.usage.cost.estimated_cost_usd),
                pricingVersion=result.usage.cost.pricing_version,
                costBasis="configured_token_rates",
            )
        _logger.info("embedding.call.completed", **fields)
        return result

    async def aclose(self) -> None:
        await self._provider.aclose()


def _safe_error_code(error: Exception) -> str:
    code = getattr(error, "code", None)
    if isinstance(code, str) and _SAFE_ERROR_CODE.fullmatch(code):
        return code
    return "PROVIDER_CALL_FAILED"
