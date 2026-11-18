from pathlib import Path

from mailpilot_ai.evaluation.rag import (
    AnswerTrace,
    evaluate,
    hybrid_rank,
    load_dataset,
    score_answers,
    score_retrieval,
    vector_rank,
)

DATASET = Path(__file__).resolve().parents[1] / "eval" / "rag-retrieval-v1.jsonl"


def test_labeled_dataset_covers_exact_semantic_and_no_answer_cases() -> None:
    cases = load_dataset(DATASET)

    assert len(cases) == 7
    assert {case.case_id for case in cases} >= {
        "exact-person-renewal",
        "exact-date-qbr",
        "invoice-reference",
        "semantic-demo-reschedule",
        "no-alarm-pin-evidence",
    }


def test_vector_and_hybrid_metrics_compare_cutoffs() -> None:
    cases = load_dataset(DATASET)
    output = evaluate(cases, k=3, iterations=2)
    vector_top_one = output["retrieval"]["vectorOnly"]["@1"]
    hybrid_top_one = output["retrieval"]["hybridRrf"]["@1"]

    assert vector_top_one["recallAtK"] == 0.3333
    assert hybrid_top_one["recallAtK"] == 1.0
    assert output["retrieval"]["vectorOnly"]["@3"]["recallAtK"] == 1.0
    assert output["retrieval"]["hybridRrf"]["@3"]["recallAtK"] == 1.0
    assert (
        output["retrieval"]["hybridRrf"]["@3"]["mrr"]
        > output["retrieval"]["vectorOnly"]["@3"]["mrr"]
    )


def test_answer_trace_scores_citations_faithfulness_and_abstention() -> None:
    cases = load_dataset(DATASET)

    scores = score_answers(cases)

    assert scores["citationCorrectness"] == 1.0
    assert scores["citationCoverage"] == 1.0
    assert scores["answerFaithfulness"] == 1.0
    assert scores["abstention"]["precision"] == 1.0
    assert scores["abstention"]["recall"] == 1.0


def test_foreign_source_is_filtered_and_duplicates_are_normalized() -> None:
    cases = load_dataset(DATASET)
    case = next(item for item in cases if item.case_id == "no-alarm-pin-evidence")
    duplicate_case = case.model_copy(
        update={"vector_candidates": ("travel-plan", "travel-plan", "office-move")}
    )

    assert vector_rank(case, limit=3) == ("travel-plan", "office-move")
    assert hybrid_rank(case, limit=3) == ("travel-plan", "office-move")
    assert vector_rank(duplicate_case, limit=3) == ("travel-plan", "office-move")


def test_citation_quote_must_match_source_text() -> None:
    case = load_dataset(DATASET)[0]
    claim = case.answer_trace.claims[0].model_copy(update={"quote": "a fabricated quote"})
    altered = case.model_copy(
        update={"answer_trace": AnswerTrace(abstained=False, claims=(claim,))}
    )

    scores = score_answers((altered,))

    assert scores["citationCorrectness"] == 0.0
    assert scores["citationCoverage"] == 0.0
    assert scores["answerFaithfulness"] == 1.0


def test_retrieval_score_handles_queries_without_relevant_evidence() -> None:
    cases = load_dataset(DATASET)
    no_answer = (next(case for case in cases if case.should_abstain),)

    scores = score_retrieval(no_answer, lambda case, k: vector_rank(case, limit=k), k=3)

    assert scores["precisionAtK"] == 0.0
    assert scores["recallAtK"] is None
    assert scores["mrr"] == 0.0
