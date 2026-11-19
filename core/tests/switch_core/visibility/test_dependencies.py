"""The key is loaded at start, an unsafe file stops the start, and with no key
the visibility routes answer 503 rather than showing raw ids."""

from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from switch_core.visibility.dependencies import get_keyed_id_key, load_keyed_id_key
from switch_core.visibility.keyed_id import KeyedIdKey, KeyedIdKeyError

SECRET = b"a-made-up-test-key-of-thirty-two-bytes-or-more"


def _config(path: str | None, version: str = "k1") -> SimpleNamespace:
    return SimpleNamespace(
        visibility_keyed_id_key_path=path, visibility_keyed_id_key_version=version
    )


def _request(key: object) -> SimpleNamespace:
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(keyed_id_key=key)))


def test_no_key_configured_loads_nothing() -> None:
    assert load_keyed_id_key(_config(None)) is None  # type: ignore[arg-type]


def test_a_good_file_loads(tmp_path: Path) -> None:
    path = tmp_path / "k"
    path.write_bytes(SECRET)
    os.chmod(path, 0o400)
    key = load_keyed_id_key(_config(str(path), "k2"))  # type: ignore[arg-type]
    assert isinstance(key, KeyedIdKey) and key.version == "k2"


def test_an_unsafe_file_stops_the_start(tmp_path: Path) -> None:
    path = tmp_path / "k"
    path.write_bytes(SECRET)
    os.chmod(path, 0o644)
    with pytest.raises(KeyedIdKeyError):
        load_keyed_id_key(_config(str(path)))  # type: ignore[arg-type]


def test_routes_get_503_without_a_key() -> None:
    with pytest.raises(HTTPException) as exc:
        get_keyed_id_key(_request(None))  # type: ignore[arg-type]
    assert exc.value.status_code == 503
    key = KeyedIdKey(SECRET, "k1")
    assert get_keyed_id_key(_request(key)) is key  # type: ignore[arg-type]
