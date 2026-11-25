"""Score versioned offline AI output snapshots against synthetic gold labels."""

from __future__ import annotations

import json
import re
import statistics
from collections import Counter
from datetime import UTC, datetime
from decimal import Decimal
from hashlib import sha256
from math import ceil
from pathlib import Path
from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, ValidationError

EVALUATOR_VERSION = "mailpilot-offline-suite-v1"
_WORDS = re.compile(r"[a-z0-9]+", re.IGNORECASE)
_ALLOWED_TOOLS = frozenset({"gmail_search", "rag_answer"})


class _StrictModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=lambda name: name.split("_")[0]
        + "".join(part.capitalize() for part in name.split("_")[1:]),
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        strict=True,
    )


class CitationClaim(_StrictModel):
    claim: str
    evidence_id: str | None
    quote: str | None
    supported: bool


class EvaluationEmail(_StrictModel):
    subject: str
    sender_name: str | None = None
    sender_email: str | None = None
    received_at: AwareDatetime | None = None
    body_text: str


class CaseGold(_StrictModel):
    summary_reference: str | None = None
    summary_fact_ids: tuple[str, ...] | None = None
    primary_category: str | None = None
    priority: str | None = None
    action_items: tuple[str, ...] | None = None
    deadlines: tuple[str, ...] | None = None
    commitments: tuple[str, ...] | None = None
    events: tuple[str, ...] | None = None
    relevant_evidence_ids: tuple[str, ...] | None = None
    retrieval_k: int = Field(default=3, ge=1, le=100)
    claims_evaluated: bool = False
    should_abstain: bool | None = None
    expected_intent: str | None = None
    expected_tools: tuple[str, ...] | None = None
    expected_graph_trace: tuple[str, ...] | None = None
    workflow_succeeded: bool | None = None


class CasePrediction(_StrictModel):
    summary: str | None = None
    summary_fact_ids: tuple[str, ...] | None = None
    primary_category: str | None = None
    priority: str | None = None
    action_items: tuple[str, ...] | None = None
    deadlines: tuple[str, ...] | None = None
    commitments: tuple[str, ...] | None = None
    events: tuple[str, ...] | None = None
    retrieved_ids: tuple[str, ...] | None = None
    claims: tuple[CitationClaim, ...] | None = None
    abstained: bool | None = None
    intent: str | None = None
    selected_tools: tuple[str, ...] | None = None
    graph_trace: tuple[str, ...] | None = None
    workflow_succeeded: bool | None = None
    provider_call_made: bool | None = None
    latency_ms: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    input_tokens: int | None = Field(default=None, ge=0)
    output_tokens: int | None = Field(default=None, ge=0)
    estimated_cost_usd: Decimal | None = Field(default=None, ge=0)


class OfflineEvaluationCase(_StrictModel):
    case_id: str = Field(min_length=1, max_length=128)
    tags: tuple[str, ...] = ()
    owner_id: str | None = None
    request: str | None = None
    email: EvaluationEmail | None = None
    evidence: dict[str, str] = Field(default_factory=dict)
    evidence_owners: dict[str, str] = Field(default_factory=dict)
    gold: CaseGold
    prediction: CasePrediction


class OfflineEvaluationRun(_StrictModel):
    dataset_version: str = Field(min_length=1, max_length=64)
    run_id: str = Field(min_length=1, max_length=128)
    run_kind: Literal["metric_fixture", "captured_model_outputs"]
    model_version: str = Field(min_length=1, max_length=128)
    prompt_version: str = Field(min_length=1, max_length=128)
    pricing_version: str | None = Field(default=None, max_length=64)
    cases: tuple[OfflineEvaluationCase, ...] = Field(min_length=1)


def load_run(path: Path) -> OfflineEvaluationRun:
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        raise ValueError("Cannot read the offline evaluation run") from None
    try:
        run = OfflineEvaluationRun.model_validate_json(content)
    except (ValidationError, ValueError):
        raise ValueError("The offline evaluation run does not match its schema") from None
    case_ids = [case.case_id for case in run.cases]
    if len(case_ids) != len(set(case_ids)):
        raise ValueError("Offline evaluation case IDs must be unique")
    _validate_run(run)
    return run


def _validate_run(run: OfflineEvaluationRun) -> None:
    for case in run.cases:
        if case.prediction.estimated_cost_usd is not None and (
            case.prediction.provider_call_made is not True
        ):
            raise ValueError(
                f"Provider cost requires provider_call_made=true for case {case.case_id}"
            )
        if case.prediction.estimated_cost_usd is not None and run.pricing_version is None:
            raise ValueError(
                f"Provider cost requires pricing_version for case {case.case_id}"
            )
        if set(case.evidence_owners) - set(case.evidence):
            raise ValueError(f"Evidence ownership is incomplete for case {case.case_id}")
        if case.owner_id is not None and set(case.evidence) - set(case.evidence_owners):
            raise ValueError(f"Evidence owner labels are missing for case {case.case_id}")
        if case.gold.relevant_evidence_ids is not None and any(
            evidence_id not in case.evidence for evidence_id in case.gold.relevant_evidence_ids
        ):
            raise ValueError(f"Gold retrieval labels reference unknown evidence in {case.case_id}")
        if case.owner_id is not None and any(
            case.evidence_owners.get(evidence_id) != case.owner_id
            for evidence_id in (case.gold.relevant_evidence_ids or ())
        ):
            raise ValueError(f"Gold retrieval labels include foreign evidence in {case.case_id}")
        if case.gold.summary_fact_ids is not None and len(set(case.gold.summary_fact_ids)) != len(
            case.gold.summary_fact_ids
        ):
            raise ValueError(f"Summary fact labels are duplicated in {case.case_id}")


def _item_metrics(
    gold_rows: list[tuple[str, ...]], predicted_rows: list[tuple[str, ...]]
) -> dict[str, object]:
    true_positive = false_positive = false_negative = 0
    for gold, predicted in zip(gold_rows, predicted_rows, strict=True):
        expected = Counter(_normalize(item) for item in gold)
        output = Counter(_normalize(item) for item in predicted)
        true_positive += sum((expected & output).values())
        false_positive += sum((output - expected).values())
        false_negative += sum((expected - output).values())
    return _prf(true_positive, false_positive, false_negative)


def _prf(true_positive: int, false_positive: int, false_negative: int) -> dict[str, object]:
    precision = (
        true_positive / (true_positive + false_positive) if true_positive + false_positive else 0.0
    )
    recall = (
        true_positive / (true_positive + false_negative) if true_positive + false_negative else 0.0
    )
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "truePositive": true_positive,
        "falsePositive": false_positive,
        "falseNegative": false_negative,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
    }


def _normalize(value: str) -> str:
    return " ".join(value.casefold().split())


def _rouge_l(reference: str, prediction: str) -> dict[str, float]:
    reference_tokens = _WORDS.findall(reference.casefold())
    prediction_tokens = _WORDS.findall(prediction.casefold())
    if not reference_tokens and not prediction_tokens:
        return {"precision": 1.0, "recall": 1.0, "f1": 1.0}
    if not reference_tokens or not prediction_tokens:
        return {"precision": 0.0, "recall": 0.0, "f1": 0.0}
    previous = [0] * (len(prediction_tokens) + 1)
    for reference_token in reference_tokens:
        current = [0]
        for index, prediction_token in enumerate(prediction_tokens, start=1):
            current.append(
                previous[index - 1] + 1
                if reference_token == prediction_token
                else max(previous[index], current[index - 1])
            )
        previous = current
    common = previous[-1]
    precision = common / len(prediction_tokens)
    recall = common / len(reference_tokens)
    return {
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(2 * precision * recall / (precision + recall), 4)
        if precision + recall
        else 0.0,
    }


def _summary_metrics(cases: tuple[OfflineEvaluationCase, ...]) -> dict[str, object] | None:
    selected = [case for case in cases if case.gold.summary_reference is not None]
    if not selected:
        return None
    scores = [
        _rouge_l(case.gold.summary_reference or "", case.prediction.summary or "")
        for case in selected
    ]
    fact_cases = [case for case in selected if case.gold.summary_fact_ids is not None]
    fact_scores = (
        _item_metrics(
            [case.gold.summary_fact_ids or () for case in fact_cases],
            [case.prediction.summary_fact_ids or () for case in fact_cases],
        )
        if fact_cases
        else None
    )
    return {
        "rougeL": {
            metric: round(statistics.mean(score[metric] for score in scores), 4)
            for metric in ("precision", "recall", "f1")
        },
        "salientFactIds": fact_scores,
        "caseCount": len(selected),
    }


def _classification_metrics(
    cases: tuple[OfflineEvaluationCase, ...], field: Literal["primary_category", "priority"]
) -> dict[str, object] | None:
    selected = [case for case in cases if getattr(case.gold, field) is not None]
    if not selected:
        return None
    labels = sorted(
        {str(getattr(case.gold, field)) for case in selected}
        | {str(getattr(case.prediction, field) or "__missing__") for case in selected}
    )
    expected = [str(getattr(case.gold, field)) for case in selected]
    predicted = [str(getattr(case.prediction, field) or "__missing__") for case in selected]
    per_class: dict[str, object] = {}
    f1_values: list[float] = []
    label_pairs = list(zip(expected, predicted, strict=True))
    for label in labels:
        tp = sum(actual == label and output == label for actual, output in label_pairs)
        fp = sum(actual != label and output == label for actual, output in label_pairs)
        fn = sum(actual == label and output != label for actual, output in label_pairs)
        item = _prf(tp, fp, fn)
        per_class[label] = item
        f1_value = item["f1"]
        if isinstance(f1_value, (int, float)):
            f1_values.append(float(f1_value))
    return {
        "accuracy": round(sum(a == p for a, p in label_pairs) / len(expected), 4),
        "macroF1": round(statistics.mean(f1_values), 4) if f1_values else 0.0,
        "perClass": per_class,
        "caseCount": len(selected),
    }


def _retrieval_metrics(cases: tuple[OfflineEvaluationCase, ...]) -> dict[str, object] | None:
    selected = [case for case in cases if case.gold.relevant_evidence_ids is not None]
    if not selected:
        return None
    precision_values: list[float] = []
    recall_values: list[float] = []
    reciprocal_ranks: list[float] = []
    foreign_source_count = 0
    for case in selected:
        gold = set(case.gold.relevant_evidence_ids or ())
        raw_ranked = case.prediction.retrieved_ids or ()
        foreign_source_count += sum(
            1
            for evidence_id in raw_ranked
            if evidence_id in case.evidence
            and case.owner_id is not None
            and case.evidence_owners.get(evidence_id) != case.owner_id
        )
        ranked: list[str] = []
        seen: set[str] = set()
        for evidence_id in raw_ranked:
            if evidence_id in seen or evidence_id not in case.evidence:
                continue
            if case.owner_id is not None and case.evidence_owners.get(evidence_id) != case.owner_id:
                continue
            seen.add(evidence_id)
            ranked.append(evidence_id)
        top_k = ranked[: case.gold.retrieval_k]
        hits = sum(evidence_id in gold for evidence_id in top_k)
        precision_values.append(hits / case.gold.retrieval_k)
        if gold:
            recall_values.append(hits / len(gold))
        first_hit = next(
            (rank for rank, evidence_id in enumerate(ranked, 1) if evidence_id in gold),
            None,
        )
        reciprocal_ranks.append(1 / first_hit if first_hit is not None else 0.0)
    return {
        f"precisionAt{selected[0].gold.retrieval_k}": round(statistics.mean(precision_values), 4),
        f"recallAt{selected[0].gold.retrieval_k}": round(statistics.mean(recall_values), 4)
        if recall_values
        else None,
        "mrr": round(statistics.mean(reciprocal_ranks), 4),
        "queryCount": len(selected),
        "queriesWithRelevantEvidence": len(recall_values),
        "foreignSourcesReturned": foreign_source_count,
    }


def _rag_metrics(cases: tuple[OfflineEvaluationCase, ...]) -> dict[str, object] | None:
    selected = [case for case in cases if case.gold.claims_evaluated]
    if not selected:
        return None
    claims = [claim for case in selected for claim in (case.prediction.claims or ())]
    citation_attempts = [
        claim for claim in claims if claim.evidence_id is not None or claim.quote is not None
    ]
    valid_citations = 0
    for case in selected:
        for claim in case.prediction.claims or ():
            evidence = case.evidence.get(claim.evidence_id or "")
            owner = case.evidence_owners.get(claim.evidence_id or "")
            valid_citations += int(
                evidence is not None
                and claim.quote is not None
                and claim.quote in evidence
                and claim.supported
                and (case.owner_id is None or owner == case.owner_id)
            )
    supported_count = sum(claim.supported for claim in claims)
    return {
        "citationCorrectness": round(valid_citations / len(citation_attempts), 4)
        if citation_attempts
        else None,
        "citationCoverage": round(valid_citations / len(claims), 4) if claims else None,
        "answerFaithfulness": round(supported_count / len(claims), 4) if claims else None,
        "citationAttempts": len(citation_attempts),
        "claimCount": len(claims),
    }


def _binary_metrics(cases: tuple[OfflineEvaluationCase, ...]) -> dict[str, object] | None:
    selected = [case for case in cases if case.gold.should_abstain is not None]
    if not selected:
        return None
    tp = sum(
        case.gold.should_abstain is True and case.prediction.abstained is True for case in selected
    )
    fp = sum(
        case.gold.should_abstain is False and case.prediction.abstained is True for case in selected
    )
    fn = sum(
        case.gold.should_abstain is True and case.prediction.abstained is not True
        for case in selected
    )
    tn = sum(
        case.gold.should_abstain is False and case.prediction.abstained is False
        for case in selected
    )
    prf = _prf(tp, fp, fn)
    return {
        "precision": prf["precision"],
        "recall": prf["recall"],
        "f1": prf["f1"],
        "accuracy": round((tp + tn) / len(selected), 4),
        "truePositive": tp,
        "falsePositive": fp,
        "falseNegative": fn,
        "trueNegative": tn,
        "caseCount": len(selected),
    }


def _agent_metrics(cases: tuple[OfflineEvaluationCase, ...]) -> dict[str, object]:
    intent_cases = [case for case in cases if case.gold.expected_intent is not None]
    tool_cases = [case for case in cases if case.gold.expected_tools is not None]
    workflow_cases = [
        case
        for case in cases
        if case.gold.workflow_succeeded is not None
    ]
    intent_accuracy = (
        sum(case.gold.expected_intent == case.prediction.intent for case in intent_cases)
        / len(intent_cases)
        if intent_cases
        else None
    )
    tool_exact = [
        case.prediction.selected_tools is not None
        and case.gold.expected_tools == case.prediction.selected_tools
        for case in tool_cases
    ]
    trace_cases = [case for case in cases if case.gold.expected_graph_trace is not None]
    trace_exact = [
        case.prediction.graph_trace is not None
        and case.gold.expected_graph_trace == case.prediction.graph_trace
        for case in trace_cases
    ]
    invalid_tools = sum(
        tool not in _ALLOWED_TOOLS
        for case in tool_cases
        for tool in (case.prediction.selected_tools or ())
    )
    success_matches = []
    for case in workflow_cases:
        trace_matches = (
            case.gold.expected_graph_trace is None
            or case.gold.expected_graph_trace == case.prediction.graph_trace
        )
        success_matches.append(
            case.gold.workflow_succeeded is case.prediction.workflow_succeeded and trace_matches
        )
    return {
        "intentAccuracy": round(intent_accuracy, 4) if intent_accuracy is not None else None,
        "intentCaseCount": len(intent_cases),
        "toolSelectionExactMatch": (
            round(sum(tool_exact) / len(tool_exact), 4) if tool_exact else None
        ),
        "toolCaseCount": len(tool_cases),
        "invalidToolCallCount": invalid_tools,
        "graphTraceExactMatch": (
            round(sum(trace_exact) / len(trace_exact), 4) if trace_exact else None
        ),
        "graphTraceCaseCount": len(trace_cases),
        "workflowSuccessRate": round(sum(success_matches) / len(success_matches), 4)
        if success_matches
        else None,
        "workflowCaseCount": len(success_matches),
    }


def _latency_cost_metrics(run: OfflineEvaluationRun) -> dict[str, object]:
    latencies = [
        case.prediction.latency_ms for case in run.cases if case.prediction.latency_ms is not None
    ]
    provider_calls = [
        case for case in run.cases if case.prediction.provider_call_made is True
    ]
    costs = [
        case.prediction.estimated_cost_usd
        for case in provider_calls
        if case.prediction.estimated_cost_usd is not None
    ]
    all_provider_calls_priced = bool(provider_calls) and len(costs) == len(provider_calls)
    token_cases = [case.prediction for case in run.cases]
    return {
        "latencyMs": {
            "count": len(latencies),
            "p50": _percentile(latencies, 0.50),
            "p95": _percentile(latencies, 0.95),
            "mean": round(statistics.mean(latencies), 3) if latencies else None,
        },
        "tokens": {
            "input": sum(prediction.input_tokens or 0 for prediction in token_cases),
            "output": sum(prediction.output_tokens or 0 for prediction in token_cases),
            "reportedCaseCount": sum(
                prediction.input_tokens is not None or prediction.output_tokens is not None
                for prediction in token_cases
            ),
        },
        "cost": {
            "estimatedTotalUsd": (
                format(sum(costs, Decimal(0)), "f") if all_provider_calls_priced else None
            ),
            "knownPartialTotalUsd": format(sum(costs, Decimal(0)), "f") if costs else None,
            "providerCallCaseCount": len(provider_calls),
            "pricedProviderCallCount": len(costs),
            "unpricedProviderCallCount": len(provider_calls) - len(costs),
            "unknownProviderCallStatusCount": sum(
                case.prediction.provider_call_made is None for case in run.cases
            ),
            "pricingVersion": run.pricing_version,
            "basis": "configured_estimates_only",
        },
    }


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, ceil(len(ordered) * percentile) - 1))
    return round(ordered[index], 3)


def evaluate_run(run: OfflineEvaluationRun) -> dict[str, object]:
    gold_rows = {
        field: [
            getattr(case.gold, field) or ()
            for case in run.cases
            if getattr(case.gold, field) is not None
        ]
        for field in ("action_items", "deadlines", "commitments", "events")
    }
    predicted_rows = {
        field: [
            getattr(case.prediction, field) or ()
            for case in run.cases
            if getattr(case.gold, field) is not None
        ]
        for field in ("action_items", "deadlines", "commitments", "events")
    }
    extraction: dict[str, object] = {}
    for field in gold_rows:
        if any(
            gold or predicted
            for gold, predicted in zip(gold_rows[field], predicted_rows[field], strict=True)
        ):
            extraction[field] = _item_metrics(gold_rows[field], predicted_rows[field])
    if extraction:
        combined_gold = [
            tuple(f"{field}:{item}" for item in row)
            for field, rows in gold_rows.items()
            for row in rows
        ]
        combined_prediction = [
            tuple(f"{field}:{item}" for item in row)
            for field, rows in predicted_rows.items()
            for row in rows
        ]
        extraction["combined"] = _item_metrics(
            combined_gold,
            combined_prediction,
        )
    return {
        "datasetVersion": run.dataset_version,
        "datasetSha256": _gold_fingerprint(run),
        "evaluatorVersion": EVALUATOR_VERSION,
        "run": {
            "runId": run.run_id,
            "runKind": run.run_kind,
            "modelVersion": run.model_version,
            "promptVersion": run.prompt_version,
            "pricingVersion": run.pricing_version,
        },
        "generatedAt": datetime.now(UTC).isoformat(),
        "caseCount": len(run.cases),
        "adversarialCaseCount": sum("adversarial" in case.tags for case in run.cases),
        "summary": _summary_metrics(run.cases),
        "classification": {
            "primaryCategory": _classification_metrics(run.cases, "primary_category"),
            "priority": _classification_metrics(run.cases, "priority"),
        },
        "extraction": extraction,
        "retrieval": _retrieval_metrics(run.cases),
        "rag": _rag_metrics(run.cases),
        "abstention": _binary_metrics(run.cases),
        "agent": _agent_metrics(run.cases),
        "operations": _latency_cost_metrics(run),
        "regressions": {
            "incorrectAbstentionCaseIds": [
                case.case_id
                for case in run.cases
                if case.gold.should_abstain is not None
                and case.gold.should_abstain is not case.prediction.abstained
            ],
            "foreignEvidenceCaseIds": [
                case.case_id
                for case in run.cases
                if any(
                    case.evidence_owners.get(evidence_id) not in {None, case.owner_id}
                    for evidence_id in (case.prediction.retrieved_ids or ())
                )
            ],
            "invalidToolCallCaseIds": [
                case.case_id
                for case in run.cases
                if any(
                    tool not in _ALLOWED_TOOLS for tool in (case.prediction.selected_tools or ())
                )
            ],
            "failedWorkflowCaseIds": [
                case.case_id
                for case in run.cases
                if case.gold.workflow_succeeded is True
                and (
                    case.prediction.workflow_succeeded is not True
                    or (
                        case.gold.expected_graph_trace is not None
                        and case.prediction.graph_trace != case.gold.expected_graph_trace
                    )
                )
            ],
        },
    }


def compare_runs(before: OfflineEvaluationRun, after: OfflineEvaluationRun) -> dict[str, object]:
    if before.dataset_version != after.dataset_version or _gold_fingerprint(
        before
    ) != _gold_fingerprint(after):
        raise ValueError("Evaluation runs must use the same labeled dataset and evidence")
    before_result = evaluate_run(before)
    after_result = evaluate_run(after)
    before_values = _flatten_numeric(before_result)
    after_values = _flatten_numeric(after_result)
    deltas = {
        key: round(after_values[key] - value, 6)
        for key, value in before_values.items()
        if key in after_values
    }
    return {
        "evaluatorVersion": EVALUATOR_VERSION,
        "before": before_result["run"],
        "after": after_result["run"],
        "metricDeltasAfterMinusBefore": deltas,
        "qualityBefore": before_result,
        "qualityAfter": after_result,
    }


def _flatten_numeric(value: object, prefix: str = "") -> dict[str, float]:
    flattened: dict[str, float] = {}
    if isinstance(value, dict):
        for key, child in value.items():
            flattened.update(_flatten_numeric(child, f"{prefix}.{key}" if prefix else str(key)))
    elif isinstance(value, (int, float, Decimal)) and not isinstance(value, bool):
        flattened[prefix] = float(value)
    elif isinstance(value, str) and prefix.endswith("estimatedTotalUsd"):
        flattened[prefix] = float(Decimal(value))
    return flattened


def _gold_fingerprint(run: OfflineEvaluationRun) -> str:
    payload = [
        {
            "caseId": case.case_id,
            "tags": case.tags,
            "ownerId": case.owner_id,
            "request": case.request,
            "email": case.email.model_dump(mode="json", by_alias=True)
            if case.email is not None
            else None,
            "evidence": case.evidence,
            "evidenceOwners": case.evidence_owners,
            "gold": case.gold.model_dump(mode="json", by_alias=True),
        }
        for case in run.cases
    ]
    serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha256(serialized.encode("utf-8")).hexdigest()


def dump_report(report: dict[str, object]) -> str:
    return json.dumps(report, indent=2, sort_keys=True)
