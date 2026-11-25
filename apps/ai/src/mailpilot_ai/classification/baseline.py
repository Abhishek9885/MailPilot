"""Reproducible TF-IDF and logistic regression email classification baseline."""

from __future__ import annotations

import json
import platform
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass
from hashlib import sha256
from importlib.metadata import version
from pathlib import Path
from typing import Literal, Self

import joblib
import numpy
import scipy
import sklearn
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline

from mailpilot_ai.analysis.schemas import EmailCategory, EmailPriority

MODEL_VERSION = "email-tfidf-logreg-v1"
DATASET_VERSION = "email-classification-v1"
RANDOM_SEED = 20261119
ARTIFACT_FILENAME = "classifier.joblib"
MANIFEST_FILENAME = "manifest.json"
_DEFAULT_DATASET_PATH = Path(__file__).resolve().parents[5] / "eval" / f"{DATASET_VERSION}.jsonl"
_DEFAULT_ARTIFACT_PATH = (
    Path(__file__).resolve().parents[3] / "artifacts" / MODEL_VERSION
)
_WHITESPACE = re.compile(r"\s+")


def _to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class _TrainingModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        extra="ignore",
        frozen=True,
        populate_by_name=True,
        str_strip_whitespace=True,
    )


class _TrainingEmail(_TrainingModel):
    subject: str = Field(max_length=2_000)
    body_text: str = Field(max_length=20_000)


class _TrainingLabels(_TrainingModel):
    primary_category: EmailCategory
    priority: EmailPriority


class _TrainingRecord(_TrainingModel):
    id: str = Field(min_length=1, max_length=128)
    split: Literal["train"]
    email: _TrainingEmail
    labels: _TrainingLabels


class _VectorizerManifest(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    lowercase: bool
    strip_accents: str
    ngram_range: tuple[int, int]
    min_df: int
    sublinear_tf: bool
    max_features: int


class _PreprocessingManifest(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    unicode_normalization: Literal["NFKC"]
    whitespace_normalization: Literal["collapse_and_strip"]
    fields: tuple[Literal["subject", "bodyText"], Literal["subject", "bodyText"]]
    field_separator: Literal["newline"]


class _LogisticRegressionManifest(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    c: float
    max_iter: int
    random_state: int
    solver: str
    category_class_weight: str | None
    priority_class_weight: str | None


class _RuntimeManifest(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    python: str
    numpy: str
    scipy: str
    scikit_learn: str
    joblib: str


class _ModelManifest(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
    )

    schema_version: Literal[1]
    model_version: str
    dataset_version: str
    random_seed: int
    training_record_ids: tuple[str, ...]
    training_data_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    primary_category_counts: dict[str, int]
    priority_counts: dict[str, int]
    preprocessing: _PreprocessingManifest
    vectorizer: _VectorizerManifest
    logistic_regression: _LogisticRegressionManifest
    runtime: _RuntimeManifest
    artifact_filename: str
    artifact_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


@dataclass(frozen=True)
class EmailClassificationPrediction:
    primary_category: EmailCategory
    priority: EmailPriority


@dataclass(frozen=True)
class EmailClassificationProbabilities:
    primary_category: dict[EmailCategory, float]
    priority: dict[EmailPriority, float]


@dataclass(frozen=True)
class _ClassifierBundle:
    primary_category: Pipeline
    priority: Pipeline


def _normalize_field(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value)
    return _WHITESPACE.sub(" ", normalized).strip()


def _prepare_text(subject: str, body_text: str) -> str:
    clean_subject = _normalize_field(subject)
    clean_body = _normalize_field(body_text)
    if not clean_subject and not clean_body:
        raise ValueError("email subject and body must not both be empty")
    return f"{clean_subject}\n{clean_body}"


def _class_weight(counts: Counter[str]) -> Literal["balanced"] | None:
    """Balance only a target whose observed train classes have unequal counts."""
    if not counts or len(set(counts.values())) == 1:
        return None
    return "balanced"


def _build_pipeline(class_weight: Literal["balanced"] | None) -> Pipeline:
    return Pipeline(
        steps=[
            (
                "tfidf",
                TfidfVectorizer(
                    lowercase=True,
                    strip_accents="unicode",
                    ngram_range=(1, 2),
                    min_df=1,
                    sublinear_tf=True,
                    max_features=20_000,
                ),
            ),
            (
                "classifier",
                LogisticRegression(
                    C=1.0,
                    max_iter=2_000,
                    random_state=RANDOM_SEED,
                    solver="lbfgs",
                    class_weight=class_weight,
                ),
            ),
        ]
    )


def _load_training_data(
    dataset_path: Path,
) -> tuple[list[_TrainingRecord], str]:
    if not dataset_path.is_file():
        raise ValueError(f"classification dataset not found: {dataset_path}")

    training_records: list[_TrainingRecord] = []
    training_lines: list[str] = []
    for line_number, line in enumerate(dataset_path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            payload: object = json.loads(line)
        except json.JSONDecodeError:
            raise ValueError(f"invalid JSON on dataset line {line_number}") from None
        if not isinstance(payload, dict):
            raise ValueError(f"invalid dataset record on line {line_number}")
        split = payload.get("split")
        if split not in {"train", "validation", "test"}:
            raise ValueError(f"invalid dataset split on line {line_number}")
        if split != "train":
            continue
        try:
            record = _TrainingRecord.model_validate(payload)
        except ValidationError as error:
            fields = sorted(
                {
                    ".".join(str(part) for part in item["loc"])
                    for item in error.errors(include_input=False)
                }
            )
            raise ValueError(
                f"invalid training record on line {line_number}; fields: {', '.join(fields)}"
            ) from None
        training_records.append(record)
        training_lines.append(line.rstrip("\r\n"))

    if not training_records:
        raise ValueError("classification dataset has no training records")
    if len({record.id for record in training_records}) != len(training_records):
        raise ValueError("training record IDs must be unique")
    data_hash = sha256("\n".join(training_lines).encode("utf-8")).hexdigest()
    return training_records, data_hash


def _manifest_path(artifact_dir: Path) -> Path:
    return artifact_dir / MANIFEST_FILENAME


def _runtime_manifest() -> _RuntimeManifest:
    return _RuntimeManifest(
        python=platform.python_version(),
        numpy=numpy.__version__,
        scipy=scipy.__version__,
        scikit_learn=sklearn.__version__,
        joblib=version("joblib"),
    )


class EmailClassifier:
    """Inference wrapper for a versioned local classification artifact."""

    def __init__(self, bundle: _ClassifierBundle, manifest: _ModelManifest) -> None:
        self._bundle = bundle
        self.manifest = manifest

    def predict(self, subject: str, body_text: str) -> EmailClassificationPrediction | None:
        """Predict primary category and priority, abstaining on wholly unseen text."""
        text = _prepare_text(subject, body_text)
        category_vectorizer = self._bundle.primary_category.named_steps.get("tfidf")
        priority_vectorizer = self._bundle.priority.named_steps.get("tfidf")
        if not isinstance(category_vectorizer, TfidfVectorizer) or not isinstance(
            priority_vectorizer, TfidfVectorizer
        ):
            raise ValueError("classifier artifact is missing its TF-IDF vectorizer")
        if category_vectorizer.transform([text]).nnz == 0:
            return None
        category = self._bundle.primary_category.predict([text])[0]
        priority = self._bundle.priority.predict([text])[0]
        return EmailClassificationPrediction(
            primary_category=EmailCategory(str(category)),
            priority=EmailPriority(str(priority)),
        )

    def predict_proba(
        self,
        subject: str,
        body_text: str,
    ) -> EmailClassificationProbabilities | None:
        """Return class probabilities for evaluation and calibrated downstream use."""
        text = _prepare_text(subject, body_text)
        category_vectorizer = self._bundle.primary_category.named_steps.get("tfidf")
        if not isinstance(category_vectorizer, TfidfVectorizer):
            raise ValueError("classifier artifact is missing its TF-IDF vectorizer")
        if category_vectorizer.transform([text]).nnz == 0:
            return None

        category_probabilities = self._bundle.primary_category.predict_proba([text])[0]
        category_classes = self._bundle.primary_category.classes_
        priority_probabilities = self._bundle.priority.predict_proba([text])[0]
        priority_classes = self._bundle.priority.classes_
        return EmailClassificationProbabilities(
            primary_category={
                EmailCategory(str(label)): float(probability)
                for label, probability in zip(category_classes, category_probabilities, strict=True)
            },
            priority={
                EmailPriority(str(label)): float(probability)
                for label, probability in zip(priority_classes, priority_probabilities, strict=True)
            },
        )

    @classmethod
    def load(cls, artifact_dir: Path) -> Self:
        """Load and verify an artifact produced by the trusted local trainer."""
        manifest_file = _manifest_path(artifact_dir)
        try:
            manifest = _ModelManifest.model_validate_json(manifest_file.read_text(encoding="utf-8"))
        except (OSError, ValidationError, ValueError) as error:
            raise ValueError("classifier manifest is missing or invalid") from error

        if manifest.model_version != MODEL_VERSION or manifest.dataset_version != DATASET_VERSION:
            raise ValueError("classifier artifact version is incompatible")
        if manifest.runtime != _runtime_manifest():
            raise ValueError("classifier runtime versions do not match the saved artifact")
        if Path(manifest.artifact_filename).name != manifest.artifact_filename:
            raise ValueError("classifier artifact filename is invalid")
        artifact_file = artifact_dir / manifest.artifact_filename
        try:
            artifact_hash = sha256(artifact_file.read_bytes()).hexdigest()
        except OSError as error:
            raise ValueError("classifier artifact file is missing") from error
        if artifact_hash != manifest.artifact_sha256:
            raise ValueError("classifier artifact checksum does not match its manifest")

        # joblib uses pickle internally; only load artifacts from the trusted local trainer.
        try:
            bundle = joblib.load(artifact_file)
        except Exception as error:
            raise ValueError("classifier artifact could not be loaded") from error
        if not isinstance(bundle, _ClassifierBundle):
            raise ValueError("classifier artifact has an unsupported structure")
        return cls(bundle=bundle, manifest=manifest)


def train_email_classifier(
    dataset_path: Path = _DEFAULT_DATASET_PATH,
    artifact_dir: Path = _DEFAULT_ARTIFACT_PATH,
) -> EmailClassifier:
    """Fit on the train split only and save a checksummed model and manifest."""
    records, training_data_sha256 = _load_training_data(dataset_path)
    category_counts: Counter[str] = Counter(
        record.labels.primary_category.value for record in records
    )
    priority_counts: Counter[str] = Counter(record.labels.priority.value for record in records)
    expected_categories = {label.value for label in EmailCategory}
    expected_priorities = {label.value for label in EmailPriority}
    if set(category_counts) != expected_categories:
        raise ValueError("training split must contain every primary category")
    if set(priority_counts) != expected_priorities:
        raise ValueError("training split must contain every priority class")

    category_weight = _class_weight(category_counts)
    priority_weight = _class_weight(priority_counts)
    category_pipeline = _build_pipeline(category_weight)
    priority_pipeline = _build_pipeline(priority_weight)
    texts = [_prepare_text(record.email.subject, record.email.body_text) for record in records]
    categories = [record.labels.primary_category.value for record in records]
    priorities = [record.labels.priority.value for record in records]
    category_pipeline.fit(texts, categories)
    priority_pipeline.fit(texts, priorities)

    artifact_dir.mkdir(parents=True, exist_ok=True)
    artifact_file = artifact_dir / ARTIFACT_FILENAME
    bundle = _ClassifierBundle(primary_category=category_pipeline, priority=priority_pipeline)
    joblib.dump(bundle, artifact_file, compress=3, protocol=5)
    artifact_sha256 = sha256(artifact_file.read_bytes()).hexdigest()

    manifest = _ModelManifest(
        schema_version=1,
        model_version=MODEL_VERSION,
        dataset_version=DATASET_VERSION,
        random_seed=RANDOM_SEED,
        training_record_ids=tuple(record.id for record in records),
        training_data_sha256=training_data_sha256,
        primary_category_counts=dict(sorted(category_counts.items())),
        priority_counts=dict(sorted(priority_counts.items())),
        preprocessing=_PreprocessingManifest(
            unicode_normalization="NFKC",
            whitespace_normalization="collapse_and_strip",
            fields=("subject", "bodyText"),
            field_separator="newline",
        ),
        vectorizer=_VectorizerManifest(
            lowercase=True,
            strip_accents="unicode",
            ngram_range=(1, 2),
            min_df=1,
            sublinear_tf=True,
            max_features=20_000,
        ),
        logistic_regression=_LogisticRegressionManifest(
            c=1.0,
            max_iter=2_000,
            random_state=RANDOM_SEED,
            solver="lbfgs",
            category_class_weight=category_weight,
            priority_class_weight=priority_weight,
        ),
        runtime=_runtime_manifest(),
        artifact_filename=ARTIFACT_FILENAME,
        artifact_sha256=artifact_sha256,
    )
    _manifest_path(artifact_dir).write_text(
        manifest.model_dump_json(by_alias=True, indent=2) + "\n",
        encoding="utf-8",
    )
    return EmailClassifier(bundle=bundle, manifest=manifest)
