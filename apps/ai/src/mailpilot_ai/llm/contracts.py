from decimal import Decimal
from typing import Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, field_serializer, model_validator

LLMMessageRole = Literal["system", "developer", "user", "assistant"]
type JsonValue = str | int | float | bool | None | list[JsonValue] | dict[str, JsonValue]


def _to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class LLMMessage(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    role: LLMMessageRole
    content: str = Field(min_length=1, max_length=250_000)


class LLMJsonSchema(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    json_schema: dict[str, JsonValue] = Field(alias="schema")
    strict: bool = True


class LLMRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    messages: tuple[LLMMessage, ...] = Field(min_length=1, max_length=100)
    max_output_tokens: int = Field(default=1_024, ge=1, le=32_000)
    output_schema: LLMJsonSchema | None = None

    @model_validator(mode="after")
    def validate_total_input_size(self) -> "LLMRequest":
        if sum(len(message.content) for message in self.messages) > 500_000:
            raise ValueError("LLM request text exceeds the configured input bound")
        return self


class LLMCost(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
    )

    estimated_cost_usd: Decimal = Field(ge=0)
    pricing_version: str = Field(min_length=1, max_length=64)
    basis: Literal["configured_token_rates"] = "configured_token_rates"

    @field_serializer("estimated_cost_usd")
    def serialize_estimated_cost(self, value: Decimal) -> str:
        return format(value, "f")


class LLMUsage(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
    )

    input_tokens: int | None = Field(default=None, ge=0)
    output_tokens: int | None = Field(default=None, ge=0)
    total_tokens: int | None = Field(default=None, ge=0)
    cached_input_tokens: int | None = Field(default=None, ge=0)
    reasoning_output_tokens: int | None = Field(default=None, ge=0)
    cost: LLMCost | None = None


class LLMResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    text: str = Field(min_length=1)
    provider: str = Field(min_length=1, max_length=64)
    model: str = Field(min_length=1, max_length=128)
    response_id: str | None = Field(default=None, max_length=256)
    provider_request_id: str | None = Field(default=None, max_length=256)
    usage: LLMUsage | None = None


class LLMProvider(Protocol):
    async def generate(self, request: LLMRequest) -> LLMResponse: ...

    async def aclose(self) -> None: ...
