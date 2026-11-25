import hashlib
import hmac
import json
from time import time
from types import SimpleNamespace
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from mailpilot_ai.analysis.schemas import EmailCategory, EmailPriority
from mailpilot_ai.classification.baseline import EmailClassificationPrediction
from mailpilot_ai.classification.service import (
    EmailClassifierUnavailableError,
    get_email_classifier,
)
from mailpilot_ai.main import app

SERVICE_TOKEN = "local-development-test-token-0123456789"
CLASSIFICATION_PATH = "/internal/v1/email-classification/"


class StubClassifier:
    manifest = SimpleNamespace(model_version="test-classifier-v1")

    def __init__(
        self,
        prediction: EmailClassificationPrediction | None = None,
        *,
        abstain: bool = False,
    ) -> None:
        self.prediction = (
            None
            if abstain
            else prediction
            or EmailClassificationPrediction(
                primary_category=EmailCategory.WORK,
                priority=EmailPriority.NORMAL,
            )
        )

    def predict(self, _subject: str, _body_text: str) -> EmailClassificationPrediction | None:
        return self.prediction


def signed_headers(payload: dict[str, object]) -> tuple[str, dict[str, str]]:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    request_id = str(uuid4())
    timestamp = str(int(time()))
    signed_content = "\n".join(
        (timestamp, "POST", CLASSIFICATION_PATH, request_id, body)
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


def classification_payload() -> dict[str, str]:
    return {
        "subject": "Project agenda review",
        "bodyText": "Please share edits to the launch agenda by Tuesday.",
    }


@pytest.mark.anyio
async def test_classifier_endpoint_returns_prediction_and_model_version(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    classifier = StubClassifier()
    monkeypatch.setattr(
        "mailpilot_ai.internal_service.get_settings",
        lambda: SimpleNamespace(ai_internal_api_token=SecretStr(SERVICE_TOKEN)),
    )
    app.dependency_overrides[get_email_classifier] = lambda: classifier
    try:
        body, headers = signed_headers(classification_payload())
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(CLASSIFICATION_PATH, headers=headers, content=body)
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["modelVersion"] == "test-classifier-v1"
    assert response.json()["schemaVersion"] == "email-classification-response-v1"
    assert response.json()["primaryCategory"] == "work"
    assert response.json()["priority"] == "normal"
    assert response.json()["abstained"] is False
    assert response.json()["requestId"] == response.headers["x-request-id"]


@pytest.mark.anyio
async def test_classifier_endpoint_requires_internal_signature(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "mailpilot_ai.internal_service.get_settings",
        lambda: SimpleNamespace(ai_internal_api_token=SecretStr(SERVICE_TOKEN)),
    )
    app.dependency_overrides[get_email_classifier] = lambda: StubClassifier()
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(CLASSIFICATION_PATH, json=classification_payload())
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 401
    assert "email" not in response.text.lower()


@pytest.mark.anyio
async def test_classifier_endpoint_validates_empty_content_safely(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "mailpilot_ai.internal_service.get_settings",
        lambda: SimpleNamespace(ai_internal_api_token=SecretStr(SERVICE_TOKEN)),
    )
    payload = {"subject": "   ", "bodyText": "\n\t"}
    body, headers = signed_headers(payload)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(CLASSIFICATION_PATH, headers=headers, content=body)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_ARGUMENT"
    assert "subject and body" not in response.text


@pytest.mark.anyio
async def test_classifier_endpoint_returns_abstention_for_unknown_vocabulary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    classifier = StubClassifier(abstain=True)
    monkeypatch.setattr(
        "mailpilot_ai.internal_service.get_settings",
        lambda: SimpleNamespace(ai_internal_api_token=SecretStr(SERVICE_TOKEN)),
    )
    app.dependency_overrides[get_email_classifier] = lambda: classifier
    try:
        body, headers = signed_headers(classification_payload())
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(CLASSIFICATION_PATH, headers=headers, content=body)
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["abstained"] is True
    assert response.json()["primaryCategory"] is None
    assert response.json()["priority"] is None


@pytest.mark.anyio
async def test_classifier_unavailable_returns_safe_retryable_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "mailpilot_ai.internal_service.get_settings",
        lambda: SimpleNamespace(ai_internal_api_token=SecretStr(SERVICE_TOKEN)),
    )

    def unavailable() -> None:
        raise EmailClassifierUnavailableError()

    app.dependency_overrides[get_email_classifier] = unavailable
    try:
        body, headers = signed_headers(classification_payload())
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(CLASSIFICATION_PATH, headers=headers, content=body)
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "EMAIL_CLASSIFIER_UNAVAILABLE"
    assert response.json()["error"]["retryable"] is True
    assert "classifier.joblib" not in response.text
