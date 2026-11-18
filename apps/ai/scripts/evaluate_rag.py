"""Run the deterministic, synthetic RAG retrieval evaluation."""

import argparse
import sys
from pathlib import Path

from mailpilot_ai.evaluation.rag import dump_evaluation, evaluate, load_dataset

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Evaluate vector-only and hybrid RAG ranking against labeled synthetic cases."
    )
    parser.add_argument("--dataset", type=Path, default=ROOT / "eval" / "rag-retrieval-v1.jsonl")
    parser.add_argument("--k", type=int, default=3, help="fixed retrieval cutoff for P@k and R@k")
    parser.add_argument(
        "--iterations", type=int, default=500, help="local replay timing iterations per case"
    )
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()
    try:
        cases = load_dataset(args.dataset)
        if args.validate_only:
            print(
                dump_evaluation(
                    {
                        "datasetVersion": "rag-retrieval-v1",
                        "evaluatorVersion": "rag-evaluator-v1",
                        "caseCount": len(cases),
                        "modelRun": False,
                    }
                )
            )
            return 0
        print(dump_evaluation(evaluate(cases, k=args.k, iterations=args.iterations)))
        return 0
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
