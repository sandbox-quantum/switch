class SessionError(ValueError):
    """A refusal with a stable `code` a caller over HTTP can act on."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
