from __future__ import annotations

import argparse
import io
import json
import platform
import sys
from contextlib import redirect_stdout
from hashlib import sha256
from pathlib import Path
from time import perf_counter_ns

import numpy as np
from sklearn.dummy import DummyClassifier
from sklearn.metrics import confusion_matrix, precision_recall_fscore_support
from validate_email_classification_dataset import (
    DatasetRecord,
    load_records,
    validate_records,
)

from mailpilot_ai.analysis.schemas import EmailCategory, EmailPriority
from mailpilot_ai.classification import EmailClassifier

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_DATASET = ROOT / "eval" / "email-classification-v1.jsonl"
DEFAULT_ARTIFACT_DIR = ROOT / "apps" / "ai" / "artifacts" / "email-tfidf-logreg-v1"
ABSTAIN_LABEL = "__abstain__"


def _training_data_sha256(dataset_path: Path) -> str:
    training_lines: list[str] = []
    for line_number, line in enumerate(dataset_path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            raise ValueError(f"invalid JSON on dataset line {line_number}") from None
        if isinstance(record, dict) and record.get("split") == "train":
            training_lines.append(line.rstrip("\r\n"))
    return sha256("\n".join(training_lines).encode("utf-8")).hexdigest()


def _target_metrics(
    expected: list[str],
    predicted: list[str],
    labels: list[str],
    baseline: list[str],
    record_ids: list[str],
) -> dict[str, object]:
    def summarize(output: list[str]) -> dict[str, object]:
        metric_labels = [*labels, ABSTAIN_LABEL]
        class_precision, class_recall, class_f1, class_support = (
            precision_recall_fscore_support(
                expected,
                output,
                labels=metric_labels,
                zero_division=0,
            )
        )
        return {
            "accuracy": float(np.mean(np.asarray(expected) == np.asarray(output))),
            "macroPrecision": float(np.mean(class_precision[: len(labels)])),
            "macroRecall": float(np.mean(class_recall[: len(labels)])),
            "macroF1": float(np.mean(class_f1[: len(labels)])),
            "perClass": {
                label: {
                    "precision": float(class_precision[index]),
                    "recall": float(class_recall[index]),
                    "f1": float(class_f1[index]),
                    "support": int(class_support[index]),
                }
                for index, label in enumerate(labels)
            },
            "confusionMatrix": {
                "labels": metric_labels,
                "counts": confusion_matrix(
                    expected,
                    output,
                    labels=metric_labels,
                ).tolist(),
            },
        }

    model_summary = summarize(predicted)
    baseline_summary = summarize(baseline)
    errors = [
        {
            "recordId": record_id,
            "actual": actual,
            "modelPrediction": model_output,
            "majorityPrediction": baseline_output,
        }
        for record_id, actual, model_output, baseline_output in zip(
            record_ids,
            expected,
            predicted,
            baseline,
            strict=True,
        )
        if actual != model_output
    ]
    return {
        "model": model_summary,
        "majorityBaseline": baseline_summary,
        "modelMisclassifications": errors,
    }


def _calibration_metrics(
    expected: list[str],
    probabilities: list[dict[str, float] | None],
    labels: list[str],
    bins: int = 5,
) -> dict[str, int | float | None]:
    paired = [
        (label, row)
        for label, row in zip(expected, probabilities, strict=True)
        if row is not None
    ]
    if not paired:
        return {
            "sampleCount": 0,
            "multiclassBrierScore": None,
            "topLabelExpectedCalibrationError5Bins": None,
            "bins": bins,
        }
    calibrated_expected = [label for label, _ in paired]
    scores = np.asarray(
        [[row[label] for label in labels] for _, row in paired],
        dtype=np.float64,
    )
    truth = np.asarray([labels.index(label) for label in calibrated_expected], dtype=np.int64)
    one_hot = np.eye(len(labels), dtype=np.float64)[truth]
    brier_score = float(np.mean(np.sum(np.square(scores - one_hot), axis=1)))

    top_classes = np.argmax(scores, axis=1)
    confidence = np.max(scores, axis=1)
    correct = (top_classes == truth).astype(np.float64)
    expected_calibration_error = 0.0
    bin_edges = np.linspace(0.0, 1.0, bins + 1)
    for index in range(bins):
        if index == bins - 1:
            mask = (confidence >= bin_edges[index]) & (confidence <= bin_edges[index + 1])
        else:
            mask = (confidence >= bin_edges[index]) & (confidence < bin_edges[index + 1])
        if np.any(mask):
            expected_calibration_error += float(np.mean(mask)) * abs(
                float(np.mean(correct[mask])) - float(np.mean(confidence[mask]))
            )
    return {
        "sampleCount": len(calibrated_expected),
        "multiclassBrierScore": brier_score,
        "topLabelExpectedCalibrationError5Bins": expected_calibration_error,
        "bins": bins,
    }


def _latency_metrics(
    classifier: EmailClassifier,
    records: list[DatasetRecord],
    repeats_per_record: int,
) -> dict[str, int | float]:
    for record in records:
        classifier.predict(record.email.subject, record.email.body_text)

    durations_ms: list[float] = []
    for record in records:
        for _ in range(repeats_per_record):
            started = perf_counter_ns()
            classifier.predict(record.email.subject, record.email.body_text)
            durations_ms.append((perf_counter_ns() - started) / 1_000_000)
    return {
        "warmupCalls": len(records),
        "measuredCalls": len(durations_ms),
        "p50Milliseconds": float(np.percentile(durations_ms, 50)),
        "p95Milliseconds": float(np.percentile(durations_ms, 95)),
    }


def evaluate(
    dataset_path: Path,
    artifact_dir: Path,
    latency_repeats: int,
) -> dict[str, object]:
    if latency_repeats < 1:
        raise ValueError("latency repeats must be at least 1")
    records = load_records(dataset_path)
    with redirect_stdout(io.StringIO()):
        validate_records(records)

    training_records = [record for record in records if record.split == "train"]
    validation_records = [record for record in records if record.split == "validation"]
    test_records = [record for record in records if record.split == "test"]
    if not test_records:
        raise ValueError("dataset test split is empty")

    classifier = EmailClassifier.load(artifact_dir)
    expected_training_ids = {record.id for record in training_records}
    if set(classifier.manifest.training_record_ids) != expected_training_ids:
        raise ValueError("classifier training record IDs do not match the dataset train split")
    if classifier.manifest.training_data_sha256 != _training_data_sha256(dataset_path):
        raise ValueError("classifier training data checksum does not match this dataset")

    category_labels = [label.value for label in EmailCategory]
    priority_labels = [label.value for label in EmailPriority]
    training_matrix = np.zeros((len(training_records), 1), dtype=np.float64)
    test_matrix = np.zeros((len(test_records), 1), dtype=np.float64)
    category_baseline = DummyClassifier(strategy="most_frequent").fit(
        training_matrix,
        [record.labels.primary_category for record in training_records],
    )
    priority_baseline = DummyClassifier(strategy="most_frequent").fit(
        training_matrix,
        [record.labels.priority for record in training_records],
    )
    category_majority = [str(value) for value in category_baseline.predict(test_matrix)]
    priority_majority = [str(value) for value in priority_baseline.predict(test_matrix)]

    category_predictions: list[str] = []
    priority_predictions: list[str] = []
    category_probabilities: list[dict[str, float] | None] = []
    priority_probabilities: list[dict[str, float] | None] = []
    for record in test_records:
        prediction = classifier.predict(record.email.subject, record.email.body_text)
        probabilities = classifier.predict_proba(record.email.subject, record.email.body_text)
        category_predictions.append(
            prediction.primary_category.value if prediction is not None else ABSTAIN_LABEL
        )
        priority_predictions.append(
            prediction.priority.value if prediction is not None else ABSTAIN_LABEL
        )
        if probabilities is not None:
            category_probabilities.append(
                {label.value: probabilities.primary_category[label] for label in EmailCategory}
            )
            priority_probabilities.append(
                {label.value: probabilities.priority[label] for label in EmailPriority}
            )
        else:
            category_probabilities.append(None)
            priority_probabilities.append(None)

    test_record_ids = [record.id for record in test_records]
    category_metrics = _target_metrics(
        [record.labels.primary_category for record in test_records],
        category_predictions,
        category_labels,
        category_majority,
        test_record_ids,
    )
    priority_metrics = _target_metrics(
        [record.labels.priority for record in test_records],
        priority_predictions,
        priority_labels,
        priority_majority,
        test_record_ids,
    )
    category_metrics["calibration"] = _calibration_metrics(
        [record.labels.primary_category for record in test_records],
        category_probabilities,
        category_labels,
    )
    priority_metrics["calibration"] = _calibration_metrics(
        [record.labels.priority for record in test_records],
        priority_probabilities,
        priority_labels,
    )

    return {
        "modelVersion": classifier.manifest.model_version,
        "datasetVersion": classifier.manifest.dataset_version,
        "evaluatedSplit": "test",
        "trainingRecords": len(training_records),
        "validationRecords": len(validation_records),
        "testRecords": len(test_records),
        "testRecordIds": [record.id for record in test_records],
        "modelWasFitOnTestSplit": False,
        "majorityBaseline": "DummyClassifier(strategy='most_frequent'), fitted on train only",
        "latency": _latency_metrics(classifier, test_records, latency_repeats),
        "targets": {
            "primaryCategory": category_metrics,
            "priority": priority_metrics,
        },
        "runtime": {
            "python": platform.python_version(),
            "numpy": np.__version__,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate the synthetic email classifier")
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--artifact-dir", type=Path, default=DEFAULT_ARTIFACT_DIR)
    parser.add_argument("--latency-repeats", type=int, default=100)
    args = parser.parse_args()

    try:
        report = evaluate(args.dataset, args.artifact_dir, args.latency_repeats)
    except ValueError as error:
        print(f"Email classifier evaluation failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
