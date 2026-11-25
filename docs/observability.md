# Observability

MailPilot emits structured JSON logs to each service's standard output. These events provide request-level operational reporting and content-free timing spans for the AI workflow. No external tracing exporter is enabled; in particular, LangSmith is not configured because it can transfer prompts and retrieved email evidence to a third party.

## Correlation and events

- Express creates or validates the public `requestId`, returns it in `x-request-id`, and forwards it to FastAPI for email analysis and reply drafting.
- FastAPI binds `requestId` to structured logs for the request lifetime. RAG requests also bind their stable `runId` while executing the graph.
- `request.completed` includes method, path, status, and `durationMs`.
- `rag.node.completed` records the safe LangGraph node name, step number, `requestId`, `runId`, and elapsed milliseconds. Workflow completion, replay, and interruption events include an aggregate duration and a node-name trace.
- `rag.tool.completed` and `rag.tool.attempt_failed` record the allowlisted tool name, attempt, elapsed milliseconds, safe error code, retryability, and result counts where applicable.
- `llm.call.completed` and `embedding.call.completed` include provider/model, elapsed milliseconds, and provider-reported token counts. Estimated cost and `pricingVersion` appear only when a configured rate card is available. These are estimates, not provider invoices.
- Failure events include a safe error code and exception class, never exception messages or raw provider responses.

The logs do not contain model reasoning, request bodies, prompts, email contents, evidence excerpts, model outputs, OAuth credentials, or provider request IDs. The AI JSON logging processor recursively redacts common sensitive field names as a final safeguard. Express Pino redaction covers request bodies and known email, prompt, credential, and token fields. Redaction is defense in depth; code should continue to log only explicit safe fields.

## Retention and access

The application does not persist operational logs or choose a log-sink retention period. Each deployment must configure its stdout collector to:

- restrict log access to operators who need service-health and incident diagnostics, using least privilege and audited access;
- keep routine operational events for no more than 30 days and temporary debug data for no more than 7 days, unless a shorter organization policy applies;
- encrypt logs in transit and at rest, and prevent email, prompt, credential, or model-output fields from being added through collector-side enrichment;
- avoid copying production logs into developer workspaces or evaluation datasets.

Do not enable content capture or export logs to a tracing SaaS without a separate privacy/security review, documented retention and access controls, and verified redaction behavior. Audit records for approvals and external actions have a separate lifecycle in the application security policy.

## Operational use

Use `requestId` to follow one HTTP request across Express and FastAPI, and `runId` to follow one persistent RAG graph run. Compare `durationMs` across request, node, tool, and provider events to locate latency. Aggregate token and estimated-cost fields by provider/model and pricing version; missing usage or cost means the adapter did not provide enough information to report it. Structured event logs are the current metrics source; no Prometheus/OpenTelemetry metrics endpoint is configured.
