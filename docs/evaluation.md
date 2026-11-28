# MailPilot AI evaluation and observability

The Phase 13.2 consolidated offline runner is documented in [the AI evaluation suite guide](ai-evaluation-suite.md). It scores versioned output snapshots and compares model/prompt runs without provider calls; the committed snapshot is only a metric fixture, not a product-quality baseline.

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

The Phase 10.1 classification seed set is [`eval/email-classification-v1.jsonl`](../eval/email-classification-v1.jsonl), documented in [the classification dataset note](email-classification-dataset.md). It contains 36 synthetic messages with a reviewed category/priority taxonomy and train/validation/test splits grouped by thread and duplicate family. The validation script checks label balance, reserved sender domains, and cross-split thread/duplicate isolation. Its train split is used only by the experimental Phase 10.2 baseline described below; the seed is not a production-quality benchmark.

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
| Model/prompt | Not observed; no model request was made (`email-analysis-prompt-v2` is the current prompt version) |
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

## Classification baseline

The reproducible synthetic TF-IDF and Logistic Regression baseline is documented in [email-classifier-baseline.md](email-classifier-baseline.md). Run the evaluation with `npm run eval:email-classifier`. It verifies that the artifact's training IDs and checksum match only the train split, fits a majority-class comparator on that split, and reports the held-out test results below. The test set was not used for training or tuning.

### Phase 10.3 held-out test results

| Run date | Model/dataset | Split sizes |
|---|---|---|
| 2026-11-19 | `email-tfidf-logreg-v1` / `email-classification-v1` | 18 train, 9 validation, 9 held-out test |

Every test class has only one message for primary category and one to three for priority. The figures below are test performance, not training performance.

The comparator is `DummyClassifier(strategy="most_frequent")`, fit on train only. All nine primary categories tie in the train split; the classifier's deterministic tie result is `finance`. Priority's most frequent train label is `low`.

| Test target | Model accuracy | Model macro precision | Model macro recall | Model macro-F1 | Majority accuracy | Majority macro-F1 |
|---|---:|---:|---:|---:|---:|---:|
| Primary category (9 labels) | 55.6% (5/9) | 50.0% | 55.6% | 51.9% | 11.1% (1/9) | 2.2% |
| Priority (4 labels) | 55.6% (5/9) | 40.0% | 45.8% | 41.3% | 22.2% (2/9) | 9.1% |

#### Per-class test metrics

| Target | Class | Support | Precision | Recall | F1 |
|---|---|---:|---:|---:|---:|
| Primary category | `work` | 1 | 0.50 | 1.00 | 0.67 |
| Primary category | `personal` | 1 | 1.00 | 1.00 | 1.00 |
| Primary category | `finance` | 1 | 0.00 | 0.00 | 0.00 |
| Primary category | `travel` | 1 | 0.00 | 0.00 | 0.00 |
| Primary category | `shopping` | 1 | 0.00 | 0.00 | 0.00 |
| Primary category | `social` | 1 | 1.00 | 1.00 | 1.00 |
| Primary category | `newsletter` | 1 | 1.00 | 1.00 | 1.00 |
| Primary category | `security` | 1 | 1.00 | 1.00 | 1.00 |
| Primary category | `other` | 1 | 0.00 | 0.00 | 0.00 |
| Priority | `low` | 2 | 0.50 | 0.50 | 0.50 |
| Priority | `normal` | 3 | 0.60 | 1.00 | 0.75 |
| Priority | `high` | 3 | 0.50 | 0.33 | 0.40 |
| Priority | `urgent` | 1 | 0.00 | 0.00 | 0.00 |

#### Confusion matrices

Rows are actual labels and columns are predicted labels. For primary category the column order is `work, personal, finance, travel, shopping, social, newsletter, security, other`:

| Actual \ Predicted | work | personal | finance | travel | shopping | social | newsletter | security | other |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| work | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| personal | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| finance | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| travel | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| shopping | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| social | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| newsletter | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 |
| security | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| other | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |

For priority the column order is `low, normal, high, urgent`:

| Actual \ Predicted | low | normal | high | urgent |
|---|---:|---:|---:|---:|
| low | 1 | 1 | 0 | 0 |
| normal | 0 | 3 | 0 | 0 |
| high | 1 | 1 | 1 | 0 |
| urgent | 0 | 0 | 1 | 0 |

The evaluator includes an extra `__abstain__` prediction column in its matrices; there were no abstentions on this test split.

The majority comparator predicts `finance` for all nine category examples and `low` for all nine priority examples. It gets one category example and two priority examples right.

#### Calibration and latency

The raw Logistic Regression probabilities produced a multiclass Brier score of `0.8530` and five-bin top-label expected calibration error of `0.4223` for category; priority scored `0.6941` Brier and `0.2316` ECE. These are uncalibrated diagnostics from only nine examples, not a calibration guarantee or a basis for a confidence threshold.

Local in-process prediction latency was **1.095 ms p50 / 2.113 ms p95**, measured over 900 calls (100 calls for each held-out message) after warming up each message once. The model was already loaded; this excludes process startup, API/network time, and production load.

#### Error inspection and limitations

- Category errors: the invoice (`cls-finance-test-01`) was called `work`; hotel booking (`cls-travel-test-01`) and saved-list availability (`cls-shopping-test-01`) were called `finance`; a building-access alarm test (`cls-other-test-01`) was called `travel`. These suggest word overlap from the tiny training examples (`invoice`, `booking`, availability, schedules), not a reliable category boundary.
- Priority errors: two `high` messages were predicted `low`/`normal`, the `low` travel booking was predicted `normal`, and the sole `urgent` building-access message was predicted `high`. The model did not identify the urgent example; urgent had only one training example, a security alert.
- Every category test support is one, while priority support is one to three. One changed prediction moves per-class recall by 1.0 for categories and by 0.33–1.0 for priority. The synthetic writing style is narrow and the corpus is not representative of a real inbox.
- The baseline beats this weak majority comparator on this fixed test sample, but the sample is too small to support a quality or deployment claim. Do not tune against these test examples; expand the synthetic/consented dataset, retain thread-level separation, and evaluate on a larger frozen test set before integration.

### Phase 10.4 ML and LLM comparison

Run `npm run compare:email-classifier` (three repeats by default) to compare `email-tfidf-logreg-v1` and the configured LLM on exactly the same nine held-out synthetic messages. The script reuses the train-only majority comparator evaluation for ML, records the LLM provider/model and prompt versions, reports first-pass and mean quality metrics, p50/p95 request latency, exact output stability across repetitions for both methods, token usage, and cost only when all requests are priced using configured rates. LLM email text is explicitly marked untrusted in the prompt. Provider failures and invalid structured outputs are counted without recording request text or provider responses; provider errors stop further calls.

#### Recorded comparison attempt (2026-11-20)

The three-repeat command used the same nine test IDs listed above, but the configured provider returned safe error code `LLM_PROVIDER_UNAVAILABLE` on the first call. The script stopped as designed: 0 valid LLM responses, 1 failed call measured at 7,948 ms, and 26 calls unattempted. The LLM's category/priority quality and run-to-run stability are **unavailable**; no token usage or dollar cost was returned, and cost is **unavailable**. This is not an LLM quality score and cannot be compared to the ML result.

| Approach | Category accuracy / macro-F1 | Priority accuracy / macro-F1 | p50 / p95 latency | Cost | Stability |
|---|---:|---:|---:|---|---|
| ML `email-tfidf-logreg-v1` | 55.6% / 51.9% | 55.6% / 41.3% | 1.06 / 1.42 ms (900 local calls) | No external API cost; excludes compute/training | 100% exact output stability (9/9 records, three local repeats) |
| Configured LLM | Unavailable (0 valid outputs) | Unavailable (0 valid outputs) | 7,948 ms failed request only; not representative | Unavailable (no usage returned; token rates not configured) | Unavailable (0 eligible records) |

Re-run after provider access is restored to collect a valid comparison. Until then, there is no measured evidence to prefer either model for classification quality. Keep the existing user-facing analysis flow unchanged.

Use the local classifier when the measured quality is adequate for a narrow, stable label set and low latency/local processing matter. Use an LLM when broader language coverage or context handling justifies its measured provider latency and cost. The current nine-message test set is too small to select a winner or make a deployment claim; keep both experimental until a larger frozen held-out set establishes useful evidence.

## Open evaluation decisions

Dataset source and consent procedure; label taxonomy and annotator guide; minimum sample size; quality thresholds; target latency/cost budgets; whether human adjudication is required for every release; and what usage/cost fields each selected provider returns. Resolve these before model quality becomes a launch claim.
