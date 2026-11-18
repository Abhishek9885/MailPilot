from typing import Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from mailpilot_ai.vector_store import HybridSearchResult, RetrievalFilters


def _to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class SemanticRetrievalModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
    )


class RetrievalRequest(SemanticRetrievalModel):
    user_id: UUID
    query: str = Field(min_length=1, max_length=20_000)
    top_k: int = Field(default=10, ge=1, le=100)
    filters: RetrievalFilters = Field(default_factory=RetrievalFilters)

    @model_validator(mode="after")
    def query_is_not_blank(self) -> Self:
        if not self.query.strip():
            raise ValueError("query cannot be blank")
        return self


class HybridRetrievalResponse(SemanticRetrievalModel):
    results: tuple[HybridSearchResult, ...] = Field(max_length=100)
