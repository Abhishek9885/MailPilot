from collections.abc import Sequence
from datetime import timedelta
from uuid import UUID, uuid4

import psycopg
from psycopg import AsyncConnection, AsyncCursor

from mailpilot_ai.chunking import EmailChunk, EmailChunkSource
from mailpilot_ai.database import psycopg_connection_url
from mailpilot_ai.email_indexing.service import ClaimResult
from mailpilot_ai.vector_store.errors import VectorStoreError
from mailpilot_ai.vector_store.models import VectorStoreChunkRef

_JOB_LEASE = timedelta(minutes=10)


class PostgresEmailChunkRepository:
    """DML adapter for Prisma-owned canonical chunks; it never changes app schema."""

    def __init__(self, database_url: str, *, connect_timeout_seconds: int = 5) -> None:
        self._database_url = psycopg_connection_url(database_url)
        self._connect_timeout_seconds = connect_timeout_seconds

    async def replace_email_chunks(
        self,
        *,
        user_id: UUID,
        source: EmailChunkSource,
        chunks: Sequence[EmailChunk],
    ) -> tuple[VectorStoreChunkRef, ...]:
        if source.user_id != user_id or any(chunk.user_id != user_id for chunk in chunks):
            raise VectorStoreError(
                "EMAIL_INDEX_OWNER_MISMATCH", "Email chunks must belong to the requested user"
            )
        if any(
            chunk.email_id != source.email_id or chunk.source_revision != source.source_revision
            for chunk in chunks
        ):
            raise VectorStoreError(
                "EMAIL_INDEX_SOURCE_MISMATCH", "Email chunks do not match their source revision"
            )

        references: list[VectorStoreChunkRef] = []
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
                    SELECT source_revision
                    FROM app.emails
                    WHERE user_id = %s AND id = %s AND deleted_at IS NULL
                    FOR UPDATE
                    """,
                    (user_id, source.email_id),
                )
                email_row = await cursor.fetchone()
                if email_row is None or int(email_row[0]) != source.source_revision:
                    raise VectorStoreError(
                        "EMAIL_INDEX_SOURCE_STALE_OR_UNAVAILABLE",
                        "The current email source revision is unavailable",
                    )
                await cursor.execute(
                    """
                    UPDATE app.email_chunks
                    SET status = 'deleted', deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP)
                    WHERE user_id = %s AND email_id = %s AND status = 'active'
                    """,
                    (user_id, source.email_id),
                )

                for chunk in chunks:
                    await cursor.execute(
                        """
                        INSERT INTO app.email_chunks (
                            id, user_id, email_id, source_revision, chunker_version,
                            ordinal, start_char, end_char, content, content_hash,
                            status, deleted_at
                        )
                        SELECT %s, e.user_id, e.id, %s, %s, %s, %s, %s, %s, %s,
                               'active', NULL
                        FROM app.emails AS e
                        WHERE e.user_id = %s AND e.id = %s
                          AND e.deleted_at IS NULL AND e.source_revision = %s
                        ON CONFLICT (email_id, source_revision, chunker_version, ordinal)
                        DO UPDATE SET
                            start_char = EXCLUDED.start_char,
                            end_char = EXCLUDED.end_char,
                            content = EXCLUDED.content,
                            content_hash = EXCLUDED.content_hash,
                            status = 'active',
                            deleted_at = NULL
                        WHERE app.email_chunks.user_id = EXCLUDED.user_id
                        RETURNING id
                        """,
                        (
                            uuid4(),
                            chunk.source_revision,
                            chunk.chunker_version,
                            chunk.ordinal,
                            chunk.start_char,
                            chunk.end_char,
                            chunk.content,
                            chunk.content_hash,
                            user_id,
                            source.email_id,
                            source.source_revision,
                        ),
                    )
                    row = await cursor.fetchone()
                    if row is None:
                        raise VectorStoreError(
                            "EMAIL_INDEX_SOURCE_STALE_OR_UNAVAILABLE",
                            "The current email source revision changed during indexing",
                        )
                    references.append(
                        VectorStoreChunkRef(
                            user_id=user_id,
                            chunk_id=row[0],
                            source_revision=chunk.source_revision,
                            chunker_version=chunk.chunker_version,
                            content_hash=chunk.content_hash,
                        )
                    )
            return tuple(references)
        except VectorStoreError:
            raise
        except psycopg.Error:
            raise VectorStoreError(
                "EMAIL_CHUNK_STORAGE_UNAVAILABLE", "Email chunks could not be stored"
            ) from None

    async def delete_email_chunks(self, *, user_id: UUID, email_id: UUID) -> int:
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
                    UPDATE app.email_chunks
                    SET status = 'deleted', deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP)
                    WHERE user_id = %s AND email_id = %s AND status <> 'deleted'
                    """,
                    (user_id, email_id),
                )
                return cursor.rowcount
        except psycopg.Error:
            raise VectorStoreError(
                "EMAIL_CHUNK_DELETE_UNAVAILABLE", "Email chunks could not be deleted"
            ) from None

    async def _set_owner(self, cursor: AsyncCursor[tuple[object, ...]], user_id: UUID) -> None:
        await cursor.execute("SET LOCAL search_path = public, pg_catalog")
        await cursor.execute("SELECT set_config('mailpilot.user_id', %s, true)", (str(user_id),))


class PostgresEmailIndexJobStore:
    """Owner-scoped status and safe error metadata in the AI-owned schema."""

    def __init__(self, database_url: str, *, connect_timeout_seconds: int = 5) -> None:
        self._database_url = psycopg_connection_url(database_url)
        self._connect_timeout_seconds = connect_timeout_seconds

    async def claim(
        self,
        *,
        user_id: UUID,
        email_id: UUID,
        source_revision: int,
        chunker_version: str,
        configured_model: str,
    ) -> ClaimResult:
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
                    INSERT INTO ai.email_index_jobs (
                        user_id, email_id, source_revision, chunker_version,
                        configured_model, status, attempt_count, started_at,
                        lease_expires_at, safe_error_code
                    ) VALUES (%s, %s, %s, %s, %s, 'processing', 1, CURRENT_TIMESTAMP,
                              CURRENT_TIMESTAMP + %s, NULL)
                    ON CONFLICT (user_id, email_id, source_revision, chunker_version,
                                 configured_model)
                    DO UPDATE SET
                        status = 'processing',
                        attempt_count = ai.email_index_jobs.attempt_count + 1,
                        started_at = CURRENT_TIMESTAMP,
                        lease_expires_at = CURRENT_TIMESTAMP + %s,
                        completed_at = NULL,
                        safe_error_code = NULL
                    WHERE ai.email_index_jobs.status IN ('failed', 'deleted')
                       OR (ai.email_index_jobs.status = 'processing'
                           AND ai.email_index_jobs.lease_expires_at < CURRENT_TIMESTAMP)
                    RETURNING status
                    """,
                    (
                        user_id,
                        email_id,
                        source_revision,
                        chunker_version,
                        configured_model,
                        _JOB_LEASE,
                        _JOB_LEASE,
                    ),
                )
                row = await cursor.fetchone()
                if row is not None:
                    return "claimed"
                await cursor.execute(
                    """
                    SELECT status FROM ai.email_index_jobs
                    WHERE user_id = %s AND email_id = %s AND source_revision = %s
                      AND chunker_version = %s AND configured_model = %s
                    """,
                    (user_id, email_id, source_revision, chunker_version, configured_model),
                )
                current = await cursor.fetchone()
                return (
                    "completed"
                    if current is not None and current[0] == "completed"
                    else "in_progress"
                )
        except psycopg.Error:
            raise VectorStoreError(
                "EMAIL_INDEX_STATUS_UNAVAILABLE", "Email indexing status could not be updated"
            ) from None

    async def complete(
        self,
        *,
        user_id: UUID,
        email_id: UUID,
        source_revision: int,
        chunker_version: str,
        configured_model: str,
        model_version: str | None,
        chunk_count: int,
        embedded_chunk_count: int,
    ) -> None:
        await self._update_job(
            user_id=user_id,
            email_id=email_id,
            source_revision=source_revision,
            chunker_version=chunker_version,
            configured_model=configured_model,
            status="completed",
            model_version=model_version,
            chunk_count=chunk_count,
            embedded_chunk_count=embedded_chunk_count,
            safe_error_code=None,
        )

    async def fail(
        self,
        *,
        user_id: UUID,
        email_id: UUID,
        source_revision: int,
        chunker_version: str,
        configured_model: str,
        safe_error_code: str,
        chunk_count: int,
    ) -> None:
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
                    INSERT INTO ai.email_index_jobs (
                        user_id, email_id, source_revision, chunker_version,
                        configured_model, status, attempt_count, chunk_count,
                        safe_error_code, started_at, completed_at, lease_expires_at
                    ) VALUES (%s, %s, %s, %s, %s, 'failed', 1, %s, %s,
                              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)
                    ON CONFLICT (user_id, email_id, source_revision, chunker_version,
                                 configured_model)
                    DO UPDATE SET status = 'failed', chunk_count = EXCLUDED.chunk_count,
                        safe_error_code = EXCLUDED.safe_error_code,
                        completed_at = CURRENT_TIMESTAMP, lease_expires_at = NULL
                    """,
                    (
                        user_id,
                        email_id,
                        source_revision,
                        chunker_version,
                        configured_model,
                        chunk_count,
                        safe_error_code,
                    ),
                )
        except psycopg.Error:
            raise VectorStoreError(
                "EMAIL_INDEX_STATUS_UNAVAILABLE", "Email indexing status could not be updated"
            ) from None

    async def mark_deleted(self, *, user_id: UUID, email_id: UUID) -> None:
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
                    UPDATE ai.email_index_jobs SET status = 'deleted',
                        safe_error_code = NULL, completed_at = CURRENT_TIMESTAMP,
                        lease_expires_at = NULL
                    WHERE user_id = %s AND email_id = %s
                    """,
                    (user_id, email_id),
                )
        except psycopg.Error:
            raise VectorStoreError(
                "EMAIL_INDEX_STATUS_UNAVAILABLE", "Email indexing status could not be updated"
            ) from None

    async def _update_job(
        self,
        *,
        user_id: UUID,
        email_id: UUID,
        source_revision: int,
        chunker_version: str,
        configured_model: str,
        status: str,
        model_version: str | None,
        chunk_count: int,
        embedded_chunk_count: int,
        safe_error_code: str | None,
    ) -> None:
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
                    UPDATE ai.email_index_jobs SET status = %s, model_version = %s,
                        chunk_count = %s, embedded_chunk_count = %s,
                        safe_error_code = %s, completed_at = CURRENT_TIMESTAMP,
                        lease_expires_at = NULL
                    WHERE user_id = %s AND email_id = %s AND source_revision = %s
                      AND chunker_version = %s AND configured_model = %s
                    """,
                    (
                        status,
                        model_version,
                        chunk_count,
                        embedded_chunk_count,
                        safe_error_code,
                        user_id,
                        email_id,
                        source_revision,
                        chunker_version,
                        configured_model,
                    ),
                )
                if cursor.rowcount != 1:
                    raise VectorStoreError(
                        "EMAIL_INDEX_CLAIM_LOST", "The email indexing lease is no longer active"
                    )
        except VectorStoreError:
            raise
        except psycopg.Error:
            raise VectorStoreError(
                "EMAIL_INDEX_STATUS_UNAVAILABLE", "Email indexing status could not be updated"
            ) from None

    async def _set_owner(self, cursor: AsyncCursor[tuple[object, ...]], user_id: UUID) -> None:
        await cursor.execute("SET LOCAL search_path = public, pg_catalog")
        await cursor.execute("SELECT set_config('mailpilot.user_id', %s, true)", (str(user_id),))
