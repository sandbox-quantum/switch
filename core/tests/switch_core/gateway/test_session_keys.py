"""Session tokens across key changes: signed with the current key and named by
`kid`, still valid after a rotation while the old key is kept, and sessions
from before `SECRET_KEYS` valid only while `JWT_SECRET_KEY` is set."""

from __future__ import annotations

import datetime

import jwt
import pytest
from fastapi import HTTPException

from switch_core.gateway.auth import JWT_ALGORITHM, create_jwt, decode_jwt
from switch_core.keys import Keyring, Purpose

_OLD = "o" * 40
_NEW = "n" * 40
_LEGACY = "legacy-jwt-secret"


def _keyring(value: str, legacy: str | None = None) -> Keyring:
    return Keyring.parse(value, legacy_secret=legacy)


def _session(keyring: Keyring) -> str:
    return create_jwt("user-1", "a@example.test", "user", keyring, "tenant-1")


def _legacy_session() -> str:
    """A session as signed before `SECRET_KEYS`: the raw secret, no `kid`."""
    payload = {
        "sub": "user-1",
        "exp": datetime.datetime.now(datetime.UTC) + datetime.timedelta(hours=1),
    }
    return jwt.encode(payload, _LEGACY, algorithm=JWT_ALGORITHM)


def test_a_session_names_its_key_and_is_not_signed_with_the_master_key() -> None:
    keyring = _keyring(f"k1:{_OLD}")
    token = _session(keyring)
    assert jwt.get_unverified_header(token)["kid"] == "k1"
    with pytest.raises(jwt.InvalidSignatureError):
        jwt.decode(token, _OLD, algorithms=[JWT_ALGORITHM])
    jwt.decode(token, keyring.derive(Purpose.SESSION), algorithms=[JWT_ALGORITHM])


def test_a_session_survives_a_rotation_while_its_key_is_kept() -> None:
    token = _session(_keyring(f"old:{_OLD}"))
    assert decode_jwt(token, _keyring(f"new:{_NEW},old:{_OLD}"))["sub"] == "user-1"


def test_and_ends_when_its_key_is_removed() -> None:
    token = _session(_keyring(f"old:{_OLD}"))
    with pytest.raises(HTTPException) as refused:
        decode_jwt(token, _keyring(f"new:{_NEW}"))
    assert refused.value.status_code == 401


def test_a_forged_kid_does_not_pick_another_purposes_key() -> None:
    """A token signed with some other derived key, claiming a real `kid`."""
    keyring = _keyring(f"k1:{_OLD}")
    forged = jwt.encode(
        {"sub": "user-1"},
        keyring.derive(Purpose.INSTALL_STATE),
        algorithm=JWT_ALGORITHM,
        headers={"kid": "k1"},
    )
    with pytest.raises(HTTPException):
        decode_jwt(forged, keyring)


def test_a_session_from_before_secret_keys_is_valid_while_the_legacy_secret_is_set() -> (
    None
):
    keyring = _keyring(f"k1:{_NEW}", legacy=_LEGACY)
    assert decode_jwt(_legacy_session(), keyring)["sub"] == "user-1"


def test_and_ends_once_it_is_removed() -> None:
    with pytest.raises(HTTPException) as refused:
        decode_jwt(_legacy_session(), _keyring(f"k1:{_NEW}"))
    assert refused.value.status_code == 401
