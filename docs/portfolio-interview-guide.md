# Portfolio interview guide

Use these concise answers with their limits. Metrics below come from synthetic fixtures, not production inboxes.

## Architecture

"The browser is only the UI. Express owns identity, OAuth credentials, Gmail access, owner checks, persisted approvals, and external actions. FastAPI owns model orchestration, embeddings, retrieval, and LangGraph, but never receives Google OAuth tokens. PostgreSQL is the source of truth; shared packages hold validated contracts."

This isolates permissions and allows Python AI tooling, at the cost of more services and network failure modes.

## Embeddings

"An embedding maps text to a vector so similarly worded passages can be retrieved even when the query uses a paraphrase. Vectors help semantic similarity, but exact names, dates, and invoice IDs are better served by keyword search. Metadata and authenticated user scope must be enforced alongside vector similarity."

Embeddings do not guarantee relevance or factual understanding.

## Hybrid RAG and RRF

"RAG retrieves source passages, assembles a bounded evidence context, then asks a model to answer with message citations. MailPilot fuses vector and PostgreSQL keyword ranks with Reciprocal Rank Fusion: `score(d) = sum(1 / (60 + rank(d)))`. It deduplicates source IDs, preserves message/thread metadata, scopes retrieval to the user, treats email as untrusted, and abstains when evidence is weak."

On the seven-query synthetic rank replay, hybrid improved Recall@1 from 0.3333 to 1.0 and MRR from 0.4762 to 0.8571. This did not execute live embeddings, PostgreSQL, or answer generation.

## LangGraph

"LangGraph makes interpretation, planning, read-only tool calls, evidence assembly, and answer generation explicit bounded nodes. Conditional routing and checkpoints make failures observable and resumable. State is minimal; graph state does not authorize an action, and private chain-of-thought is not exposed."

## Traditional ML

"I implemented a reproducible TF-IDF + Logistic Regression baseline with a train-only fit, fixed seed, versioned artifact, and thread-separated splits. It scored 55.6% category accuracy and 51.9% macro-F1 on nine synthetic held-out examples. That split is too small for production claims, so the model is not in the app request path."

The LLM comparison returned no valid response because the provider was unavailable. There is no measured basis to select ML or LLM classification.

## Approval safeguards

"Each proposed operation is an immutable payload snapshot with user, evidence, risk, timestamp, and expiry. Approval binds to the exact payload and authenticated owner. Immediately before execution, Express rechecks authorization, lifecycle state, expiry, and idempotency, and records an audit trail. An uncertain provider outcome is reconciled before retry."

Gmail sending is not implemented. Calendar event creation is disabled by default. Repository safeguards are not a substitute for the uncompleted staging/production release gates.

## Trade-offs

- **RRF over a learned reranker:** limited fixture evidence did not justify another model, latency, or tuning stage.
- **Lexical plus vector search:** exact terms and paraphrases have different strengths; the current replay is too small to establish general quality.
- **PostgreSQL system of record:** simple transactional ownership and recovery; service schema ownership and capacity still need care.
- **Synthetic evaluation:** repeatable and privacy preserving, but less representative than a diverse consented corpus.
- **Managed deployment:** planned to reduce operations work; the dated Render estimate was about $89.20/month before variable/model costs, and no resources were provisioned.
- **Approval gates:** more state and user effort, in exchange for explicit review of consequential payloads.

## What next?

"Complete a staging deployment and verify OAuth, sync, migrations, backups, and failure recovery. Then expand the frozen, consented evaluation set, capture privacy-safe service traces, compare quality/latency/cost on fixed model versions, and add a reranker or classifier integration only if measurements justify it."
