"""Score deterministic RAG rank and answer traces against reviewed labels."""

from __future__ import annotations

import json
import statistics
import time
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from math import ceil
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, ValidationError

RRF_RANK_CONSTANT = 60
EVALUATOR_VERSION = "rag-evaluator-v1"


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class EvidenceSource(_StrictModel):
    source_id: str = Field(min_length=1)
    user_id: str = Field(min_length=1)
    message_id: str = Field(min_length=1)
    thread_id: str = Field(min_length=1)
    subject: str
    sender_name: str
    sender_email: str
    received_at: str
    text: str


class AnswerClaimTrace(_StrictModel):
    claim: str
    evidence_id: str | None
    quote: str | None
    supported: bool


class AnswerTrace(_StrictModel):
    abstained: bool
    claims: tuple[AnswerClaimTrace, ...]


class RAGEvaluationCase(_StrictModel):
    case_id: str = Field(min_length=1)
    query: str = Field(min_length=1)
    user_id: str = Field(min_length=1)
    sources: dict[str, EvidenceSource]
    relevant_evidence_ids: tuple[str, ...]
    vector_candidates: tuple[str, ...]
    keyword_candidates: tuple[str, ...]
    should_abstain: bool
    answer_trace: AnswerTrace


def load_dataset(path: Path) -> tuple[RAGEvaluationCase, ...]:
    cases: list[RAGEvaluationCase] = []
    seen_ids: set[str] = set()
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
        for line_number, line in enumerate(lines, start=1):
            if not line.strip():
                continue
            try:
                case = RAGEvaluationCase.model_validate_json(line)
            except ValidationError:
                raise ValueError(
                    f"Invalid RAG evaluation data at line {line_number}"
                ) from None
            if case.case_id in seen_ids:
                raise ValueError(f"Duplicate RAG evaluation case id at line {line_number}")
            _validate_case(case, line_number)
            seen_ids.add(case.case_id)
            cases.append(case)
    except OSError as error:
        raise ValueError(f"Cannot read RAG evaluation dataset: {error}") from None
    if not cases:
        raise ValueError("The RAG evaluation dataset must contain at least one case")
    return tuple(cases)


def _validate_case(case: RAGEvaluationCase, line_number: int) -> None:
    for source_id, source in case.sources.items():
        if source_id != source.source_id:
            raise ValueError(f"Source key mismatch in RAG evaluation data at line {line_number}")
    referenced_ids = (
        *case.relevant_evidence_ids,
        *case.vector_candidates,
        *case.keyword_candidates,
    )
    if any(source_id not in case.sources for source_id in referenced_ids):
        raise ValueError(f"Unknown retrieval source in RAG evaluation data at line {line_number}")
    if any(
        case.sources[source_id].user_id != case.user_id
        for source_id in case.relevant_evidence_ids
    ):
        raise ValueError(f"Gold evidence is not user-scoped at line {line_number}")


def vector_rank(case: RAGEvaluationCase, *, limit: int) -> tuple[str, ...]:
    return _owner_scoped_unique(case.vector_candidates, case, limit=limit)


def hybrid_rank(case: RAGEvaluationCase, *, limit: int) -> tuple[str, ...]:
    vector = _owner_scoped_unique(case.vector_candidates, case, limit=None)
    keyword = _owner_scoped_unique(case.keyword_candidates, case, limit=None)
    ranks: dict[str, tuple[int | None, int | None]] = {}
    for rank, source_id in enumerate(vector, start=1):
        ranks[source_id] = (rank, None)
    for rank, source_id in enumerate(keyword, start=1):
        vector_rank_value, _ = ranks.get(source_id, (None, None))
        ranks[source_id] = (vector_rank_value, rank)

    def score(source_id: str) -> float:
        vector_rank_value, keyword_rank_value = ranks[source_id]
        return sum(
            1.0 / (RRF_RANK_CONSTANT + rank)
            for rank in (vector_rank_value, keyword_rank_value)
            if rank is not None
        )

    def sort_key(source_id: str) -> tuple[float, int, str]:
        vector_rank_value, keyword_rank_value = ranks[source_id]
        first_rank = min(
            rank for rank in (vector_rank_value, keyword_rank_value) if rank is not None
        )
        return (-score(source_id), first_rank, source_id)

    return tuple(sorted(ranks, key=sort_key)[:limit])


def _owner_scoped_unique(
    candidates: Sequence[str], case: RAGEvaluationCase, *, limit: int | None
) -> tuple[str, ...]:
    selected: list[str] = []
    seen: set[str] = set()
    for source_id in candidates:
        if source_id in seen or case.sources[source_id].user_id != case.user_id:
            continue
        seen.add(source_id)
        selected.append(source_id)
        if limit is not None and len(selected) == limit:
            break
    return tuple(selected)


def score_retrieval(
    cases: Sequence[RAGEvaluationCase],
    ranker: Callable[[RAGEvaluationCase, int], tuple[str, ...]],
    *,
    k: int,
) -> dict[str, object]:
    if k < 1:
        raise ValueError("k must be positive")
    precisions: list[float] = []
    recalls: list[float] = []
    reciprocal_ranks: list[float] = []
    positive_count = 0
    for case in cases:
        ranked = ranker(case, k)
        relevant = set(case.relevant_evidence_ids)
        hits = [source_id for source_id in ranked if source_id in relevant]
        precisions.append(len(hits) / k)
        if relevant:
            positive_count += 1
            recalls.append(len(hits) / len(relevant))
        first_relevant_rank = next(
            (rank for rank, source_id in enumerate(ranked, start=1) if source_id in relevant),
            None,
        )
        reciprocal_ranks.append(1.0 / first_relevant_rank if first_relevant_rank else 0.0)
    return {
        "precisionAtK": _rounded(statistics.mean(precisions)),
        "recallAtK": _rounded(statistics.mean(recalls)) if recalls else None,
        "mrr": _rounded(statistics.mean(reciprocal_ranks)),
        "queryCount": len(cases),
        "queriesWithRelevantEvidence": positive_count,
        "k": k,
    }


def score_answers(cases: Sequence[RAGEvaluationCase]) -> dict[str, object]:
    all_claims = [claim for case in cases for claim in case.answer_trace.claims]
    citation_attempts = [
        claim for claim in all_claims if claim.evidence_id is not None or claim.quote is not None
    ]
    valid_citations = 0
    supported_claims = 0
    for case in cases:
        for claim in case.answer_trace.claims:
            source = case.sources.get(claim.evidence_id or "")
            quote_is_exact = (
                source is not None and claim.quote is not None and claim.quote in source.text
            )
            source_is_owned = source is not None and source.user_id == case.user_id
            if quote_is_exact and source_is_owned and claim.supported:
                valid_citations += 1
            if claim.supported:
                supported_claims += 1

    abstained_true_positives = sum(
        1
        for case in cases
        if case.answer_trace.abstained and case.should_abstain
    )
    abstained_false_positives = sum(
        1
        for case in cases
        if case.answer_trace.abstained and not case.should_abstain
    )
    abstained_false_negatives = sum(
        1
        for case in cases
        if not case.answer_trace.abstained and case.should_abstain
    )
    abstained_true_negatives = len(cases) - (
        abstained_true_positives + abstained_false_positives + abstained_false_negatives
    )
    precision_denominator = abstained_true_positives + abstained_false_positives
    recall_denominator = abstained_true_positives + abstained_false_negatives
    abstention_precision = (
        abstained_true_positives / precision_denominator if precision_denominator else None
    )
    abstention_recall = (
        abstained_true_positives / recall_denominator if recall_denominator else None
    )
    if abstention_precision is None or abstention_recall is None:
        abstention_f1 = None
    elif abstention_precision + abstention_recall == 0:
        abstention_f1 = 0.0
    else:
        abstention_f1 = 2 * abstention_precision * abstention_recall / (
            abstention_precision + abstention_recall
        )

    return {
        "citationCorrectness": (
            _rounded(valid_citations / len(citation_attempts)) if citation_attempts else None
        ),
        "citationCoverage": _rounded(valid_citations / len(all_claims)) if all_claims else None,
        "citationAttemptCount": len(citation_attempts),
        "claimCount": len(all_claims),
        "answerFaithfulness": (
            _rounded(supported_claims / len(all_claims)) if all_claims else None
        ),
        "abstention": {
            "precision": _rounded(abstention_precision),
            "recall": _rounded(abstention_recall),
            "f1": _rounded(abstention_f1),
            "accuracy": _rounded(
                (abstained_true_positives + abstained_true_negatives) / len(cases)
            ),
            "truePositive": abstained_true_positives,
            "falsePositive": abstained_false_positives,
            "falseNegative": abstained_false_negatives,
            "trueNegative": abstained_true_negatives,
        },
    }


def benchmark_rankers(
    cases: Sequence[RAGEvaluationCase], *, k: int, iterations: int
) -> dict[str, object]:
    if iterations < 1:
        raise ValueError("iterations must be positive")
    rankers: dict[str, Callable[[RAGEvaluationCase], tuple[str, ...]]] = {
        "vectorOnly": lambda case: vector_rank(case, limit=k),
        "hybridRrf": lambda case: hybrid_rank(case, limit=k),
    }
    timings: dict[str, list[float]] = {name: [] for name in rankers}
    for _ in range(iterations):
        for case in cases:
            for name, ranker in rankers.items():
                started = time.perf_counter_ns()
                ranker(case)
                timings[name].append((time.perf_counter_ns() - started) / 1_000_000)
    return {
        name: {
            "mean": round(statistics.mean(values), 6),
            "p50": _percentile(values, 0.50),
            "p95": _percentile(values, 0.95),
            "sampleCount": len(values),
        }
        for name, values in timings.items()
    }


def evaluate(
    cases: Sequence[RAGEvaluationCase], *, k: int = 3, iterations: int = 500
) -> dict[str, object]:
    count_unscoped = sum(
        source.user_id != case.user_id for case in cases for source in case.sources.values()
    )
    cutoffs = tuple(dict.fromkeys((1, k)))
    retrieval: dict[str, dict[str, object]] = {}
    for name, ranker in (
        ("vectorOnly", lambda case, top_k: vector_rank(case, limit=top_k)),
        ("hybridRrf", lambda case, top_k: hybrid_rank(case, limit=top_k)),
    ):
        retrieval[name] = {
            f"@{cutoff}": score_retrieval(cases, ranker, k=cutoff) for cutoff in cutoffs
        }
    return {
        "datasetVersion": "rag-retrieval-v1",
        "evaluatorVersion": EVALUATOR_VERSION,
        "generatedAt": datetime.now(UTC).isoformat(),
        "evaluationMode": "synthetic_rank_and_answer_trace_replay",
        "sampleCount": len(cases),
        "retrieval": retrieval,
        "answers": score_answers(cases),
        "latencyMs": {
            "scope": (
                "local rank-replay operation only; excludes embeddings, PostgreSQL, "
                "network, and LLM"
            ),
            "iterationsPerCase": iterations,
            **benchmark_rankers(cases, k=k, iterations=iterations),
        },
        "cost": {
            "externalCalls": 0,
            "localReplayEstimatedUsd": "0",
            "providerAnswerCostUsd": None,
            "providerAnswerCostMeasured": False,
        },
        "ownerScope": {
            "foreignSourcesInFixture": count_unscoped,
            "foreignSourcesReturned": 0,
        },
    }


def dump_evaluation(value: dict[str, object]) -> str:
    return json.dumps(value, indent=2, sort_keys=True)


def _rounded(value: float | None) -> float | None:
    return round(value, 4) if value is not None else None


def _percentile(values: Sequence[float], percentile: float) -> float:
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, ceil(len(ordered) * percentile) - 1))
    return round(ordered[index], 6)
