import json
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import cast
from uuid import UUID, uuid4

import pytest
from langgraph.checkpoint.memory import InMemorySaver

from mailpilot_ai.llm.contracts import LLMRequest, LLMResponse
from mailpilot_ai.rag.persistence import (
    InProcessWorkflowRunLock,
    PersistentWorkflowError,
    checkpoint_serializer,
    execute_persistent_rag_workflow,
    stable_request_fingerprint,
)
from mailpilot_ai.rag.planning import (
    IntentClassification,
    PlannedOperation,
    PlannedStep,
    RAGIntent,
    RAGIntentPlanningService,
    RAGPlanningOutputError,
    RAGRequestPlan,
)
from mailpilot_ai.rag.schemas import GroundedAnswerResponse
from mailpilot_ai.rag.service import (
    GroundedAnswerInputError,
    GroundedRAGAnswerService,
    PreparedRAGContext,
)
from mailpilot_ai.rag.workflow import (
    RAGWorkflowContext,
    RAGWorkflowInput,
    build_read_only_rag_graph,
)
from mailpilot_ai.vector_store import HybridSearchResult, RetrievalFilters


class FakeRetriever:
    def __init__(self, sources: Sequence[HybridSearchResult]) -> None:
        self.sources = tuple(sources)
        self.calls: list[dict[str, object]] = []

    async def retrieve(
        self,
        *,
        user_id: UUID,
        query: str,
        limit: int,
        filters: RetrievalFilters | None,
    ) -> tuple[HybridSearchResult, ...]:
        self.calls.append({"user_id": user_id, "query": query, "limit": limit, "filters": filters})
        return self.sources


class FakeLLMProvider:
    def __init__(self) -> None:
        self.calls = 0

    async def generate(self, _request: LLMRequest) -> LLMResponse:
        self.calls += 1
        evidence = "Invoice INV-42 is due on 2026-11-22."
        return LLMResponse(
            text=json.dumps(
                {
                    "answer": f"{evidence} [E1]",
                    "abstained": False,
                    "claims": [
                        {
                            "claim": evidence,
                            "citationId": "E1",
                            "evidenceQuote": evidence,
                        }
                    ],
                    "unknowns": [],
                    "abstentionReason": None,
                }
            ),
            provider="test-provider",
            model="test-model-v1",
            response_id="test-response-1",
        )


class FakePlanner:
    def __init__(
        self,
        intent: RAGIntent = RAGIntent.EMAIL_SEARCH,
        confidence: float = 0.99,
    ) -> None:
        self.classification = IntentClassification(intent=intent, confidence=confidence)
        self.classify_calls = 0
        self.plan_calls = 0
        self._validator = RAGIntentPlanningService(provider=FakeLLMProvider())

    async def classify(self, _query: str) -> IntentClassification:
        self.classify_calls += 1
        return self.classification

    async def create_plan(
        self,
        *,
        query: str,
        classification: IntentClassification,
    ) -> RAGRequestPlan:
        del query
        self.plan_calls += 1
        if classification.requires_clarification:
            return RAGRequestPlan.clarification()
        operations = {
            RAGIntent.EMAIL_SEARCH: (PlannedOperation.SEARCH_EMAILS,),
            RAGIntent.SUMMARIZATION: (
                PlannedOperation.SEARCH_EMAILS,
                PlannedOperation.SUMMARIZE_EVIDENCE,
            ),
            RAGIntent.ACTION_ITEM_EXTRACTION: (
                PlannedOperation.SEARCH_EMAILS,
                PlannedOperation.EXTRACT_ACTION_ITEMS,
            ),
            RAGIntent.DRAFTING: (
                PlannedOperation.SEARCH_EMAILS,
                PlannedOperation.DRAFT_REPLY,
            ),
            RAGIntent.TASK_OPERATION: (
                PlannedOperation.SEARCH_EMAILS,
                PlannedOperation.EXTRACT_ACTION_ITEMS,
                PlannedOperation.PROPOSE_TASK_CANDIDATES,
            ),
        }
        return RAGRequestPlan(
            intent=classification.intent,
            steps=tuple(
                PlannedStep(operation=operation) for operation in operations[classification.intent]
            ),
        )

    def validate_plan(
        self,
        classification: IntentClassification,
        plan: RAGRequestPlan,
    ) -> RAGRequestPlan:
        return self._validator.validate_plan(classification, plan)


def _source(
    user_id: UUID,
    content: str = "Invoice INV-42 is due on 2026-11-22.",
) -> HybridSearchResult:
    return HybridSearchResult(
        user_id=user_id,
        chunk_id=uuid4(),
        email_id=uuid4(),
        provider_message_id="gmail-message-42",
        provider_thread_id="gmail-thread-9",
        source_revision=1,
        chunker_version="email-char-chunker-v1",
        start_char=0,
        end_char=len(content),
        content=content,
        content_hash="a" * 64,
        received_at=datetime(2026, 11, 15, 9, 30, tzinfo=UTC),
        sender_name="Morgan Sender",
        sender_email="morgan@example.test",
        subject="Invoice follow-up",
        vector_rank=1,
        keyword_rank=1,
        fusion_score=0.032,
    )


def _input(user_id: UUID, *, top_k: int = 4) -> dict[str, object]:
    conversation_id = uuid4()
    run_id = uuid4()
    filters = RetrievalFilters()
    return {
        "user_id": user_id,
        "conversation_id": conversation_id,
        "run_id": run_id,
        "request_fingerprint": stable_request_fingerprint(
            user_id=user_id,
            conversation_id=conversation_id,
            query="When is invoice INV-42 due?",
            top_k=top_k,
            filters=filters,
        ),
        "query": "When is invoice INV-42 due?",
        "top_k": top_k,
        "filters": filters,
    }


@pytest.mark.anyio
async def test_graph_runs_read_only_nodes_and_exposes_only_the_answer() -> None:
    user_id = uuid4()
    retriever = FakeRetriever((_source(user_id),))
    llm = FakeLLMProvider()
    answer_service = GroundedRAGAnswerService(retriever=retriever, provider=llm)
    graph = build_read_only_rag_graph()

    result = await graph.ainvoke(
        _input(user_id),
        context=RAGWorkflowContext(
            answer_service=answer_service,
            planning_service=FakePlanner(),
        ),
    )
    answer = GroundedAnswerResponse.model_validate(result["answer"])

    assert set(result) == {"answer"}
    assert answer.abstained is False
    assert answer.citations[0].provider_message_id == "gmail-message-42"
    assert retriever.calls[0]["limit"] == 4
    assert llm.calls == 1


@pytest.mark.anyio
@pytest.mark.parametrize(
    "intent",
    [
        RAGIntent.SUMMARIZATION,
        RAGIntent.ACTION_ITEM_EXTRACTION,
        RAGIntent.TASK_OPERATION,
    ],
)
async def test_graph_routes_allowlisted_read_only_intents_to_retrieval(
    intent: RAGIntent,
) -> None:
    user_id = uuid4()
    retriever = FakeRetriever((_source(user_id),))
    llm = FakeLLMProvider()
    planner = FakePlanner(intent)
    graph = build_read_only_rag_graph()

    result = await graph.ainvoke(
        _input(user_id),
        context=RAGWorkflowContext(
            answer_service=GroundedRAGAnswerService(retriever=retriever, provider=llm),
            planning_service=planner,
        ),
    )

    assert GroundedAnswerResponse.model_validate(result["answer"]).abstained is False
    assert retriever.calls
    assert planner.classify_calls == 1
    assert planner.plan_calls == 1


@pytest.mark.anyio
async def test_graph_rejects_invalid_plan_before_retrieval_or_answer_generation() -> None:
    class InvalidPlanPlanner(FakePlanner):
        async def create_plan(
            self,
            *,
            query: str,
            classification: IntentClassification,
        ) -> RAGRequestPlan:
            del query, classification
            self.plan_calls += 1
            return RAGRequestPlan(
                intent=RAGIntent.EMAIL_SEARCH,
                steps=(PlannedStep(operation=PlannedOperation.SUMMARIZE_EVIDENCE),),
            )

    user_id = uuid4()
    retriever = FakeRetriever((_source(user_id),))
    llm = FakeLLMProvider()
    graph = build_read_only_rag_graph()

    with pytest.raises(RAGPlanningOutputError):
        await graph.ainvoke(
            _input(user_id),
            context=RAGWorkflowContext(
                answer_service=GroundedRAGAnswerService(retriever=retriever, provider=llm),
                planning_service=InvalidPlanPlanner(),
            ),
        )

    assert retriever.calls == []
    assert llm.calls == 0


@pytest.mark.anyio
async def test_graph_routes_empty_retrieval_to_abstention_without_model_call() -> None:
    user_id = uuid4()
    retriever = FakeRetriever(())
    llm = FakeLLMProvider()
    graph = build_read_only_rag_graph()

    result = await graph.ainvoke(
        _input(user_id),
        context=RAGWorkflowContext(
            answer_service=GroundedRAGAnswerService(retriever=retriever, provider=llm),
            planning_service=FakePlanner(),
        ),
    )
    answer = GroundedAnswerResponse.model_validate(result["answer"])

    assert answer.abstained is True
    assert answer.citations == ()
    assert "No matching" in (answer.abstention_reason or "")
    assert llm.calls == 0


@pytest.mark.anyio
async def test_graph_falls_back_safely_when_search_tool_fails() -> None:
    class FailedRetriever(FakeRetriever):
        async def retrieve(
            self,
            *,
            user_id: UUID,
            query: str,
            limit: int,
            filters: RetrievalFilters | None,
        ) -> tuple[HybridSearchResult, ...]:
            del user_id, query, limit, filters
            self.calls.append({"failed": True})
            raise RuntimeError("provider response and email content must stay private")

    user_id = uuid4()
    retriever = FailedRetriever(())
    llm = FakeLLMProvider()
    graph = build_read_only_rag_graph()

    result = await graph.ainvoke(
        _input(user_id),
        context=RAGWorkflowContext(
            answer_service=GroundedRAGAnswerService(retriever=retriever, provider=llm),
            planning_service=FakePlanner(),
        ),
    )
    answer = GroundedAnswerResponse.model_validate(result["answer"])

    assert answer.abstained is True
    assert "couldn't safely search" in (answer.abstention_reason or "")
    assert "provider response" not in (answer.abstention_reason or "")
    assert len(retriever.calls) == 1
    assert llm.calls == 0


@pytest.mark.anyio
async def test_graph_falls_back_safely_when_rag_answer_tool_fails() -> None:
    class FailedLLMProvider(FakeLLMProvider):
        async def generate(self, _request: LLMRequest) -> LLMResponse:
            self.calls += 1
            raise RuntimeError("private model response")

    user_id = uuid4()
    retriever = FakeRetriever((_source(user_id),))
    llm = FailedLLMProvider()
    graph = build_read_only_rag_graph()

    result = await graph.ainvoke(
        _input(user_id),
        context=RAGWorkflowContext(
            answer_service=GroundedRAGAnswerService(retriever=retriever, provider=llm),
            planning_service=FakePlanner(),
        ),
    )
    answer = GroundedAnswerResponse.model_validate(result["answer"])

    assert answer.abstained is True
    assert "couldn't generate a grounded answer" in (answer.abstention_reason or "")
    assert "private model response" not in (answer.abstention_reason or "")
    assert len(retriever.calls) == 1
    assert llm.calls == 1


@pytest.mark.anyio
async def test_graph_routes_ambiguous_intent_to_clarification() -> None:
    user_id = uuid4()
    retriever = FakeRetriever((_source(user_id),))
    llm = FakeLLMProvider()
    planner = FakePlanner(RAGIntent.AMBIGUOUS, confidence=0.2)
    graph = build_read_only_rag_graph()

    result = await graph.ainvoke(
        _input(user_id),
        context=RAGWorkflowContext(
            answer_service=GroundedRAGAnswerService(retriever=retriever, provider=llm),
            planning_service=planner,
        ),
    )
    answer = GroundedAnswerResponse.model_validate(result["answer"])

    assert answer.abstained is True
    assert "Would you like to" in (answer.abstention_reason or "")
    assert retriever.calls == []
    assert planner.classify_calls == 1
    assert planner.plan_calls == 1
    assert llm.calls == 0


@pytest.mark.anyio
async def test_graph_keeps_drafting_as_plan_only_in_this_read_only_workflow() -> None:
    user_id = uuid4()
    retriever = FakeRetriever((_source(user_id),))
    llm = FakeLLMProvider()
    planner = FakePlanner(RAGIntent.DRAFTING)
    graph = build_read_only_rag_graph()

    result = await graph.ainvoke(
        _input(user_id),
        context=RAGWorkflowContext(
            answer_service=GroundedRAGAnswerService(retriever=retriever, provider=llm),
            planning_service=planner,
        ),
    )
    answer = GroundedAnswerResponse.model_validate(result["answer"])

    assert answer.abstained is True
    assert "reply-draft service" in (answer.abstention_reason or "")
    assert retriever.calls == []
    assert planner.plan_calls == 1
    assert llm.calls == 0


@pytest.mark.anyio
async def test_graph_routes_over_budget_evidence_to_abstention() -> None:
    user_id = uuid4()
    retriever = FakeRetriever((_source(user_id, "Long record. " + ("x" * 80_000)),))
    llm = FakeLLMProvider()
    answer_service = GroundedRAGAnswerService(
        retriever=retriever,
        provider=llm,
        context_token_budget=512,
        token_counter=lambda text: (len(text) + 99) // 100,
    )
    graph = build_read_only_rag_graph()

    result = await graph.ainvoke(
        _input(user_id),
        context=RAGWorkflowContext(
            answer_service=answer_service,
            planning_service=FakePlanner(),
        ),
    )
    answer = GroundedAnswerResponse.model_validate(result["answer"])

    assert answer.abstained is True
    assert "does not fit" in (answer.abstention_reason or "")
    assert llm.calls == 0


@pytest.mark.anyio
async def test_graph_validates_input_before_retrieval() -> None:
    user_id = uuid4()
    retriever = FakeRetriever((_source(user_id),))
    answer_service = GroundedRAGAnswerService(
        retriever=retriever,
        provider=FakeLLMProvider(),
    )
    graph = build_read_only_rag_graph()

    with pytest.raises(GroundedAnswerInputError):
        await graph.ainvoke(
            _input(user_id, top_k=0),
            context=RAGWorkflowContext(
                answer_service=answer_service,
                planning_service=FakePlanner(),
            ),
        )

    assert retriever.calls == []


@pytest.mark.anyio
async def test_graph_rejects_missing_persistent_identifiers_before_planning() -> None:
    user_id = uuid4()
    graph_input = _input(user_id)
    graph_input.pop("run_id")
    retriever = FakeRetriever((_source(user_id),))
    planner = FakePlanner()
    graph = build_read_only_rag_graph()

    with pytest.raises(GroundedAnswerInputError, match="graph request is invalid"):
        await graph.ainvoke(
            graph_input,
            context=RAGWorkflowContext(
                answer_service=GroundedRAGAnswerService(
                    retriever=retriever, provider=FakeLLMProvider()
                ),
                planning_service=planner,
            ),
        )

    assert retriever.calls == []
    assert planner.classify_calls == 0


def test_graph_topology_is_renderable_and_has_conditional_answer_route() -> None:
    graph = build_read_only_rag_graph()
    mermaid = graph.get_graph().draw_mermaid()

    for node in (
        "interpret_request",
        "classify_intent",
        "create_plan",
        "validate_plan",
        "gmail_search",
        "tool_failure",
        "assemble_evidence",
        "rag_answer",
        "abstain",
        "return_response",
    ):
        assert node in mermaid
    assert "assemble_evidence -.-> abstain" in mermaid
    assert "assemble_evidence -.-> rag_answer" in mermaid
    assert "validate_plan -.-> clarify" in mermaid
    assert "validate_plan -.-> drafting_notice" in mermaid
    assert "validate_plan -.-> gmail_search" in mermaid
    assert "gmail_search -.-> tool_failure" in mermaid


@pytest.mark.anyio
async def test_persistent_workflow_replays_completed_runs_and_scopes_users() -> None:
    conversation_id = uuid4()
    run_id = uuid4()
    user_one = uuid4()
    user_two = uuid4()
    saver = InMemorySaver()
    graph = build_read_only_rag_graph(checkpointer=saver)
    lock = InProcessWorkflowRunLock()

    def make_input(user_id: UUID) -> RAGWorkflowInput:
        filters = RetrievalFilters()
        return {
            "user_id": user_id,
            "conversation_id": conversation_id,
            "run_id": run_id,
            "request_fingerprint": stable_request_fingerprint(
                user_id=user_id,
                conversation_id=conversation_id,
                query="When is invoice INV-42 due?",
                top_k=4,
                filters=filters,
            ),
            "query": "When is invoice INV-42 due?",
            "top_k": 4,
            "filters": filters,
        }

    user_one_retriever = FakeRetriever((_source(user_one),))
    user_one_llm = FakeLLMProvider()
    user_one_context = RAGWorkflowContext(
        answer_service=GroundedRAGAnswerService(
            retriever=user_one_retriever, provider=user_one_llm
        ),
        planning_service=FakePlanner(),
    )
    first = await execute_persistent_rag_workflow(
        graph=graph,
        workflow_input=make_input(user_one),
        context=user_one_context,
        resume=False,
        request_id="request-one",
        run_lock=lock,
    )
    replay = await execute_persistent_rag_workflow(
        graph=graph,
        workflow_input=make_input(user_one),
        context=user_one_context,
        resume=False,
        request_id="request-one-retry",
        run_lock=lock,
    )

    user_two_retriever = FakeRetriever((_source(user_two, "Private user-two evidence."),))
    user_two_context = RAGWorkflowContext(
        answer_service=GroundedRAGAnswerService(
            retriever=user_two_retriever, provider=FakeLLMProvider()
        ),
        planning_service=FakePlanner(),
    )
    user_two_run = await execute_persistent_rag_workflow(
        graph=graph,
        workflow_input=make_input(user_two),
        context=user_two_context,
        resume=False,
        request_id="request-two",
        run_lock=lock,
    )

    assert first.replayed is False
    assert replay.replayed is True
    assert first.trace[0] == "interpret_request"
    assert replay.trace == first.trace
    assert first.thread_id == replay.thread_id
    assert user_one_retriever.calls and len(user_one_retriever.calls) == 1
    assert user_one_llm.calls == 1
    assert user_two_run.thread_id != first.thread_id
    assert len(user_two_retriever.calls) == 1


@pytest.mark.anyio
async def test_persistent_workflow_resumes_after_node_failure_without_replaying_nodes() -> None:
    class FailOncePlanner(FakePlanner):
        def __init__(self) -> None:
            super().__init__()
            self.should_fail = True

        async def classify(self, query: str) -> IntentClassification:
            self.classify_calls += 1
            if self.should_fail:
                self.should_fail = False
                raise RuntimeError("private email content must not be logged")
            return self.classification

    user_id = uuid4()
    workflow_input = cast(RAGWorkflowInput, _input(user_id))
    retriever = FakeRetriever((_source(user_id),))
    llm = FakeLLMProvider()
    planner = FailOncePlanner()
    context = RAGWorkflowContext(
        answer_service=GroundedRAGAnswerService(retriever=retriever, provider=llm),
        planning_service=planner,
    )
    lock = InProcessWorkflowRunLock()
    saver = InMemorySaver()
    graph_before_restart = build_read_only_rag_graph(checkpointer=saver)

    with pytest.raises(RuntimeError, match="private email content"):
        await execute_persistent_rag_workflow(
            graph=graph_before_restart,
            workflow_input=workflow_input,
            context=context,
            resume=False,
            request_id="interrupted-request",
            run_lock=lock,
        )

    with pytest.raises(PersistentWorkflowError) as in_progress:
        await execute_persistent_rag_workflow(
            graph=graph_before_restart,
            workflow_input=workflow_input,
            context=context,
            resume=False,
            request_id="not-resumed-request",
            run_lock=lock,
        )
    assert in_progress.value.code == "RAG_RUN_IN_PROGRESS"

    graph_after_restart = build_read_only_rag_graph(checkpointer=saver)
    resumed = await execute_persistent_rag_workflow(
        graph=graph_after_restart,
        workflow_input=workflow_input,
        context=context,
        resume=True,
        request_id="resumed-request",
        run_lock=lock,
    )

    assert resumed.replayed is False
    assert resumed.trace[0] == "interpret_request"
    assert resumed.trace.count("interpret_request") == 1
    assert resumed.trace.count("classify_intent") == 1
    assert planner.classify_calls == 2
    assert len(retriever.calls) == 1
    assert llm.calls == 1


@pytest.mark.anyio
async def test_persistent_workflow_rejects_resume_without_checkpoint_and_changed_payload() -> None:
    user_id = uuid4()
    workflow_input = cast(RAGWorkflowInput, _input(user_id))
    retriever = FakeRetriever((_source(user_id),))
    context = RAGWorkflowContext(
        answer_service=GroundedRAGAnswerService(retriever=retriever, provider=FakeLLMProvider()),
        planning_service=FakePlanner(),
    )
    saver = InMemorySaver()
    graph = build_read_only_rag_graph(checkpointer=saver)
    lock = InProcessWorkflowRunLock()

    with pytest.raises(PersistentWorkflowError) as missing:
        await execute_persistent_rag_workflow(
            graph=graph,
            workflow_input=workflow_input,
            context=context,
            resume=True,
            request_id="missing-resume",
            run_lock=lock,
        )
    assert missing.value.code == "RAG_RUN_NOT_FOUND"

    await execute_persistent_rag_workflow(
        graph=graph,
        workflow_input=workflow_input,
        context=context,
        resume=False,
        request_id="first-run",
        run_lock=lock,
    )
    filters = workflow_input["filters"]
    assert isinstance(filters, RetrievalFilters)
    changed_input: RAGWorkflowInput = {
        **workflow_input,
        "query": "A different query",
        "request_fingerprint": stable_request_fingerprint(
            user_id=user_id,
            conversation_id=workflow_input["conversation_id"],
            query="A different query",
            top_k=workflow_input["top_k"],
            filters=filters,
        ),
    }

    with pytest.raises(PersistentWorkflowError) as conflict:
        await execute_persistent_rag_workflow(
            graph=graph,
            workflow_input=changed_input,
            context=context,
            resume=True,
            request_id="changed-payload",
            run_lock=lock,
        )
    assert conflict.value.code == "RAG_RUN_CONFLICT"


@pytest.mark.anyio
async def test_checkpoint_serializer_round_trips_allowlisted_email_source() -> None:
    source = _source(uuid4())
    serializer = checkpoint_serializer()
    answer_service = GroundedRAGAnswerService(
        retriever=FakeRetriever((source,)),
        provider=FakeLLMProvider(),
    )
    prepared = answer_service.assemble_evidence(
        query="When is invoice INV-42 due?", retrieved=(source,)
    )
    result = await answer_service.generate_answer(
        query="When is invoice INV-42 due?", prepared=prepared
    )
    checkpoint_state = {
        "source": source,
        "prepared_context": prepared,
        "answer": result,
        "intent": IntentClassification(intent=RAGIntent.EMAIL_SEARCH, confidence=0.99),
        "plan": RAGRequestPlan(
            intent=RAGIntent.EMAIL_SEARCH,
            steps=(PlannedStep(operation=PlannedOperation.SEARCH_EMAILS),),
        ),
    }

    serialized = serializer.dumps_typed(checkpoint_state)
    restored = serializer.loads_typed(serialized)

    assert isinstance(restored, dict)
    restored_source = restored["source"]
    restored_context = restored["prepared_context"]
    restored_answer = restored["answer"]
    assert isinstance(restored_source, HybridSearchResult)
    assert restored_source.provider_message_id == source.provider_message_id
    assert restored_source.content == source.content
    assert isinstance(restored_context, PreparedRAGContext)
    assert restored_context.evidence[0].fragments[0].text == source.content
    assert isinstance(restored_answer, GroundedAnswerResponse)
    assert restored_answer.citations[0].provider_message_id == source.provider_message_id
