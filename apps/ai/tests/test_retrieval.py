from collections.abc import Sequence
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from httpx import ASGITransport, AsyncClient

from mailpilot_ai.embeddings.contracts import EmbeddingResult, EmbeddingUsage
from mailpilot_ai.internal_service import require_internal_service_signature
from mailpilot_ai.main import app
from mailpilot_ai.retrieval import SemanticRetrievalService
from mailpilot_ai.retrieval.router import get_embedding_provider, get_vector_store
from mailpilot_ai.retrieval.service import HybridRetrievalService
from mailpilot_ai.vector_store import (
    KeywordNeighbor,
    NearestNeighbor,
    RetrievalFilters,
    SourceReference,
    VectorStoreError,
)


class FakeEmbeddingProvider:
    def __init__(self, result: EmbeddingResult) -> None:
        self.result = result
        self.calls: list[tuple[str, ...]] = []

    async def embed(self, texts: Sequence[str]) -> EmbeddingResult:
        self.calls.append(tuple(texts))
        return self.result

    async def aclose(self) -> None:
        return None


class FakeVectorStore:
    def __init__(
        self,
        neighbors: tuple[NearestNeighbor, ...],
        *,
        keyword_matches: tuple[KeywordNeighbor, ...] = (),
    ) -> None:
        self.neighbors = neighbors
        self.keyword_matches = keyword_matches
        self.query: dict[str, object] | None = None
        self.keyword_query: dict[str, object] | None = None

    async def nearest_neighbors(
        self,
        *,
        user_id: UUID,
        model_version: str,
        query_vector: Sequence[float],
        limit: int,
        filters: RetrievalFilters | None,
        query_provider: str | None,
    ) -> tuple[NearestNeighbor, ...]:
        self.query = {
            "user_id": user_id,
            "model_version": model_version,
            "query_vector": tuple(query_vector),
            "limit": limit,
            "filters": filters,
            "query_provider": query_provider,
        }
        return self.neighbors

    async def keyword_neighbors(
        self,
        *,
        user_id: UUID,
        query: str,
        limit: int,
        filters: RetrievalFilters | None,
    ) -> tuple[KeywordNeighbor, ...]:
        self.keyword_query = {
            "user_id": user_id,
            "query": query,
            "limit": limit,
            "filters": filters,
        }
        return self.keyword_matches


def _embedding_result(vectors: tuple[tuple[float, ...], ...] | None = None) -> EmbeddingResult:
    return EmbeddingResult(
        provider="openai",
        model_version="text-embedding-3-small-2026-11-01",
        dimensions=1_536,
        vectors=vectors if vectors is not None else ((1.0,) + (0.0,) * 1_535,),
        usage=EmbeddingUsage(input_tokens=3, total_tokens=3),
    )


def _neighbor(user_id: UUID) -> NearestNeighbor:
    return NearestNeighbor(
        user_id=user_id,
        chunk_id=uuid4(),
        email_id=uuid4(),
        provider_message_id="gmail-message-1",
        provider_thread_id="gmail-thread-1",
        source_revision=2,
        chunker_version="email-char-chunker-v1",
        start_char=0,
        end_char=17,
        content="Planning meeting.",
        content_hash="a" * 64,
        received_at=datetime(2026, 11, 12, tzinfo=UTC),
        sender_name="Avery Sender",
        sender_email="avery@example.test",
        subject="Planning meeting",
        provider="openai",
        model="text-embedding-3-small",
        model_version="text-embedding-3-small-2026-11-01",
        embedding_version="b" * 64,
        dimensions=1_536,
        cosine_distance=0.04,
    )


def _keyword_neighbor(source: NearestNeighbor, *, score: float) -> KeywordNeighbor:
    shared_fields = SourceReference.model_validate(
        source.model_dump(
            exclude={
                "provider",
                "model",
                "model_version",
                "embedding_version",
                "dimensions",
                "cosine_distance",
            }
        )
    ).model_dump()
    return KeywordNeighbor.model_validate({**shared_fields, "keyword_score": score})


@pytest.mark.anyio
async def test_retrieval_embeds_query_and_returns_scoped_source_references() -> None:
    user_id = uuid4()
    query_vector = (0.5, 0.5) + (0.0,) * 1_534
    provider = FakeEmbeddingProvider(_embedding_result((query_vector,)))
    source = _neighbor(user_id)
    store = FakeVectorStore((source,))
    service = SemanticRetrievalService(embedding_provider=provider, vector_store=store)
    filters = RetrievalFilters(
        provider_thread_id="gmail-thread-1",
        sender_email=" AVERY@EXAMPLE.TEST ",
    )

    results = await service.retrieve(
        user_id=user_id,
        query="planning meeting",
        limit=3,
        filters=filters,
    )

    assert provider.calls == [("planning meeting",)]
    assert results == (source,)
    assert store.query == {
        "user_id": user_id,
        "model_version": "text-embedding-3-small-2026-11-01",
        "query_vector": query_vector,
        "limit": 3,
        "filters": filters,
        "query_provider": "openai",
    }
    assert results[0].provider_message_id == "gmail-message-1"
    assert results[0].provider_thread_id == "gmail-thread-1"
    assert results[0].subject == "Planning meeting"


@pytest.mark.anyio
async def test_retrieval_returns_empty_store_result_without_rewriting_it() -> None:
    user_id = uuid4()
    provider = FakeEmbeddingProvider(_embedding_result())
    store = FakeVectorStore(())
    service = SemanticRetrievalService(embedding_provider=provider, vector_store=store)

    assert await service.retrieve(user_id=user_id, query="nothing indexed yet") == ()
    assert store.query is not None
    assert store.query["user_id"] == user_id


@pytest.mark.anyio
async def test_retrieval_rejects_blank_queries_before_embedding() -> None:
    provider = FakeEmbeddingProvider(_embedding_result())
    store = FakeVectorStore(())
    service = SemanticRetrievalService(embedding_provider=provider, vector_store=store)

    with pytest.raises(VectorStoreError) as raised:
        await service.retrieve(user_id=uuid4(), query=" \n ")

    assert raised.value.code == "EMBEDDING_QUERY_INVALID"
    assert provider.calls == []
    assert store.query is None


@pytest.mark.anyio
async def test_retrieval_rejects_embedding_batch_with_wrong_result_count() -> None:
    provider = FakeEmbeddingProvider(_embedding_result(()))
    store = FakeVectorStore(())
    service = SemanticRetrievalService(embedding_provider=provider, vector_store=store)

    with pytest.raises(VectorStoreError) as raised:
        await service.retrieve(user_id=uuid4(), query="planning meeting")

    assert raised.value.code == "EMBEDDING_QUERY_RESULT_INVALID"
    assert store.query is None


@pytest.mark.anyio
async def test_hybrid_search_fuses_exact_reference_and_semantic_paraphrase_candidates() -> None:
    user_id = uuid4()
    semantic_content = "The bill should be settled by November 14."
    exact_content = "Jordan Lee invoice INV-2026-1042 due 2026-11-14 PO-77881."
    semantic_match = _neighbor(user_id).model_copy(
        update={"content": semantic_content, "end_char": len(semantic_content)}
    )
    exact_match = _neighbor(user_id).model_copy(
        update={"content": exact_content, "end_char": len(exact_content)}
    )
    keyword_match = _keyword_neighbor(exact_match, score=0.8)
    provider = FakeEmbeddingProvider(_embedding_result())
    store = FakeVectorStore((semantic_match, exact_match), keyword_matches=(keyword_match,))
    service = HybridRetrievalService(embedding_provider=provider, search_store=store)

    results = await service.retrieve(
        user_id=user_id,
        query="When does Jordan expect the bill to be paid?",
        limit=2,
    )

    assert len(results) == 2
    assert results[0].chunk_id == exact_match.chunk_id
    assert results[0].vector_rank == 2
    assert results[0].keyword_rank == 1
    assert results[0].fusion_score == pytest.approx((1 / 62) + (1 / 61))
    assert results[1].chunk_id == semantic_match.chunk_id
    assert results[1].vector_rank == 1
    assert results[1].keyword_rank is None
    assert results[1].fusion_score == pytest.approx(1 / 61)


@pytest.mark.anyio
async def test_hybrid_search_returns_empty_when_both_retrievers_find_nothing() -> None:
    user_id = uuid4()
    provider = FakeEmbeddingProvider(_embedding_result())
    store = FakeVectorStore(())
    service = HybridRetrievalService(embedding_provider=provider, search_store=store)

    assert await service.retrieve(user_id=user_id, query="unrelated query") == ()


@pytest.mark.anyio
async def test_hybrid_search_rejects_candidates_from_a_different_user() -> None:
    provider = FakeEmbeddingProvider(_embedding_result())
    store = FakeVectorStore((_neighbor(uuid4()),))
    service = HybridRetrievalService(embedding_provider=provider, search_store=store)

    with pytest.raises(VectorStoreError) as raised:
        await service.retrieve(user_id=uuid4(), query="cross user probe")

    assert raised.value.code == "RETRIEVAL_OWNER_MISMATCH"


@pytest.mark.anyio
async def test_internal_retrieval_route_returns_source_references() -> None:
    user_id = uuid4()
    provider = FakeEmbeddingProvider(_embedding_result())
    source = _neighbor(user_id)
    keyword_match = _keyword_neighbor(source, score=0.5)
    store = FakeVectorStore((source,), keyword_matches=(keyword_match,))
    app.dependency_overrides[get_embedding_provider] = lambda: provider
    app.dependency_overrides[get_vector_store] = lambda: store  # type: ignore[assignment]
    app.dependency_overrides[require_internal_service_signature] = lambda: None
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                "/internal/v1/retrieval/",
                json={
                    "userId": str(user_id),
                    "query": "planning meeting",
                    "topK": 1,
                    "filters": {"providerThreadId": "gmail-thread-1"},
                },
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    result = response.json()["results"][0]
    assert result["providerMessageId"] == "gmail-message-1"
    assert result["providerThreadId"] == "gmail-thread-1"
    assert result["subject"] == "Planning meeting"
    assert result["vectorRank"] == 1
    assert result["keywordRank"] == 1
    assert result["fusionScore"] == pytest.approx(2 / 61)
    assert store.query is not None
    assert store.query["user_id"] == user_id
