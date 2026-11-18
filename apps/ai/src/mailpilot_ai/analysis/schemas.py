from datetime import date, time
from enum import StrEnum
from typing import Literal, Self
from uuid import UUID

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from mailpilot_ai.llm.contracts import LLMUsage


def _to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class EmailCategory(StrEnum):
    WORK = "work"
    PERSONAL = "personal"
    FINANCE = "finance"
    TRAVEL = "travel"
    SHOPPING = "shopping"
    SOCIAL = "social"
    NEWSLETTER = "newsletter"
    SECURITY = "security"
    OTHER = "other"


class EmailPriority(StrEnum):
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    URGENT = "urgent"


class EmailAnalysisModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        str_strip_whitespace=True,
    )


class EmailActionItem(EmailAnalysisModel):
    task: str = Field(min_length=1, max_length=240)
    owner: Literal["user", "sender", "other", "unknown"]
    due_date: date | None = Field(
        strict=True,
        description=(
            "ISO date only when the message supports an unambiguous calendar date; otherwise null."
        ),
    )
    evidence: str = Field(min_length=1, max_length=500)


class EmailDeadlineCandidate(EmailAnalysisModel):
    source_text: str = Field(min_length=1, max_length=160)
    candidate_date: date | None = Field(
        strict=True,
        description=(
            "Resolve relative dates against received_at only when unambiguous; otherwise null."
        ),
    )
    confidence: float = Field(ge=0, le=1)
    evidence: str = Field(min_length=1, max_length=500)


class EmailCommitment(EmailAnalysisModel):
    speaker: Literal["sender", "user", "third_party", "unknown"]
    commitment: str = Field(min_length=1, max_length=300)
    due_date: date | None = Field(
        strict=True, description="ISO date only when explicit or unambiguous; otherwise null."
    )
    evidence: str = Field(min_length=1, max_length=500)


class EmailEventCandidate(EmailAnalysisModel):
    title: str = Field(min_length=1, max_length=200)
    start_date: date | None = Field(
        strict=True, description="ISO calendar date or null when the email does not determine it."
    )
    start_time: time | None = Field(
        strict=True, description="24-hour local time or null when the email does not determine it."
    )
    end_date: date | None = Field(
        strict=True, description="ISO calendar date or null when the email does not determine it."
    )
    end_time: time | None = Field(
        strict=True, description="24-hour local time or null when the email does not determine it."
    )
    timezone: str | None = Field(max_length=64)
    location: str | None = Field(max_length=240)
    evidence: str = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def validate_end_is_not_before_start(self) -> Self:
        if self.start_date is not None and self.end_date is not None:
            if self.end_date < self.start_date:
                raise ValueError("event end date must not precede its start date")
            if (
                self.end_date == self.start_date
                and self.start_time is not None
                and self.end_time is not None
                and self.end_time < self.start_time
            ):
                raise ValueError("event end time must not precede its start time")
        return self


class EmailAnalysis(EmailAnalysisModel):
    categories: list[EmailCategory] = Field(min_length=1, max_length=4)
    priority: EmailPriority
    summary: str = Field(min_length=1, max_length=600)
    action_items: list[EmailActionItem] = Field(max_length=12)
    deadlines: list[EmailDeadlineCandidate] = Field(max_length=8)
    commitments: list[EmailCommitment] = Field(max_length=8)
    event_candidates: list[EmailEventCandidate] = Field(max_length=8)

    @field_validator("categories")
    @classmethod
    def categories_are_unique(cls, value: list[EmailCategory]) -> list[EmailCategory]:
        if len(value) != len(set(value)):
            raise ValueError("categories must be unique")
        return value


class EmailAnalysisRequest(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        str_strip_whitespace=True,
    )

    user_id: UUID
    email_id: UUID
    source_revision: int = Field(ge=1)
    subject: str = Field(max_length=2_000)
    sender_name: str | None = Field(max_length=320)
    sender_email: str | None = Field(max_length=320)
    received_at: AwareDatetime
    body_text: str = Field(max_length=100_000)


class EmailAnalysisResponse(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
    )

    user_id: UUID
    email_id: UUID
    source_revision: int = Field(ge=1)
    schema_version: str = Field(min_length=1, max_length=64)
    provider: str = Field(min_length=1, max_length=64)
    model_version: str = Field(min_length=1, max_length=128)
    response_id: str | None = Field(default=None, max_length=256)
    provider_request_id: str | None = Field(default=None, max_length=256)
    usage: LLMUsage | None = None
    analysis: EmailAnalysis
