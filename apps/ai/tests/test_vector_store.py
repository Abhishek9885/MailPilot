import hashlib
import os
from pathlib import Path
from urllib.parse import unquote, urlsplit
from uuid import UUID, uuid4

import psycopg
import pytest

from mailpilot_ai.database import psycopg_connection_url
from mailpilot_ai.embeddings.contracts import EmbeddingResult, EmbeddingUsage
from mailpilot_ai.vector_store import (
    PostgresEmbeddingStore,
    RetrievalFilters,
    VectorStoreChunkRef,
    VectorStoreError,
    apply_ai_migrations,
    embedding_version_key,
)

TEST_DATABASE_URL = os.environ.get("MAILPILOT_TEST_DATABASE_URL")
MIGRATIONS_DIRECTORY = (
    Path(__file__).parents[1] / "src" / "mailpilot_ai" / "vector_store" / "migrations"
)


def test_embedding_version_changes_when_model_or_dimensions_change() -> None:
    base = embedding_version_key(
        provider="openai",
        model="text-embedding-3-small",
        model_version="text-embedding-3-small-2026-11-01",
        dimensions=1_536,
    )
    changed_model = embedding_version_key(
        provider="openai",
        model="text-embedding-3-large",
        model_version="text-embedding-3-large-2026-11-01",
        dimensions=1_536,
    )
    changed_snapshot = embedding_version_key(
        provider="openai",
        model="text-embedding-3-small",
        model_version="text-embedding-3-small-2026-11-02",
        dimensions=1_536,
    )
    changed_dimensions = embedding_version_key(
        provider="openai",
        model="text-embedding-3-small",
        model_version="text-embedding-3-small-2026-11-01",
        dimensions=1_024,
    )
    assert base != changed_model
    assert base != changed_snapshot
    assert base != changed_dimensions


def _test_database_url() -> str:
    if TEST_DATABASE_URL is None:
        pytest.skip("Set MAILPILOT_TEST_DATABASE_URL to an isolated PostgreSQL database")
    database_name = unquote(urlsplit(TEST_DATABASE_URL).path.rsplit("/", 1)[-1])
    if not database_name.endswith("_test"):
        pytest.fail("MAILPILOT_TEST_DATABASE_URL must target a database ending in _test")
    return TEST_DATABASE_URL


async def _make_store(
    database_url: str, *, model: str = "text-embedding-3-small"
) -> PostgresEmbeddingStore:
    await apply_ai_migrations(database_url)
    return PostgresEmbeddingStore(database_url, model=model, dimensions=1_536)


async def _create_source_chunk(
    database_url: str,
    *,
    user_id: UUID | None = None,
    content: str = "A canonical source chunk for vector storage.",
    sender_email: str = "sender@example.test",
) -> VectorStoreChunkRef:
    owner_id = user_id or uuid4()
    connection_id = uuid4()
    email_id = uuid4()
    chunk_id = uuid4()
    provider_message_id = f"test-message-{uuid4()}"
    provider_thread_id = f"test-thread-{uuid4()}"
    content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
    async with (
        await psycopg.AsyncConnection.connect(
            psycopg_connection_url(database_url), connect_timeout=5
        ) as connection,
        connection.transaction(),
        connection.cursor() as cursor,
    ):
        await cursor.execute(
            """
                INSERT INTO app.users (id, email_normalized, updated_at)
                VALUES (%s, %s, CURRENT_TIMESTAMP)
                ON CONFLICT (id) DO NOTHING
                """,
            (owner_id, f"{owner_id}@example.test"),
        )
        await cursor.execute(
            "SELECT id FROM app.google_connections WHERE user_id = %s",
            (owner_id,),
        )
        existing_connection = await cursor.fetchone()
        if existing_connection is not None:
            connection_id = existing_connection[0]
        else:
            await cursor.execute(
                """
                    INSERT INTO app.google_connections (
                        id, user_id, provider_subject, provider_email_normalized, updated_at
                    ) VALUES (%s, %s, %s, %s, CURRENT_TIMESTAMP)
                    """,
                (connection_id, owner_id, f"subject-{connection_id}", f"{owner_id}@example.test"),
            )
        await cursor.execute(
            """
                INSERT INTO app.emails (
                    id, user_id, google_connection_id, provider_message_id,
                    provider_thread_id, sender_name, sender_email_normalized,
                    subject, body_text, body_hash, received_at, updated_at
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
                """,
            (
                email_id,
                owner_id,
                connection_id,
                provider_message_id,
                provider_thread_id,
                "Vector Test Sender",
                sender_email,
                "Vector storage integration test",
                content,
                content_hash,
            ),
        )
        await cursor.execute(
            """
                INSERT INTO app.email_chunks (
                    id, user_id, email_id, source_revision, chunker_version,
                    ordinal, start_char, end_char, content, content_hash
                ) VALUES (%s, %s, %s, 1, %s, 0, 0, %s, %s, %s)
                """,
            (
                chunk_id,
                owner_id,
                email_id,
                "email-char-chunker-v1",
                len(content),
                content,
                content_hash,
            ),
        )
    return VectorStoreChunkRef(
        user_id=owner_id,
        chunk_id=chunk_id,
        source_revision=1,
        chunker_version="email-char-chunker-v1",
        content_hash=content_hash,
    )


async def _delete_owner(database_url: str, user_id: UUID) -> None:
    async with await psycopg.AsyncConnection.connect(
        psycopg_connection_url(database_url), connect_timeout=5
    ) as connection:
        await connection.execute("DELETE FROM app.users WHERE id = %s", (user_id,))


def _vector(*values: float) -> tuple[float, ...]:
    return (*values, *(0.0 for _ in range(1_536 - len(values))))


def _embeddings(*, version: str, vectors: tuple[tuple[float, ...], ...]) -> EmbeddingResult:
    return EmbeddingResult(
        provider="openai",
        model_version=version,
        dimensions=1_536,
        vectors=vectors,
        usage=EmbeddingUsage(input_tokens=0, total_tokens=0),
    )


@pytest.mark.anyio
@pytest.mark.skipif(
    TEST_DATABASE_URL is None, reason="requires isolated PostgreSQL integration database"
)
async def test_migrations_are_reproducible_and_immutable(tmp_path: Path) -> None:
    database_url = _test_database_url()
    first = await apply_ai_migrations(database_url)
    second = await apply_ai_migrations(database_url)

    assert first == second
    assert first
    assert all(len(migration.checksum) == 64 for migration in first)

    copied_migrations = tmp_path / "migrations"
    copied_migrations.mkdir()
    for migration_file in MIGRATIONS_DIRECTORY.glob("*.sql"):
        copied_migrations.joinpath(migration_file.name).write_text(
            migration_file.read_text(encoding="utf-8") + "\n-- changed after application\n",
            encoding="utf-8",
        )
    with pytest.raises(VectorStoreError) as raised:
        await apply_ai_migrations(database_url, migrations_directory=copied_migrations)
    assert raised.value.code == "AI_MIGRATION_CHECKSUM_MISMATCH"


@pytest.mark.anyio
@pytest.mark.skipif(
    TEST_DATABASE_URL is None, reason="requires isolated PostgreSQL integration database"
)
async def test_insert_nearest_neighbors_and_filtering_are_owner_scoped() -> None:
    database_url = _test_database_url()
    store = await _make_store(database_url)
    owner_id = uuid4()
    own_nearest = await _create_source_chunk(
        database_url,
        user_id=owner_id,
        content="nearest",
        sender_email="near@example.test",
    )
    own_farther = await _create_source_chunk(
        database_url,
        user_id=owner_id,
        content="farther",
        sender_email="filter@example.test",
    )
    other_owner_nearest = await _create_source_chunk(database_url, content="other owner")
    version = "text-embedding-3-small-2026-11-01"
    try:
        await store.upsert_embeddings(
            user_id=owner_id,
            chunks=[own_nearest, own_farther],
            embeddings=_embeddings(
                version=version,
                vectors=(_vector(1.0, 0.0), _vector(0.0, 1.0)),
            ),
        )
        other_store = await _make_store(database_url)
        await other_store.upsert_embeddings(
            user_id=other_owner_nearest.user_id,
            chunks=[other_owner_nearest],
            embeddings=_embeddings(version=version, vectors=(_vector(1.0, 0.0),)),
        )

        neighbors = await store.nearest_neighbors(
            user_id=owner_id,
            model_version=version,
            query_vector=_vector(1.0, 0.0),
            limit=1,
        )

        assert [neighbor.chunk_id for neighbor in neighbors] == [own_nearest.chunk_id]
        assert all(neighbor.user_id == owner_id for neighbor in neighbors)
        assert neighbors[0].cosine_distance == pytest.approx(0.0)
        assert neighbors[0].content == "nearest"
        assert neighbors[0].provider_message_id.startswith("test-message-")
        assert neighbors[0].provider_thread_id.startswith("test-thread-")
        assert neighbors[0].email_id is not None

        filtered_neighbors = await store.nearest_neighbors(
            user_id=owner_id,
            model_version=version,
            query_vector=_vector(1.0, 0.0),
            filters=RetrievalFilters(sender_email=" FILTER@EXAMPLE.TEST "),
        )
        assert [neighbor.chunk_id for neighbor in filtered_neighbors] == [own_farther.chunk_id]
        filtered_keyword_neighbors = await store.keyword_neighbors(
            user_id=owner_id,
            query="farther",
            filters=RetrievalFilters(sender_email=" FILTER@EXAMPLE.TEST "),
        )
        assert [neighbor.chunk_id for neighbor in filtered_keyword_neighbors] == [
            own_farther.chunk_id
        ]

        other_neighbors = await other_store.nearest_neighbors(
            user_id=other_owner_nearest.user_id,
            model_version=version,
            query_vector=_vector(1.0, 0.0),
        )
        assert [neighbor.chunk_id for neighbor in other_neighbors] == [
            other_owner_nearest.chunk_id
        ]
        assert await store.keyword_neighbors(user_id=owner_id, query="other owner") == ()
        other_keyword_neighbors = await other_store.keyword_neighbors(
            user_id=other_owner_nearest.user_id,
            query="other owner",
        )
        assert [neighbor.chunk_id for neighbor in other_keyword_neighbors] == [
            other_owner_nearest.chunk_id
        ]
    finally:
        await _delete_owner(database_url, owner_id)
        await _delete_owner(database_url, other_owner_nearest.user_id)


@pytest.mark.anyio
@pytest.mark.skipif(
    TEST_DATABASE_URL is None, reason="requires isolated PostgreSQL integration database"
)
async def test_nearest_neighbors_return_empty_when_no_current_embeddings_exist() -> None:
    database_url = _test_database_url()
    store = await _make_store(database_url)
    chunk = await _create_source_chunk(database_url)
    try:
        neighbors = await store.nearest_neighbors(
            user_id=chunk.user_id,
            model_version="text-embedding-3-small-2026-11-01",
            query_vector=_vector(1.0, 0.0),
        )
        assert neighbors == ()
    finally:
        await _delete_owner(database_url, chunk.user_id)


@pytest.mark.anyio
@pytest.mark.skipif(
    TEST_DATABASE_URL is None, reason="requires isolated PostgreSQL integration database"
)
async def test_nearest_neighbors_exclude_deleted_source_messages() -> None:
    database_url = _test_database_url()
    store = await _make_store(database_url)
    chunk = await _create_source_chunk(database_url)
    version = "text-embedding-3-small-2026-11-01"
    try:
        await store.upsert_embeddings(
            user_id=chunk.user_id,
            chunks=[chunk],
            embeddings=_embeddings(version=version, vectors=(_vector(1.0, 0.0),)),
        )
        async with (
            await psycopg.AsyncConnection.connect(
                psycopg_connection_url(database_url), connect_timeout=5
            ) as connection,
            connection.transaction(),
        ):
            await connection.execute(
                """
                UPDATE app.emails SET deleted_at = CURRENT_TIMESTAMP
                WHERE user_id = %s AND id = (
                    SELECT email_id FROM app.email_chunks
                    WHERE user_id = %s AND id = %s
                )
                """,
                (chunk.user_id, chunk.user_id, chunk.chunk_id),
            )

        neighbors = await store.nearest_neighbors(
            user_id=chunk.user_id,
            model_version=version,
            query_vector=_vector(1.0, 0.0),
        )
        assert neighbors == ()
        assert (
            await store.keyword_neighbors(
                user_id=chunk.user_id,
                query="canonical source chunk",
            )
            == ()
        )
    finally:
        await _delete_owner(database_url, chunk.user_id)


@pytest.mark.anyio
@pytest.mark.skipif(
    TEST_DATABASE_URL is None, reason="requires isolated PostgreSQL integration database"
)
async def test_keyword_neighbors_find_exact_names_dates_invoice_and_reference_numbers() -> None:
    database_url = _test_database_url()
    store = await _make_store(database_url)
    content = (
        "Jordan Lee approved invoice INV-2026-1042 for payment on 2026-11-14. "
        "The purchase reference is PO-77881."
    )
    chunk = await _create_source_chunk(database_url, content=content)
    try:
        for query in (
            "Jordan Lee",
            "2026-11-14",
            "INV-2026-1042",
            "PO-77881",
        ):
            matches = await store.keyword_neighbors(
                user_id=chunk.user_id,
                query=query,
                limit=5,
            )
            assert matches
            assert matches[0].chunk_id == chunk.chunk_id
            assert matches[0].provider_message_id.startswith("test-message-")
            assert matches[0].provider_thread_id.startswith("test-thread-")
            assert matches[0].content == content
            assert matches[0].keyword_score > 0

        assert (
            await store.keyword_neighbors(
                user_id=chunk.user_id,
                query="Comet 9281 unrelated",
            )
            == ()
        )
    finally:
        await _delete_owner(database_url, chunk.user_id)


@pytest.mark.anyio
@pytest.mark.skipif(
    TEST_DATABASE_URL is None, reason="requires isolated PostgreSQL integration database"
)
async def test_duplicate_prevention_and_model_changes_keep_versions_separate() -> None:
    database_url = _test_database_url()
    small_store = await _make_store(database_url)
    large_store = await _make_store(database_url, model="text-embedding-3-large")
    chunk = await _create_source_chunk(database_url)
    small_version = "text-embedding-3-small-2026-11-01"
    large_version = "text-embedding-3-large-2026-11-01"
    user_id = chunk.user_id
    try:
        for _ in range(2):
            await small_store.upsert_embeddings(
                user_id=user_id,
                chunks=[chunk],
                embeddings=_embeddings(version=small_version, vectors=(_vector(1.0, 0.0),)),
            )
        await large_store.upsert_embeddings(
            user_id=user_id,
            chunks=[chunk],
            embeddings=_embeddings(version=large_version, vectors=(_vector(0.0, 1.0),)),
        )

        small_neighbors = await small_store.nearest_neighbors(
            user_id=user_id,
            model_version=small_version,
            query_vector=_vector(1.0, 0.0),
        )
        large_neighbors = await large_store.nearest_neighbors(
            user_id=user_id,
            model_version=large_version,
            query_vector=_vector(1.0, 0.0),
        )

        assert len(small_neighbors) == 1
        assert len(large_neighbors) == 1
        assert small_neighbors[0].cosine_distance == pytest.approx(0.0)
        assert large_neighbors[0].cosine_distance == pytest.approx(1.0)
        assert small_neighbors[0].embedding_version != large_neighbors[0].embedding_version
    finally:
        await _delete_owner(database_url, user_id)


@pytest.mark.anyio
@pytest.mark.skipif(
    TEST_DATABASE_URL is None, reason="requires isolated PostgreSQL integration database"
)
async def test_dimension_mismatch_is_rejected_before_database_write() -> None:
    database_url = _test_database_url()
    chunk = await _create_source_chunk(database_url)
    user_id = chunk.user_id
    store = await _make_store(database_url)
    try:
        mismatched = EmbeddingResult(
            provider="openai",
            model_version="text-embedding-3-large-2026-11-01",
            dimensions=1_024,
            vectors=((1.0,) * 1_024,),
            usage=EmbeddingUsage(input_tokens=1, total_tokens=1),
        )
        with pytest.raises(VectorStoreError) as raised:
            await store.upsert_embeddings(user_id=user_id, chunks=[chunk], embeddings=mismatched)
        assert raised.value.code == "EMBEDDING_INDEX_DIMENSIONS_UNSUPPORTED"
        assert (
            await store.nearest_neighbors(
                user_id=user_id,
                model_version=mismatched.model_version,
                query_vector=_vector(1.0, 0.0),
            )
            == ()
        )
    finally:
        await _delete_owner(database_url, user_id)


@pytest.mark.anyio
@pytest.mark.skipif(
    TEST_DATABASE_URL is None, reason="requires isolated PostgreSQL integration database"
)
async def test_deletion_removes_embeddings_and_canonical_chunk_delete_cascades() -> None:
    database_url = _test_database_url()
    store = await _make_store(database_url)
    chunk = await _create_source_chunk(database_url)
    user_id = chunk.user_id
    version = "text-embedding-3-small-2026-11-01"
    try:
        await store.upsert_embeddings(
            user_id=user_id,
            chunks=[chunk],
            embeddings=_embeddings(version=version, vectors=(_vector(1.0, 0.0),)),
        )
        assert await store.delete_chunk_embeddings(user_id=user_id, chunk_id=chunk.chunk_id) == 1
        assert (
            await store.nearest_neighbors(
                user_id=user_id, model_version=version, query_vector=_vector(1.0, 0.0)
            )
            == ()
        )

        await store.upsert_embeddings(
            user_id=user_id,
            chunks=[chunk],
            embeddings=_embeddings(version=version, vectors=(_vector(1.0, 0.0),)),
        )
        async with await psycopg.AsyncConnection.connect(
            psycopg_connection_url(database_url), connect_timeout=5
        ) as connection:
            await connection.execute(
                "DELETE FROM app.email_chunks WHERE user_id = %s AND id = %s",
                (user_id, chunk.chunk_id),
            )
        assert (
            await store.nearest_neighbors(
                user_id=user_id, model_version=version, query_vector=_vector(1.0, 0.0)
            )
            == ()
        )
    finally:
        await _delete_owner(database_url, user_id)
