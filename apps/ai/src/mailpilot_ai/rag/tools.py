"""Allowlisted, owner-scoped read-only tools for the RAG workflow."""

import asyncio
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from enum import StrEnum
from time import perf_counter
from typing import Protocol, TypeVar
from uuid import UUID

import structlog
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from mailpilot_ai.rag.schemas import GroundedAnswerResponse
from mailpilot_ai.rag.service import (
    GroundedAnswerInputError,
    GroundedRAGAnswerService,
    PreparedRAGContext,
)
from mailpilot_ai.vector_store import HybridSearchResult, RetrievalFilters

MAX_TOOL_SEARCH_RESULTS = 100
DEFAULT_GMAIL_SEARCH_TIMEOUT_SECONDS = 35.0
DEFAULT_RAG_ANSWER_TIMEOUT_SECONDS = 120.0
DEFAULT_GMAIL_SEARCH_RETRIES = 1
DEFAULT_RAG_ANSWER_RETRIES = 0
_SAFE_ERROR_CODE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_logger = structlog.get_logger().bind(service="ai")


class ReadOnlyToolName(StrEnum):
    GMAIL_SEARCH = "gmail_search"
    RAG_ANSWER = "rag_answer"


class ToolPermission(StrEnum):
    SEARCH_OWN_MAILBOX = "search_own_mailbox"
    GENERATE_GROUNDED_ANSWER = "generate_grounded_answer"


_REQUIRED_PERMISSIONS: dict[ReadOnlyToolName, ToolPermission] = {
    ReadOnlyToolName.GMAIL_SEARCH: ToolPermission.SEARCH_OWN_MAILBOX,
    ReadOnlyToolName.RAG_ANSWER: ToolPermission.GENERATE_GROUNDED_ANSWER,
}


class ToolArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


class GmailSearchArguments(ToolArguments):
    """Search the caller's synced Gmail index; identity is injected separately."""

    query: str = Field(min_length=1, max_length=20_000)
    top_k: int = Field(default=10, ge=1, le=MAX_TOOL_SEARCH_RESULTS)
    filters: RetrievalFilters = Field(default_factory=RetrievalFilters)

    @field_validator("query")
    @classmethod
    def normalize_query(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("query cannot be blank")
        return normalized


class RAGAnswerArguments(ToolArguments):
    query: str = Field(min_length=1, max_length=20_000)

    @field_validator("query")
    @classmethod
    def normalize_query(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("query cannot be blank")
        return normalized


class GmailSearchToolResult(ToolArguments):
    sources: tuple[HybridSearchResult, ...] = Field(max_length=MAX_TOOL_SEARCH_RESULTS)


class RAGAnswerToolResult(ToolArguments):
    answer: GroundedAnswerResponse


class ToolInvocationError(RuntimeError):
    """Sanitized, structured failure raised by a read-only tool invocation."""

    def __init__(
        self,
        *,
        tool_name: ReadOnlyToolName | None,
        code: str,
        retryable: bool,
        attempts: int = 0,
    ) -> None:
        self.tool_name = tool_name
        self.code = code if _SAFE_ERROR_CODE.fullmatch(code) else "TOOL_EXECUTION_FAILED"
        self.retryable = retryable
        self.attempts = attempts
        super().__init__(self.code)


class ToolAuthorizationPolicy(Protocol):
    async def authorize(self, *, user_id: UUID, tool_name: ReadOnlyToolName) -> None: ...


class ReadOnlyToolAuthorizer:
    """Apply explicit per-tool permissions to a trusted internal user identity."""

    def __init__(
        self,
        permissions: frozenset[ToolPermission] | None = None,
    ) -> None:
        self._permissions = frozenset(ToolPermission) if permissions is None else permissions

    async def authorize(self, *, user_id: UUID, tool_name: ReadOnlyToolName) -> None:
        if not isinstance(user_id, UUID) or user_id.int == 0:
            raise ToolInvocationError(
                tool_name=tool_name,
                code="TOOL_IDENTITY_REQUIRED",
                retryable=False,
            )
        required_permission = _REQUIRED_PERMISSIONS.get(tool_name)
        if required_permission is None or required_permission not in self._permissions:
            raise ToolInvocationError(
                tool_name=tool_name,
                code="TOOL_NOT_AUTHORIZED",
                retryable=False,
            )


@dataclass(frozen=True, slots=True)
class ToolInvocationContext:
    """Trusted graph context; never accepted from model-produced arguments."""

    user_id: UUID
    query: str | None = None
    prepared_context: PreparedRAGContext | None = None


_ToolResult = TypeVar("_ToolResult")


class ReadOnlyRAGToolRegistry:
    """Expose only Gmail-index search and grounded RAG answer operations."""

    def __init__(
        self,
        *,
        answer_service: GroundedRAGAnswerService,
        authorizer: ToolAuthorizationPolicy | None = None,
        gmail_search_timeout_seconds: float = DEFAULT_GMAIL_SEARCH_TIMEOUT_SECONDS,
        rag_answer_timeout_seconds: float = DEFAULT_RAG_ANSWER_TIMEOUT_SECONDS,
        gmail_search_retries: int = DEFAULT_GMAIL_SEARCH_RETRIES,
        rag_answer_retries: int = DEFAULT_RAG_ANSWER_RETRIES,
    ) -> None:
        if gmail_search_timeout_seconds <= 0 or rag_answer_timeout_seconds <= 0:
            raise ValueError("tool timeouts must be positive")
        if gmail_search_retries < 0 or rag_answer_retries < 0:
            raise ValueError("tool retry counts must not be negative")
        self._answer_service = answer_service
        self._authorizer = authorizer or ReadOnlyToolAuthorizer()
        self._gmail_search_timeout_seconds = gmail_search_timeout_seconds
        self._rag_answer_timeout_seconds = rag_answer_timeout_seconds
        self._gmail_search_retries = gmail_search_retries
        self._rag_answer_retries = rag_answer_retries

    async def invoke(
        self,
        tool_name: ReadOnlyToolName | str,
        arguments: object,
        *,
        user_id: UUID,
        context: ToolInvocationContext | None = None,
    ) -> GmailSearchToolResult | RAGAnswerToolResult:
        try:
            name = ReadOnlyToolName(tool_name)
        except ValueError:
            raise ToolInvocationError(
                tool_name=None,
                code="TOOL_NOT_APPROVED",
                retryable=False,
            ) from None

        if not isinstance(user_id, UUID) or user_id.int == 0:
            raise ToolInvocationError(
                tool_name=name,
                code="TOOL_IDENTITY_REQUIRED",
                retryable=False,
            )
        invocation_context = context or ToolInvocationContext(user_id=user_id)
        if invocation_context.user_id != user_id:
            raise ToolInvocationError(
                tool_name=name,
                code="TOOL_IDENTITY_MISMATCH",
                retryable=False,
            )

        parsed_arguments: GmailSearchArguments | RAGAnswerArguments
        try:
            if name is ReadOnlyToolName.GMAIL_SEARCH:
                parsed_arguments = GmailSearchArguments.model_validate(arguments)
            else:
                parsed_arguments = RAGAnswerArguments.model_validate(arguments)
        except (ValidationError, TypeError, ValueError):
            raise ToolInvocationError(
                tool_name=name,
                code="TOOL_ARGUMENTS_INVALID",
                retryable=False,
            ) from None

        await self._authorizer.authorize(user_id=user_id, tool_name=name)
        if name is ReadOnlyToolName.GMAIL_SEARCH:
            if not isinstance(parsed_arguments, GmailSearchArguments):
                raise ToolInvocationError(
                    tool_name=name,
                    code="TOOL_ARGUMENTS_INVALID",
                    retryable=False,
                )
            return await self._with_recovery(
                tool_name=name,
                timeout_seconds=self._gmail_search_timeout_seconds,
                max_retries=self._gmail_search_retries,
                operation=lambda: self._gmail_search(
                    parsed_arguments,
                    invocation_context.user_id,
                ),
            )

        if not isinstance(parsed_arguments, RAGAnswerArguments):
            raise ToolInvocationError(
                tool_name=name,
                code="TOOL_ARGUMENTS_INVALID",
                retryable=False,
            )
        return await self._with_recovery(
            tool_name=name,
            timeout_seconds=self._rag_answer_timeout_seconds,
            max_retries=self._rag_answer_retries,
            operation=lambda: self._rag_answer(
                parsed_arguments,
                invocation_context,
            ),
        )

    async def _gmail_search(
        self,
        arguments: GmailSearchArguments,
        user_id: UUID,
    ) -> GmailSearchToolResult:
        try:
            sources = await self._answer_service.retrieve_sources(
                user_id=user_id,
                query=arguments.query,
                top_k=arguments.top_k,
                filters=arguments.filters,
            )
        except GroundedAnswerInputError as error:
            if error.code == "RAG_SOURCE_OWNER_MISMATCH":
                raise ToolInvocationError(
                    tool_name=ReadOnlyToolName.GMAIL_SEARCH,
                    code="TOOL_SOURCE_SCOPE_VIOLATION",
                    retryable=False,
                ) from None
            raise
        if any(source.user_id != user_id for source in sources):
            raise ToolInvocationError(
                tool_name=ReadOnlyToolName.GMAIL_SEARCH,
                code="TOOL_SOURCE_SCOPE_VIOLATION",
                retryable=False,
            )
        return GmailSearchToolResult(sources=sources)

    async def _rag_answer(
        self,
        arguments: RAGAnswerArguments,
        context: ToolInvocationContext,
    ) -> RAGAnswerToolResult:
        if context.query != arguments.query or context.prepared_context is None:
            raise ToolInvocationError(
                tool_name=ReadOnlyToolName.RAG_ANSWER,
                code="TOOL_CONTEXT_INVALID",
                retryable=False,
            )
        if any(
            evidence.source.user_id != context.user_id
            for evidence in context.prepared_context.evidence
        ):
            raise ToolInvocationError(
                tool_name=ReadOnlyToolName.RAG_ANSWER,
                code="TOOL_SOURCE_SCOPE_VIOLATION",
                retryable=False,
            )
        answer = await self._answer_service.generate_answer(
            query=arguments.query,
            prepared=context.prepared_context,
        )
        return RAGAnswerToolResult(answer=answer)

    async def _with_recovery(
        self,
        *,
        tool_name: ReadOnlyToolName,
        timeout_seconds: float,
        max_retries: int,
        operation: Callable[[], Awaitable[_ToolResult]],
    ) -> _ToolResult:
        for attempt in range(1, max_retries + 2):
            started_at = perf_counter()
            try:
                result = await asyncio.wait_for(operation(), timeout=timeout_seconds)
                fields: dict[str, object] = {
                    "toolName": tool_name.value,
                    "attempt": attempt,
                    "durationMs": round((perf_counter() - started_at) * 1_000, 2),
                }
                if isinstance(result, GmailSearchToolResult):
                    fields["resultCount"] = len(result.sources)
                elif isinstance(result, RAGAnswerToolResult):
                    fields["abstained"] = result.answer.abstained
                    fields["citationCount"] = len(result.answer.citations)
                _logger.info("rag.tool.completed", **fields)
                return result
            except ToolInvocationError as error:
                failure_code = error.code
                retryable = error.retryable
            except TimeoutError:
                failure_code = "TOOL_TIMEOUT"
                retryable = True
            except Exception as error:
                raw_code = getattr(error, "code", None)
                failure_code = (
                    raw_code
                    if isinstance(raw_code, str) and _SAFE_ERROR_CODE.fullmatch(raw_code)
                    else "TOOL_EXECUTION_FAILED"
                )
                retryable = getattr(error, "retryable", False) is True

            _logger.warning(
                "rag.tool.attempt_failed",
                toolName=tool_name.value,
                attempt=attempt,
                durationMs=round((perf_counter() - started_at) * 1_000, 2),
                errorCode=failure_code,
                retryable=retryable,
            )

            if retryable and attempt <= max_retries:
                await asyncio.sleep(min(0.05 * (2 ** (attempt - 1)), 0.2))
                continue
            raise ToolInvocationError(
                tool_name=tool_name,
                code=failure_code,
                retryable=retryable,
                attempts=attempt,
            ) from None

        raise ToolInvocationError(
            tool_name=tool_name,
            code="TOOL_EXECUTION_FAILED",
            retryable=False,
            attempts=max_retries + 1,
        )
