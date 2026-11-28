import logging
import re
from collections.abc import Mapping, Sequence
from typing import cast

import structlog
from structlog.typing import EventDict, WrappedLogger

_SENSITIVE_FIELDS = frozenset(
    {
        "body",
        "bodytext",
        "bodyhtml",
        "content",
        "emailbody",
        "emailcontent",
        "subject",
        "sender",
        "senderemail",
        "sendername",
        "recipient",
        "recipientemail",
        "from",
        "to",
        "cc",
        "bcc",
        "headers",
        "attachments",
        "filename",
        "query",
        "prompt",
        "evidence",
        "evidencetext",
        "excerpt",
        "text",
        "messages",
        "request",
        "input",
        "requestbody",
        "payload",
        "response",
        "output",
        "draft",
        "authorization",
        "cookie",
        "token",
        "accesstoken",
        "refreshtoken",
        "clientsecret",
        "apikey",
        "password",
        "secret",
    }
)
_NON_ALPHANUMERIC = re.compile(r"[^a-z0-9]")


def _is_sensitive_field(key: object) -> bool:
    normalized = _NON_ALPHANUMERIC.sub("", str(key).lower())
    return (
        normalized in _SENSITIVE_FIELDS
        or normalized.endswith(
            (
                "token",
                "secret",
                "apikey",
                "password",
                "email",
                "body",
                "content",
                "text",
                "prompt",
                "query",
                "evidence",
                "excerpt",
                "subject",
            )
        )
    )


def _redact_value(value: object) -> object:
    if isinstance(value, Mapping):
        redacted: dict[str, object] = {
            str(key): "[REDACTED]" if _is_sensitive_field(key) else _redact_value(item)
            for key, item in value.items()
        }
        return redacted
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_redact_value(item) for item in value]
    return value


def redact_sensitive_fields(
    _logger: WrappedLogger, _method_name: str, event_dict: EventDict
) -> EventDict:
    """Redact sensitive structured fields before they reach the JSON sink."""
    redacted = _redact_value(event_dict)
    if isinstance(redacted, dict):
        return cast(EventDict, redacted)
    return event_dict


def configure_logging(level: str) -> None:
    numeric_level = {
        "critical": logging.CRITICAL,
        "error": logging.ERROR,
        "warning": logging.WARNING,
        "info": logging.INFO,
        "debug": logging.DEBUG,
    }[level]
    logging.basicConfig(format="%(message)s", stream=None, level=numeric_level)
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            redact_sensitive_fields,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.add_log_level,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(numeric_level),
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )
