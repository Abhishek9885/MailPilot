# MailPilot AI evaluation and observability

**Status:** Phase 5.4 evaluation protocol and Phase 7.4 synthetic RAG evaluation are implemented. No live-model or production-database RAG baseline has run; the recorded Phase 7.4 results below are deterministic rank and answer-trace replays, not product-quality claims.

## What to evaluate

| Area | Metrics | Failure examples |
|---|---|---|
| Retrieval | Recall@k, Precision@k, MRR, nDCG; filter correctness; citation coverage/precision; p50/p95 retrieval latency | Correct conversation omitted, wrong account/source returned, citation does not support claim. |
| Understanding/extraction | Field-level precision/recall/F1; exact date accuracy; evidence-span accuracy; calibration by confidence bucket; abstention rate | Invented deadline, missed task, unsupported priority/category. |
| Answer and draft quality | Human rubric for factual correctness, groundedness, completeness, tone, recipient/thread correctness; citation precision and recall; unsupported-claim rate | False commitment, unsupported answer, wrong recipient or reply context. |
| Tool selection and approval | Tool selection exact match; invalid tool argument rate; unnecessary tool rate; approval bypass count; duplicate side effect count | Any send without approval, changed payload after approval, duplicate send. |
| Baseline classifier | Per-class precision/recall/F1, macro-F1, confusion matrix, calibration; compare against deterministic rules and LLM signal | Baseline fails to beat majority/rule baseline or is overconfident. |
| Operations | End-to-end and per-node p50/p95 latency; sync/index lag; retry/dead-letter rate; provider timeout/rate errors; failure recovery success | Run claims completion with missing durable result or cannot resume after interruption. |
| Cost | Calls and input/output units per run; provider-reported token usage where available; actual or versioned estimated cost per completed run | Cost grows without product-quality improvement or telemetry is mislabeled as actual. |

Targets are not set until a seed corpus, expected user load, and selected providers are known. Define launch gates and SLOs from that baseline; `approval bypasses = 0` and `cross-account results = 0` are hard invariants, not quality targets.

## Evaluation data

- Create a small manually labeled seed set before tuning retrieval or prompts. Store only consented, redacted, synthetic, or otherwise approved content. Keep it outside production mailbox storage and document access/retention.
- Each query has a user/account partition, relevant message/chunk IDs, metadata filters, expected answer facts, required evidence references, task fields/date labels, and expected tool/action decision.
- Split by user and thread, not by chunk, to prevent nearly identical messages from leaking across train and test sets. The classifier training split must not include messages from its evaluation users/threads.
- Include difficult cases: sparse historical context, contradictory dates, forwarded/quoted chains, locale/timezone variation, missing deadline, duplicate sender names, long threads, prompt injection text, and no-answer queries.
- Keep a versioned golden set and record dataset version, annotation rules, model/prompt/index versions, run configuration, and evaluator version for every result.

### Phase 5.4 seed set

`eval/email-analysis-v1.jsonl` is a manually reviewed, fully synthetic eight-message set. It covers work requests with explicit and ambiguous deadlines, finance, travel/event extraction, personal mail, security mail with a prompt-injection attempt, a sender commitment, and a no-action newsletter. Names and addresses are fictional and use the reserved `.invalid` domain. It contains no copied mailbox content and is not used by production services.

Run the live evaluation from the repository root after configuring the local AI provider and explicit pricing rates:

```powershell
npm run eval:analysis
```

Set `OPENAI_API_KEY`, `AI_LLM_INPUT_PRICE_USD_PER_MTOK`, `AI_LLM_OUTPUT_PRICE_USD_PER_MTOK`, and `AI_LLM_PRICING_VERSION` in the local environment. `AI_LLM_CACHED_INPUT_PRICE_USD_PER_MTOK` is optional. The evaluator emits `datasetVersion`, `evaluatorVersion`, and `promptVersion` with each measured run.

Validate labels without making provider calls:

```powershell
uv run --directory apps/ai --project . python scripts/evaluate_email_analysis.py --validate-only
```

The evaluator reports category micro/per-class precision, recall, and F1; priority accuracy; exact-match action, commitment, and event precision/recall/F1; deadline candidate precision/recall/F1 and exact date accuracy; exact-match unmatched extraction rate; source-span support rate; mean/p50/p95 end-to-end analysis latency; token usage; and configured-rate estimated cost. Summary quality is not scored because the short set has no reliable exact-match target for free text. Exact text matching is intentionally conservative for this small set. The unmatched rate is a proxy, not a semantic entailment judgment. A quote appearing in the source does not prove that it supports the claim, so human review remains necessary. Latency includes adapter retries. If output validation fails, latency is counted but the current service response does not expose usage for that failed case. Cost is a configured-rate estimate for successful responses, not a provider invoice; it is omitted unless all cases report configured cost metadata.

### First baseline run record

| Field | Value |
|---|---|
| Run status | Preflight attempted 2026-10-29; no model request (`LLM_CONFIGURATION_INVALID`: provider key unavailable) |
| Checked | 2026-10-29 |
| Dataset | `email-analysis-v1` (8 synthetic reviewed cases) |
| Model/prompt | Not observed; no model request was made (`email-analysis-prompt-v1` is the current prompt version) |
| Accuracy, category performance, deadline correctness, unsupported claims | Not measured |
| Latency and token usage | Not measured |
| Cost | Not measured; no pricing rates configured |

The local environment check found neither a process nor `.env` `OPENAI_API_KEY`, and the three required input/output/pricing-version settings were absent. Configure them in the local environment, run `npm run eval:analysis`, and replace this row with the emitted metrics plus model version, prompt version, pricing version, date, and evaluator revision. Never put a key in the dataset, command line, or report.

## Retrieval evaluation

1. Build a gold query-to-source mapping and label relevant messages/chunks.
2. Measure lexical-only, vector-only, and hybrid retrieval at fixed `k`; report Recall@k, MRR/nDCG and p95 latency by query type.
3. Validate metadata filters independently with adversarial cross-account fixtures; no wrong-account result is acceptable.
4. Measure citation support: for every factual claim, annotators mark whether the cited excerpt entails the claim. Report precision/coverage and abstentions.
5. Evaluate optional reranking as a separate ablation. Add it only when it improves a selected quality measure enough to justify its latency and cost.
6. Re-run the suite after embedding, chunking, full-text configuration, metadata, or retrieval fusion changes. Do not compare incompatible vector versions as if they were the same index.

### Phase 7.4 synthetic RAG baseline

`apps/ai/eval/rag-retrieval-v1.jsonl` is a seven-query, fully synthetic and manually labeled fixture set. It covers exact names, dates, an invoice reference, two semantic paraphrases, a no-answer query, and a foreign-user distractor. Source records retain message/thread IDs, sender, subject, and received-at metadata. No mailbox content or provider call is involved.

Recorded run: 2026-11-15, evaluator `rag-evaluator-v1`, dataset `rag-retrieval-v1`, 500 replay timing iterations per case, fixed retrieval cutoff 3 (also reports @1).

Run the deterministic evaluation from the repository root:

```powershell
npm run eval:rag
```

Validate the labels without running the scorer or timing replay:

```powershell
uv run --directory apps/ai --project . python scripts/evaluate_rag.py --validate-only
```

The evaluator replays the labeled candidate ranks. Vector-only uses the vector candidate order; hybrid uses the Phase 7.2 Reciprocal Rank Fusion formula with rank constant 60. Candidate IDs are deduplicated, and sources outside the query user's scope are discarded. Precision uses `k` as its denominator across all queries, including the no-answer query; Recall averages over the six queries with at least one relevant source; MRR averages across all seven queries with no-relevant queries scored as zero. Citation correctness requires an owned source, an exact quote present in that source, and a manually labeled supported claim. Faithfulness uses the manual support labels. Abstention is scored against the expected abstention label.

| Metric | Vector only (before) | Hybrid RRF (after) |
|---|---:|---:|
| Recall@1 | 0.3333 | 1.0000 |
| Precision@1 | 0.2857 | 0.8571 |
| MRR | 0.4762 | 0.8571 |
| Recall@3 | 1.0000 | 1.0000 |
| Precision@3 | 0.2857 | 0.2857 |

The answer-trace fixture scored citation correctness 1.0000, citation coverage 1.0000, faithfulness 1.0000, and abstention precision/recall 1.0000. These are checks of six hand-authored supported claims and one expected abstention, not generated model answers. The owner-scope fixture contained one foreign-user source and returned zero foreign-user sources.

The recorded local rank replay (500 iterations × 7 cases) measured vector-only p50/p95 at 0.0007/0.0008 ms and hybrid RRF at 0.0039/0.0044 ms. This covers only Python rank selection/fusion; it excludes embedding generation, PostgreSQL, network, and model latency. Replay external calls and estimated local cost were zero; provider answer cost is unavailable because no model was called. Do not use these timings or the synthetic quality scores as production SLO or launch evidence.

No reranker was added. RRF already ranked all six answerable fixture cases first at @1, and this set contains no model-backed or realistic latency/cost evidence that would justify another ranking stage. Re-run against an approved mailbox evaluation set and actual service traces before making a product quality or reranker decision.

## Answer and extraction evaluation

Use a strict structured schema with null/unknown values. Compare fields independently and annotate evidence correctness. Dates are scored only when grounded; parse relative dates against the source message timestamp and explicit timezone assumptions. A missing timezone or ambiguous relative date remains unresolved rather than being assigned a silently guessed time. Evaluate unsupported-claim rate and abstention separately from stylistic quality.

For drafts, use blinded human review against a rubric and validate protocol facts programmatically: recipients must be allowed, reply thread/source IDs must match, and no unapproved claims or recipients may appear. A human score cannot replace the exact server-side approval hash check.

## Scikit-learn baseline

Start with a transparent baseline such as TF-IDF features plus logistic regression for a small labeled category/priority taxonomy. Use class-weighting only when justified by the training set. Keep the split grouped by user/thread, compare macro-F1 and per-class recall to majority and deterministic rules, and inspect confusion/calibration. The baseline is a benchmark and safe fallback signal, not a substitute for extraction or permission checks. Refit only on approved labeled data and version the training corpus/model artifact.

## Tool and approval evaluation

- Construct scenarios whose expected outcome is no tool, read-only retrieval, ask for clarification, or draft proposal.
- Assert exact action and argument correctness; fuzz missing, malformed, and cross-tenant IDs.
- Inject malicious email instructions to verify no policy change and no tool execution.
- Test approval accepted only for exact visible action/version; edit-after-approval, expired, rejected, duplicate, replayed, or wrong-user approval must not send.
- Test timeout immediately before/after provider response and verify reconciliation prevents duplicate side effects.
- Record `approval_bypass_count`, `duplicate_action_count`, and `cross_account_hit_count`; all must remain zero in automated release tests.

## Latency, cost, and tracing

Propagate trace IDs through Next.js → Express → FastAPI → database/provider boundaries. Record node start/end, retries, model/provider version, retrieval configuration, vector/FTS candidate counts, result IDs/ranks, and token/cost usage only when returned by the selected adapter. Track total and per-node p50/p95; separate queue wait, sync, indexing, retrieval, model, approval wait, and execution times. Approval wait is reported separately from compute latency.

The evaluation ledger stores a cost basis: provider-reported units and timestamped price configuration when known, or an explicitly labeled estimate. Do not fabricate comparable costs when adapters/providers expose different usage fields. Content logging is disabled in routine traces; detailed evaluation outputs use a controlled, short-lived store with approved access.

## Release gates and recovery checks

- Contract/schema tests pass for each provider adapter and both HTTP boundaries.
- Gold retrieval and extraction evaluations meet thresholds chosen by product/security owners; report failures, not just averages.
- Cross-account retrieval and unapproved send tests have zero violations.
- Every graph interrupt can resume from persistent storage after process restart; rejection and expiry finish safely.
- Retry/replay tests cover Gmail sync pagination, outbox delivery, embedding idempotency, provider timeout, and send uncertainty.
- Dashboards cover sync/index lag, pending approvals, run status/latency, provider errors, dead letters, token reauth, and deletion completion.
- Evaluate model/provider upgrades against a frozen versioned set before rollout; canary behind a version/config flag and preserve rollback to the previous adapter/model/index.

## Open evaluation decisions

Dataset source and consent procedure; label taxonomy and annotator guide; minimum sample size; quality thresholds; target latency/cost budgets; whether human adjudication is required for every release; and what usage/cost fields each selected provider returns. Resolve these before model quality becomes a launch claim.
