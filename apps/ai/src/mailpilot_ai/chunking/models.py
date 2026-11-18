from typing import Self
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator


def _to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class EmailChunkModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        str_strip_whitespace=False,
    )


class EmailChunkSource(EmailChunkModel):
    """Owner-scoped, parsed message fields required to produce reproducible chunks."""

    user_id: UUID
    email_id: UUID
    provider_message_id: str = Field(min_length=1, max_length=255)
    provider_thread_id: str = Field(min_length=1, max_length=255)
    source_revision: int = Field(ge=1)
    received_at: AwareDatetime
    sender_name: str | None = Field(default=None, max_length=320)
    sender_email: str | None = Field(default=None, max_length=320)
    subject: str = Field(max_length=2_000)
    body_text: str = Field(default="", max_length=2_000_000)
    body_html: str | None = Field(default=None, max_length=4_000_000)


class EmailChunk(EmailChunkModel):
    """A chunk and the source metadata needed to scope and cite it."""

    user_id: UUID
    email_id: UUID
    provider_message_id: str = Field(min_length=1, max_length=255)
    provider_thread_id: str = Field(min_length=1, max_length=255)
    source_revision: int = Field(ge=1)
    content_version: str = Field(min_length=1, max_length=64)
    chunker_version: str = Field(min_length=1, max_length=64)
    ordinal: int = Field(ge=0)
    start_char: int = Field(ge=0)
    end_char: int = Field(gt=0)
    content: str = Field(min_length=1, max_length=10_000)
    content_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    received_at: AwareDatetime
    sender_name: str | None = Field(default=None, max_length=320)
    sender_email: str | None = Field(default=None, max_length=320)
    subject: str = Field(max_length=2_000)

    @model_validator(mode="after")
    def validate_offsets(self) -> Self:
        if self.end_char <= self.start_char:
            raise ValueError("chunk end offset must be after start offset")
        if len(self.content) != self.end_char - self.start_char:
            raise ValueError("chunk content length must match its source offsets")
        return self
