import hashlib
import hmac
import re
from collections.abc import AsyncIterator
from time import time
from typing import Annotated

from fastapi import Header, HTTPException, Request

from mailpilot_ai.config import get_settings
from mailpilot_ai.llm.contracts import LLMProvider
from mailpilot_ai.llm.factory import create_llm_provider

_SERVICE_SIGNATURE_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_SERVICE_SIGNATURE_TTL_SECONDS = 60


async def require_internal_service_signature(
    request: Request,
    service_timestamp: Annotated[str | None, Header(alias="X-Service-Timestamp")] = None,
    service_signature: Annotated[str | None, Header(alias="X-Service-Signature")] = None,
) -> None:
    expected = get_settings().ai_internal_api_token
    if expected is None:
        raise HTTPException(status_code=503, detail="Internal service is not configured")
    if (
        service_timestamp is None
        or not re.fullmatch(r"[0-9]{1,12}", service_timestamp)
        or service_signature is None
        or not _SERVICE_SIGNATURE_PATTERN.fullmatch(service_signature)
    ):
        raise HTTPException(status_code=401, detail="Internal service authentication is required")
    if abs(int(time()) - int(service_timestamp)) > _SERVICE_SIGNATURE_TTL_SECONDS:
        raise HTTPException(status_code=401, detail="Internal service authentication is required")

    body = await request.body()
    request_id = request.headers.get("x-request-id", "")
    signed_content = b"\n".join(
        (
            service_timestamp.encode("ascii"),
            request.method.encode("ascii"),
            request.url.path.encode("utf-8"),
            request_id.encode("ascii", errors="ignore"),
            body,
        )
    )
    expected_signature = hmac.new(
        expected.get_secret_value().encode("utf-8"), signed_content, hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(service_signature, expected_signature):
        raise HTTPException(status_code=401, detail="Internal service authentication is required")


async def get_llm_provider() -> AsyncIterator[LLMProvider]:
    provider = create_llm_provider(get_settings())
    try:
        yield provider
    finally:
        await provider.aclose()
