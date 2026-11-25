"""Stable, owner-scoped LangGraph checkpoint execution for read-only RAG runs."""

import asyncio
import json
from collections.abc import AsyncIterator, Mapping
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass
from hashlib import sha256
from time import perf_counter
from typing import Protocol, cast
from uuid import UUID

import structlog
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from langgraph.graph.state import CompiledStateGraph
from psycopg import AsyncConnection
from psycopg.rows import DictRow
from psycopg_pool import AsyncConnectionPool

from mailpilot_ai.rag.planning import (
    IntentClassification,
    PlannedOperation,
    PlannedStep,
    RAGIntent,
    RAGRequestPlan,
)
from mailpilot_ai.rag.schemas import (
    GroundedAnswerCitation,
    GroundedAnswerClaim,
    GroundedAnswerResponse,
)
from mailpilot_ai.rag.service import (
    PreparedRAGContext,
    _EvidenceFragment,
    _EvidenceItem,
)
from mailpilot_ai.rag.workflow import (
    RAGWorkflowContext,
    RAGWorkflowInput,
    RAGWorkflowOutput,
    RAGWorkflowState,
)
from mailpilot_ai.vector_store import HybridSearchResult, RetrievalFilters

MAX_GRAPH_STEPS = 16
_logger = structlog.get_logger().bind(service="ai")


class PersistentWorkflowError(RuntimeError):
    """Safe public error for invalid persistent-run transitions."""

    def __init__(self, code: str, message: str, *, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


class WorkflowRunLock(Protocol):
    """Exclusive lock for one stable conversation/run pair."""

    def hold(self, thread_id: str, checkpoint_ns: str) -> AbstractAsyncContextManager[None]: ...


class InProcessWorkflowRunLock:
    """Small local/test lock; production uses PostgreSQL advisory locks."""

    def __init__(self) -> None:
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}

    @asynccontextmanager
    async def hold(self, thread_id: str, checkpoint_ns: str) -> AsyncIterator[None]:
        key = (thread_id, checkpoint_ns)
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            yield


class PostgreSQLWorkflowRunLock:
    """Serialize duplicate requests across AI-service processes and restarts."""

    def __init__(self, pool: AsyncConnectionPool[AsyncConnection[DictRow]]) -> None:
        self._pool = pool

    @asynccontextmanager
    async def hold(self, thread_id: str, checkpoint_ns: str) -> AsyncIterator[None]:
        digest = sha256(f"{thread_id}\0{checkpoint_ns}".encode()).digest()
        first_key = int.from_bytes(digest[:4], byteorder="big", signed=True)
        second_key = int.from_bytes(digest[4:8], byteorder="big", signed=True)
        async with self._pool.connection() as connection:
            await connection.execute("SELECT pg_advisory_lock(%s, %s)", (first_key, second_key))
            try:
                yield
            finally:
                await connection.execute(
                    "SELECT pg_advisory_unlock(%s, %s)", (first_key, second_key)
                )


@dataclass(frozen=True, slots=True)
class RAGWorkflowExecution:
    answer: GroundedAnswerResponse
    thread_id: str
    trace: tuple[str, ...]
    replayed: bool


def stable_thread_id(user_id: UUID, conversation_id: UUID, run_id: UUID) -> str:
    """Return an opaque, stable checkpoint thread for one owner-scoped run."""
    digest = sha256(
        f"mailpilot.rag.run.v1\0{user_id.hex}\0{conversation_id.hex}\0{run_id.hex}".encode()
    )
    return f"rag-v1-{digest.hexdigest()}"


def stable_request_fingerprint(
    *,
    user_id: UUID,
    conversation_id: UUID,
    query: str,
    top_k: int,
    filters: RetrievalFilters,
) -> str:
    """Hash only the normalized semantic request fields used by the graph."""
    payload = {
        "user_id": str(user_id),
        "conversation_id": str(conversation_id),
        "query": query.strip(),
        "top_k": top_k,
        "filters": filters.model_dump(mode="json", by_alias=True),
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return sha256(encoded.encode()).hexdigest()


def checkpoint_serializer() -> JsonPlusSerializer:
    """Allow only application checkpoint types during msgpack deserialization."""
    return JsonPlusSerializer(
        allowed_msgpack_modules=(
            GroundedAnswerCitation,
            GroundedAnswerClaim,
            GroundedAnswerResponse,
            IntentClassification,
            PlannedOperation,
            PlannedStep,
            RAGIntent,
            RAGRequestPlan,
            PreparedRAGContext,
            _EvidenceFragment,
            _EvidenceItem,
            HybridSearchResult,
            RetrievalFilters,
        )
    )


def _config(thread_id: str, run_id: UUID) -> RunnableConfig:
    return {
        "configurable": {"thread_id": thread_id},
        "metadata": {"workflow": "read-only-rag-v1", "run_id": str(run_id)},
        "recursion_limit": MAX_GRAPH_STEPS,
    }


def _checkpoint_exists(config: RunnableConfig) -> bool:
    configurable = config.get("configurable", {})
    return bool(configurable.get("checkpoint_id"))


def _values(snapshot_values: object) -> Mapping[str, object]:
    if isinstance(snapshot_values, Mapping):
        return cast(Mapping[str, object], snapshot_values)
    return {}


def _matches_request(values: Mapping[str, object], workflow_input: RAGWorkflowInput) -> bool:
    return (
        values.get("user_id") == workflow_input["user_id"]
        and values.get("conversation_id") == workflow_input["conversation_id"]
        and values.get("run_id") == workflow_input["run_id"]
        and values.get("request_fingerprint") == workflow_input["request_fingerprint"]
    )


async def _checkpoint_trace(
    graph: CompiledStateGraph[
        RAGWorkflowState,
        RAGWorkflowContext,
        RAGWorkflowInput,
        RAGWorkflowOutput,
    ],
    config: RunnableConfig,
) -> tuple[str, ...]:
    node_names = set(graph.get_graph().nodes)
    snapshots = [snapshot async for snapshot in graph.aget_state_history(config)]
    trace: list[str] = []
    for snapshot in list(reversed(snapshots))[:-1]:
        for node in snapshot.next:
            if node in node_names and not node.startswith("__"):
                trace.append(node)
    return tuple(trace)


async def execute_persistent_rag_workflow(
    *,
    graph: CompiledStateGraph[
        RAGWorkflowState,
        RAGWorkflowContext,
        RAGWorkflowInput,
        RAGWorkflowOutput,
    ],
    workflow_input: RAGWorkflowInput,
    context: RAGWorkflowContext,
    resume: bool,
    request_id: str,
    run_lock: WorkflowRunLock,
) -> RAGWorkflowExecution:
    """Start, safely resume, or idempotently replay one persisted graph run."""
    thread_id = stable_thread_id(
        workflow_input["user_id"],
        workflow_input["conversation_id"],
        workflow_input["run_id"],
    )
    checkpoint_ns = "root"
    config = _config(thread_id, workflow_input["run_id"])

    async with run_lock.hold(thread_id, checkpoint_ns):
        workflow_started_at = perf_counter()
        snapshot = await graph.aget_state(config)
        exists = _checkpoint_exists(snapshot.config)
        state = _values(snapshot.values)

        if exists and not _matches_request(state, workflow_input):
            raise PersistentWorkflowError(
                "RAG_RUN_CONFLICT",
                "This run ID is already bound to a different request.",
                status_code=409,
            )
        if not exists and resume:
            raise PersistentWorkflowError(
                "RAG_RUN_NOT_FOUND",
                "No interrupted workflow run is available to resume.",
                status_code=404,
            )
        if exists and snapshot.next:
            if not resume:
                raise PersistentWorkflowError(
                    "RAG_RUN_IN_PROGRESS",
                    "This workflow run is incomplete; resume it with the same request.",
                    status_code=409,
                )
            graph_input: RAGWorkflowInput | None = None
        elif exists:
            answer_value = state.get("answer")
            if answer_value is None:
                raise PersistentWorkflowError(
                    "RAG_CHECKPOINT_INVALID",
                    "The stored workflow result is incomplete.",
                    status_code=503,
                )
            answer = GroundedAnswerResponse.model_validate(answer_value)
            trace = await _checkpoint_trace(graph, config)
            _logger.info(
                "rag.workflow.replayed",
                requestId=request_id,
                runId=str(workflow_input["run_id"]),
                graphTrace=trace,
                durationMs=round((perf_counter() - workflow_started_at) * 1_000, 2),
            )
            return RAGWorkflowExecution(
                answer=answer,
                thread_id=thread_id,
                trace=trace,
                replayed=True,
            )
        else:
            graph_input = workflow_input

        streamed_trace: list[str] = []
        previous_node_event_at = perf_counter()
        try:
            async for event in graph.astream(
                graph_input,
                config=config,
                context=context,
                stream_mode="updates",
            ):
                if isinstance(event, Mapping):
                    event_time = perf_counter()
                    for node in event:
                        if isinstance(node, str) and not node.startswith("__"):
                            streamed_trace.append(node)
                            _logger.info(
                                "rag.node.completed",
                                requestId=request_id,
                                runId=str(workflow_input["run_id"]),
                                node=node,
                                step=len(streamed_trace),
                                durationMs=round((event_time - previous_node_event_at) * 1_000, 2),
                            )
                    previous_node_event_at = event_time
        except Exception as error:
            try:
                trace = await _checkpoint_trace(graph, config)
            except Exception:
                trace = tuple(streamed_trace)
            _logger.warning(
                "rag.workflow.interrupted",
                requestId=request_id,
                runId=str(workflow_input["run_id"]),
                graphTrace=trace,
                failureType=type(error).__name__,
                durationMs=round((perf_counter() - workflow_started_at) * 1_000, 2),
            )
            raise

        final_snapshot = await graph.aget_state(config)
        final_state = _values(final_snapshot.values)
        if not _matches_request(final_state, workflow_input):
            raise PersistentWorkflowError(
                "RAG_CHECKPOINT_INVALID",
                "The stored workflow state did not match the requested run.",
                status_code=503,
            )
        answer_value = final_state.get("answer")
        if answer_value is None:
            raise PersistentWorkflowError(
                "RAG_CHECKPOINT_INVALID",
                "The workflow completed without a result.",
                status_code=503,
            )
        answer = GroundedAnswerResponse.model_validate(answer_value)
        try:
            trace = await _checkpoint_trace(graph, config)
        except Exception:
            trace = tuple(streamed_trace)
        if not trace:
            trace = tuple(streamed_trace)
        _logger.info(
            "rag.workflow.completed",
            requestId=request_id,
            runId=str(workflow_input["run_id"]),
            graphTrace=trace,
            abstained=answer.abstained,
            durationMs=round((perf_counter() - workflow_started_at) * 1_000, 2),
        )
        return RAGWorkflowExecution(
            answer=answer,
            thread_id=thread_id,
            trace=trace,
            replayed=False,
        )
