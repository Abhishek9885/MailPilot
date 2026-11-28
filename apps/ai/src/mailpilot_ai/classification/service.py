from functools import lru_cache
from pathlib import Path

from mailpilot_ai.classification.baseline import MODEL_VERSION, EmailClassifier
from mailpilot_ai.config import get_settings

_ARTIFACT_DIRECTORY = Path(__file__).resolve().parents[3] / "artifacts" / MODEL_VERSION


class EmailClassifierUnavailableError(RuntimeError):
    code = "EMAIL_CLASSIFIER_UNAVAILABLE"

    def __init__(self) -> None:
        super().__init__("The email classifier is unavailable")


@lru_cache(maxsize=1)
def get_email_classifier() -> EmailClassifier:
    artifact_directory = get_settings().classifier_artifact_dir or _ARTIFACT_DIRECTORY
    try:
        classifier = EmailClassifier.load(artifact_directory)
    except (OSError, ValueError):
        raise EmailClassifierUnavailableError() from None
    return classifier
