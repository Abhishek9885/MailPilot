"""Read-only LangGraph workflow for grounded answers over mailbox evidence."""

from dataclasses import dataclass
from typing import Literal, TypedDict
from uuid import UUID

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.runtime import Runtime
from pydantic import ValidationError

from mailpilot_ai.rag.planning import (
    IntentClassification,
    RAGIntent,
    RAGPlanner,
    RAGRequestPlan,
)
from mailpilot_ai.rag.schemas import GroundedAnswerResponse
from mailpilot_ai.rag.service import (
    GroundedAnswerInputError,
    GroundedRAGAnswerService,
    PreparedRAGContext,
)
from mailpilot_ai.rag.tools import (
    GmailSearchToolResult,
    RAGAnswerArguments,
    RAGAnswerToolResult,
    ReadOnlyRAGToolRegistry,
    ReadOnlyToolName,
    ToolInvocationContext,
    ToolInvocationError,
)
from mailpilot_ai.retrieval.schemas import RetrievalRequest
from mailpilot_ai.vector_store import HybridSearchResult, RetrievalFilters


class RAGWorkflowInput(TypedDict):
    """Minimal, validated request fields accepted by the graph."""

    user_id: UUID
    conversation_id: UUID
    run_id: UUID
    request_fingerprint: str
    query: str
    top_k: int
    filters: RetrievalFilters | None


class RAGWorkflowState(RAGWorkflowInput, total=False):
    """Private, checkpointed state; only the final answer is exposed to callers."""

    retrieved_sources: tuple[HybridSearchResult, ...]
    prepared_context: PreparedRAGContext
    intent: IntentClassification
    plan: RAGRequestPlan
    answer: GroundedAnswerResponse
    tool_error_code: str


class RAGWorkflowOutput(TypedDict):
    answer: GroundedAnswerResponse


@dataclass(frozen=True, slots=True)
class RAGWorkflowContext:
    """Runtime dependencies kept outside graph state and checkpoints."""

    answer_service: GroundedRAGAnswerService
    planning_service: RAGPlanner
    tool_registry: ReadOnlyRAGToolRegistry | None = None

    def __post_init__(self) -> None:
        if self.tool_registry is None:
            object.__setattr__(
                self,
                "tool_registry",
                ReadOnlyRAGToolRegistry(answer_service=self.answer_service),
            )

    @property
    def tools(self) -> ReadOnlyRAGToolRegistry:
        registry = self.tool_registry
        if registry is None:
            raise RuntimeError("The read-only tool registry is not configured")
        return registry


class _InterpretedRequest(TypedDict):
    user_id: UUID
    conversation_id: UUID
    run_id: UUID
    request_fingerprint: str
    query: str
    top_k: int
    filters: RetrievalFilters


class _SearchUpdate(TypedDict):
    retrieved_sources: tuple[HybridSearchResult, ...]
    tool_error_code: str


class _ClassificationUpdate(TypedDict):
    intent: IntentClassification


class _PlanUpdate(TypedDict):
    plan: RAGRequestPlan


class _PreparedContext(TypedDict):
    retrieved_sources: tuple[HybridSearchResult, ...]
    prepared_context: PreparedRAGContext


class _AnswerUpdate(TypedDict):
    answer: GroundedAnswerResponse


class _ToolFailureUpdate(_AnswerUpdate):
    tool_error_code: str


def _interpret_request(
    state: RAGWorkflowState,
    runtime: Runtime[RAGWorkflowContext],
) -> _InterpretedRequest:
    conversation_id = state.get("conversation_id")
    run_id = state.get("run_id")
    request_fingerprint = state.get("request_fingerprint")
    if (
        not isinstance(conversation_id, UUID)
        or not isinstance(run_id, UUID)
        or not isinstance(request_fingerprint, str)
        or len(request_fingerprint) != 64
        or any(char not in "0123456789abcdef" for char in request_fingerprint)
    ):
        raise GroundedAnswerInputError("RAG_QUERY_INVALID", "The graph request is invalid")
    try:
        request = RetrievalRequest.model_validate(
            {
                "user_id": state["user_id"],
                "query": state["query"],
                "top_k": state["top_k"],
                "filters": state.get("filters") or {},
            }
        )
    except (ValidationError, TypeError):
        raise GroundedAnswerInputError(
            "RAG_QUERY_INVALID", "The graph request is invalid"
        ) from None
    request_query = request.query.strip()
    runtime.context.answer_service.validate_request(
        query=request_query,
        top_k=request.top_k,
    )
    return {
        "user_id": request.user_id,
        "conversation_id": conversation_id,
        "run_id": run_id,
        "request_fingerprint": request_fingerprint,
        "query": request_query,
        "top_k": request.top_k,
        "filters": request.filters,
    }


async def _classify_intent(
    state: RAGWorkflowState,
    runtime: Runtime[RAGWorkflowContext],
) -> _ClassificationUpdate:
    return {"intent": await runtime.context.planning_service.classify(state["query"])}


async def _create_plan(
    state: RAGWorkflowState,
    runtime: Runtime[RAGWorkflowContext],
) -> _PlanUpdate:
    classification = state.get("intent")
    if classification is None:
        raise GroundedAnswerInputError(
            "RAG_GRAPH_STATE_INVALID", "The request intent was not classified"
        )
    plan = await runtime.context.planning_service.create_plan(
        query=state["query"],
        classification=classification,
    )
    return {"plan": plan}


def _validate_plan(
    state: RAGWorkflowState,
    runtime: Runtime[RAGWorkflowContext],
) -> _PlanUpdate:
    classification = state.get("intent")
    plan = state.get("plan")
    if classification is None or plan is None:
        raise GroundedAnswerInputError("RAG_GRAPH_STATE_INVALID", "The request plan is incomplete")
    return {"plan": runtime.context.planning_service.validate_plan(classification, plan)}


def _route_after_plan(
    state: RAGWorkflowState,
) -> Literal["clarify", "drafting_notice", "gmail_search"]:
    plan = state.get("plan")
    intent = state.get("intent")
    if plan is None or intent is None or plan.intent is RAGIntent.AMBIGUOUS:
        return "clarify"
    if intent.intent is RAGIntent.DRAFTING:
        return "drafting_notice"
    return "gmail_search"


def _route_after_retrieval(
    state: RAGWorkflowState,
) -> Literal["tool_failure", "assemble_evidence"]:
    if state.get("tool_error_code"):
        return "tool_failure"
    return "assemble_evidence"


def _clarify(
    state: RAGWorkflowState,
    runtime: Runtime[RAGWorkflowContext],
) -> _AnswerUpdate:
    plan = state.get("plan")
    reason = (
        plan.clarification_question
        if plan is not None and plan.clarification_question is not None
        else "Please clarify what you would like MailPilot to do."
    )
    return {"answer": runtime.context.answer_service.abstain_for_request(reason)}


def _drafting_notice(
    state: RAGWorkflowState,
    runtime: Runtime[RAGWorkflowContext],
) -> _AnswerUpdate:
    del state
    return {
        "answer": runtime.context.answer_service.abstain_for_request(
            "The request is planned as a reply draft. Use the selected-thread reply-draft service; "
            "this workflow does not generate or save drafts."
        )
    }


async def _retrieve_emails(
    state: RAGWorkflowState,
    runtime: Runtime[RAGWorkflowContext],
) -> _SearchUpdate:
    try:
        result = await runtime.context.tools.invoke(
            ReadOnlyToolName.GMAIL_SEARCH,
            {
                "query": state["query"],
                "top_k": state["top_k"],
                "filters": state.get("filters") or {},
            },
            user_id=state["user_id"],
        )
    except ToolInvocationError as error:
        return {"retrieved_sources": (), "tool_error_code": error.code}
    if not isinstance(result, GmailSearchToolResult):
        return {"retrieved_sources": (), "tool_error_code": "TOOL_RESULT_INVALID"}
    return {"retrieved_sources": result.sources, "tool_error_code": ""}


def _tool_failure(
    state: RAGWorkflowState,
    runtime: Runtime[RAGWorkflowContext],
) -> _AnswerUpdate:
    del state
    return {
        "answer": runtime.context.answer_service.abstain_for_request(
            "I couldn't safely search the indexed mailbox. Please try again."
        )
    }


def _assemble_evidence(
    state: RAGWorkflowState,
    runtime: Runtime[RAGWorkflowContext],
) -> _PreparedContext:
    sources = state.get("retrieved_sources", ())
    prepared = runtime.context.answer_service.assemble_evidence(
        query=state["query"],
        retrieved=sources,
    )
    return {"retrieved_sources": (), "prepared_context": prepared}


def _route_after_assembly(
    state: RAGWorkflowState,
) -> Literal["rag_answer", "abstain"]:
    prepared = state.get("prepared_context")
    if prepared is not None and prepared.evidence:
        return "rag_answer"
    return "abstain"


async def _generate_answer(
    state: RAGWorkflowState,
    runtime: Runtime[RAGWorkflowContext],
) -> _ToolFailureUpdate | _AnswerUpdate:
    prepared = state.get("prepared_context")
    if prepared is None:
        raise GroundedAnswerInputError(
            "RAG_GRAPH_STATE_INVALID", "The evidence context was not assembled"
        )
    try:
        result = await runtime.context.tools.invoke(
            ReadOnlyToolName.RAG_ANSWER,
            RAGAnswerArguments(query=state["query"]),
            user_id=state["user_id"],
            context=ToolInvocationContext(
                user_id=state["user_id"],
                query=state["query"],
                prepared_context=prepared,
            ),
        )
    except ToolInvocationError as error:
        return {
            "answer": runtime.context.answer_service.abstain_for_request(
                "I couldn't generate a grounded answer from the retrieved emails. Please try again."
            ),
            "tool_error_code": error.code,
        }
    if not isinstance(result, RAGAnswerToolResult):
        return {
            "answer": runtime.context.answer_service.abstain_for_request(
                "I couldn't validate the grounded answer. Please try again."
            ),
            "tool_error_code": "TOOL_RESULT_INVALID",
        }
    return {"answer": result.answer}


def _abstain(
    state: RAGWorkflowState,
    runtime: Runtime[RAGWorkflowContext],
) -> _AnswerUpdate:
    prepared = state.get("prepared_context")
    if prepared is None:
        raise GroundedAnswerInputError(
            "RAG_GRAPH_STATE_INVALID", "The evidence context was not assembled"
        )
    return {"answer": runtime.context.answer_service.abstain_without_evidence(prepared)}


def _return_response(state: RAGWorkflowState) -> RAGWorkflowOutput:
    answer = state.get("answer")
    if answer is None:
        raise GroundedAnswerInputError(
            "RAG_GRAPH_STATE_INVALID", "The graph did not produce an answer"
        )
    return {"answer": answer}


def build_read_only_rag_graph(
    *, checkpointer: BaseCheckpointSaver | None = None
) -> CompiledStateGraph[
    RAGWorkflowState,
    RAGWorkflowContext,
    RAGWorkflowInput,
    RAGWorkflowOutput,
]:
    """Compile the bounded read-only graph with an optional persistent checkpointer."""
    builder = StateGraph(
        RAGWorkflowState,
        context_schema=RAGWorkflowContext,
        input_schema=RAGWorkflowInput,
        output_schema=RAGWorkflowOutput,
    )
    builder.add_node("interpret_request", _interpret_request)
    builder.add_node("classify_intent", _classify_intent)
    builder.add_node("create_plan", _create_plan)
    builder.add_node("validate_plan", _validate_plan)
    builder.add_node("gmail_search", _retrieve_emails)
    builder.add_node("tool_failure", _tool_failure)
    builder.add_node("assemble_evidence", _assemble_evidence)
    builder.add_node("rag_answer", _generate_answer)
    builder.add_node("abstain", _abstain)
    builder.add_node("clarify", _clarify)
    builder.add_node("drafting_notice", _drafting_notice)
    builder.add_node("return_response", _return_response)
    builder.add_edge(START, "interpret_request")
    builder.add_edge("interpret_request", "classify_intent")
    builder.add_edge("classify_intent", "create_plan")
    builder.add_edge("create_plan", "validate_plan")
    builder.add_conditional_edges(
        "validate_plan",
        _route_after_plan,
        {
            "clarify": "clarify",
            "drafting_notice": "drafting_notice",
            "gmail_search": "gmail_search",
        },
    )
    builder.add_conditional_edges(
        "gmail_search",
        _route_after_retrieval,
        {"tool_failure": "tool_failure", "assemble_evidence": "assemble_evidence"},
    )
    builder.add_conditional_edges(
        "assemble_evidence",
        _route_after_assembly,
        {"rag_answer": "rag_answer", "abstain": "abstain"},
    )
    builder.add_edge("rag_answer", "return_response")
    builder.add_edge("abstain", "return_response")
    builder.add_edge("clarify", "return_response")
    builder.add_edge("drafting_notice", "return_response")
    builder.add_edge("tool_failure", "return_response")
    builder.add_edge("return_response", END)
    return builder.compile(checkpointer=checkpointer)
