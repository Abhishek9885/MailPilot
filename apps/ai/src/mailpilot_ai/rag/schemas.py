from typing import Self
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator

from mailpilot_ai.retrieval.schemas import RetrievalRequest


def _to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class RAGModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        str_strip_whitespace=True,
    )


class GroundedAnswerClaim(RAGModel):
    claim: str = Field(min_length=1, max_length=500)
    citation_id: str = Field(pattern=r"^E[1-9][0-9]{0,2}$")
    evidence_quote: str = Field(min_length=1, max_length=500)


class GroundedAnswerContent(RAGModel):
    answer: str = Field(max_length=12_000)
    abstained: bool
    claims: tuple[GroundedAnswerClaim, ...] = Field(max_length=24)
    unknowns: tuple[str, ...] = Field(max_length=16)
    abstention_reason: str | None = Field(max_length=500)

    @model_validator(mode="after")
    def validate_abstention_shape(self) -> Self:
        if self.abstained:
            if self.answer or self.claims or not self.abstention_reason:
                raise ValueError("abstentions must have a reason and no answer claims")
        elif not self.answer or not self.claims or self.abstention_reason is not None:
            raise ValueError(
                "answered responses require claims and cannot include an abstention reason"
            )
        return self

    @field_validator("unknowns")
    @classmethod
    def unknowns_are_unique(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if len(value) != len(set(value)):
            raise ValueError("unknowns must be unique")
        return value


class GroundedAnswerCitation(RAGModel):
    citation_id: str = Field(pattern=r"^E[1-9][0-9]{0,2}$")
    claim: str = Field(min_length=1, max_length=500)
    evidence_quote: str = Field(min_length=1, max_length=500)
    email_id: UUID
    chunk_id: UUID
    provider_message_id: str = Field(min_length=1, max_length=255)
    provider_thread_id: str = Field(min_length=1, max_length=255)
    source_revision: int = Field(ge=1)
    received_at: AwareDatetime
    subject: str
    start_char: int = Field(ge=0)
    end_char: int = Field(gt=0)

    @model_validator(mode="after")
    def validate_offsets(self) -> Self:
        if self.end_char <= self.start_char:
            raise ValueError("citation end offset must be after its start offset")
        return self


class GroundedAnswerResponse(RAGModel):
    schema_version: str = "grounded-rag-answer-v1"
    answer: str = Field(max_length=12_000)
    abstained: bool
    citations: tuple[GroundedAnswerCitation, ...] = Field(max_length=24)
    unknowns: tuple[str, ...] = Field(max_length=16)
    abstention_reason: str | None = Field(max_length=500)
    context_tokens_used: int = Field(ge=0)
    context_token_budget: int = Field(ge=1)
    evidence_count: int = Field(ge=0, le=100)
    provider: str | None = Field(default=None, max_length=64)
    model_version: str | None = Field(default=None, max_length=128)
    response_id: str | None = Field(default=None, max_length=256)

    @model_validator(mode="after")
    def validate_abstention_shape(self) -> Self:
        if self.context_tokens_used > self.context_token_budget:
            raise ValueError("context token usage exceeds its budget")
        if self.abstained:
            if self.answer or self.citations or not self.abstention_reason:
                raise ValueError("abstentions must have a reason and no answer citations")
        elif not self.answer or not self.citations or self.abstention_reason is not None:
            raise ValueError("answered responses require citations and no abstention reason")
        return self


class GroundedRAGWorkflowRequest(RetrievalRequest):
    """Trusted service request identifiers required for idempotent graph runs."""

    conversation_id: UUID
    run_id: UUID
    resume: bool = False
