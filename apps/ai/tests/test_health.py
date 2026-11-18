from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from mailpilot_ai.main import app


@pytest.mark.anyio
async def test_liveness_returns_request_id() -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/internal/v1/health/live")

    assert response.status_code == 200
    assert response.json()["service"] == "ai"
    assert response.json()["status"] == "ok"
    assert response.json()["requestId"] == response.headers["x-request-id"]


@pytest.mark.anyio
async def test_liveness_preserves_valid_incoming_request_id() -> None:
    request_id = "d24cb56a-b2f9-4b32-a74a-a36da9fd9300"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/health/live", headers={"x-request-id": request_id})

    assert response.status_code == 200
    assert response.json()["requestId"] == request_id
    assert response.headers["x-request-id"] == request_id


@pytest.mark.anyio
async def test_liveness_replaces_invalid_request_id() -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/health/live", headers={"x-request-id": "invalid"})

    assert response.status_code == 200
    assert response.json()["requestId"] == response.headers["x-request-id"]
    assert response.headers["x-request-id"] != "invalid"


@pytest.mark.anyio
async def test_readiness_reports_database_connectivity() -> None:
    with patch("mailpilot_ai.main.check_database", new=AsyncMock(return_value=None)):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/internal/v1/health/ready")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


@pytest.mark.anyio
async def test_readiness_returns_safe_503_when_database_is_down() -> None:
    unavailable = AsyncMock(side_effect=OSError("private details"))
    with patch("mailpilot_ai.main.check_database", new=unavailable):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/health/ready")

    assert response.status_code == 503
    assert response.json()["status"] == "unavailable"
    assert "private details" not in response.text


@pytest.mark.anyio
async def test_missing_route_returns_standard_error_envelope() -> None:
    request_id = "d24cb56a-b2f9-4b32-a74a-a36da9fd9300"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/missing", headers={"x-request-id": request_id})

    assert response.status_code == 404
    assert response.json() == {
        "error": {
            "code": "NOT_FOUND",
            "message": "Route not found",
            "requestId": request_id,
            "retryable": False,
            "details": {},
        }
    }
    assert response.headers["x-request-id"] == request_id
