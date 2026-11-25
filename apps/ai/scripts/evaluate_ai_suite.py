"""Run the repeatable offline MailPilot evaluation suite."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

from evaluate_email_classifier import (
    DEFAULT_ARTIFACT_DIR,
    DEFAULT_DATASET,
)
from evaluate_email_classifier import (
    evaluate as evaluate_classifier,
)

from mailpilot_ai.classification import train_email_classifier
from mailpilot_ai.evaluation.offline_suite import (
    compare_runs,
    dump_report,
    evaluate_run,
    load_run,
)
from mailpilot_ai.evaluation.rag import evaluate as evaluate_rag
from mailpilot_ai.evaluation.rag import load_dataset as load_rag_dataset

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_RUN = ROOT / "eval" / "offline-agent-suite-v1.json"
DEFAULT_RAG_DATASET = ROOT / "apps" / "ai" / "eval" / "rag-retrieval-v1.jsonl"


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Score captured AI output snapshots and run local retrieval/classifier evaluations."
        )
    )
    parser.add_argument("--run", type=Path, default=DEFAULT_RUN)
    parser.add_argument("--compare-before", type=Path)
    parser.add_argument("--compare-after", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--rag-iterations", type=int, default=100)
    parser.add_argument("--classifier-latency-repeats", type=int, default=25)
    parser.add_argument("--skip-classifier", action="store_true")
    args = parser.parse_args()

    if (args.compare_before is None) != (args.compare_after is None):
        parser.error("--compare-before and --compare-after must be supplied together")
    if args.rag_iterations < 1 or args.classifier_latency_repeats < 1:
        parser.error("latency iteration counts must be positive")

    try:
        report: dict[str, object]
        if args.compare_before is not None and args.compare_after is not None:
            report = compare_runs(load_run(args.compare_before), load_run(args.compare_after))
        else:
            run = load_run(args.run)
            rag_cases = load_rag_dataset(DEFAULT_RAG_DATASET)
            report = {
                "suiteVersion": "mailpilot-ai-evaluation-suite-v1",
                "predictionSnapshot": evaluate_run(run),
                "retrievalReplay": evaluate_rag(
                    rag_cases,
                    k=3,
                    iterations=args.rag_iterations,
                ),
            }
            if not args.skip_classifier:
                if (DEFAULT_ARTIFACT_DIR / "manifest.json").is_file():
                    report["localClassifier"] = evaluate_classifier(
                        DEFAULT_DATASET,
                        DEFAULT_ARTIFACT_DIR,
                        args.classifier_latency_repeats,
                    )
                else:
                    with TemporaryDirectory(prefix="mailpilot-eval-classifier-") as temp_dir:
                        artifact_dir = Path(temp_dir) / "email-tfidf-logreg-v1"
                        train_email_classifier(DEFAULT_DATASET, artifact_dir)
                        report["localClassifier"] = evaluate_classifier(
                            DEFAULT_DATASET,
                            artifact_dir,
                            args.classifier_latency_repeats,
                        )
            report["limitations"] = [
                "Prediction snapshot fixture scores validate evaluator behavior, "
                "not live model quality.",
                "RAG metrics replay synthetic ranks and reviewed answer traces; "
                "no provider or database is called.",
                "Classifier quality uses a frozen synthetic test split; it is not "
                "representative of real mailboxes.",
            ]
        serialized = dump_report(report)
        if args.output is not None:
            args.output.write_text(serialized + "\n", encoding="utf-8")
        print(serialized)
        return 0
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
