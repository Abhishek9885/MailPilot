class VectorStoreError(RuntimeError):
    """Safe error raised for vector persistence, query, or migration failures."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
