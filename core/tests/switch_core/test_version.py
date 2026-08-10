"""Tests for switch-core reporting its own version (CHOO-1865)."""

from __future__ import annotations

import logging
import re
import tomllib
from importlib.metadata import PackageNotFoundError
from pathlib import Path

import pytest

from switch_core import version as version_module
from switch_core.version import server_declaration, switch_core_version

PYPROJECT = Path(__file__).resolve().parents[2] / "pyproject.toml"


@pytest.fixture(autouse=True)
def _clear_cache() -> None:
    switch_core_version.cache_clear()


def _raise_not_found(name: str) -> str:
    raise PackageNotFoundError(name)


def test_matches_the_version_declared_in_pyproject() -> None:
    """The running version is the one pyproject declares, with no second copy.

    A `__version__` constant beside pyproject would be one more thing to keep
    in step by hand — the drift CHOO-1865 exists to end.
    """
    declared = tomllib.loads(PYPROJECT.read_text())["project"]["version"]
    assert switch_core_version() == declared


def test_the_declared_version_is_three_part_semver() -> None:
    """Every Switch artifact carries MAJOR.MINOR.PATCH, switch-core included."""
    declared = tomllib.loads(PYPROJECT.read_text())["project"]["version"]
    assert re.fullmatch(r"\d+\.\d+\.\d+", declared), declared


def test_unknown_when_distribution_metadata_is_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unreadable version is None, never a placeholder.

    "0.0.0" or "unknown" would read downstream as a version somebody chose.
    Unknown has to stay distinguishable from known.
    """
    monkeypatch.setattr(version_module, "distribution_version", _raise_not_found)
    assert switch_core_version() is None


def test_warns_when_the_version_cannot_be_read(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Degraded, but disclosed — a silent None would hide a broken install."""
    monkeypatch.setattr(version_module, "distribution_version", _raise_not_found)
    with caplog.at_level(logging.WARNING, logger=version_module.__name__):
        switch_core_version()
    assert any(record.levelno == logging.WARNING for record in caplog.records)


# ── Disclosure ───────────────────────────────────────────────────────────────


def test_a_declaration_carries_only_the_contracts_asked_for() -> None:
    """Least disclosure: a credential sees its own contract and no others."""
    declared = server_declaration("agent-protocol")

    assert set(declared["contracts"]) == {"agent-protocol"}
    assert declared["contracts"]["agent-protocol"].keys() == {"speaks", "accepts"}


def test_a_declaration_reports_an_unknown_version_as_null(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(version_module, "switch_core_version", lambda: None)

    assert server_declaration("agent-protocol")["version"] is None


def test_db_schema_cannot_be_disclosed() -> None:
    """Internal to switch-core, and no external client can act on it.

    Enforced here rather than left to reviewers to remember, because the cost
    of forgetting is a permanent leak in a public deployment.
    """
    with pytest.raises(ValueError, match="internal to switch-core"):
        server_declaration("db-schema")


def test_db_schema_cannot_ride_alongside_a_public_contract() -> None:
    """The likelier mistake than asking for it alone."""
    with pytest.raises(ValueError, match="internal to switch-core"):
        server_declaration("gateway-api", "db-schema")
