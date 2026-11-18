import hashlib
import html.parser
import json
import re
import unicodedata
from collections.abc import Sequence
from datetime import UTC
from typing import Final

from mailpilot_ai.chunking.models import EmailChunk, EmailChunkSource

CONTENT_VERSION: Final = "email-content-v1"
CHUNKER_VERSION: Final = "email-char-chunker-v1"
DEFAULT_MAX_CHARS: Final = 2_400
_BLOCK_TAGS: Final = frozenset(
    {
        "address",
        "article",
        "aside",
        "dd",
        "div",
        "dl",
        "dt",
        "figcaption",
        "figure",
        "footer",
        "form",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "header",
        "hr",
        "li",
        "main",
        "nav",
        "ol",
        "p",
        "pre",
        "section",
        "table",
        "td",
        "th",
        "tr",
        "ul",
    }
)
_VOID_TAGS: Final = frozenset(
    {
        "area",
        "base",
        "br",
        "col",
        "embed",
        "hr",
        "img",
        "input",
        "link",
        "meta",
        "param",
        "source",
        "track",
        "wbr",
    }
)
_IGNORED_TAGS: Final = frozenset({"blockquote", "head", "noscript", "script", "style", "template"})
_QUOTE_BOUNDARIES: Final = (
    re.compile(r"^On\s+.{1,400}\bwrote:\s*$", re.IGNORECASE),
    re.compile(r"^-{2,}\s*Original Message\s*-{2,}$", re.IGNORECASE),
    re.compile(r"^-{2,}\s*Forwarded message\s*-{2,}$", re.IGNORECASE),
    re.compile(r"^Begin forwarded message:\s*$", re.IGNORECASE),
)


class EmailChunkingError(ValueError):
    """Safe error raised when duplicate source metadata is inconsistent."""

    code = "EMAIL_CHUNKING_SOURCE_CONFLICT"

    def __init__(self) -> None:
        super().__init__("A repeated email source has inconsistent content or metadata")


class _PlainTextExtractor(html.parser.HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._ignored_stack: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        normalized_tag = tag.lower()
        if self._ignored_stack:
            if normalized_tag not in _VOID_TAGS:
                self._ignored_stack.append(normalized_tag)
            return

        classes = {
            item.lower()
            for name, value in attrs
            if name.lower() == "class" and value is not None
            for item in value.split()
        }
        is_quote_container = classes.intersection(
            {"gmail_quote", "yahoo_quoted", "protonmail_quote"}
        )
        if (
            normalized_tag in _IGNORED_TAGS or is_quote_container
        ) and normalized_tag not in _VOID_TAGS:
            self._ignored_stack.append(normalized_tag)
            self.parts.append("\n")
            return

        if normalized_tag == "br" or normalized_tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        normalized_tag = tag.lower()
        if self._ignored_stack:
            for index in range(len(self._ignored_stack) - 1, -1, -1):
                if self._ignored_stack[index] == normalized_tag:
                    del self._ignored_stack[index:]
                    self.parts.append("\n")
                    break
            return
        if normalized_tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._ignored_stack:
            self.parts.append(data)


def clean_email_content(*, body_text: str, body_html: str | None = None) -> str:
    """Normalize one message body; plain text wins and quoted history is trimmed."""
    selected = body_text
    if not selected.strip() and body_html:
        extractor = _PlainTextExtractor()
        extractor.feed(body_html)
        extractor.close()
        selected = "".join(extractor.parts)
    normalized = unicodedata.normalize(
        "NFC", selected.replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")
    )
    lines: list[str] = []
    for line in normalized.split("\n"):
        if any(boundary.match(line.strip()) for boundary in _QUOTE_BOUNDARIES):
            break
        if line.lstrip().startswith(">"):
            continue
        cleaned_line = re.sub(r"[\t\f\v ]+", " ", line).strip()
        if cleaned_line:
            lines.append(cleaned_line)
        elif lines and lines[-1] != "":
            lines.append("")
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


def chunk_emails(
    messages: Sequence[EmailChunkSource], *, max_chars: int = DEFAULT_MAX_CHARS
) -> tuple[EmailChunk, ...]:
    """Chunk each message independently in stable order; never combine messages."""
    if max_chars < 1 or max_chars > 10_000:
        raise ValueError("max_chars must be between 1 and 10000")

    by_identity: dict[tuple[str, str, int], tuple[EmailChunkSource, str, str]] = {}
    for message in messages:
        if not isinstance(message, EmailChunkSource):
            raise TypeError("messages must contain validated EmailChunkSource records")
        identity = (str(message.user_id), str(message.email_id), message.source_revision)
        content = clean_email_content(body_text=message.body_text, body_html=message.body_html)
        fingerprint = _source_fingerprint(message, content)
        previous = by_identity.get(identity)
        if previous is not None:
            if previous[2] != fingerprint:
                raise EmailChunkingError()
            continue
        by_identity[identity] = (message, content, fingerprint)

    ordered = sorted(
        by_identity.values(),
        key=lambda item: (
            item[0].received_at.astimezone(UTC),
            str(item[0].provider_thread_id),
            str(item[0].email_id),
            item[0].source_revision,
        ),
    )
    chunks: list[EmailChunk] = []
    for message, content, _fingerprint in ordered:
        for ordinal, (start, end) in enumerate(_split_ranges(content, max_chars)):
            chunk_content = content[start:end]
            chunks.append(
                EmailChunk(
                    user_id=message.user_id,
                    email_id=message.email_id,
                    provider_message_id=message.provider_message_id,
                    provider_thread_id=message.provider_thread_id,
                    source_revision=message.source_revision,
                    content_version=CONTENT_VERSION,
                    chunker_version=CHUNKER_VERSION,
                    ordinal=ordinal,
                    start_char=start,
                    end_char=end,
                    content=chunk_content,
                    content_hash=hashlib.sha256(chunk_content.encode("utf-8")).hexdigest(),
                    received_at=message.received_at,
                    sender_name=message.sender_name,
                    sender_email=message.sender_email,
                    subject=message.subject,
                )
            )
    return tuple(chunks)


def _source_fingerprint(message: EmailChunkSource, content: str) -> str:
    values = json.dumps(
        [
            str(message.user_id),
            str(message.email_id),
            message.provider_message_id,
            str(message.provider_thread_id),
            str(message.source_revision),
            message.received_at.isoformat(),
            message.sender_name or "",
            message.sender_email or "",
            message.subject,
            content,
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(values.encode("utf-8")).hexdigest()


def _split_ranges(text: str, max_chars: int) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    start = 0
    while start < len(text):
        hard_end = min(start + max_chars, len(text))
        if hard_end == len(text):
            end = len(text)
            while end > start and text[end - 1].isspace():
                end -= 1
            if end > start:
                ranges.append((start, end))
            break

        cut = _preferred_cut(text, start, hard_end)
        end = cut
        while end > start and text[end - 1].isspace():
            end -= 1
        if end <= start:
            cut = hard_end
            end = cut
        if end > start:
            ranges.append((start, end))
        start = cut
        while start < len(text) and text[start].isspace():
            start += 1
    return ranges


def _preferred_cut(text: str, start: int, hard_end: int) -> int:
    window = text[start : hard_end + 1]
    min_boundary = start + max(1, (hard_end - start) // 2)
    paragraph_boundaries = [
        start + match.start()
        for match in re.finditer(r"\n[ \t]*\n", window)
        if min_boundary <= start + match.start() <= hard_end
    ]
    if paragraph_boundaries:
        return paragraph_boundaries[-1]

    sentence_boundaries = [
        start + match.end()
        for match in re.finditer(r"[.!?][\"')\]]*(?=\s)", window)
        if min_boundary <= start + match.end() <= hard_end
    ]
    if sentence_boundaries:
        return sentence_boundaries[-1]

    whitespace_boundaries = [
        start + match.start()
        for match in re.finditer(r"\s+", window)
        if min_boundary <= start + match.start() <= hard_end
    ]
    if whitespace_boundaries:
        return whitespace_boundaries[-1]
    return hard_end
