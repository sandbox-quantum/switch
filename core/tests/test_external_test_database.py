"""The throwaway-database switch for runners without Docker refuses anything
that could be a real database, before any connection is made, and lets only
one test run use it at a time."""

import random
from types import SimpleNamespace

import pytest

from tests.conftest import (
    THROWAWAY_DATABASE,
    busy_database,
    external_test_database,
    pytest_configure,
    sole_run_on,
)

GOOD = f"postgresql+asyncpg://u:p@127.0.0.1:5432/{THROWAWAY_DATABASE}"
FLAG = {"SWITCH_TEST_POSTGRES_THROWAWAY": "1"}


def test_accepts_the_local_throwaway_database_with_the_flag():
    external_test_database(GOOD, FLAG)
    external_test_database(GOOD.replace("127.0.0.1", "localhost"), FLAG)


@pytest.mark.parametrize(
    ("url", "environ"),
    [
        (GOOD, {}),
        (GOOD, {"SWITCH_TEST_POSTGRES_THROWAWAY": "yes"}),
        ("postgresql+asyncpg://u:p@127.0.0.1:55432/switch", FLAG),
        (f"postgresql+asyncpg://u:p@192.0.2.10:5432/{THROWAWAY_DATABASE}", FLAG),
        (f"postgresql+asyncpg://u:p@db.example.com/{THROWAWAY_DATABASE}", FLAG),
        (f"sqlite+aiosqlite:///{THROWAWAY_DATABASE}", FLAG),
    ],
)
def test_refuses_anything_else(url, environ):
    with pytest.raises(RuntimeError, match="SWITCH_TEST_POSTGRES_THROWAWAY"):
        external_test_database(url, environ)


def test_a_refusal_names_the_database_but_never_the_password():
    url = f"postgresql+asyncpg://tester:hunter2-secret@127.0.0.1:5433/{THROWAWAY_DATABASE}"
    assert busy_database(url) == f"{THROWAWAY_DATABASE} on 127.0.0.1:5433"
    assert "hunter2" not in busy_database(url)


def test_xdist_workers_are_refused_on_the_shared_database():
    with pytest.raises(RuntimeError, match="run without -n") as refused:
        with sole_run_on(GOOD, {"PYTEST_XDIST_WORKER": "gw0"}):
            pass
    assert "u:p" not in str(refused.value)


@pytest.fixture
def lock_key() -> int:
    """A key of the test's own, so the run's real lock (on INT) isn't in the way."""
    return random.randint(1, 2**62)


def test_a_second_run_is_refused_at_once_while_the_first_holds_the_database(
    postgres_schema, lock_key
):
    with sole_run_on(postgres_schema, {}, key=lock_key):
        with pytest.raises(RuntimeError, match="Another test run is using") as refused:
            with sole_run_on(postgres_schema, {}, key=lock_key):
                pass
        assert busy_database(postgres_schema) in str(refused.value)
    # Free again once the first run has finished.
    with sole_run_on(postgres_schema, {}, key=lock_key):
        pass


def test_an_unreachable_database_is_refused_plainly(lock_key):
    url = f"postgresql+asyncpg://u:secret@127.0.0.1:1/{THROWAWAY_DATABASE}"
    with pytest.raises(RuntimeError, match="Couldn't lock") as refused:
        with sole_run_on(url, {}, key=lock_key):
            pass
    assert "secret" not in str(refused.value)


def test_n_is_refused_at_start_up_only_on_the_shared_database(monkeypatch):
    config = SimpleNamespace(option=SimpleNamespace(numprocesses=2))
    # CI: -n with no URL, a container per worker. Untouched.
    monkeypatch.delenv("SWITCH_TEST_POSTGRES_URL", raising=False)
    pytest_configure(config)  # type: ignore[arg-type]
    monkeypatch.setenv(
        "SWITCH_TEST_POSTGRES_URL",
        f"postgresql+asyncpg://u:secret@127.0.0.1:5432/{THROWAWAY_DATABASE}",
    )
    with pytest.raises(pytest.UsageError, match="run without -n") as refused:
        pytest_configure(config)  # type: ignore[arg-type]
    assert "secret" not in str(refused.value)
    # One process on the shared database is fine.
    config.option.numprocesses = None
    pytest_configure(config)  # type: ignore[arg-type]
