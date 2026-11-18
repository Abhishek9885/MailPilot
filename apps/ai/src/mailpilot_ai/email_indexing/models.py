from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


def _to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class EmailIndexModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
    )


class EmailIndexStatus(StrEnum):
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    DELETED = "deleted"


class EmailIndexFailure(EmailIndexModel):
    email_id: UUID
    code: str = Field(min_length=1, max_length=128)
    retryable: bool


class EmailIndexReport(EmailIndexModel):
    received_count: int = Field(ge=0)
    succeeded_count: int = Field(ge=0)
    skipped_count: int = Field(ge=0)
    failed_count: int = Field(ge=0)
    chunk_count: int = Field(ge=0)
    embedded_chunk_count: int = Field(ge=0)
    failures: tuple[EmailIndexFailure, ...] = Field(max_length=100)

    @model_validator(mode="after")
    def validate_totals(self) -> "EmailIndexReport":
        if self.succeeded_count + self.skipped_count + self.failed_count != self.received_count:
            raise ValueError("email indexing report counts do not add up")
        if self.failed_count != len(self.failures):
            raise ValueError("failed email count must match the failure details")
        return self
