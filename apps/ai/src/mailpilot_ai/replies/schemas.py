from typing import Self
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from mailpilot_ai.analysis.schemas import _to_camel
from mailpilot_ai.llm.contracts import LLMUsage


class ReplyModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        str_strip_whitespace=True,
    )


class ReplySourceMessage(ReplyModel):
    id: UUID
    source_revision: int = Field(ge=1)
    subject: str = Field(max_length=2_000)
    sender_name: str | None = Field(max_length=320)
    sender_email: str | None = Field(max_length=320)
    received_at: AwareDatetime
    body_text: str = Field(max_length=30_000)


class ReplyDraftRequest(ReplyModel):
    user_id: UUID
    email_id: UUID
    source_revision: int = Field(ge=1)
    instruction: str | None = Field(max_length=1_000)
    messages: list[ReplySourceMessage] = Field(min_length=1, max_length=8)

    @model_validator(mode="after")
    def selected_message_is_in_context(self) -> Self:
        if not any(
            message.id == self.email_id and message.source_revision == self.source_revision
            for message in self.messages
        ):
            raise ValueError("selected email must be included in the thread context")
        if len({message.id for message in self.messages}) != len(self.messages):
            raise ValueError("thread context message IDs must be unique")
        return self


class ReplyDraftClaim(ReplyModel):
    claim: str = Field(min_length=1, max_length=300)
    source_message_id: UUID
    evidence_quote: str = Field(min_length=1, max_length=500)


class ReplyDraftContent(ReplyModel):
    can_draft: bool
    subject: str = Field(max_length=2_000)
    body_text: str = Field(max_length=12_000)
    claims: list[ReplyDraftClaim] = Field(max_length=16)
    uncertainties: list[str] = Field(max_length=10)
    missing_context_reason: str | None = Field(max_length=300)

    @model_validator(mode="after")
    def validate_available_draft(self) -> Self:
        if self.can_draft and (
            not self.body_text.strip() or self.missing_context_reason is not None
        ):
            raise ValueError("available drafts require body text and no missing-context reason")
        if not self.can_draft and (
            self.subject or self.body_text or self.claims or not self.missing_context_reason
        ):
            raise ValueError("unavailable drafts cannot contain generated content")
        return self


class ReplyDraftSourceReference(ReplyModel):
    id: UUID
    source_revision: int = Field(ge=1)


class ReplyDraftResponse(ReplyModel):
    user_id: UUID
    email_id: UUID
    source_revision: int = Field(ge=1)
    schema_version: str = Field(min_length=1, max_length=64)
    provider: str | None = Field(max_length=64)
    model_version: str | None = Field(max_length=128)
    response_id: str | None = Field(max_length=256)
    provider_request_id: str | None = Field(max_length=256)
    usage: LLMUsage | None
    source_messages: list[ReplyDraftSourceReference] = Field(min_length=1, max_length=8)
    draft: ReplyDraftContent
