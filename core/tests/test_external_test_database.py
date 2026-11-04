"""The throwaway-database switch for runners without Docker refuses anything
that could be a real database, before any connection is made."""

import pytest

from tests.conftest import THROWAWAY_DATABASE, external_test_database

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
