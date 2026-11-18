from typing import Annotated, cast

from fastapi import APIRouter, Depends, Request
from langgraph.graph.state import CompiledStateGraph

from mailpilot_ai.config import get_settings
from mailpilot_ai.embeddings.contracts import EmbeddingProvider
from mailpilot_ai.internal_service import get_llm_provider, require_internal_service_signature
from mailpilot_ai.llm.contracts import LLMProvider
from mailpilot_ai.rag.persistence import (
    PersistentWorkflowError,
    WorkflowRunLock,
    execute_persistent_rag_workflow,
    stable_request_fingerprint,
)
from mailpilot_ai.rag.planning import RAGIntentPlanningService
from mailpilot_ai.rag.schemas import GroundedAnswerResponse, GroundedRAGWorkflowRequest
from mailpilot_ai.rag.service import GroundedRAGAnswerService
from mailpilot_ai.rag.tools import ReadOnlyRAGToolRegistry
from mailpilot_ai.rag.workflow import (
    RAGWorkflowContext,
    RAGWorkflowInput,
    RAGWorkflowOutput,
    RAGWorkflowState,
)
from mailpilot_ai.retrieval.router import get_embedding_provider, get_vector_store
from mailpilot_ai.retrieval.service import HybridRetrievalService
from mailpilot_ai.vector_store import PostgresEmbeddingStore

router = APIRouter(prefix="/internal/v1/answers", tags=["grounded RAG answers"])


@router.post(
    "/",
    response_model=GroundedAnswerResponse,
    dependencies=[Depends(require_internal_service_signature)],
)
async def answer_question(
    request: GroundedRAGWorkflowRequest,
    http_request: Request,
    embedding_provider: Annotated[EmbeddingProvider, Depends(get_embedding_provider)],
    llm_provider: Annotated[LLMProvider, Depends(get_llm_provider)],
    vector_store: Annotated[PostgresEmbeddingStore, Depends(get_vector_store)],
) -> GroundedAnswerResponse:
    graph_candidate = getattr(http_request.app.state, "rag_graph", None)
    run_lock_candidate = getattr(http_request.app.state, "rag_run_lock", None)
    if graph_candidate is None or run_lock_candidate is None:
        raise PersistentWorkflowError(
            "RAG_CHECKPOINTER_UNAVAILABLE",
            "The persistent workflow service is not ready.",
            status_code=503,
        )
    graph = cast(
        CompiledStateGraph[
            RAGWorkflowState,
            RAGWorkflowContext,
            RAGWorkflowInput,
            RAGWorkflowOutput,
        ],
        graph_candidate,
    )
    run_lock = cast(WorkflowRunLock, run_lock_candidate)
    settings = get_settings()
    retriever = HybridRetrievalService(
        embedding_provider=embedding_provider,
        search_store=vector_store,
    )
    answer_service = GroundedRAGAnswerService(
        retriever=retriever,
        provider=llm_provider,
        context_token_budget=settings.rag_context_token_budget,
    )
    graph_input: RAGWorkflowInput = {
        "user_id": request.user_id,
        "conversation_id": request.conversation_id,
        "run_id": request.run_id,
        "request_fingerprint": stable_request_fingerprint(
            user_id=request.user_id,
            conversation_id=request.conversation_id,
            query=request.query,
            top_k=request.top_k,
            filters=request.filters,
        ),
        "query": request.query.strip(),
        "top_k": request.top_k,
        "filters": request.filters,
    }
    execution = await execute_persistent_rag_workflow(
        graph=graph,
        workflow_input=graph_input,
        context=RAGWorkflowContext(
            answer_service=answer_service,
            planning_service=RAGIntentPlanningService(provider=llm_provider),
            tool_registry=ReadOnlyRAGToolRegistry(answer_service=answer_service),
        ),
        resume=request.resume,
        request_id=str(getattr(http_request.state, "request_id", "unknown")),
        run_lock=run_lock,
    )
    return execution.answer
