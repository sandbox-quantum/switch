"""The operator list: an owner-only file, re-read on change, failing closed."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

import pytest

from switch_core.visibility.operators import OperatorList


def _write(path: Path, data: object, mode: int = 0o600) -> None:
    path.write_text(json.dumps(data))
    os.chmod(path, mode)


def test_unset_or_missing_means_nobody(tmp_path: Path) -> None:
    assert not OperatorList(None).is_operator("u1")
    assert not OperatorList(tmp_path / "missing.json").is_operator("u1")
    assert not OperatorList(None).is_operator(None)


@pytest.mark.parametrize("mode", [0o400, 0o600])
def test_listed_users_only(tmp_path: Path, mode: int) -> None:
    path = tmp_path / "operators.json"
    _write(path, {"operators": ["u1", "u2"]}, mode)
    ops = OperatorList(path)
    assert ops.is_operator("u1") and ops.is_operator("u2")
    assert not ops.is_operator("u3")
    assert not ops.is_operator(None)


def test_a_removal_applies_on_the_next_check(tmp_path: Path) -> None:
    path = tmp_path / "operators.json"
    _write(path, {"operators": ["u1", "u2"]})
    ops = OperatorList(path)
    assert ops.is_operator("u2")
    _write(path, {"operators": ["u1"]})
    assert not ops.is_operator("u2")
    assert ops.is_operator("u1")


@pytest.mark.parametrize(
    "data",
    [
        ["u1"],
        {"operators": "u1"},
        {"operators": ["u1"], "extra": True},
        {"operators": [1]},
        {"operators": [""]},
        {"operators": [" u1"]},
        {"operators": ["u" * 129]},
        {"operators": [f"u{i}" for i in range(101)]},
    ],
)
def test_a_bad_file_means_nobody(tmp_path: Path, data: object) -> None:
    path = tmp_path / "operators.json"
    _write(path, data)
    assert not OperatorList(path).is_operator("u1")


@pytest.mark.parametrize("mode", [0o640, 0o604, 0o644, 0o660, 0o666])
def test_a_file_others_can_read_or_change_means_nobody(
    tmp_path: Path, mode: int
) -> None:
    path = tmp_path / "operators.json"
    _write(path, {"operators": ["u1"]}, mode=mode)
    assert not OperatorList(path).is_operator("u1")


def test_a_link_means_nobody(tmp_path: Path) -> None:
    real = tmp_path / "real.json"
    _write(real, {"operators": ["u1"]})
    link = tmp_path / "operators.json"
    link.symlink_to(real)
    assert not OperatorList(link).is_operator("u1")


def test_bad_json_logs_once_and_recovers(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    path = tmp_path / "operators.json"
    path.write_text("{not json")
    os.chmod(path, 0o600)
    ops = OperatorList(path)
    with caplog.at_level(logging.ERROR):
        assert not ops.is_operator("u1")
        path.write_text("{still not json")
        assert not ops.is_operator("u1")
    assert len([r for r in caplog.records if "operator list" in r.getMessage()]) == 1
    _write(path, {"operators": ["u1"]})
    assert ops.is_operator("u1")


def test_a_fifo_means_nobody_without_waiting(tmp_path: Path) -> None:
    fifo = tmp_path / "operators.json"
    os.mkfifo(fifo, 0o600)
    assert not OperatorList(fifo).is_operator("u1")


def test_a_same_size_rewrite_is_seen(tmp_path: Path) -> None:
    """Same length, same modified time: the change time and inode still differ,
    so the new list is read."""
    path = tmp_path / "operators.json"
    _write(path, {"operators": ["ua"]})
    ops = OperatorList(path)
    assert ops.is_operator("ua")
    before = path.stat()
    replacement = tmp_path / "new.json"
    _write(replacement, {"operators": ["ub"]})
    os.utime(replacement, ns=(before.st_atime_ns, before.st_mtime_ns))
    os.replace(replacement, path)
    assert path.stat().st_size == before.st_size
    assert ops.is_operator("ub") and not ops.is_operator("ua")
