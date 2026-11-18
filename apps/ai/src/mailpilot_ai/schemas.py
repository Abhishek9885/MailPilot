from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class HealthResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    service: str
    status: Literal["ok", "unavailable"]
    request_id: UUID = Field(alias="requestId")


class ErrorBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    code: str
    message: str
    request_id: UUID = Field(alias="requestId")
    retryable: bool = False
    details: dict[str, object] = Field(default_factory=dict)


class ErrorResponse(BaseModel):
    error: ErrorBody
