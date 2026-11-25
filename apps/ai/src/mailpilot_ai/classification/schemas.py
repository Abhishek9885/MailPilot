from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from mailpilot_ai.analysis.schemas import EmailCategory, EmailPriority


def _to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class EmailClassificationRequest(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        str_strip_whitespace=True,
    )

    subject: str = Field(max_length=2_000)
    body_text: str = Field(max_length=100_000)

    @model_validator(mode="after")
    def require_nonempty_email_text(self) -> "EmailClassificationRequest":
        if not self.subject and not self.body_text:
            raise ValueError("email subject and body must not both be empty")
        return self


class EmailClassificationResponse(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
    )

    request_id: UUID
    schema_version: Literal["email-classification-response-v1"]
    model_version: str = Field(min_length=1, max_length=128)
    primary_category: EmailCategory | None
    priority: EmailPriority | None
    abstained: bool
