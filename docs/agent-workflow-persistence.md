# Persistent read-only RAG workflow

**Status:** Phase 8.4 is implemented for the read-only RAG graph. The workflow does not execute Gmail, task, or other consequential actions. Phase 9 approval checks remain a prerequisite for any such capability.

## Checkpointer and identifiers

FastAPI creates LangGraph's supported `AsyncPostgresSaver` from the pinned `langgraph-checkpoint-postgres` package during application lifespan. Its tables use the Python AI service's `ai` schema and are managed by the saver package, separately from Prisma. The service uses a bounded Psycopg pool and closes it during shutdown. Apply `npm run db:ai:migrate` before service startup to create the AI schema.

The signed internal answer request requires stable UUIDs for `conversationId` and `runId`. FastAPI derives the LangGraph `thread_id` as a SHA-256 hash of the trusted `userId`, `conversationId`, and `runId`; the caller cannot choose the checkpoint thread directly. This makes each run recoverable by its original identifiers and isolates both owners and runs. A conversation ID groups requests at the service boundary; the read-only answer graph does not inherit prior run state.

The run ID is bound to a hash of the owner, conversation, normalized query, top-k value, and metadata filters. A retry must use the same payload. `resume` defaults to false and must be true to continue an incomplete run. PostgreSQL advisory locks serialize duplicate starts and resumes across service processes. Checkpoint decoding uses an explicit allowlist of the application types stored in graph state.

## Resume behavior and limits

| Checkpoint state | Request | Result |
|---|---|---|
| No checkpoint | `resume: false` | Start a new graph run. |
| No checkpoint | `resume: true` | Return `RAG_RUN_NOT_FOUND`. |
| Incomplete checkpoint | Same request, `resume: false` | Return `RAG_RUN_IN_PROGRESS`. |
| Incomplete checkpoint | Same request, `resume: true` | Continue from the next unfinished node. Completed nodes are not repeated. |
| Completed checkpoint | Same request | Return the stored answer idempotently. |
| Existing run ID | Different request fields | Return `RAG_RUN_CONFLICT`. |

The graph is acyclic and the call sets LangGraph's recursion limit to 16 steps. No loop, open-ended model tool call, or write tool is present. A provider failure after a completed node leaves the preceding checkpoint available; retrying with the same run ID and `resume: true` continues from that checkpoint. Read-only retrieval and answer generation may be repeated only if their node had not completed and checkpointed before interruption.

## Traces and validation

Structured workflow logs include request ID, stable run ID, opaque hashed thread ID, outcome, and the ordered node trace. They omit email content, retrieved evidence, model output, checkpoint state, and chain-of-thought. The graph still returns only `GroundedAnswerResponse`; its topology is shown in [rag-workflow.mmd](rag-workflow.mmd).

`tests/test_rag_workflow.py` covers completed-run replay, cross-user isolation, changed-payload rejection, explicit resume, failure recovery after graph reconstruction, and serializer allowlisting. `tests/test_rag_postgres_workflow.py` performs a saver and pool restart test when `MAILPILOT_TEST_DATABASE_URL` points to a dedicated test database; it is skipped otherwise.
