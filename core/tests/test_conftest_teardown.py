"""The session's test database is removed without failing a run over it."""

from __future__ import annotations

import pytest
import requests
from docker.errors import APIError
from testcontainers.core.config import testcontainers_config

from tests.conftest import _remove


class _SlowToRemove:
    def __init__(self, error: Exception) -> None:
        self.error = error
        self.stopped = False

    def stop(self) -> None:
        self.stopped = True
        raise self.error

    def get_wrapped_container(self) -> _Wrapped:
        return _Wrapped()


class _Wrapped:
    short_id = "0123456789ab"


@pytest.fixture
def no_reaper(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(testcontainers_config, "ryuk_disabled", True)


@pytest.mark.parametrize(
    "error",
    [
        requests.exceptions.ReadTimeout("Read timed out. (read timeout=60)"),
        APIError("removal of container is already in progress"),
    ],
)
@pytest.mark.usefixtures("no_reaper")
def test_a_removal_docker_does_not_finish_is_a_warning(error: Exception) -> None:
    with pytest.warns(UserWarning, match="0123456789ab was not removed"):
        _remove(_SlowToRemove(error))  # type: ignore[arg-type]


@pytest.mark.usefixtures("no_reaper")
def test_any_other_error_still_fails_the_run() -> None:
    with pytest.raises(RuntimeError):
        _remove(_SlowToRemove(RuntimeError("not docker")))  # type: ignore[arg-type]


def test_with_the_reaper_running_the_container_is_left_to_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every worker removing its own container at once kept each waiting on
    Docker for up to a minute after its last test."""
    monkeypatch.setattr(testcontainers_config, "ryuk_disabled", False)
    container = _SlowToRemove(RuntimeError("not to be called"))

    _remove(container)  # type: ignore[arg-type]

    assert not container.stopped
