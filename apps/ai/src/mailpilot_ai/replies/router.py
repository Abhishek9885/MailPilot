from fastapi import APIRouter, Depends

from mailpilot_ai.config import get_settings
from mailpilot_ai.internal_service import require_internal_service_signature
from mailpilot_ai.llm.factory import create_llm_provider
from mailpilot_ai.replies.schemas import ReplyDraftRequest, ReplyDraftResponse
from mailpilot_ai.replies.service import ReplyDraftService, has_substantive_context

router = APIRouter(prefix="/internal/v1/reply-drafts", tags=["reply drafts"])


@router.post(
    "/",
    response_model=ReplyDraftResponse,
    dependencies=[Depends(require_internal_service_signature)],
)
async def draft_reply(
    request: ReplyDraftRequest,
) -> ReplyDraftResponse:
    if not has_substantive_context(request):
        return await ReplyDraftService(None).draft(request)

    provider = create_llm_provider(get_settings())
    try:
        return await ReplyDraftService(provider).draft(request)
    finally:
        await provider.aclose()
