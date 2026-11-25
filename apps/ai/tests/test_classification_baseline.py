from __future__ import annotations

import json
from pathlib import Path

import pytest

from mailpilot_ai.classification import EmailClassifier, train_email_classifier

ROOT = Path(__file__).resolve().parents[3]
DATASET = ROOT / "eval" / "email-classification-v1.jsonl"
ARTIFACT_DIR = ROOT / "apps" / "ai" / "artifacts" / "email-tfidf-logreg-v1"


@pytest.fixture(scope="module")
def trained_classifier() -> EmailClassifier:
    return train_email_classifier(DATASET, ARTIFACT_DIR)


def test_serialization_round_trip_preserves_predictions(
    trained_classifier: EmailClassifier,
) -> None:
    before = trained_classifier.predict(
        "Invoice 4821 is due Friday", "Please review the attached project invoice."
    )
    loaded = EmailClassifier.load(ARTIFACT_DIR)

    assert (
        loaded.predict("Invoice 4821 is due Friday", "Please review the attached project invoice.")
        == before
    )
    assert loaded.predict_proba(
        "Invoice 4821 is due Friday", "Please review the attached project invoice."
    ) == trained_classifier.predict_proba(
        "Invoice 4821 is due Friday", "Please review the attached project invoice."
    )
    assert loaded.manifest.artifact_sha256 == trained_classifier.manifest.artifact_sha256
    assert (
        loaded.manifest.training_data_sha256
        == trained_classifier.manifest.training_data_sha256
    )


def test_unseen_vocabulary_abstains(
    trained_classifier: EmailClassifier,
) -> None:
    assert trained_classifier.predict("qzxvplmok", "blargle zorbify quuxnix") is None


@pytest.mark.parametrize(
    ("subject", "body_text"),
    [("", ""), ("  \n ", "\t")],
)
def test_empty_input_is_rejected(
    trained_classifier: EmailClassifier,
    subject: str,
    body_text: str,
) -> None:
    with pytest.raises(ValueError, match="must not both be empty"):
        trained_classifier.predict(subject, body_text)


def test_repeated_inference_is_consistent(
    trained_classifier: EmailClassifier,
) -> None:
    email = ("Team project schedule", "Please review the release plan before Thursday.")
    assert trained_classifier.predict(*email) == trained_classifier.predict(*email)


def test_probability_outputs_are_normalized(
    trained_classifier: EmailClassifier,
) -> None:
    probabilities = trained_classifier.predict_proba(
        "Team project schedule", "Please review the release plan before Thursday."
    )

    assert probabilities is not None
    assert sum(probabilities.primary_category.values()) == pytest.approx(1.0)
    assert sum(probabilities.priority.values()) == pytest.approx(1.0)


def test_retraining_produces_the_same_artifact_hash(
    trained_classifier: EmailClassifier,
) -> None:
    retrained = train_email_classifier(DATASET, ARTIFACT_DIR)
    assert retrained.manifest.artifact_sha256 == trained_classifier.manifest.artifact_sha256


def test_training_manifest_records_only_training_split(
    trained_classifier: EmailClassifier,
) -> None:
    expected_train_ids: set[str] = set()
    non_train_ids: set[str] = set()
    for line in DATASET.read_text(encoding="utf-8").splitlines():
        record = json.loads(line)
        target = expected_train_ids if record["split"] == "train" else non_train_ids
        target.add(record["id"])

    recorded_ids = set(trained_classifier.manifest.training_record_ids)
    assert recorded_ids == expected_train_ids
    assert recorded_ids.isdisjoint(non_train_ids)


def test_class_weights_follow_train_imbalance(
    trained_classifier: EmailClassifier,
) -> None:
    parameters = trained_classifier.manifest.logistic_regression
    assert parameters.category_class_weight is None
    assert parameters.priority_class_weight == "balanced"
