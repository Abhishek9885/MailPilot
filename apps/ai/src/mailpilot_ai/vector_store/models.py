from typing import Self
from uuid import UUID

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)


def _to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class VectorStoreModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
    )


class VectorStoreChunkRef(VectorStoreModel):
    """Expected canonical chunk version, checked against Prisma storage on insert."""

    user_id: UUID
    chunk_id: UUID
    source_revision: int = Field(ge=1)
    chunker_version: str = Field(min_length=1, max_length=64)
    content_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


class RetrievalFilters(VectorStoreModel):
    """Optional owner-scoped email metadata constraints for retrieval."""

    email_id: UUID | None = None
    provider_message_id: str | None = Field(default=None, min_length=1, max_length=255)
    provider_thread_id: str | None = Field(default=None, min_length=1, max_length=255)
    sender_email: str | None = Field(default=None, min_length=1, max_length=320)
    received_after: AwareDatetime | None = None
    received_before: AwareDatetime | None = None

    @field_validator("sender_email")
    @classmethod
    def normalize_sender_email(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip().lower()
        if not normalized:
            raise ValueError("sender email filter cannot be blank")
        return normalized

    @model_validator(mode="after")
    def validate_received_range(self) -> Self:
        if (
            self.received_after is not None
            and self.received_before is not None
            and self.received_after > self.received_before
        ):
            raise ValueError("received_after must not be later than received_before")
        return self


class SourceReference(VectorStoreModel):
    """Canonical email chunk and message metadata shared by search methods."""

    user_id: UUID
    chunk_id: UUID
    email_id: UUID
    provider_message_id: str = Field(min_length=1, max_length=255)
    provider_thread_id: str = Field(min_length=1, max_length=255)
    source_revision: int = Field(ge=1)
    chunker_version: str = Field(min_length=1, max_length=64)
    start_char: int = Field(ge=0)
    end_char: int = Field(gt=0)
    content: str = Field(min_length=1)
    content_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    received_at: AwareDatetime
    sender_name: str | None = None
    sender_email: str | None = None
    subject: str

    @model_validator(mode="after")
    def validate_offsets(self) -> Self:
        if self.end_char <= self.start_char:
            raise ValueError("source end offset must be after start offset")
        if len(self.content) != self.end_char - self.start_char:
            raise ValueError("source content length must match its offsets")
        if len(self.content_hash) != 64:
            raise ValueError("source content hash is invalid")
        return self


class NearestNeighbor(SourceReference):
    provider: str = Field(min_length=1, max_length=64)
    model: str = Field(min_length=1, max_length=128)
    model_version: str = Field(min_length=1, max_length=128)
    embedding_version: str = Field(pattern=r"^[0-9a-f]{64}$")
    dimensions: int = Field(ge=1, le=1_536)
    cosine_distance: float = Field(ge=0, le=2, allow_inf_nan=False)


class KeywordNeighbor(SourceReference):
    keyword_score: float = Field(gt=0, allow_inf_nan=False)


class HybridSearchResult(SourceReference):
    vector_rank: int | None = Field(default=None, ge=1)
    keyword_rank: int | None = Field(default=None, ge=1)
    fusion_score: float = Field(gt=0, allow_inf_nan=False)
