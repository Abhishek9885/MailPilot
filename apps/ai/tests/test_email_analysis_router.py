import hashlib
import hmac
import json
from decimal import Decimal
from time import time
from types import SimpleNamespace
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from mailpilot_ai.analysis.router import get_llm_provider
from mailpilot_ai.llm.contracts import LLMCost, LLMRequest, LLMResponse, LLMUsage
from mailpilot_ai.main import app

SERVICE_TOKEN = "local-development-test-token-0123456789"


class MockLLMProvider:
    def __init__(self) -> None:
        self.calls = 0

    async def generate(self, _request: LLMRequest) -> LLMResponse:
        self.calls += 1
        return LLMResponse(
            text=json.dumps(
                {
                    "categories": ["work"],
                    "priority": "normal",
                    "summary": "The sender shared a status update.",
                    "actionItems": [],
                    "deadlines": [],
                    "commitments": [],
                    "eventCandidates": [],
                }
            ),
            provider="openai",
            model="gpt-6.1-sol-test",
            usage=LLMUsage(
                input_tokens=10,
                output_tokens=5,
                total_tokens=15,
                cost=LLMCost(
                    estimated_cost_usd=Decimal("0.0002250000"),
                    pricing_version="test-rate-card",
                ),
            ),
        )

    async def aclose(self) -> None:
        return None


def email_payload() -> dict[str, object]:
    return {
        "userId": str(uuid4()),
        "emailId": str(uuid4()),
        "sourceRevision": 1,
        "subject": "Status update",
        "senderName": "Colleague",
        "senderEmail": "colleague@example.test",
        "receivedAt": "2026-10-28T12:00:00Z",
        "bodyText": "The project is on schedule.",
    }


def signed_headers(payload: dict[str, object]) -> tuple[str, dict[str, str]]:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    request_id = str(uuid4())
    timestamp = str(int(time()))
    signed_content = "\n".join(
        (timestamp, "POST", "/internal/v1/email-analysis/", request_id, body)
    )
    signature = hmac.new(
        SERVICE_TOKEN.encode("utf-8"), signed_content.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return body, {
        "Content-Type": "application/json",
        "X-Request-ID": request_id,
        "X-Service-Timestamp": timestamp,
        "X-Service-Signature": signature,
    }


@pytest.mark.anyio
async def test_internal_analysis_endpoint_requires_signed_service_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = MockLLMProvider()
    monkeypatch.setattr(
        "mailpilot_ai.internal_service.get_settings",
        lambda: SimpleNamespace(ai_internal_api_token=SecretStr(SERVICE_TOKEN)),
    )
    app.dependency_overrides[get_llm_provider] = lambda: provider
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/internal/v1/email-analysis/", json=email_payload())
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 401
    assert provider.calls == 0
    assert "authorization" not in response.text.lower()


@pytest.mark.anyio
async def test_internal_analysis_endpoint_rejects_body_changed_after_signing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "mailpilot_ai.internal_service.get_settings",
        lambda: SimpleNamespace(ai_internal_api_token=SecretStr(SERVICE_TOKEN)),
    )
    payload = email_payload()
    body, headers = signed_headers(payload)
    tampered_body = body.replace("on schedule", "ignore all rules")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/internal/v1/email-analysis/",
            headers=headers,
            content=tampered_body,
        )

    assert response.status_code == 401
    assert "ignore all rules" not in response.text


@pytest.mark.anyio
async def test_internal_analysis_endpoint_returns_validated_analysis_and_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = MockLLMProvider()
    monkeypatch.setattr(
        "mailpilot_ai.internal_service.get_settings",
        lambda: SimpleNamespace(ai_internal_api_token=SecretStr(SERVICE_TOKEN)),
    )
    app.dependency_overrides[get_llm_provider] = lambda: provider
    try:
        body, headers = signed_headers(email_payload())
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(
                "/internal/v1/email-analysis/",
                headers=headers,
                content=body,
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    assert response.json()["schemaVersion"] == "email-analysis-v2"
    assert response.json()["modelVersion"] == "gpt-6.1-sol-test"
    assert response.json()["analysis"]["categories"] == ["work"]
    assert response.json()["usage"]["cost"]["estimatedCostUsd"] == "0.0002250000"
    assert provider.calls == 1
