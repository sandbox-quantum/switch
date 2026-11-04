"""The server runs on uvloop where it is installed, and on asyncio's own loop
where it is not (Windows)."""

from __future__ import annotations

import sys

import pytest

from switch_core import main


def test_uvloop_where_it_is_installed() -> None:
    uvloop = pytest.importorskip("uvloop")
    assert main._event_loop_factory() is uvloop.new_event_loop


def test_asyncios_own_loop_where_it_is_not(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "uvloop", None)
    assert main._event_loop_factory() is None
