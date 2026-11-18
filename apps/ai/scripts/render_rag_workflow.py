"""Print the read-only RAG StateGraph topology as Mermaid."""

from mailpilot_ai.rag.workflow import build_read_only_rag_graph


def main() -> None:
    print(build_read_only_rag_graph().get_graph().draw_mermaid())


if __name__ == "__main__":
    main()
