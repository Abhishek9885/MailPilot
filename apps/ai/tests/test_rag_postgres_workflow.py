"""Opt-in PostgreSQL saver restart test using MAILPILOT_TEST_DATABASE_URL."""

import os
from uuid import UUID, uuid4

import pytest
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from mailpilot_ai.database import psycopg_connection_url
from mailpilot_ai.llm.contracts import LLMRequest, LLMResponse
from mailpilot_ai.rag.persistence import (
    PostgreSQLWorkflowRunLock,
    checkpoint_serializer,
    execute_persistent_rag_workflow,
    stable_request_fingerprint,
    stable_thread_id,
)
from mailpilot_ai.rag.planning import (
    IntentClassification,
    PlannedOperation,
    PlannedStep,
    RAGIntent,
    RAGRequestPlan,
)
from mailpilot_ai.rag.service import GroundedRAGAnswerService
from mailpilot_ai.rag.workflow import (
    RAGWorkflowContext,
    RAGWorkflowInput,
    build_read_only_rag_graph,
)
from mailpilot_ai.vector_store import HybridSearchResult, RetrievalFilters

_TEST_DATABASE_URL = os.getenv("MAILPILOT_TEST_DATABASE_URL")


class EmptyRetriever:
    async def retrieve(
        self,
        *,
        user_id: UUID,
        query: str,
        limit: int,
        filters: RetrievalFilters | None,
    ) -> tuple[HybridSearchResult, ...]:
        del user_id, query, limit, filters
        return ()


class UnusedProvider:
    async def generate(self, _request: LLMRequest) -> LLMResponse:
        raise AssertionError("Empty evidence should not call the answer model")


class FailOncePlanner:
    def __init__(self) -> None:
        self.fail = True

    async def classify(self, _query: str) -> IntentClassification:
        if self.fail:
            self.fail = False
            raise RuntimeError("simulated process interruption")
        return IntentClassification(intent=RAGIntent.EMAIL_SEARCH, confidence=0.99)

    async def create_plan(
        self,
        *,
        query: str,
        classification: IntentClassification,
    ) -> RAGRequestPlan:
        del query
        return RAGRequestPlan(
            intent=classification.intent,
            steps=(PlannedStep(operation=PlannedOperation.SEARCH_EMAILS),),
        )

    def validate_plan(
        self,
        classification: IntentClassification,
        plan: RAGRequestPlan,
    ) -> RAGRequestPlan:
        assert plan.intent is classification.intent
        return plan


def _test_pool(database_url: str) -> AsyncConnectionPool:
    return AsyncConnectionPool(
        conninfo=psycopg_connection_url(database_url),
        min_size=1,
        max_size=4,
        kwargs={
            "autocommit": True,
            "row_factory": dict_row,
            "options": "-c search_path=ai,public",
            "connect_timeout": 5,
        },
        open=False,
    )


@pytest.mark.anyio
@pytest.mark.skipif(
    not _TEST_DATABASE_URL,
    reason="Set MAILPILOT_TEST_DATABASE_URL to run PostgreSQL persistence tests",
)
async def test_postgres_checkpoint_recovers_after_pool_and_graph_restart() -> None:
    assert _TEST_DATABASE_URL is not None
    user_id = uuid4()
    conversation_id = uuid4()
    run_id = uuid4()
    filters = RetrievalFilters()
    workflow_input: RAGWorkflowInput = {
        "user_id": user_id,
        "conversation_id": conversation_id,
        "run_id": run_id,
        "request_fingerprint": stable_request_fingerprint(
            user_id=user_id,
            conversation_id=conversation_id,
            query="Summarize recent mail",
            top_k=5,
            filters=filters,
        ),
        "query": "Summarize recent mail",
        "top_k": 5,
        "filters": filters,
    }
    planner = FailOncePlanner()
    context = RAGWorkflowContext(
        answer_service=GroundedRAGAnswerService(
            retriever=EmptyRetriever(), provider=UnusedProvider()
        ),
        planning_service=planner,
    )
    thread_id = stable_thread_id(user_id, conversation_id, run_id)

    first_pool = _test_pool(_TEST_DATABASE_URL)
    await first_pool.open(wait=True)
    try:
        async with first_pool.connection() as connection:
            await connection.execute("CREATE SCHEMA IF NOT EXISTS ai")
        first_saver = AsyncPostgresSaver(first_pool, serde=checkpoint_serializer())
        await first_saver.setup()
        with pytest.raises(RuntimeError, match="simulated process interruption"):
            await execute_persistent_rag_workflow(
                graph=build_read_only_rag_graph(checkpointer=first_saver),
                workflow_input=workflow_input,
                context=context,
                resume=False,
                request_id="postgres-before-restart",
                run_lock=PostgreSQLWorkflowRunLock(first_pool),
            )
    finally:
        await first_pool.close()

    second_pool = _test_pool(_TEST_DATABASE_URL)
    await second_pool.open(wait=True)
    try:
        second_saver = AsyncPostgresSaver(second_pool, serde=checkpoint_serializer())
        await second_saver.setup()
        execution = await execute_persistent_rag_workflow(
            graph=build_read_only_rag_graph(checkpointer=second_saver),
            workflow_input=workflow_input,
            context=context,
            resume=True,
            request_id="postgres-after-restart",
            run_lock=PostgreSQLWorkflowRunLock(second_pool),
        )
        assert execution.thread_id == thread_id
        assert execution.trace[0] == "interpret_request"
        assert execution.answer.abstained is True
        await second_saver.adelete_thread(thread_id)
    finally:
        await second_pool.close()
