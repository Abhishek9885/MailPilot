from collections.abc import Sequence
from decimal import Decimal
from typing import Protocol

from pydantic import BaseModel, ConfigDict, Field, field_serializer, model_validator


def _to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class EmbeddingCost(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
    )

    estimated_cost_usd: Decimal = Field(ge=0)
    pricing_version: str = Field(min_length=1, max_length=64)

    @field_serializer("estimated_cost_usd")
    def serialize_estimated_cost(self, value: Decimal) -> str:
        return format(value, "f")


class EmbeddingUsage(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
    )

    input_tokens: int = Field(ge=0)
    total_tokens: int = Field(ge=0)
    cost: EmbeddingCost | None = None

    @model_validator(mode="after")
    def total_is_at_least_input(self) -> "EmbeddingUsage":
        if self.total_tokens < self.input_tokens:
            raise ValueError("total token usage cannot be smaller than input token usage")
        return self


class EmbeddingResult(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        allow_inf_nan=False,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
    )

    provider: str = Field(min_length=1, max_length=64)
    model_version: str = Field(min_length=1, max_length=128)
    dimensions: int = Field(ge=1, le=3_072)
    vectors: tuple[tuple[float, ...], ...]
    usage: EmbeddingUsage

    @model_validator(mode="after")
    def vectors_match_dimensions(self) -> "EmbeddingResult":
        if any(len(vector) != self.dimensions for vector in self.vectors):
            raise ValueError("embedding vector dimensions do not match the declared dimensions")
        return self


class EmbeddingProvider(Protocol):
    async def embed(self, texts: Sequence[str]) -> EmbeddingResult: ...

    async def aclose(self) -> None: ...
