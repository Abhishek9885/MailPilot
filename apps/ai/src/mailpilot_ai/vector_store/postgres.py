import hashlib
import json
import math
from collections.abc import Sequence
from uuid import UUID

import psycopg
from psycopg import AsyncConnection, AsyncCursor

from mailpilot_ai.database import psycopg_connection_url
from mailpilot_ai.embeddings.contracts import EmbeddingResult
from mailpilot_ai.vector_store.errors import VectorStoreError
from mailpilot_ai.vector_store.models import (
    KeywordNeighbor,
    NearestNeighbor,
    RetrievalFilters,
    VectorStoreChunkRef,
)

STORAGE_DIMENSIONS = 1_536
MAX_NEIGHBOR_LIMIT = 100


def embedding_version_key(*, provider: str, model: str, model_version: str, dimensions: int) -> str:
    identity = json.dumps(
        [provider, model, model_version, dimensions],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


class PostgresEmbeddingStore:
    """Owner-scoped pgvector persistence against the canonical Prisma email chunks."""

    def __init__(
        self,
        database_url: str,
        *,
        model: str,
        provider: str = "openai",
        dimensions: int = STORAGE_DIMENSIONS,
        connect_timeout_seconds: int = 5,
    ) -> None:
        if dimensions != STORAGE_DIMENSIONS:
            raise VectorStoreError(
                "EMBEDDING_INDEX_DIMENSIONS_UNSUPPORTED",
                "The current pgvector index supports 1536 dimensions",
            )
        self._database_url = psycopg_connection_url(database_url)
        self._model = model
        self._provider = provider
        self._dimensions = dimensions
        self._connect_timeout_seconds = connect_timeout_seconds

    async def upsert_embeddings(
        self,
        *,
        user_id: UUID,
        chunks: Sequence[VectorStoreChunkRef],
        embeddings: EmbeddingResult,
    ) -> int:
        if not chunks and not embeddings.vectors:
            return 0
        if len(chunks) != len(embeddings.vectors):
            raise VectorStoreError(
                "EMBEDDING_BATCH_SHAPE_INVALID",
                "The vector count does not match the source chunk count",
            )
        if any(chunk.user_id != user_id for chunk in chunks):
            raise VectorStoreError(
                "EMBEDDING_OWNER_MISMATCH",
                "Every chunk must belong to the requested user",
            )
        chunk_ids = [chunk.chunk_id for chunk in chunks]
        if len(chunk_ids) != len(set(chunk_ids)):
            raise VectorStoreError(
                "EMBEDDING_BATCH_DUPLICATE_CHUNK",
                "A chunk may occur only once in an embedding batch",
            )
        self._validate_embedding_result(embeddings)
        version_key = embedding_version_key(
            provider=embeddings.provider,
            model=self._model,
            model_version=embeddings.model_version,
            dimensions=embeddings.dimensions,
        )

        try:
            async with await AsyncConnection.connect(  # noqa: SIM117
                self._database_url, connect_timeout=self._connect_timeout_seconds
            ) as connection:
                async with connection.transaction():  # noqa: SIM117
                    async with connection.cursor() as cursor:
                        await self._set_owner(cursor, user_id)
                        await cursor.execute(
                            """
                            SELECT c.id, c.source_revision, c.chunker_version, c.content_hash
                            FROM app.email_chunks AS c
                            JOIN app.emails AS e
                              ON e.id = c.email_id AND e.user_id = c.user_id
                            WHERE c.user_id = %s
                              AND c.id = ANY(%s::UUID[])
                              AND c.status = 'active'
                              AND c.deleted_at IS NULL
                              AND e.deleted_at IS NULL
                              AND e.source_revision = c.source_revision
                            FOR KEY SHARE OF c, e
                            """,
                            (user_id, chunk_ids),
                        )
                        source_rows = await cursor.fetchall()
                        stored_sources = {
                            row[0]: (int(row[1]), str(row[2]), str(row[3]).strip())
                            for row in source_rows
                        }
                        for chunk in chunks:
                            stored = stored_sources.get(chunk.chunk_id)
                            expected = (
                                chunk.source_revision,
                                chunk.chunker_version,
                                chunk.content_hash,
                            )
                            if stored != expected:
                                raise VectorStoreError(
                                    "EMBEDDING_SOURCE_STALE_OR_UNAVAILABLE",
                                    "A source chunk is missing, stale, inactive, "
                                    "or owned by another user",
                                )

                        for chunk, vector in zip(chunks, embeddings.vectors, strict=True):
                            vector_text = _serialize_vector(vector, self._dimensions)
                            await cursor.execute(
                                """
                                INSERT INTO ai.chunk_embeddings_1536 AS stored (
                                    user_id, chunk_id, source_revision, chunker_version,
                                    content_hash, provider, model, model_version,
                                    embedding_version, dimensions, embedding
                                )
                                SELECT c.user_id, c.id, c.source_revision, c.chunker_version,
                                       c.content_hash, %s, %s, %s, %s, %s,
                                       %s::public.vector(1536)
                                FROM app.email_chunks AS c
                                JOIN app.emails AS e
                                  ON e.id = c.email_id AND e.user_id = c.user_id
                                WHERE c.user_id = %s
                                  AND c.id = %s
                                  AND c.source_revision = %s
                                  AND c.chunker_version = %s
                                  AND c.content_hash = %s
                                  AND c.status = 'active'
                                  AND c.deleted_at IS NULL
                                  AND e.deleted_at IS NULL
                                  AND e.source_revision = c.source_revision
                                ON CONFLICT (user_id, chunk_id, embedding_version)
                                DO UPDATE SET
                                    source_revision = EXCLUDED.source_revision,
                                    chunker_version = EXCLUDED.chunker_version,
                                    content_hash = EXCLUDED.content_hash,
                                    provider = EXCLUDED.provider,
                                    model = EXCLUDED.model,
                                    model_version = EXCLUDED.model_version,
                                    dimensions = EXCLUDED.dimensions,
                                    embedding = EXCLUDED.embedding,
                                    updated_at = CURRENT_TIMESTAMP
                                WHERE stored.source_revision <= EXCLUDED.source_revision
                                RETURNING 1
                                """,
                                (
                                    embeddings.provider,
                                    self._model,
                                    embeddings.model_version,
                                    version_key,
                                    self._dimensions,
                                    vector_text,
                                    user_id,
                                    chunk.chunk_id,
                                    chunk.source_revision,
                                    chunk.chunker_version,
                                    chunk.content_hash,
                                ),
                            )
                            if await cursor.fetchone() is None:
                                raise VectorStoreError(
                                    "EMBEDDING_SOURCE_STALE_OR_UNAVAILABLE",
                                    "A source chunk changed while its vector was being stored",
                                )
            return len(chunks)
        except VectorStoreError:
            raise
        except psycopg.Error:
            raise VectorStoreError(
                "EMBEDDING_STORAGE_UNAVAILABLE",
                "The embedding database operation failed",
            ) from None

    async def nearest_neighbors(
        self,
        *,
        user_id: UUID,
        model_version: str,
        query_vector: Sequence[float],
        limit: int = 10,
        filters: RetrievalFilters | None = None,
        query_provider: str | None = None,
    ) -> tuple[NearestNeighbor, ...]:
        if limit < 1 or limit > MAX_NEIGHBOR_LIMIT:
            raise VectorStoreError(
                "EMBEDDING_QUERY_LIMIT_INVALID",
                f"Nearest-neighbor limit must be between 1 and {MAX_NEIGHBOR_LIMIT}",
            )
        vector_text = _serialize_vector(query_vector, self._dimensions)
        active_filters = filters or RetrievalFilters()
        if query_provider is not None and query_provider != self._provider:
            raise VectorStoreError(
                "EMBEDDING_PROVIDER_MISMATCH",
                "The query embedding provider does not match the configured vector store",
            )
        version_key = embedding_version_key(
            provider=self._provider,
            model=self._model,
            model_version=model_version,
            dimensions=self._dimensions,
        )

        try:
            async with (
                await AsyncConnection.connect(
                    self._database_url, connect_timeout=self._connect_timeout_seconds
                ) as connection,
                connection.transaction(),
                connection.cursor() as cursor,
            ):
                await self._set_owner(cursor, user_id)
                await cursor.execute("SET LOCAL hnsw.iterative_scan = 'strict_order'")
                await cursor.execute(
                    "SELECT set_config('hnsw.ef_search', %s, true)",
                    (str(min(1_000, max(100, limit * 10))),),
                )
                await cursor.execute(
                    """
                            SELECT x.user_id, x.chunk_id, c.email_id,
                                   e.provider_message_id, e.provider_thread_id,
                                   c.source_revision, c.chunker_version,
                                   c.start_char, c.end_char, c.content, c.content_hash,
                                   e.received_at, e.sender_name, e.sender_email_normalized,
                                   e.subject, x.provider, x.model, x.model_version,
                                   x.embedding_version, x.dimensions,
                                   x.embedding <=> %s::public.vector(1536) AS cosine_distance
                            FROM ai.chunk_embeddings_1536 AS x
                            JOIN app.email_chunks AS c
                              ON c.id = x.chunk_id AND c.user_id = x.user_id
                            JOIN app.emails AS e
                              ON e.id = c.email_id AND e.user_id = c.user_id
                            WHERE x.user_id = %s
                              AND x.embedding_version = %s
                              AND c.status = 'active'
                              AND c.deleted_at IS NULL
                              AND c.source_revision = x.source_revision
                              AND c.chunker_version = x.chunker_version
                              AND c.content_hash = x.content_hash
                              AND e.deleted_at IS NULL
                              AND e.source_revision = c.source_revision
                              AND (%s::UUID IS NULL OR e.id = %s::UUID)
                              AND (%s::TEXT IS NULL OR e.provider_message_id = %s::TEXT)
                              AND (%s::TEXT IS NULL OR e.provider_thread_id = %s::TEXT)
                              AND (%s::TEXT IS NULL OR e.sender_email_normalized = %s::TEXT)
                              AND (%s::TIMESTAMPTZ IS NULL OR e.received_at >= %s::TIMESTAMPTZ)
                              AND (%s::TIMESTAMPTZ IS NULL OR e.received_at <= %s::TIMESTAMPTZ)
                            ORDER BY x.embedding <=> %s::public.vector(1536)
                            LIMIT %s
                            """,
                    (
                        vector_text,
                        user_id,
                        version_key,
                        active_filters.email_id,
                        active_filters.email_id,
                        active_filters.provider_message_id,
                        active_filters.provider_message_id,
                        active_filters.provider_thread_id,
                        active_filters.provider_thread_id,
                        active_filters.sender_email,
                        active_filters.sender_email,
                        active_filters.received_after,
                        active_filters.received_after,
                        active_filters.received_before,
                        active_filters.received_before,
                        vector_text,
                        limit,
                    ),
                )
                rows = await cursor.fetchall()
            return tuple(
                NearestNeighbor.model_validate(
                    {
                        **_source_values(row),
                        "provider": row[15],
                        "model": row[16],
                        "model_version": row[17],
                        "embedding_version": str(row[18]).strip(),
                        "dimensions": row[19],
                        "cosine_distance": row[20],
                    }
                )
                for row in rows
            )
        except VectorStoreError:
            raise
        except psycopg.Error:
            raise VectorStoreError(
                "EMBEDDING_QUERY_UNAVAILABLE",
                "The nearest-neighbor database query failed",
            ) from None

    async def keyword_neighbors(
        self,
        *,
        user_id: UUID,
        query: str,
        limit: int = 10,
        filters: RetrievalFilters | None = None,
    ) -> tuple[KeywordNeighbor, ...]:
        """Return owner-scoped full-text matches ranked with PostgreSQL ts_rank_cd."""
        if limit < 1 or limit > MAX_NEIGHBOR_LIMIT:
            raise VectorStoreError(
                "EMBEDDING_QUERY_LIMIT_INVALID",
                f"Keyword-search limit must be between 1 and {MAX_NEIGHBOR_LIMIT}",
            )
        if not query.strip():
            raise VectorStoreError("EMBEDDING_QUERY_INVALID", "The retrieval query cannot be blank")
        active_filters = filters or RetrievalFilters()

        try:
            async with (
                await AsyncConnection.connect(
                    self._database_url, connect_timeout=self._connect_timeout_seconds
                ) as connection,
                connection.transaction(),
                connection.cursor() as cursor,
            ):
                await self._set_owner(cursor, user_id)
                await cursor.execute(
                    """
                    WITH search_query AS (
                        SELECT websearch_to_tsquery('simple', %s) AS terms,
                               %s::TEXT AS raw_query
                    ), source_documents AS (
                        SELECT c.user_id, c.id AS chunk_id, c.email_id,
                               e.provider_message_id, e.provider_thread_id,
                               c.source_revision, c.chunker_version,
                               c.start_char, c.end_char, c.content, c.content_hash,
                               e.received_at, e.sender_name, e.sender_email_normalized,
                               e.subject,
                               setweight(to_tsvector('simple', COALESCE(e.subject, '')), 'A')
                               || setweight(to_tsvector(
                                      'simple',
                                      concat_ws(' ', e.sender_name, e.sender_email_normalized)
                                  ), 'B')
                               || setweight(to_tsvector('simple', c.content), 'C')
                               || setweight(to_tsvector(
                                      'simple',
                                      concat_ws(
                                          ' ', e.provider_message_id, e.provider_thread_id,
                                          to_char(e.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
                                      )
                                  ), 'A') AS search_document,
                               concat_ws(
                                   ' ', e.subject, e.sender_name, e.sender_email_normalized,
                                   c.content, e.provider_message_id, e.provider_thread_id,
                                   to_char(e.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
                               ) AS raw_document
                        FROM app.email_chunks AS c
                        JOIN app.emails AS e
                          ON e.id = c.email_id AND e.user_id = c.user_id
                        WHERE c.user_id = %s
                          AND c.status = 'active'
                          AND c.deleted_at IS NULL
                          AND c.source_revision = e.source_revision
                          AND e.deleted_at IS NULL
                          AND (%s::UUID IS NULL OR e.id = %s::UUID)
                          AND (%s::TEXT IS NULL OR e.provider_message_id = %s::TEXT)
                          AND (%s::TEXT IS NULL OR e.provider_thread_id = %s::TEXT)
                          AND (%s::TEXT IS NULL OR e.sender_email_normalized = %s::TEXT)
                          AND (%s::TIMESTAMPTZ IS NULL OR e.received_at >= %s::TIMESTAMPTZ)
                          AND (%s::TIMESTAMPTZ IS NULL OR e.received_at <= %s::TIMESTAMPTZ)
                    ), ranked_matches AS (
                        SELECT d.*,
                               ts_rank_cd(d.search_document, q.terms)
                               + CASE WHEN position(
                                   lower(q.raw_query) IN lower(d.raw_document)
                                 ) > 0 THEN 1.0 ELSE 0.0 END AS keyword_score
                        FROM source_documents AS d
                        CROSS JOIN search_query AS q
                        WHERE (numnode(q.terms) > 0 AND d.search_document @@ q.terms)
                           OR position(lower(q.raw_query) IN lower(d.raw_document)) > 0
                    )
                    SELECT user_id, chunk_id, email_id, provider_message_id, provider_thread_id,
                           source_revision, chunker_version, start_char, end_char, content,
                           content_hash, received_at, sender_name, sender_email_normalized,
                           subject, keyword_score
                    FROM ranked_matches
                    ORDER BY keyword_score DESC, received_at DESC, chunk_id
                    LIMIT %s
                    """,
                    (
                        query,
                        query,
                        user_id,
                        active_filters.email_id,
                        active_filters.email_id,
                        active_filters.provider_message_id,
                        active_filters.provider_message_id,
                        active_filters.provider_thread_id,
                        active_filters.provider_thread_id,
                        active_filters.sender_email,
                        active_filters.sender_email,
                        active_filters.received_after,
                        active_filters.received_after,
                        active_filters.received_before,
                        active_filters.received_before,
                        limit,
                    ),
                )
                rows = await cursor.fetchall()
            return tuple(
                KeywordNeighbor.model_validate(
                    {**_source_values(row), "keyword_score": float(row[15])}
                )
                for row in rows
            )
        except VectorStoreError:
            raise
        except psycopg.Error:
            raise VectorStoreError(
                "KEYWORD_QUERY_UNAVAILABLE",
                "The full-text database query failed",
            ) from None

    async def delete_chunk_embeddings(self, *, user_id: UUID, chunk_id: UUID) -> int:
        try:
            async with (
                await AsyncConnection.connect(
                    self._database_url, connect_timeout=self._connect_timeout_seconds
                ) as connection,
                connection.transaction(),
                connection.cursor() as cursor,
            ):
                await self._set_owner(cursor, user_id)
                await cursor.execute(
                    "DELETE FROM ai.chunk_embeddings_1536 WHERE user_id = %s AND chunk_id = %s",
                    (user_id, chunk_id),
                )
                return cursor.rowcount
        except psycopg.Error:
            raise VectorStoreError(
                "EMBEDDING_DELETE_UNAVAILABLE",
                "The embedding deletion failed",
            ) from None

    async def existing_embedding_versions(
        self,
        *,
        user_id: UUID,
        chunks: Sequence[VectorStoreChunkRef],
    ) -> dict[UUID, str]:
        """Return current vectors for the configured provider/model and exact source chunks."""
        if not chunks:
            return {}
        if any(chunk.user_id != user_id for chunk in chunks):
            raise VectorStoreError(
                "EMBEDDING_OWNER_MISMATCH",
                "Every chunk must belong to the requested user",
            )
        try:
            async with (
                await AsyncConnection.connect(
                    self._database_url, connect_timeout=self._connect_timeout_seconds
                ) as connection,
                connection.transaction(),
                connection.cursor() as cursor,
            ):
                await self._set_owner(cursor, user_id)
                await cursor.execute(
                    """
                    SELECT DISTINCT ON (x.chunk_id) x.chunk_id, x.model_version
                    FROM ai.chunk_embeddings_1536 AS x
                    JOIN app.email_chunks AS c
                      ON c.id = x.chunk_id AND c.user_id = x.user_id
                    JOIN app.emails AS e
                      ON e.id = c.email_id AND e.user_id = c.user_id
                    WHERE x.user_id = %s
                      AND x.chunk_id = ANY(%s::UUID[])
                      AND x.provider = %s
                      AND x.model = %s
                      AND x.source_revision = c.source_revision
                      AND x.chunker_version = c.chunker_version
                      AND x.content_hash = c.content_hash
                      AND c.status = 'active'
                      AND c.deleted_at IS NULL
                      AND e.deleted_at IS NULL
                      AND e.source_revision = c.source_revision
                    ORDER BY x.chunk_id, x.updated_at DESC
                    """,
                    (user_id, [chunk.chunk_id for chunk in chunks], self._provider, self._model),
                )
                return {row[0]: str(row[1]) for row in await cursor.fetchall()}
        except VectorStoreError:
            raise
        except psycopg.Error:
            raise VectorStoreError(
                "EMBEDDING_QUERY_UNAVAILABLE",
                "The current embedding versions could not be read",
            ) from None

    async def delete_obsolete_email_embeddings(
        self,
        *,
        user_id: UUID,
        email_id: UUID,
        source_revision: int,
        chunker_version: str,
        current_chunk_ids: Sequence[UUID],
    ) -> int:
        """Remove stale source/chunker vectors while retaining valid model versions."""
        try:
            async with (
                await AsyncConnection.connect(
                    self._database_url, connect_timeout=self._connect_timeout_seconds
                ) as connection,
                connection.transaction(),
                connection.cursor() as cursor,
            ):
                await self._set_owner(cursor, user_id)
                await cursor.execute(
                    """
                    DELETE FROM ai.chunk_embeddings_1536 AS x
                    USING app.email_chunks AS c
                    WHERE x.user_id = %s
                      AND c.user_id = x.user_id
                      AND c.id = x.chunk_id
                      AND c.email_id = %s
                      AND (
                          c.status <> 'active'
                          OR c.deleted_at IS NOT NULL
                          OR c.source_revision <> %s
                          OR c.chunker_version <> %s
                          OR x.source_revision <> c.source_revision
                          OR x.chunker_version <> c.chunker_version
                          OR x.content_hash <> c.content_hash
                          OR NOT (c.id = ANY(%s::UUID[]))
                      )
                    """,
                    (user_id, email_id, source_revision, chunker_version, list(current_chunk_ids)),
                )
                return cursor.rowcount
        except psycopg.Error:
            raise VectorStoreError(
                "EMBEDDING_DELETE_UNAVAILABLE",
                "Stale email embeddings could not be deleted",
            ) from None

    async def delete_email_embeddings(self, *, user_id: UUID, email_id: UUID) -> int:
        try:
            async with (
                await AsyncConnection.connect(
                    self._database_url, connect_timeout=self._connect_timeout_seconds
                ) as connection,
                connection.transaction(),
                connection.cursor() as cursor,
            ):
                await self._set_owner(cursor, user_id)
                await cursor.execute(
                    """
                    DELETE FROM ai.chunk_embeddings_1536 AS x
                    USING app.email_chunks AS c
                    WHERE x.user_id = %s
                      AND c.user_id = x.user_id
                      AND c.id = x.chunk_id
                      AND c.email_id = %s
                    """,
                    (user_id, email_id),
                )
                return cursor.rowcount
        except psycopg.Error:
            raise VectorStoreError(
                "EMBEDDING_DELETE_UNAVAILABLE",
                "The email embeddings could not be deleted",
            ) from None

    async def delete_user_embeddings(self, *, user_id: UUID) -> int:
        try:
            async with (
                await AsyncConnection.connect(
                    self._database_url, connect_timeout=self._connect_timeout_seconds
                ) as connection,
                connection.transaction(),
                connection.cursor() as cursor,
            ):
                await self._set_owner(cursor, user_id)
                await cursor.execute(
                    "DELETE FROM ai.chunk_embeddings_1536 WHERE user_id = %s",
                    (user_id,),
                )
                return cursor.rowcount
        except psycopg.Error:
            raise VectorStoreError(
                "EMBEDDING_DELETE_UNAVAILABLE",
                "The embedding deletion failed",
            ) from None

    def _validate_embedding_result(self, result: EmbeddingResult) -> None:
        if result.provider != self._provider:
            raise VectorStoreError(
                "EMBEDDING_PROVIDER_MISMATCH",
                "The embedding provider does not match the configured vector store",
            )
        if result.dimensions != self._dimensions:
            raise VectorStoreError(
                "EMBEDDING_INDEX_DIMENSIONS_UNSUPPORTED",
                "The embedding dimensions do not match the active pgvector index",
            )
        for vector in result.vectors:
            _serialize_vector(vector, self._dimensions)

    async def _set_owner(self, cursor: AsyncCursor[tuple[object, ...]], user_id: UUID) -> None:
        await cursor.execute("SET LOCAL search_path = public, pg_catalog")
        await cursor.execute("SELECT set_config('mailpilot.user_id', %s, true)", (str(user_id),))


def _serialize_vector(values: Sequence[float], dimensions: int) -> str:
    if len(values) != dimensions:
        raise VectorStoreError(
            "EMBEDDING_VECTOR_SHAPE_INVALID",
            "The vector dimensions do not match the active pgvector index",
        )
    if any(not math.isfinite(value) for value in values) or not any(values):
        raise VectorStoreError(
            "EMBEDDING_VECTOR_INVALID",
            "The vector must contain finite values and cannot be zero",
        )
    return "[" + ",".join(repr(float(value)) for value in values) + "]"


def _source_values(row: Sequence[object]) -> dict[str, object]:
    return {
        "user_id": row[0],
        "chunk_id": row[1],
        "email_id": row[2],
        "provider_message_id": row[3],
        "provider_thread_id": row[4],
        "source_revision": row[5],
        "chunker_version": row[6],
        "start_char": row[7],
        "end_char": row[8],
        "content": row[9],
        "content_hash": str(row[10]).strip(),
        "received_at": row[11],
        "sender_name": row[12],
        "sender_email": row[13],
        "subject": row[14],
    }
