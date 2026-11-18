import asyncio
from collections.abc import Sequence
from dataclasses import dataclass
from math import inf
from typing import Protocol
from uuid import UUID

from mailpilot_ai.embeddings import EmbeddingProvider
from mailpilot_ai.vector_store import (
    HybridSearchResult,
    KeywordNeighbor,
    NearestNeighbor,
    RetrievalFilters,
    SourceReference,
    VectorStoreError,
)

RRF_RANK_CONSTANT = 60
MAX_RETRIEVAL_LIMIT = 100


class NearestNeighborStore(Protocol):
    async def nearest_neighbors(
        self,
        *,
        user_id: UUID,
        model_version: str,
        query_vector: Sequence[float],
        limit: int,
        filters: RetrievalFilters | None,
        query_provider: str | None,
    ) -> tuple[NearestNeighbor, ...]: ...


class HybridSearchStore(NearestNeighborStore, Protocol):
    async def keyword_neighbors(
        self,
        *,
        user_id: UUID,
        query: str,
        limit: int,
        filters: RetrievalFilters | None,
    ) -> tuple[KeywordNeighbor, ...]: ...


@dataclass(slots=True)
class _RankedCandidate:
    source: SourceReference
    vector_rank: int | None = None
    keyword_rank: int | None = None


def _canonical_source(source: SourceReference) -> SourceReference:
    return SourceReference.model_validate(
        source.model_dump(include=set(SourceReference.model_fields))
    )


class SemanticRetrievalService:
    """Embed a search query and return owner-scoped pgvector source references."""

    def __init__(
        self,
        *,
        embedding_provider: EmbeddingProvider,
        vector_store: NearestNeighborStore,
    ) -> None:
        self._embedding_provider = embedding_provider
        self._vector_store = vector_store

    async def retrieve(
        self,
        *,
        user_id: UUID,
        query: str,
        limit: int = 10,
        filters: RetrievalFilters | None = None,
    ) -> tuple[NearestNeighbor, ...]:
        if not query.strip():
            raise VectorStoreError("EMBEDDING_QUERY_INVALID", "The retrieval query cannot be blank")

        result = await self._embedding_provider.embed([query])
        if len(result.vectors) != 1:
            raise VectorStoreError(
                "EMBEDDING_QUERY_RESULT_INVALID",
                "The query embedding provider must return exactly one vector",
            )
        return await self._vector_store.nearest_neighbors(
            user_id=user_id,
            model_version=result.model_version,
            query_vector=result.vectors[0],
            limit=limit,
            filters=filters,
            query_provider=result.provider,
        )


class HybridRetrievalService:
    """Combine vector and PostgreSQL full-text ranks with Reciprocal Rank Fusion."""

    def __init__(
        self,
        *,
        embedding_provider: EmbeddingProvider,
        search_store: HybridSearchStore,
    ) -> None:
        self._embedding_provider = embedding_provider
        self._search_store = search_store

    async def retrieve(
        self,
        *,
        user_id: UUID,
        query: str,
        limit: int = 10,
        filters: RetrievalFilters | None = None,
    ) -> tuple[HybridSearchResult, ...]:
        if not query.strip():
            raise VectorStoreError("EMBEDDING_QUERY_INVALID", "The retrieval query cannot be blank")
        if limit < 1 or limit > MAX_RETRIEVAL_LIMIT:
            raise VectorStoreError(
                "EMBEDDING_QUERY_LIMIT_INVALID",
                f"Retrieval limit must be between 1 and {MAX_RETRIEVAL_LIMIT}",
            )

        embedding_result = await self._embedding_provider.embed([query])
        if len(embedding_result.vectors) != 1:
            raise VectorStoreError(
                "EMBEDDING_QUERY_RESULT_INVALID",
                "The query embedding provider must return exactly one vector",
            )

        candidate_limit = min(MAX_RETRIEVAL_LIMIT, limit * 4)
        vector_results, keyword_results = await asyncio.gather(
            self._search_store.nearest_neighbors(
                user_id=user_id,
                model_version=embedding_result.model_version,
                query_vector=embedding_result.vectors[0],
                limit=candidate_limit,
                filters=filters,
                query_provider=embedding_result.provider,
            ),
            self._search_store.keyword_neighbors(
                user_id=user_id,
                query=query,
                limit=candidate_limit,
                filters=filters,
            ),
        )

        ranked: dict[tuple[UUID, UUID], _RankedCandidate] = {}
        for rank, candidate in enumerate(vector_results, start=1):
            if candidate.user_id != user_id:
                raise VectorStoreError(
                    "RETRIEVAL_OWNER_MISMATCH",
                    "A retrieval candidate does not belong to the requested user",
                )
            key = (candidate.user_id, candidate.chunk_id)
            current = ranked.get(key)
            if current is None:
                current = _RankedCandidate(source=_canonical_source(candidate))
                ranked[key] = current
            if current.vector_rank is None:
                current.vector_rank = rank

        for rank, keyword_candidate in enumerate(keyword_results, start=1):
            if keyword_candidate.user_id != user_id:
                raise VectorStoreError(
                    "RETRIEVAL_OWNER_MISMATCH",
                    "A retrieval candidate does not belong to the requested user",
                )
            key = (keyword_candidate.user_id, keyword_candidate.chunk_id)
            current = ranked.get(key)
            if current is None:
                current = _RankedCandidate(source=_canonical_source(keyword_candidate))
                ranked[key] = current
            if current.keyword_rank is None:
                current.keyword_rank = rank

        def fusion_score(candidate: _RankedCandidate) -> float:
            score = 0.0
            if candidate.vector_rank is not None:
                score += 1.0 / (RRF_RANK_CONSTANT + candidate.vector_rank)
            if candidate.keyword_rank is not None:
                score += 1.0 / (RRF_RANK_CONSTANT + candidate.keyword_rank)
            return score

        ordered = sorted(
            ranked.values(),
            key=lambda candidate: (
                -fusion_score(candidate),
                min(
                    candidate.vector_rank if candidate.vector_rank is not None else inf,
                    candidate.keyword_rank if candidate.keyword_rank is not None else inf,
                ),
                str(candidate.source.chunk_id),
            ),
        )
        return tuple(
            HybridSearchResult.model_validate(
                {
                    **candidate.source.model_dump(),
                    "vector_rank": candidate.vector_rank,
                    "keyword_rank": candidate.keyword_rank,
                    "fusion_score": fusion_score(candidate),
                }
            )
            for candidate in ordered[:limit]
        )
