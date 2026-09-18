from __future__ import annotations

import fcntl
from pathlib import Path
from types import TracebackType
from typing import TextIO


class ControllerAlreadyRunning(RuntimeError):
    pass


class ControllerLock:
    def __init__(self, path: Path):
        self._path = path
        self._file: TextIO | None = None

    def __enter__(self) -> ControllerLock:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._file = self._path.open("a+")
        try:
            fcntl.flock(self._file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            self._file.close()
            self._file = None
            raise ControllerAlreadyRunning(f"another reconciler holds {self._path}") from exc
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        if self._file is not None:
            fcntl.flock(self._file.fileno(), fcntl.LOCK_UN)
            self._file.close()
            self._file = None
