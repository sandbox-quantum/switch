"""The session's test database is removed without failing a run over it."""

from __future__ import annotations

import pytest
import requests
from docker.errors import APIError

from tests.conftest import _remove


class _SlowToRemove:
    def __init__(self, error: Exception) -> None:
        self.error = error

    def stop(self) -> None:
        raise self.error


@pytest.mark.parametrize(
    "error",
    [
        requests.exceptions.ReadTimeout("Read timed out. (read timeout=60)"),
        APIError("removal of container is already in progress"),
    ],
)
def test_a_removal_docker_does_not_finish_is_a_warning(error: Exception) -> None:
    with pytest.warns(UserWarning, match="reaper removes it"):
        _remove(_SlowToRemove(error))  # type: ignore[arg-type]


def test_any_other_error_still_fails_the_run() -> None:
    with pytest.raises(RuntimeError):
        _remove(_SlowToRemove(RuntimeError("not docker")))  # type: ignore[arg-type]
