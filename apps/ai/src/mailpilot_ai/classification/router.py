from typing import Annotated

from fastapi import APIRouter, Depends, Request

from mailpilot_ai.classification.baseline import EmailClassifier
from mailpilot_ai.classification.schemas import (
    EmailClassificationRequest,
    EmailClassificationResponse,
)
from mailpilot_ai.classification.service import get_email_classifier
from mailpilot_ai.internal_service import require_internal_service_signature

router = APIRouter(prefix="/internal/v1/email-classification", tags=["email classification"])


@router.post(
    "/",
    response_model=EmailClassificationResponse,
    dependencies=[Depends(require_internal_service_signature)],
)
async def classify_email(
    body: EmailClassificationRequest,
    request: Request,
    classifier: Annotated[EmailClassifier, Depends(get_email_classifier)],
) -> EmailClassificationResponse:
    prediction = classifier.predict(body.subject, body.body_text)
    return EmailClassificationResponse(
        request_id=request.state.request_id,
        schema_version="email-classification-response-v1",
        model_version=classifier.manifest.model_version,
        primary_category=prediction.primary_category if prediction is not None else None,
        priority=prediction.priority if prediction is not None else None,
        abstained=prediction is None,
    )
