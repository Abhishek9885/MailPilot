from collections import defaultdict
from collections.abc import Sequence
from typing import Literal, Protocol
from uuid import UUID

from mailpilot_ai.chunking import EmailChunk, EmailChunkSource, chunk_emails
from mailpilot_ai.embeddings import EmbeddingProvider
from mailpilot_ai.embeddings.errors import EmbeddingError
from mailpilot_ai.email_indexing.models import EmailIndexFailure, EmailIndexReport
from mailpilot_ai.vector_store import PostgresEmbeddingStore, VectorStoreChunkRef
from mailpilot_ai.vector_store.errors import VectorStoreError


ClaimResult = Literal["claimed", "completed", "in_progress"]


class EmailChunkRepository(Protocol):
    async def replace_email_chunks(
        self,
        *,
        user_id: UUID,
        source: EmailChunkSource,
        chunks: Sequence[EmailChunk],
    ) -> tuple[VectorStoreChunkRef, ...]: ...

    async def delete_email_chunks(self, *, user_id: UUID, email_id: UUID) -> int: ...


class EmailIndexJobStore(Protocol):
    async def claim(
        self,
        *,
        user_id: UUID,
        email_id: UUID,
        source_revision: int,
        chunker_version: str,
        configured_model: str,
    ) -> ClaimResult: ...

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
    ) -> None: ...

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
    ) -> None: ...

    async def mark_deleted(self, *, user_id: UUID, email_id: UUID) -> None: ...


class EmailEmbeddingPipeline:
    """Clean, chunk, embed, and persist owner-scoped email content idempotently."""

    def __init__(
        self,
        *,
        provider: EmbeddingProvider,
        chunk_repository: EmailChunkRepository,
        job_store: EmailIndexJobStore,
        vector_store: PostgresEmbeddingStore,
        configured_model: str,
    ) -> None:
        self._provider = provider
        self._chunk_repository = chunk_repository
        self._job_store = job_store
        self._vector_store = vector_store
        self._configured_model = configured_model

    async def process(self, messages: Sequence[EmailChunkSource]) -> EmailIndexReport:
        groups: dict[tuple[UUID, UUID, int], list[EmailChunkSource]] = defaultdict(list)
        for message in messages:
            groups[(message.user_id, message.email_id, message.source_revision)].append(message)

        succeeded = 0
        skipped = 0
        chunk_count = 0
        embedded_chunk_count = 0
        failures: list[EmailIndexFailure] = []
        for group in groups.values():
            source = group[0]
            if source is None:
                continue
            try:
                report = await self._process_one(source, group)
                if report[0] == "skipped":
                    skipped += 1
                else:
                    succeeded += 1
                chunk_count += report[1]
                embedded_chunk_count += report[2]
            except Exception as error:
                code, retryable = _safe_error(error)
                failed_chunk_count = error.chunk_count if isinstance(error, _PipelineError) else 0
                failures.append(
                    EmailIndexFailure(email_id=source.email_id, code=code, retryable=retryable)
                )
                await self._job_store.fail(
                    user_id=source.user_id,
                    email_id=source.email_id,
                    source_revision=source.source_revision,
                    chunker_version="email-char-chunker-v1",
                    configured_model=self._configured_model,
                    safe_error_code=code,
                    chunk_count=failed_chunk_count,
                )
                chunk_count += failed_chunk_count

        return EmailIndexReport(
            received_count=len(groups),
            succeeded_count=succeeded,
            skipped_count=skipped,
            failed_count=len(failures),
            chunk_count=chunk_count,
            embedded_chunk_count=embedded_chunk_count,
            failures=tuple(failures),
        )

    async def delete_email(self, *, user_id: UUID, email_id: UUID) -> int:
        await self._job_store.mark_deleted(user_id=user_id, email_id=email_id)
        await self._chunk_repository.delete_email_chunks(user_id=user_id, email_id=email_id)
        return await self._vector_store.delete_email_embeddings(user_id=user_id, email_id=email_id)

    async def _process_one(
        self,
        source: EmailChunkSource,
        deliveries: Sequence[EmailChunkSource],
    ) -> tuple[Literal["processed", "skipped"], int, int]:
        chunks = chunk_emails(deliveries)
        chunker_version = chunks[0].chunker_version if chunks else "email-char-chunker-v1"
        try:
            claim = await self._job_store.claim(
                user_id=source.user_id,
                email_id=source.email_id,
                source_revision=source.source_revision,
                chunker_version=chunker_version,
                configured_model=self._configured_model,
            )
            if claim in {"completed", "in_progress"}:
                return "skipped", len(chunks), 0

            references = await self._chunk_repository.replace_email_chunks(
                user_id=source.user_id,
                source=source,
                chunks=chunks,
            )
            await self._vector_store.delete_obsolete_email_embeddings(
                user_id=source.user_id,
                email_id=source.email_id,
                source_revision=source.source_revision,
                chunker_version=chunker_version,
                current_chunk_ids=[reference.chunk_id for reference in references],
            )

            existing = await self._vector_store.existing_embedding_versions(
                user_id=source.user_id,
                chunks=references,
            )
            missing_indexes = [
                index for index, reference in enumerate(references)
                if reference.chunk_id not in existing
            ]
            model_version: str | None = (
                next(iter(existing.values()), None) if len(missing_indexes) == 0 else None
            )
            embedded_count = 0
            if missing_indexes:
                missing_chunks = [chunks[index] for index in missing_indexes]
                missing_references = [references[index] for index in missing_indexes]
                result = await self._provider.embed([chunk.content for chunk in missing_chunks])
                embedded_count = await self._vector_store.upsert_embeddings(
                    user_id=source.user_id,
                    chunks=missing_references,
                    embeddings=result,
                )
                model_version = result.model_version

            await self._job_store.complete(
                user_id=source.user_id,
                email_id=source.email_id,
                source_revision=source.source_revision,
                chunker_version=chunker_version,
                configured_model=self._configured_model,
                model_version=model_version,
                chunk_count=len(chunks),
                embedded_chunk_count=embedded_count,
            )
            return "processed", len(chunks), embedded_count
        except Exception as error:
            code, retryable = _safe_error(error)
            raise _PipelineError(code, retryable, len(chunks)) from None


def _safe_error(error: Exception) -> tuple[str, bool]:
    if isinstance(error, _PipelineError):
        return error.code, error.retryable
    if isinstance(error, EmbeddingError):
        return error.code, error.retryable
    if isinstance(error, VectorStoreError):
        return error.code, True
    if isinstance(error, ValueError):
        return "EMAIL_INDEX_INPUT_INVALID", False
    return "EMAIL_INDEXING_FAILED", True


class _PipelineError(RuntimeError):
    def __init__(self, code: str, retryable: bool, chunk_count: int) -> None:
        super().__init__(code)
        self.code = code
        self.retryable = retryable
        self.chunk_count = chunk_count
