# FastAPI service

`mailpilot-ai` is the Python service boundary for model analysis and retrieval. It provides configuration validation, health routes, structured errors, provider-neutral asynchronous LLM and embedding interfaces, typed email analysis, evidence-validated reply suggestions, and a read-only LangGraph workflow with allowlisted intent planning for grounded RAG answers. It does not access Gmail or perform mailbox mutations.

## Dependency management

Use **uv** as the only Python dependency manager for this service. Direct dependencies are exact-pinned in `pyproject.toml`; `uv.lock` records the complete resolved graph and artifact hashes. Do not add a `requirements.txt` or manage the same dependencies with pip.

From the repository root:

```powershell
uv sync --project apps/ai --locked
uv run --directory apps/ai --project . python -m mailpilot_ai
uv run --directory apps/ai --project . pytest
uv run --directory apps/ai --project . ruff check src tests
uv run --directory apps/ai --project . mypy src
```

To change a dependency, update its exact version in `pyproject.toml`, run `uv lock --project apps/ai`, review both dependency files, and sync with `uv sync --project apps/ai --locked`. Commit `pyproject.toml` and `uv.lock` together.

Root scripts provide the same workflow: `npm run dev:ai`, `npm run test:py`, `npm run lint:py`, and `npm run typecheck:py`. `npm run dev:ai` reads the root `.env` through `dotenv-cli` before starting the service.

## Configuration and routes

Pydantic Settings validates environment variables at startup. Invalid configuration errors identify variable names only. The service uses `AI_PORT` (default `8000`), `AI_LOG_LEVEL` (default `info`), optional `AI_SERVICE_NAME` (default `ai`), and `DATABASE_URL` for readiness checks.

- `GET /internal/v1/health/live` reports process liveness without checking external dependencies.
- `GET /internal/v1/health/ready` runs a bounded `SELECT 1` check and returns `503` if PostgreSQL is unavailable.
- `/health/live` and `/health/ready` remain aliases for local process and container probes.
- Other errors use the shared JSON envelope with a request ID, stable safe code, retryability flag, and empty details by default.

The AI readiness probe removes Prisma's `schema` URL parameter before connecting through Psycopg/libpq and preserves other connection options. FastAPI opens a bounded Psycopg pool for LangGraph's `AsyncPostgresSaver` in schema `ai` and closes it on shutdown; run `npm run db:ai:migrate` before startup so the AI schema exists. Logs are JSON and include service name, severity, and request ID. Request bodies, credentials, email content, and provider responses are not logged. PostgreSQL connections used by readiness are scoped to the check and closed immediately.

## LLM adapter

Set `AI_LLM_PROVIDER=openai` and `AI_LLM_MODEL=gpt-6.1-sol` to select the implemented provider/model. Provider calls require `OPENAI_API_KEY`; the key is validated when the provider is constructed and is never included in logs or errors. The default request timeout is 30 seconds, with at most two application retries for transient failures. HTTP 429 responses honor a bounded `Retry-After`; longer provider delays are returned to the caller rather than retried early. The adapter disables response storage, returns typed text and usage metadata, and calculates an estimated cost only when dated input/output token rates are explicitly configured.

The provider-neutral contract and OpenAI implementation live under `src/mailpilot_ai/llm`. Model selection rationale and alternatives are in [the provider/model decision note](../../docs/llm-provider.md). Structured analysis and suggestion-only reply drafting send bounded, minimized mailbox content to the configured model.

## Embedding adapter

The provider-neutral embedding contract is under `src/mailpilot_ai/embeddings`; the OpenAI HTTP adapter is the current implementation. It defaults to `text-embedding-3-small` with 1,536 dimensions. It uses the same server-side `OPENAI_API_KEY` as the LLM adapter, but has independent model, dimension, timeout, retry, and optional cost settings. It sends no logs or request content to the application logger.

The adapter uses the `cl100k_base` tokenizer to reject blank, oversized, or over-limit input before sending any batch. A call accepts at most 512 texts and 300,000 local tokens. Provider requests are sequential, each with at most 64 texts and 100,000 tokens; OpenAI's documented hard limits are 2,048 inputs, 8,192 tokens per input, and 300,000 combined tokens per request. Transient network errors, HTTP 408/409/429, and 5xx responses use bounded retries; a long `Retry-After` is returned safely instead of being retried early. Response indexes, vector shape, finite numbers, usage, and model-version consistency are checked before returning typed vectors.

Set `AI_EMBEDDING_PROVIDER`, `AI_EMBEDDING_MODEL`, and `AI_EMBEDDING_DIMENSIONS` to override the defaults. Dimension changes require a matching vector-column/index version and a full re-embedding; do not mix dimensions or model versions in one index. Optional estimated cost metadata uses `AI_EMBEDDING_INPUT_PRICE_USD_PER_MTOK` and `AI_EMBEDDING_PRICING_VERSION` as a pair. The model choice and privacy/deployment trade-offs are documented in [the embedding decision note](../../docs/embedding-provider.md).

## Email chunking

`src/mailpilot_ai/chunking` cleans and splits email messages deterministically before future embedding. `chunk_emails` accepts owner-scoped source records and handles each message independently, even when multiple messages share a Gmail thread. It sorts source records by received time and stable IDs, keeps user ID, application and Gmail message IDs, thread ID, revision, timestamp, sender, subject, and chunk ordinal on every output, and never joins adjacent messages. Repeated delivery of the same owner/email/source revision is emitted once; conflicting copies of that same revision fail safely.

Plain text is preferred. HTML is converted to text when plain text is empty; script/style content, known quoted HTML blocks, common plain-text reply/forward history, and quoted `>` lines are removed. Chunks are at most 2,400 Unicode code points by default, split at paragraph, sentence, or whitespace boundaries where possible, with no overlap. `startChar` and `endChar` point into the canonical cleaned message text, not the original MIME/HTML byte stream. Outputs include `contentVersion`, `chunkerVersion`, and a SHA-256 `contentHash`; `sourceRevision` is the source email version used for idempotency. Persisted chunk ownership and message metadata are additionally backed by the composite user/email foreign key in Prisma's `app.email_chunks` model. This module generates chunks only; it does not write to the database or call the embedding provider.

## pgvector storage

`src/mailpilot_ai/vector_store` stores vectors in the AI-owned `ai.chunk_embeddings_1536` table. Prisma continues to own `app.email_chunks`; the vector table references `(user_id, chunk_id)` with `ON DELETE CASCADE` and snapshots the source revision, chunker version, and content hash. Provider, configured model, returned model version, dimensions, and an immutable embedding-version key are stored with every vector. The selected 1,536-dimensional `text-embedding-3-small` index uses cosine distance and HNSW. Storage rejects any vector dimension other than 1,536; changing dimensions requires a new migration/index version and a full re-embedding. A different model or returned model version creates a separate version key, and retrieval requires the requested model version.

All repository methods require a `user_id`; SQL also filters by that user, joins the canonical chunk and email under the same owner, and enables PostgreSQL row-level security using a transaction-local owner setting. Signed Express requests can call `POST /internal/v1/retrieval/` with `userId`, `query`, optional `topK` (1–100), and optional exact email, provider message, provider thread, sender, and received-time filters. `HybridRetrievalService` embeds one query and runs pgvector cosine search alongside PostgreSQL full-text search over subject, sender, message content, provider IDs, and received date. Exact case-insensitive query substrings receive a lexical score boost for names, dates, and identifiers. It merges the two rank lists with Reciprocal Rank Fusion: `score = Σ 1 / (60 + rank)`, using one-based ranks. Each search retrieves up to four times `topK` candidates (capped at 100), then results are sorted by fused score and deduplicated by `(user_id, chunk_id)` before taking `topK`. This is rank fusion only; there is no additional reranking. Results return canonical message/thread IDs, email/chunk IDs, text span, content, sender, subject, received time, each source rank, and fusion score. Both searches exclude deleted, inactive, and email-revision-mismatched chunks; vector search also checks the embedding's source revision, chunker version, and content hash against the canonical chunk. HNSW iterative scans are enabled for filtered vector queries. Deleting vectors directly or deleting their canonical chunk/user removes the corresponding embedding rows.

## Grounded RAG answers

Signed Express requests can call `POST /internal/v1/answers/` with `userId`, `conversationId`, `runId`, `query`, `topK`, and metadata filters. The stable conversation and run UUIDs are required for replay and recovery. The route runs the read-only LangGraph StateGraph: validate/interpret the request, retrieve owner-scoped emails, assemble deduplicated evidence, then conditionally generate an answer or abstain before returning the response. Its output schema contains only the grounded answer; private intermediate state and model reasoning are not returned. The graph uses a PostgreSQL checkpointer and has no mailbox mutations. Its allowlisted `gmail_search` tool searches only owner-scoped synced/indexed data, and `rag_answer` grounds responses in validated evidence; FastAPI receives no Gmail OAuth tokens or live Gmail API capability. Both tools validate arguments, enforce per-tool read permission and user scope, and apply bounded timeout/retry behavior with safe abstention on failure. The RAG service reuses hybrid retrieval, removes already-covered character ranges from overlapping chunks, and assembles the evidence under `AI_RAG_CONTEXT_TOKEN_BUDGET` (default 12,000; allowed range 512–48,000). The budget counts system and user messages plus the structured output schema with the local `cl100k_base` tokenizer. Email evidence is serialized as untrusted JSON in a user message; system instructions tell the model never to follow instructions found in email content. Model claims must cite an evidence ID and exact quote, and the service checks that each claim appears in the answer, each `[E#]` marker is present, and each quote appears in the evidence shown to the model. Responses include citations with message/thread IDs and source metadata. The service abstains without an LLM call when retrieval finds no evidence or no evidence fits the budget, and validates model abstentions when evidence is insufficient. Safe graph traces record node names, run ID, hashed thread ID, outcome, and request ID without email content or checkpoint state. Run `npm run visualize:rag` to render the topology shown in [the Mermaid diagram](../../docs/rag-workflow.mmd); checkpoint identity and resume behavior are described in [the persistence note](../../docs/agent-workflow-persistence.md).

Run `npm run db:deploy` before `npm run db:ai:migrate`. AI SQL migrations live under `src/mailpilot_ai/vector_store/migrations`, are recorded in `ai.schema_migrations`, and are checksum-verified on every apply. Migration files are immutable after application. The migration creates the pgvector extension in `public` and requires pgvector 0.8.0 or newer; on managed PostgreSQL, a database administrator may need to install the extension first. Integration tests use only `MAILPILOT_TEST_DATABASE_URL`, which must target a dedicated database ending in `_test`; they never fall back to the development `DATABASE_URL`.

## Structured email analysis

FastAPI accepts signed internal requests at `POST /internal/v1/email-analysis/`. Express reads the message under the authenticated user ID and sends only the bounded plain-text body, subject, sender metadata, received time, and stable source IDs. The `AI_SERVICE_TOKEN` secret is used to sign the exact method, route, request ID, timestamp, and body; signatures expire after 60 seconds. Gmail OAuth credentials never cross this boundary.

The analysis returns categories, priority, a concise summary, action items, deadline candidates, commitments, and event candidates. It uses a strict JSON Schema derived from Pydantic, then independently validates dates, event ordering, enum values, field bounds, and that evidence quotes occur in the source email. Malformed or ungrounded output becomes a safe error without echoing generated text. The system prompt treats all email fields as untrusted quoted data and provides no tools or mailbox side effects.

Express stores successful output in the Prisma-owned `app.analyses` table with source revision, analysis schema version, actual provider model version, provider IDs, usage, and result. Repeated requests reuse a completed analysis for the same source revision and schema version. The schema and retention policy are documented in [the API contracts](../../docs/api-contracts.md).

## Suggestion-only reply drafting

FastAPI accepts signed internal requests at `POST /internal/v1/reply-drafts/`. Express supplies the selected message and at most seven recent messages from the same owner-scoped thread. Each message includes an application message ID, source revision, sender metadata, timestamp, subject, and bounded plain-text body. Email text is untrusted data; a separate optional user instruction may set writing style but cannot authorize commitments or actions.

The Pydantic schema limits the reply, factual claims, evidence quotes, and uncertainty labels. FastAPI rejects claims whose quote is absent from the referenced source message or whose claim text is absent from the reply. It returns an explicit no-draft result when context is insufficient. Express independently validates identity, source revisions, references, and evidence, then stores successful suggestions in Prisma's `app.reply_drafts`. The public API can edit suggestion text while preserving suggestion status. The feature has no Gmail send or Gmail draft-write capability.
