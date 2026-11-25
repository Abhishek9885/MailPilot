# Offline AI evaluation suite

Phase 13.2 adds a repeatable offline suite. It makes no LLM, embedding, Gmail, or database calls. The runner scores a versioned output snapshot, replays the synthetic RAG rank set, and evaluates the local classifier on its frozen held-out test split.

## Run and compare

From the repository root:

```powershell
npm run eval:offline
npm run eval:offline -- --output eval/results/offline-baseline.json
npm run eval:offline -- --run eval/results/candidate-run.json
npm run eval:offline -- --compare-before eval/results/before.json --compare-after eval/results/after.json
```

The committed `eval/offline-agent-suite-v1.json` is a **metric-fixture** run. Its hand-authored predictions check the scorer and adversarial regression cases; its scores are not measured model quality. For a model or prompt evaluation, copy the file, preserve the input/evidence/gold fields, replace each `prediction` with the captured output, and set `runKind` to `captured_model_outputs` with the actual `modelVersion`, `promptVersion`, run ID, pricing version, token use, and per-case latency when available. Human reviewers must label each output claim's `supported` field. Keep captured outputs synthetic or appropriately consented and anonymized.

The snapshot scorer returns metrics and regression case IDs only; it does not copy request text, source evidence, summaries, or claims into the report. `datasetSha256` fingerprints inputs, evidence, and labels. Comparison refuses runs whose dataset version or fingerprint differs, then reports numeric deltas as after minus before. Keep snapshots with their output reports in a controlled evaluation location.

The suite also runs the existing [synthetic RAG evaluator](../apps/ai/eval/rag-retrieval-v1.jsonl) and the local TF-IDF classifier's train-validated, held-out test evaluation. If the local classifier artifact is absent, the runner deterministically trains it from the synthetic train split in a temporary directory. RAG iterations and classifier latency repeats are adjustable with `--rag-iterations` and `--classifier-latency-repeats`. Use `--skip-classifier` when only evaluating output snapshots and the RAG fixture.

## Coverage and metric definitions

| Evaluation area | Definition |
|---|---|
| Summaries | ROUGE-L precision/recall/F1 against one reference summary, plus precision/recall/F1 of manually labeled salient fact IDs. |
| Structured extraction | Exact normalized item matching for actions, deadlines, commitments, and events; report per-type and combined precision/recall/F1. |
| Classification | Accuracy and per-label/macro-F1 for primary category and priority in snapshots. The included classifier report also gives held-out per-class precision/recall/F1, confusion matrices, calibration, and a train-only majority comparator. |
| Retrieval | Precision@k uses `k` as denominator; Recall@k is averaged only across queries with at least one relevant source; MRR includes no-answer queries as zero. Results are owner-scoped and deduplicated. Existing RAG evaluation compares vector-only and RRF hybrid rankings. |
| Citations | Citation correctness requires a known source owned by the case owner, an exact quote in that evidence, and a human support label. Citation coverage divides valid citations by all factual claims. |
| Faithfulness | Share of claims marked supported by human review. Exact quote matching alone does not establish entailment. |
| Abstention | Precision, recall, F1, and accuracy for abstaining when labeled evidence is insufficient. |
| Tool selection | Exact match of the selected allowlisted tool sequence to the labeled sequence; report unknown tool calls separately. |
| Workflow success | A case succeeds only when its success label matches and its graph node trace matches the expected path. |
| Latency, tokens, cost | Captured model snapshots report per-case latency percentiles and token totals. Cost is reported only for cases explicitly marked as provider calls; the total is withheld if any provider-call cost is missing, while a known partial total and coverage counts remain visible. Supplied configured-rate estimates include a pricing version and are never represented as provider billing. RAG replay latency and classifier latency are local computation measurements, not end-to-end service latency. |

## Regression and adversarial cases

The metric fixture includes exact invoice identifiers and dates, action/deadline extraction, prompt-injection text inside an email, an unsupported question, foreign-owner evidence, an ambiguous request that should ask for clarification, and a drafting request that must not invoke a mail tool. The existing RAG set adds semantic paraphrases, source citations, no-answer behavior, and a foreign-user distractor. Add new cases with stable IDs and update `datasetVersion` whenever the labels or inputs change; never tune a held-out classifier split against its test records.

## Limitations

- The committed output snapshot is a scorer fixture, not a generated answer set. It cannot justify model, prompt, or deployment quality claims.
- ROUGE-L is a lexical overlap measure and can undervalue a faithful paraphrase or reward a fluent but incorrect summary. Salient fact IDs help detect omission but still need careful annotation.
- Structured extraction matching is exact after whitespace/case normalization. Equivalent wording and alternate but correct date normalization count as errors unless the labels use the same canonical representation.
- Citation support requires human claim review. The evaluator checks source ownership and quote presence but cannot independently judge entailment.
- The datasets are small synthetic regression sets. The classifier's test sample remains small, and its score does not predict performance on personal or business mail.
- Local replay timing excludes network, database, queueing, provider load, startup, and user-perceived delays. Missing tokens, latency, or cost are reported as unavailable, never filled with estimates.
- Captured outputs should set `providerCallMade` for every case to distinguish a zero-provider-cost fixture from missing provider-call telemetry. A supplied cost without `providerCallMade: true` is rejected; partial provider cost reports are never presented as complete totals.
- Comparing snapshots with different `datasetSha256` values is rejected. Compare model or prompt changes on the same frozen input/gold set, then create a new dataset version when cases change.
