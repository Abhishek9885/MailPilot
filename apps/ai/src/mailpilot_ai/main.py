import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from time import perf_counter
from uuid import UUID, uuid4

import structlog
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg import AsyncConnection
from psycopg.rows import DictRow, dict_row
from psycopg_pool import AsyncConnectionPool
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.base import RequestResponseEndpoint
from starlette.responses import Response

from mailpilot_ai.analysis.router import router as email_analysis_router
from mailpilot_ai.analysis.service import EmailAnalysisInputError, EmailAnalysisOutputError
from mailpilot_ai.classification.router import router as email_classification_router
from mailpilot_ai.classification.service import (
    EmailClassifierUnavailableError,
    get_email_classifier,
)
from mailpilot_ai.config import get_settings
from mailpilot_ai.database import check_database, psycopg_connection_url
from mailpilot_ai.embeddings import EmbeddingError
from mailpilot_ai.errors import error_response, public_http_error
from mailpilot_ai.llm.errors import LLMError
from mailpilot_ai.logging_config import configure_logging
from mailpilot_ai.rag.persistence import (
    PersistentWorkflowError,
    PostgreSQLWorkflowRunLock,
    checkpoint_serializer,
)
from mailpilot_ai.rag.planning import RAGPlanningOutputError
from mailpilot_ai.rag.router import router as grounded_rag_router
from mailpilot_ai.rag.service import GroundedAnswerInputError, GroundedAnswerOutputError
from mailpilot_ai.rag.workflow import build_read_only_rag_graph
from mailpilot_ai.replies.router import router as reply_drafts_router
from mailpilot_ai.replies.service import ReplyDraftInputError, ReplyDraftOutputError
from mailpilot_ai.retrieval.router import router as semantic_retrieval_router
from mailpilot_ai.schemas import HealthResponse
from mailpilot_ai.vector_store.errors import VectorStoreError

settings = get_settings()
configure_logging(settings.ai_log_level)
logger = structlog.get_logger().bind(service=settings.service_name)
REQUEST_ID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    flags=re.IGNORECASE,
)


@asynccontextmanager
async def lifespan(application: FastAPI) -> AsyncIterator[None]:
    logger.info("service.started")
    connection_options = {
        "autocommit": True,
        "row_factory": dict_row,
        "options": "-c search_path=ai,public",
        "connect_timeout": 5,
    }
    conninfo = psycopg_connection_url(str(settings.database_connection_url))
    pool: AsyncConnectionPool[AsyncConnection[DictRow]] = AsyncConnectionPool(
        conninfo=conninfo,
        min_size=1,
        max_size=10,
        kwargs=connection_options,
        open=False,
    )
    run_lock_pool: AsyncConnectionPool[AsyncConnection[DictRow]] = AsyncConnectionPool(
        conninfo=conninfo,
        min_size=1,
        max_size=10,
        kwargs=connection_options,
        open=False,
    )
    pool_open = False
    run_lock_pool_open = False
    try:
        await pool.open(wait=True)
        pool_open = True
        await run_lock_pool.open(wait=True)
        run_lock_pool_open = True
        checkpointer = AsyncPostgresSaver(pool, serde=checkpoint_serializer())
        await checkpointer.setup()
        application.state.rag_graph = build_read_only_rag_graph(checkpointer=checkpointer)
        application.state.rag_run_lock = PostgreSQLWorkflowRunLock(run_lock_pool)
        logger.info("rag.checkpointer.ready", schema="ai", backend="postgres")
        yield
    finally:
        try:
            if run_lock_pool_open:
                await run_lock_pool.close()
        finally:
            try:
                if pool_open:
                    await pool.close()
            finally:
                logger.info("service.shutdown.completed")


app = FastAPI(
    title="MailPilot AI Service",
    version="0.1.0",
    lifespan=lifespan,
)
app.include_router(email_analysis_router)
app.include_router(email_classification_router)
app.include_router(reply_drafts_router)
app.include_router(semantic_retrieval_router)
app.include_router(grounded_rag_router)


@app.middleware("http")
async def request_context(request: Request, call_next: RequestResponseEndpoint) -> Response:
    provided_request_id = request.headers.get("x-request-id", "")
    request_id = (
        str(UUID(provided_request_id))
        if REQUEST_ID_PATTERN.fullmatch(provided_request_id)
        else str(uuid4())
    )
    request.state.request_id = request_id
    context_tokens = structlog.contextvars.bind_contextvars(requestId=request_id)
    started_at = perf_counter()
    try:
        response = await call_next(request)
        response.headers["x-request-id"] = request_id
        logger.info(
            "request.completed",
            method=request.method,
            path=request.url.path,
            statusCode=response.status_code,
            durationMs=round((perf_counter() - started_at) * 1_000, 2),
        )
        return response
    except Exception as error:
        logger.error(
            "request.failed",
            method=request.method,
            path=request.url.path,
            code="INTERNAL",
            errorType=type(error).__name__,
            durationMs=round((perf_counter() - started_at) * 1_000, 2),
        )
        raise
    finally:
        structlog.contextvars.reset_contextvars(**context_tokens)


@app.exception_handler(RequestValidationError)
async def handle_validation_error(request: Request, _error: RequestValidationError) -> Response:
    request_id = getattr(request.state, "request_id", str(uuid4()))
    logger.warning("request.validation_failed", requestId=request_id, code="INVALID_ARGUMENT")
    return error_response(
        status_code=422,
        code="INVALID_ARGUMENT",
        message="The request is invalid",
        request_id=request_id,
    )


@app.exception_handler(StarletteHTTPException)
async def handle_http_error(request: Request, error: StarletteHTTPException) -> Response:
    request_id = getattr(request.state, "request_id", str(uuid4()))
    code, message, retryable = public_http_error(error.status_code)
    log_method = logger.error if error.status_code >= 500 else logger.warning
    log_method(
        "request.failed",
        requestId=request_id,
        statusCode=error.status_code,
        code=code,
    )
    return error_response(
        status_code=error.status_code,
        code=code,
        message=message,
        request_id=request_id,
        retryable=retryable,
    )


@app.exception_handler(LLMError)
async def handle_llm_error(request: Request, error: LLMError) -> Response:
    request_id = getattr(request.state, "request_id", str(uuid4()))
    status_code = {
        "LLM_RATE_LIMITED": 429,
        "LLM_TIMEOUT": 504,
        "LLM_CONFIGURATION_INVALID": 503,
    }.get(error.code, 502)
    logger.warning("llm.provider_failed", requestId=request_id, code=error.code)
    headers = (
        {"Retry-After": str(max(1, int(error.retry_after_seconds + 0.999)))}
        if error.retry_after_seconds is not None
        else None
    )
    response = error_response(
        status_code=status_code,
        code=error.code,
        message=str(error),
        request_id=request_id,
        retryable=error.retryable,
    )
    if headers is not None:
        response.headers.update(headers)
    return response


@app.exception_handler(EmbeddingError)
async def handle_embedding_error(request: Request, error: EmbeddingError) -> Response:
    request_id = getattr(request.state, "request_id", str(uuid4()))
    status_code = {
        "EMBEDDING_RATE_LIMITED": 429,
        "EMBEDDING_TIMEOUT": 504,
        "EMBEDDING_CONFIGURATION_INVALID": 503,
    }.get(error.code, 502)
    logger.warning("embedding.provider_failed", requestId=request_id, code=error.code)
    response = error_response(
        status_code=status_code,
        code=error.code,
        message=str(error),
        request_id=request_id,
        retryable=error.retryable,
    )
    if error.retry_after_seconds is not None:
        response.headers["Retry-After"] = str(max(1, int(error.retry_after_seconds + 0.999)))
    return response


@app.exception_handler(VectorStoreError)
async def handle_vector_store_error(request: Request, error: VectorStoreError) -> Response:
    request_id = getattr(request.state, "request_id", str(uuid4()))
    status_code = (
        422
        if error.code
        in {
            "EMBEDDING_QUERY_INVALID",
            "EMBEDDING_QUERY_LIMIT_INVALID",
        }
        else 503
    )
    logger.warning("retrieval.failed", requestId=request_id, code=error.code)
    return error_response(
        status_code=status_code,
        code=error.code,
        message=str(error),
        request_id=request_id,
        retryable=status_code >= 500,
    )


@app.exception_handler(GroundedAnswerInputError)
async def handle_grounded_answer_input_error(
    request: Request, error: GroundedAnswerInputError
) -> Response:
    request_id = getattr(request.state, "request_id", str(uuid4()))
    status_code = {
        "RAG_QUERY_INVALID": 422,
        "RAG_TOP_K_INVALID": 422,
        "RAG_CONTEXT_BUDGET_EXCEEDED": 413,
        "RAG_QUERY_TOO_LARGE": 413,
        "RAG_TOKENIZER_UNAVAILABLE": 503,
    }.get(error.code, 502)
    logger.warning("rag.input_rejected", requestId=request_id, code=error.code)
    return error_response(
        status_code=status_code,
        code=error.code,
        message=str(error),
        request_id=request_id,
        retryable=status_code >= 500,
    )


@app.exception_handler(PersistentWorkflowError)
async def handle_persistent_workflow_error(
    request: Request, error: PersistentWorkflowError
) -> Response:
    request_id = getattr(request.state, "request_id", str(uuid4()))
    logger.warning("rag.workflow.rejected", requestId=request_id, code=error.code)
    return error_response(
        status_code=error.status_code,
        code=error.code,
        message=str(error),
        request_id=request_id,
        retryable=error.status_code >= 500,
    )


@app.exception_handler(GroundedAnswerOutputError)
async def handle_grounded_answer_output_error(
    request: Request, error: GroundedAnswerOutputError
) -> Response:
    request_id = getattr(request.state, "request_id", str(uuid4()))
    logger.warning("rag.output_rejected", requestId=request_id, code=error.code)
    return error_response(
        status_code=502,
        code=error.code,
        message=str(error),
        request_id=request_id,
        retryable=True,
    )


@app.exception_handler(RAGPlanningOutputError)
async def handle_rag_planning_output_error(
    request: Request, error: RAGPlanningOutputError
) -> Response:
    request_id = getattr(request.state, "request_id", str(uuid4()))
    logger.warning("rag.plan_rejected", requestId=request_id, code=error.code)
    return error_response(
        status_code=502,
        code=error.code,
        message=str(error),
        request_id=request_id,
        retryable=True,
    )


@app.exception_handler(EmailAnalysisOutputError)
async def handle_analysis_output_error(
    request: Request, error: EmailAnalysisOutputError
) -> Response:
    request_id = getattr(request.state, "request_id", str(uuid4()))
    logger.warning("email_analysis.output_rejected", requestId=request_id, code=error.code)
    return error_response(
        status_code=502,
        code=error.code,
        message=str(error),
        request_id=request_id,
        retryable=True,
    )


@app.exception_handler(EmailAnalysisInputError)
async def handle_analysis_input_error(request: Request, error: EmailAnalysisInputError) -> Response:
    request_id = getattr(request.state, "request_id", str(uuid4()))
    logger.warning("email_analysis.input_rejected", requestId=request_id, code=error.code)
    return error_response(
        status_code=413,
        code=error.code,
        message=str(error),
        request_id=request_id,
    )


@app.exception_handler(EmailClassifierUnavailableError)
async def handle_classifier_unavailable(
    request: Request, error: EmailClassifierUnavailableError
) -> Response:
    request_id = getattr(request.state, "request_id", str(uuid4()))
    logger.error("email_classification.model_unavailable", requestId=request_id, code=error.code)
    return error_response(
        status_code=503,
        code=error.code,
        message=str(error),
        request_id=request_id,
        retryable=True,
    )


@app.exception_handler(ReplyDraftOutputError)
async def handle_reply_draft_output_error(
    request: Request, error: ReplyDraftOutputError
) -> Response:
    request_id = getattr(request.state, "request_id", str(uuid4()))
    logger.warning("reply_draft.output_rejected", requestId=request_id, code=error.code)
    return error_response(
        status_code=502,
        code=error.code,
        message=str(error),
        request_id=request_id,
        retryable=True,
    )


@app.exception_handler(ReplyDraftInputError)
async def handle_reply_draft_input_error(request: Request, error: ReplyDraftInputError) -> Response:
    request_id = getattr(request.state, "request_id", str(uuid4()))
    logger.warning("reply_draft.input_rejected", requestId=request_id, code=error.code)
    return error_response(
        status_code=413,
        code=error.code,
        message=str(error),
        request_id=request_id,
    )


@app.exception_handler(Exception)
async def handle_unexpected_error(request: Request, error: Exception) -> Response:
    request_id = getattr(request.state, "request_id", str(uuid4()))
    logger.error(
        "request.failed",
        requestId=request_id,
        statusCode=500,
        code="INTERNAL",
        errorType=type(error).__name__,
    )
    return error_response(
        status_code=500,
        code="INTERNAL",
        message="An unexpected error occurred",
        request_id=request_id,
    )


@app.get("/health/live", response_model=HealthResponse, include_in_schema=False)
@app.get("/internal/v1/health/live", response_model=HealthResponse)
async def health_live(request: Request) -> HealthResponse:
    return HealthResponse(
        service=settings.service_name,
        status="ok",
        request_id=request.state.request_id,
    )


@app.get("/health/ready", response_model=HealthResponse, include_in_schema=False)
@app.get("/internal/v1/health/ready", response_model=HealthResponse)
async def health_ready(request: Request) -> HealthResponse | JSONResponse:
    try:
        await check_database()
    except Exception:
        logger.warning("health.database_unavailable", requestId=request.state.request_id)
        unavailable = HealthResponse(
            service=settings.service_name,
            status="unavailable",
            request_id=request.state.request_id,
        )
        return JSONResponse(
            status_code=503,
            content=unavailable.model_dump(mode="json", by_alias=True),
            headers={"x-request-id": request.state.request_id},
        )
    try:
        get_email_classifier()
    except EmailClassifierUnavailableError:
        logger.warning("health.classifier_unavailable", requestId=request.state.request_id)
        unavailable = HealthResponse(
            service=settings.service_name,
            status="unavailable",
            request_id=request.state.request_id,
        )
        return JSONResponse(
            status_code=503,
            content=unavailable.model_dump(mode="json", by_alias=True),
            headers={"x-request-id": request.state.request_id},
        )
    return HealthResponse(
        service=settings.service_name,
        status="ok",
        request_id=request.state.request_id,
    )


@app.get("/v1/ai")
async def placeholder() -> dict[str, object]:
    return {
        "service": settings.service_name,
        "status": "placeholder",
        "capabilities": {
            "emailAnalysis": True,
            "replyDrafts": True,
            "embeddings": False,
            "agentWorkflows": False,
        },
    }
