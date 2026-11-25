from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, Depends

from mailpilot_ai.config import get_settings
from mailpilot_ai.embeddings import EmbeddingProvider, create_embedding_provider
from mailpilot_ai.internal_service import require_internal_service_signature
from mailpilot_ai.retrieval.schemas import HybridRetrievalResponse, RetrievalRequest
from mailpilot_ai.retrieval.service import HybridRetrievalService
from mailpilot_ai.vector_store import PostgresEmbeddingStore

router = APIRouter(prefix="/internal/v1/retrieval", tags=["hybrid retrieval"])


async def get_embedding_provider() -> AsyncIterator[EmbeddingProvider]:
    provider = create_embedding_provider(get_settings())
    try:
        yield provider
    finally:
        await provider.aclose()


def get_vector_store() -> PostgresEmbeddingStore:
    settings = get_settings()
    return PostgresEmbeddingStore(
        str(settings.database_connection_url),
        model=settings.embedding_model,
        provider=settings.embedding_provider,
        dimensions=settings.embedding_dimensions,
    )


@router.post(
    "/",
    response_model=HybridRetrievalResponse,
    dependencies=[Depends(require_internal_service_signature)],
)
async def retrieve_sources(
    request: RetrievalRequest,
    provider: Annotated[EmbeddingProvider, Depends(get_embedding_provider)],
    vector_store: Annotated[PostgresEmbeddingStore, Depends(get_vector_store)],
) -> HybridRetrievalResponse:
    results = await HybridRetrievalService(
        embedding_provider=provider,
        search_store=vector_store,
    ).retrieve(
        user_id=request.user_id,
        query=request.query,
        limit=request.top_k,
        filters=request.filters,
    )
    return HybridRetrievalResponse(results=results)
