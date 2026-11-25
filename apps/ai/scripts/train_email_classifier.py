from __future__ import annotations

import argparse
from pathlib import Path

from mailpilot_ai.classification import train_email_classifier

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_DATASET = ROOT / "eval" / "email-classification-v1.jsonl"
DEFAULT_ARTIFACT_DIR = ROOT / "apps" / "ai" / "artifacts" / "email-tfidf-logreg-v1"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Train the synthetic email classification baseline"
    )
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--artifact-dir", type=Path, default=DEFAULT_ARTIFACT_DIR)
    args = parser.parse_args()

    classifier = train_email_classifier(args.dataset, args.artifact_dir)
    manifest = classifier.manifest
    print(f"Model: {manifest.model_version}")
    print(f"Training rows: {len(manifest.training_record_ids)}")
    print(f"Artifact directory: {args.artifact_dir.resolve()}")
    print(f"Training data SHA-256: {manifest.training_data_sha256}")
    print(f"Artifact SHA-256: {manifest.artifact_sha256}")
    print(f"Class weights: {manifest.logistic_regression.model_dump()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
