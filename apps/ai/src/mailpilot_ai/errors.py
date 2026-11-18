from uuid import UUID

from fastapi.responses import JSONResponse

from mailpilot_ai.schemas import ErrorBody, ErrorResponse


def error_response(
    *,
    status_code: int,
    code: str,
    message: str,
    request_id: UUID | str,
    retryable: bool = False,
) -> JSONResponse:
    body = ErrorResponse(
        error=ErrorBody(
            code=code,
            message=message,
            request_id=request_id,
            retryable=retryable,
        )
    )
    return JSONResponse(
        status_code=status_code,
        content=body.model_dump(mode="json", by_alias=True),
        headers={"x-request-id": str(request_id)},
    )


def public_http_error(status_code: int) -> tuple[str, str, bool]:
    if status_code == 401:
        return "UNAUTHENTICATED", "Authentication is required", False
    if status_code == 403:
        return "FORBIDDEN", "Access is forbidden", False
    if status_code == 404:
        return "NOT_FOUND", "Route not found", False
    if status_code == 409:
        return "CONFLICT", "The request conflicts with the current state", False
    if status_code == 429:
        return "RATE_LIMITED", "Too many requests", True
    if status_code in {400, 422}:
        return "INVALID_ARGUMENT", "The request is invalid", False
    if status_code >= 500:
        return "INTERNAL", "An unexpected error occurred", status_code in {502, 503, 504}
    return "INVALID_ARGUMENT", "The request failed", False
