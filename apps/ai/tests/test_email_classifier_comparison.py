from compare_email_classifier import LLM_ERROR_LABEL, _metrics, _stability


def test_comparison_metrics_mark_unavailable_when_no_llm_response_exists() -> None:
    report = _metrics(["work"], [LLM_ERROR_LABEL], ["work", "finance"])

    assert report["validPredictions"] == 0
    assert report["failedPredictions"] == 1
    assert report["coverage"] == 0.0
    assert report["accuracy"] is None
    assert report["macroF1"] is None
    assert report["perClass"] == {}


def test_comparison_metrics_and_stability_cover_valid_repeated_outputs() -> None:
    metrics = _metrics(["work", "finance"], ["work", "work"], ["work", "finance"])
    runs = [
        [
            {"primaryCategory": "work", "priority": "high"},
            {"primaryCategory": "finance", "priority": "normal"},
        ],
        [
            {"primaryCategory": "work", "priority": "high"},
            {"primaryCategory": "finance", "priority": "low"},
        ],
    ]
    stability = _stability(runs, ["one", "two"])

    assert metrics["validPredictions"] == 2
    assert metrics["accuracy"] == 0.5
    assert stability["primaryCategory"]["exactStabilityRate"] == 1.0
    assert stability["priority"]["exactStabilityRate"] == 0.5
    assert stability["joint"]["exactStabilityRate"] == 0.5


def test_comparison_stability_is_unavailable_without_valid_predictions() -> None:
    failed_run = [
        {"primaryCategory": LLM_ERROR_LABEL, "priority": LLM_ERROR_LABEL},
    ]

    stability = _stability([failed_run, failed_run], ["one"])

    assert stability["joint"]["eligibleRecords"] == 0
    assert stability["joint"]["exactStabilityRate"] is None
