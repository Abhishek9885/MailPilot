from datetime import UTC, datetime
from uuid import uuid4

import pytest

from mailpilot_ai.chunking import (
    CHUNKER_VERSION,
    CONTENT_VERSION,
    EmailChunkingError,
    EmailChunkSource,
    chunk_emails,
    clean_email_content,
)


def make_email(**overrides: object) -> EmailChunkSource:
    values: dict[str, object] = {
        "user_id": uuid4(),
        "email_id": uuid4(),
        "provider_message_id": "gmail-message-1",
        "provider_thread_id": "gmail-thread-1",
        "source_revision": 3,
        "received_at": datetime(2026, 11, 6, 10, 30, tzinfo=UTC),
        "sender_name": "Avery Sender",
        "sender_email": "avery@example.test",
        "subject": "Project update",
        "body_text": "The project plan is ready.",
    }
    values.update(overrides)
    return EmailChunkSource.model_validate(values)


def test_short_message_is_one_chunk_with_owner_source_metadata_and_offsets() -> None:
    message = make_email()

    chunks = chunk_emails([message])

    assert len(chunks) == 1
    chunk = chunks[0]
    assert chunk.content == "The project plan is ready."
    assert chunk.user_id == message.user_id
    assert chunk.email_id == message.email_id
    assert chunk.provider_message_id == message.provider_message_id
    assert chunk.provider_thread_id == message.provider_thread_id
    assert chunk.received_at == message.received_at
    assert chunk.sender_name == message.sender_name
    assert chunk.sender_email == message.sender_email
    assert chunk.subject == message.subject
    assert chunk.source_revision == 3
    assert chunk.content_version == CONTENT_VERSION
    assert chunk.chunker_version == CHUNKER_VERSION
    assert (chunk.start_char, chunk.end_char) == (0, len(chunk.content))


def test_long_thread_is_chunked_per_message_without_cross_message_content() -> None:
    user_id = uuid4()
    first = make_email(
        user_id=user_id,
        email_id=uuid4(),
        received_at=datetime(2026, 11, 6, 9, 0, tzinfo=UTC),
        body_text="First message says alpha. " * 8,
    )
    second = make_email(
        user_id=user_id,
        email_id=uuid4(),
        received_at=datetime(2026, 11, 6, 10, 0, tzinfo=UTC),
        body_text="Second message says beta. " * 8,
    )

    chunks = chunk_emails([second, first], max_chars=48)

    assert {chunk.email_id for chunk in chunks} == {first.email_id, second.email_id}
    assert [chunk.received_at for chunk in chunks] == sorted(chunk.received_at for chunk in chunks)
    assert all(len(chunk.content) <= 48 for chunk in chunks)
    assert all(
        chunk.content.startswith("First") for chunk in chunks if chunk.email_id == first.email_id
    )
    assert all(
        chunk.content.startswith("Second") for chunk in chunks if chunk.email_id == second.email_id
    )
    for message in (first, second):
        message_chunks = [chunk for chunk in chunks if chunk.email_id == message.email_id]
        assert [chunk.ordinal for chunk in message_chunks] == list(range(len(message_chunks)))
        assert all(
            chunk.provider_thread_id == message.provider_thread_id for chunk in message_chunks
        )


def test_cleaner_removes_quoted_reply_history_from_plain_text() -> None:
    cleaned = clean_email_content(
        body_text=(
            "Thanks for the update.\n\nOn Tue, Nov 3, Avery wrote:\n"
            "> The old request\n> Previous details\n"
        )
    )

    assert cleaned == "Thanks for the update."


def test_html_fallback_extracts_text_and_drops_quoted_and_executable_markup() -> None:
    cleaned = clean_email_content(
        body_text="",
        body_html=(
            "<html><body><p>Hello &amp; welcome.</p>"
            "<div class='gmail_quote'>Old quoted content</div>"
            "<script>ignore this code</script></body></html>"
        ),
    )

    assert cleaned == "Hello & welcome."


def test_duplicate_delivery_is_idempotent_and_conflicting_duplicate_is_rejected() -> None:
    message = make_email(body_text="Same content repeated by delivery.")

    duplicate_chunks = chunk_emails([message, message])
    assert len(duplicate_chunks) == 1
    assert duplicate_chunks[0].content == "Same content repeated by delivery."

    conflicting = message.model_copy(update={"body_text": "Different content for same revision."})
    with pytest.raises(EmailChunkingError) as raised:
        chunk_emails([message, conflicting])
    assert raised.value.code == "EMAIL_CHUNKING_SOURCE_CONFLICT"
    assert "Same content" not in str(raised.value)


def test_chunking_is_deterministic_and_offsets_reconstruct_cleaned_text() -> None:
    message = make_email(body_text="One sentence here.\n\nAnother sentence there.\nFinal note.")

    first = chunk_emails([message], max_chars=25)
    second = chunk_emails([message], max_chars=25)

    assert first == second
    canonical = clean_email_content(body_text=message.body_text)
    assert [canonical[chunk.start_char : chunk.end_char] for chunk in first] == [
        chunk.content for chunk in first
    ]
    assert all(
        left.end_char <= right.start_char for left, right in zip(first, first[1:], strict=False)
    )


def test_chunker_rejects_invalid_bounds() -> None:
    with pytest.raises(ValueError, match="max_chars"):
        chunk_emails([], max_chars=0)
    with pytest.raises(ValueError, match="max_chars"):
        chunk_emails([], max_chars=10_001)
