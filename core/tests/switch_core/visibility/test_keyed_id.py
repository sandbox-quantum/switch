"""Keyed ids: stable, kind-separated, versioned, and the key stays hidden."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from switch_core.visibility.keyed_id import (
    KeyedIdKey,
    KeyedIdKeyError,
    KeyedIdKind,
    display_form,
    is_keyed_id,
    load_key,
)

SECRET = b"a-made-up-test-key-of-thirty-two-bytes-or-more"


def test_same_input_same_id_and_the_shape_is_versioned() -> None:
    key = KeyedIdKey(SECRET, "k1")
    a = key.keyed_id(KeyedIdKind.USER, "user-123")
    assert a == key.keyed_id(KeyedIdKind.USER, "user-123")
    assert a.startswith("k1-") and len(a) == 3 + 16
    assert is_keyed_id(a)
    assert display_form(a) == a[3:7]


def test_kind_is_part_of_the_hash() -> None:
    key = KeyedIdKey(SECRET, "k1")
    assert key.keyed_id(KeyedIdKind.USER, "x1") != key.keyed_id(
        KeyedIdKind.WORKSPACE, "x1"
    )


def test_a_new_key_or_version_gives_ids_that_dont_match() -> None:
    old = KeyedIdKey(SECRET, "k1").keyed_id(KeyedIdKind.USER, "u")
    rotated = KeyedIdKey(SECRET + b"!", "k2").keyed_id(KeyedIdKind.USER, "u")
    assert old != rotated and rotated.startswith("k2-")


def test_the_key_never_appears_in_repr() -> None:
    key = KeyedIdKey(SECRET, "k1")
    assert SECRET.decode() not in repr(key)
    assert "hidden" in repr(key)


@pytest.mark.parametrize("bad", ["", "a", "1", "k", "kk1", "k1234", "K1"])
def test_bad_versions_are_refused(bad: str) -> None:
    with pytest.raises(KeyedIdKeyError):
        KeyedIdKey(SECRET, bad)


def test_a_short_key_is_refused() -> None:
    with pytest.raises(KeyedIdKeyError):
        KeyedIdKey(b"short", "k1")


def test_raw_ids_and_names_are_not_keyed_ids() -> None:
    assert not is_keyed_id("user-123")
    assert not is_keyed_id("Ada Lovelace")
    assert not is_keyed_id("k1-ABCDEF0123456789")
    with pytest.raises(ValueError):
        display_form("user-123")


def _write(tmp_path: Path, mode: int, content: bytes = SECRET + b"\n") -> Path:
    path = tmp_path / "keyed-id.key"
    path.write_bytes(content)
    os.chmod(path, mode)
    return path


@pytest.mark.parametrize("mode", [0o400, 0o600])
def test_load_key_reads_an_owner_only_file(tmp_path: Path, mode: int) -> None:
    key = load_key(_write(tmp_path, mode), "k1")
    # The trailing newline is stripped, so the key matches one built directly.
    assert key.keyed_id(KeyedIdKind.BOX, "b") == KeyedIdKey(SECRET, "k1").keyed_id(
        KeyedIdKind.BOX, "b"
    )


@pytest.mark.parametrize("mode", [0o440, 0o404, 0o644, 0o620])
def test_load_key_refuses_a_file_others_can_read(tmp_path: Path, mode: int) -> None:
    with pytest.raises(KeyedIdKeyError, match="0400"):
        load_key(_write(tmp_path, mode), "k1")


def test_load_key_refuses_a_link_and_a_missing_file(tmp_path: Path) -> None:
    real = _write(tmp_path, 0o400)
    link = tmp_path / "link.key"
    link.symlink_to(real)
    with pytest.raises(KeyedIdKeyError, match="regular file"):
        load_key(link, "k1")
    with pytest.raises(KeyedIdKeyError, match="does not exist"):
        load_key(tmp_path / "nope.key", "k1")


def test_load_key_refuses_a_fifo_without_waiting(tmp_path: Path) -> None:
    """Opened non-blocking and checked on the open file, so a named pipe is
    refused at once rather than hanging the start."""
    fifo = tmp_path / "pipe.key"
    os.mkfifo(fifo, 0o600)
    with pytest.raises(KeyedIdKeyError, match="regular file"):
        load_key(fifo, "k1")


@pytest.mark.parametrize("ending", [b"\n", b"\r\n", b""])
def test_only_one_trailing_newline_is_dropped(tmp_path: Path, ending: bytes) -> None:
    """A binary key keeps its edge bytes, whitespace included; only the one
    newline an editor adds is dropped."""
    binary = b" \t" + SECRET + b"\t "
    key = load_key(_write(tmp_path, 0o400, binary + ending), "k1")
    assert key.keyed_id(KeyedIdKind.USER, "u") == KeyedIdKey(binary, "k1").keyed_id(
        KeyedIdKind.USER, "u"
    )
    assert key.keyed_id(KeyedIdKind.USER, "u") != KeyedIdKey(SECRET, "k1").keyed_id(
        KeyedIdKind.USER, "u"
    )
