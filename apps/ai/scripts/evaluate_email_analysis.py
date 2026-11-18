import argparse
import asyncio
import json
import math
import statistics
import sys
from collections.abc import Sequence
from datetime import UTC, date, datetime, time
from decimal import Decimal
from pathlib import Path
from typing import Literal
from uuid import NAMESPACE_URL, uuid5

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, ValidationError

from mailpilot_ai.analysis.schemas import EmailAnalysisRequest
from mailpilot_ai.analysis.service import (
    EMAIL_ANALYSIS_PROMPT_VERSION,
    EmailAnalysisOutputError,
    EmailAnalysisService,
)
from mailpilot_ai.config import get_settings
from mailpilot_ai.llm.errors import LLMError
from mailpilot_ai.llm.factory import create_llm_provider

ROOT = Path(__file__).resolve().parents[3]
DATASET_VERSION = "email-analysis-v1"
EVALUATOR_VERSION = "email-analysis-eval-v1"


def _to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class EvaluationModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        str_strip_whitespace=True,
    )


class EvaluationEmail(EvaluationModel):
    subject: str = Field(max_length=2_000)
    sender_name: str | None = Field(max_length=320)
    sender_email: str | None = Field(max_length=320)
    received_at: AwareDatetime
    body_text: str = Field(max_length=100_000)


class ExpectedAction(EvaluationModel):
    task: str
    owner: Literal["user", "sender", "other", "unknown"]
    due_date: date | None


class ExpectedDeadline(EvaluationModel):
    source_text: str
    candidate_date: date | None


class ExpectedCommitment(EvaluationModel):
    speaker: Literal["sender", "user", "third_party", "unknown"]
    commitment: str
    due_date: date | None


class ExpectedEvent(EvaluationModel):
    title: str
    start_date: date | None
    start_time: time | None
    location: str | None


EvaluationCategory = Literal[
    "work",
    "personal",
    "finance",
    "travel",
    "shopping",
    "social",
    "newsletter",
    "security",
    "other",
]


class EvaluationGold(EvaluationModel):
    categories: list[EvaluationCategory] = Field(min_length=1)
    priority: Literal["low", "normal", "high", "urgent"]
    action_items: list[ExpectedAction]
    deadlines: list[ExpectedDeadline]
    commitments: list[ExpectedCommitment]
    event_candidates: list[ExpectedEvent]


class EvaluationRecord(EvaluationModel):
    id: str = Field(pattern=r"^[a-z0-9_]{3,64}$")
    email: EvaluationEmail
    gold: EvaluationGold


def load_dataset(path: Path) -> list[EvaluationRecord]:
    records: list[EvaluationRecord] = []
    seen_ids: set[str] = set()
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            record = EvaluationRecord.model_validate_json(line)
        except ValidationError:
            raise ValueError(f"Invalid evaluation record at line {line_number}") from None
        if record.id in seen_ids:
            raise ValueError(f"Duplicate evaluation record ID at line {line_number}")
        seen_ids.add(record.id)
        records.append(record)
    if not records:
        raise ValueError("Evaluation dataset is empty")
    return records


def normalized(value: str) -> str:
    return " ".join(value.casefold().split())


def score_items(
    gold: Sequence[tuple[object, ...]], predicted: Sequence[tuple[object, ...]]
) -> tuple[int, int, int]:
    remaining = list(gold)
    true_positive = 0
    false_positive = 0
    for item in predicted:
        try:
            remaining.remove(item)
            true_positive += 1
        except ValueError:
            false_positive += 1
    return true_positive, false_positive, len(remaining)


def prf(true_positive: int, false_positive: int, false_negative: int) -> dict[str, float | int]:
    precision = (
        true_positive / (true_positive + false_positive) if true_positive + false_positive else 0.0
    )
    recall = (
        true_positive / (true_positive + false_negative) if true_positive + false_negative else 0.0
    )
    f1 = (2 * precision * recall / (precision + recall)) if precision + recall else 0.0
    return {
        "truePositive": true_positive,
        "falsePositive": false_positive,
        "falseNegative": false_negative,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
    }


def percentile(values: list[float], percentile_value: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, math.ceil(percentile_value * len(ordered)) - 1)
    return round(ordered[index], 2)


def score_category_metrics(
    gold_by_record: list[set[str]], predicted_by_record: list[set[str]]
) -> dict[str, object]:
    labels = sorted(set.union(set(), *gold_by_record, *predicted_by_record))
    per_category: dict[str, object] = {}
    macro_f1_values: list[float] = []
    total_tp = total_fp = total_fn = 0
    for label in labels:
        pairs = zip(gold_by_record, predicted_by_record, strict=True)
        tp = sum(label in gold and label in predicted for gold, predicted in pairs)
        pairs = zip(gold_by_record, predicted_by_record, strict=True)
        fp = sum(label not in gold and label in predicted for gold, predicted in pairs)
        pairs = zip(gold_by_record, predicted_by_record, strict=True)
        fn = sum(label in gold and label not in predicted for gold, predicted in pairs)
        metrics = prf(tp, fp, fn)
        per_category[label] = metrics
        macro_f1_values.append(float(metrics["f1"]))
        total_tp += tp
        total_fp += fp
        total_fn += fn
    return {
        "perCategory": per_category,
        "micro": prf(total_tp, total_fp, total_fn),
        "macroF1": round(statistics.mean(macro_f1_values), 4) if macro_f1_values else 0.0,
    }


def evidence_supported(quote: str, record: EvaluationRecord) -> bool:
    source = normalized("\n".join((record.email.subject, record.email.body_text)))
    return normalized(quote) in source


async def run_evaluation(records: list[EvaluationRecord]) -> dict[str, object]:
    settings = get_settings()
    provider = create_llm_provider(settings)
    service = EmailAnalysisService(provider)
    latencies: list[float] = []
    category_gold: list[set[str]] = []
    category_predicted: list[set[str]] = []
    priority_correct = 0
    action_counts = [0, 0, 0]
    deadline_counts = [0, 0, 0]
    commitment_counts = [0, 0, 0]
    event_counts = [0, 0, 0]
    deadline_date_correct = 0
    deadline_date_expected = sum(len(record.gold.deadlines) for record in records)
    unsupported_predictions = 0
    predicted_fact_count = 0
    evidence_supported_count = 0
    evidence_quote_count = 0
    input_tokens = output_tokens = total_tokens = 0
    cost_values: list[Decimal] = []
    pricing_versions: set[str] = set()
    cost_missing_count = 0
    model_versions: set[str] = set()
    provider_names: set[str] = set()
    invalid_output_count = 0

    try:
        for record in records:
            email_id = uuid5(NAMESPACE_URL, f"mailpilot-eval:{DATASET_VERSION}:{record.id}")
            request = EmailAnalysisRequest(
                user_id=uuid5(NAMESPACE_URL, "mailpilot-evaluation-owner"),
                email_id=email_id,
                source_revision=1,
                subject=record.email.subject,
                sender_name=record.email.sender_name,
                sender_email=record.email.sender_email,
                received_at=record.email.received_at,
                body_text=record.email.body_text,
            )
            started = asyncio.get_running_loop().time()
            try:
                response = await service.analyze(request)
            except EmailAnalysisOutputError:
                latencies.append((asyncio.get_running_loop().time() - started) * 1_000)
                invalid_output_count += 1
                category_gold.append(set(record.gold.categories))
                category_predicted.append(set())
                action_counts = [
                    first + second
                    for first, second in zip(
                        action_counts,
                        score_items(
                            [
                                (
                                    normalized(item.task),
                                    item.owner,
                                    item.due_date.isoformat() if item.due_date else "",
                                )
                                for item in record.gold.action_items
                            ],
                            [],
                        ),
                        strict=True,
                    )
                ]
                deadline_counts = [
                    first + second
                    for first, second in zip(
                        deadline_counts,
                        score_items(
                            [
                                (
                                    normalized(item.source_text),
                                    item.candidate_date.isoformat() if item.candidate_date else "",
                                )
                                for item in record.gold.deadlines
                            ],
                            [],
                        ),
                        strict=True,
                    )
                ]
                commitment_counts = [
                    first + second
                    for first, second in zip(
                        commitment_counts,
                        score_items(
                            [
                                (
                                    item.speaker,
                                    normalized(item.commitment),
                                    item.due_date.isoformat() if item.due_date else "",
                                )
                                for item in record.gold.commitments
                            ],
                            [],
                        ),
                        strict=True,
                    )
                ]
                event_counts = [
                    first + second
                    for first, second in zip(
                        event_counts,
                        score_items(
                            [
                                (
                                    normalized(item.title),
                                    item.start_date.isoformat() if item.start_date else "",
                                    item.start_time.isoformat() if item.start_time else "",
                                    normalized(item.location or ""),
                                )
                                for item in record.gold.event_candidates
                            ],
                            [],
                        ),
                        strict=True,
                    )
                ]
                cost_missing_count += 1
                continue
            latencies.append((asyncio.get_running_loop().time() - started) * 1_000)
            model_versions.add(response.model_version)
            provider_names.add(response.provider)

            gold_categories: set[str] = set(record.gold.categories)
            predicted_categories: set[str] = {
                category.value for category in response.analysis.categories
            }
            category_gold.append(gold_categories)
            category_predicted.append(predicted_categories)
            priority_correct += response.analysis.priority.value == record.gold.priority

            action_keys_gold = [
                (
                    normalized(item.task),
                    item.owner,
                    item.due_date.isoformat() if item.due_date else "",
                )
                for item in record.gold.action_items
            ]
            action_keys_predicted = [
                (
                    normalized(item.task),
                    item.owner,
                    item.due_date.isoformat() if item.due_date else "",
                )
                for item in response.analysis.action_items
            ]
            counts = score_items(action_keys_gold, action_keys_predicted)
            fact_false_positives = counts[1]
            action_counts = [
                first + second for first, second in zip(action_counts, counts, strict=True)
            ]

            deadline_keys_gold = [
                (
                    normalized(item.source_text),
                    item.candidate_date.isoformat() if item.candidate_date else "",
                )
                for item in record.gold.deadlines
            ]
            deadline_keys_predicted = [
                (
                    normalized(item.source_text),
                    item.candidate_date.isoformat() if item.candidate_date else "",
                )
                for item in response.analysis.deadlines
            ]
            counts = score_items(deadline_keys_gold, deadline_keys_predicted)
            fact_false_positives += counts[1]
            deadline_date_correct += counts[0]
            deadline_counts = [
                first + second for first, second in zip(deadline_counts, counts, strict=True)
            ]

            commitment_keys_gold = [
                (
                    item.speaker,
                    normalized(item.commitment),
                    item.due_date.isoformat() if item.due_date else "",
                )
                for item in record.gold.commitments
            ]
            commitment_keys_predicted = [
                (
                    item.speaker,
                    normalized(item.commitment),
                    item.due_date.isoformat() if item.due_date else "",
                )
                for item in response.analysis.commitments
            ]
            counts = score_items(commitment_keys_gold, commitment_keys_predicted)
            fact_false_positives += counts[1]
            commitment_counts = [
                first + second for first, second in zip(commitment_counts, counts, strict=True)
            ]

            event_keys_gold = [
                (
                    normalized(item.title),
                    item.start_date.isoformat() if item.start_date else "",
                    item.start_time.isoformat() if item.start_time else "",
                    normalized(item.location or ""),
                )
                for item in record.gold.event_candidates
            ]
            event_keys_predicted = [
                (
                    normalized(item.title),
                    item.start_date.isoformat() if item.start_date else "",
                    item.start_time.isoformat() if item.start_time else "",
                    normalized(item.location or ""),
                )
                for item in response.analysis.event_candidates
            ]
            counts = score_items(event_keys_gold, event_keys_predicted)
            fact_false_positives += counts[1]
            event_counts = [
                first + second for first, second in zip(event_counts, counts, strict=True)
            ]

            predicted_fact_count += (
                len(response.analysis.action_items)
                + len(response.analysis.deadlines)
                + len(response.analysis.commitments)
                + len(response.analysis.event_candidates)
            )
            unsupported_predictions += fact_false_positives
            for action in response.analysis.action_items:
                evidence_quote_count += 1
                evidence_supported_count += evidence_supported(action.evidence, record)
            for deadline in response.analysis.deadlines:
                evidence_quote_count += 1
                evidence_supported_count += evidence_supported(deadline.evidence, record)
            for commitment in response.analysis.commitments:
                evidence_quote_count += 1
                evidence_supported_count += evidence_supported(commitment.evidence, record)
            for event in response.analysis.event_candidates:
                evidence_quote_count += 1
                evidence_supported_count += evidence_supported(event.evidence, record)

            if response.usage is None:
                cost_missing_count += 1
                continue
            input_tokens += response.usage.input_tokens or 0
            output_tokens += response.usage.output_tokens or 0
            total_tokens += response.usage.total_tokens or 0
            if response.usage.cost is None:
                cost_missing_count += 1
            else:
                cost_values.append(response.usage.cost.estimated_cost_usd)
                pricing_versions.add(response.usage.cost.pricing_version)
    finally:
        await provider.aclose()

    extraction_tp = action_counts[0] + commitment_counts[0] + event_counts[0]
    extraction_fp = action_counts[1] + commitment_counts[1] + event_counts[1]
    extraction_fn = action_counts[2] + commitment_counts[2] + event_counts[2]
    estimated_cost: str | None = None
    if cost_missing_count == 0 and len(cost_values) == len(records):
        estimated_cost = format(sum(cost_values, Decimal(0)), "f")

    return {
        "datasetVersion": DATASET_VERSION,
        "evaluatorVersion": EVALUATOR_VERSION,
        "promptVersion": EMAIL_ANALYSIS_PROMPT_VERSION,
        "generatedAt": datetime.now(UTC).isoformat(),
        "provider": sorted(provider_names),
        "modelVersion": sorted(model_versions),
        "sampleCount": len(records),
        "invalidOutputCount": invalid_output_count,
        "invalidOutputRate": round(invalid_output_count / len(records), 4),
        "categoryPerformance": score_category_metrics(category_gold, category_predicted),
        "priorityAccuracy": round(priority_correct / len(records), 4),
        "structuredExtraction": {
            "actions": prf(*action_counts),
            "commitments": prf(*commitment_counts),
            "events": prf(*event_counts),
            "combined": prf(extraction_tp, extraction_fp, extraction_fn),
        },
        "deadlines": {
            "candidates": prf(*deadline_counts),
            "exactDateAccuracy": (
                round(deadline_date_correct / deadline_date_expected, 4)
                if deadline_date_expected
                else None
            ),
            "goldDeadlineCount": deadline_date_expected,
        },
        "unsupportedOrUnmatchedClaimRate": (
            round(unsupported_predictions / predicted_fact_count, 4)
            if predicted_fact_count
            else 0.0
        ),
        "evidenceQuoteSupportRate": (
            round(evidence_supported_count / evidence_quote_count, 4)
            if evidence_quote_count
            else 1.0
        ),
        "latencyMs": {
            "mean": round(statistics.mean(latencies), 2),
            "p50": percentile(latencies, 0.50),
            "p95": percentile(latencies, 0.95),
        },
        "usage": {
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "totalTokens": total_tokens,
            "estimatedCostUsd": estimated_cost,
            "estimatedCostPerEmailUsd": (
                format(sum(cost_values, Decimal(0)) / len(records), "f")
                if estimated_cost is not None
                else None
            ),
            "costBasis": "configured_token_rates" if estimated_cost is not None else None,
            "pricingVersions": sorted(pricing_versions),
            "costEstimateAvailableForCases": len(cost_values),
        },
    }


async def async_main(dataset_path: Path, validate_only: bool) -> int:
    try:
        records = load_dataset(dataset_path)
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2

    if validate_only:
        print(
            json.dumps(
                {
                    "datasetVersion": DATASET_VERSION,
                    "evaluatorVersion": EVALUATOR_VERSION,
                    "caseCount": len(records),
                    "modelRun": False,
                }
            )
        )
        return 0

    try:
        baseline = await run_evaluation(records)
    except (LLMError, RuntimeError) as error:
        code = error.code if isinstance(error, LLMError) else "AI_CONFIGURATION_INVALID"
        print(json.dumps({"modelRun": False, "safeErrorCode": code}), file=sys.stderr)
        return 2
    print(json.dumps(baseline, indent=2, sort_keys=True))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run the MailPilot structured email analysis baseline."
    )
    parser.add_argument("--dataset", type=Path, default=ROOT / "eval" / f"{DATASET_VERSION}.jsonl")
    parser.add_argument(
        "--validate-only", action="store_true", help="Validate labels without calling the model"
    )
    args = parser.parse_args()
    return asyncio.run(async_main(args.dataset, args.validate_only))


if __name__ == "__main__":
    raise SystemExit(main())
