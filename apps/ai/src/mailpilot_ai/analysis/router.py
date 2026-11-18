from typing import Annotated

from fastapi import APIRouter, Depends

from mailpilot_ai.analysis.schemas import EmailAnalysisRequest, EmailAnalysisResponse
from mailpilot_ai.analysis.service import EmailAnalysisService
from mailpilot_ai.internal_service import get_llm_provider, require_internal_service_signature
from mailpilot_ai.llm.contracts import LLMProvider

router = APIRouter(prefix="/internal/v1/email-analysis", tags=["email analysis"])


@router.post(
    "/",
    response_model=EmailAnalysisResponse,
    dependencies=[Depends(require_internal_service_signature)],
)
async def analyze_email(
    email: EmailAnalysisRequest,
    provider: Annotated[LLMProvider, Depends(get_llm_provider)],
) -> EmailAnalysisResponse:
    return await EmailAnalysisService(provider).analyze(email)
