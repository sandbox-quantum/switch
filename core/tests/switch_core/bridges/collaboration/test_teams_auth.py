from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from switch_core.bridges.collaboration.teams.auth import (
    BOT_CONNECTOR_SCOPE,
    InboundActivityValidator,
    TeamsTokenProvider,
)

_ISSUER = "https://api.botframework.com"


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _FakeResp:
    def __init__(self, status_code: int, payload: dict[str, Any]) -> None:
        self.status_code = status_code
        self._payload = payload
        self.text = str(payload)

    def json(self) -> dict[str, Any]:
        return self._payload


class _FakeHttp:
    def __init__(self, resp: _FakeResp) -> None:
        self._resp = resp
        self.calls: list[dict[str, Any]] = []

    async def post(self, url: str, data: dict[str, Any]) -> _FakeResp:
        self.calls.append({"url": url, "data": data})
        return self._resp


def _provider(http: _FakeHttp) -> TeamsTokenProvider:
    return TeamsTokenProvider(
        tenant_id="tenant-1",
        app_id="app-1",
        app_password="secret",
        http=http,  # type: ignore[arg-type]
    )


def test_token_is_fetched_and_returned() -> None:
    http = _FakeHttp(_FakeResp(200, {"access_token": "tok-1", "expires_in": 3600}))
    provider = _provider(http)

    token = _run(provider.token(BOT_CONNECTOR_SCOPE))

    assert token == "tok-1"
    assert len(http.calls) == 1
    assert http.calls[0]["data"]["scope"] == BOT_CONNECTOR_SCOPE
    assert http.calls[0]["data"]["grant_type"] == "client_credentials"


def test_token_is_cached_until_expiry() -> None:
    http = _FakeHttp(_FakeResp(200, {"access_token": "tok-1", "expires_in": 3600}))
    provider = _provider(http)

    first = _run(provider.token(BOT_CONNECTOR_SCOPE))
    second = _run(provider.token(BOT_CONNECTOR_SCOPE))

    assert first == second == "tok-1"
    # Only one network round-trip — the second call is served from cache.
    assert len(http.calls) == 1


def test_token_error_raises() -> None:
    http = _FakeHttp(_FakeResp(401, {"error": "invalid_client"}))
    provider = _provider(http)

    try:
        _run(provider.token(BOT_CONNECTOR_SCOPE))
        raised = False
    except RuntimeError:
        raised = True
    assert raised


# ── InboundActivityValidator (Bot Framework JWT verification) ─────────────────


def _keypair() -> tuple[str, str]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    priv_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    pub_pem = (
        key.public_key()
        .public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode()
    )
    return priv_pem, pub_pem


class _FakeSigningKey:
    def __init__(self, public_pem: str) -> None:
        self.key = public_pem


class _FakeJwks:
    """Stands in for the network-backed PyJWKClient so decode uses our key."""

    def __init__(self, public_pem: str) -> None:
        self._public_pem = public_pem

    def get_signing_key_from_jwt(self, token: str) -> _FakeSigningKey:
        return _FakeSigningKey(self._public_pem)


def _validator(public_pem: str, *, app_id: str = "app-1") -> InboundActivityValidator:
    validator = InboundActivityValidator(app_id=app_id)
    # Bypass the network JWKS fetch by pre-seeding the signing-key source.
    validator._jwks = _FakeJwks(public_pem)  # type: ignore[assignment]
    return validator


def _token(
    priv_pem: str,
    *,
    aud: str = "app-1",
    iss: str = _ISSUER,
    expired: bool = False,
) -> str:
    now = datetime.now(UTC)
    exp = now - timedelta(minutes=5) if expired else now + timedelta(hours=1)
    return jwt.encode(
        {"aud": aud, "iss": iss, "exp": exp},
        priv_pem,
        algorithm="RS256",
    )


def test_validator_accepts_valid_token() -> None:
    priv, pub = _keypair()
    validator = _validator(pub)

    # No raise = accepted.
    validator.validate(f"Bearer {_token(priv)}")


def test_validator_rejects_missing_header() -> None:
    _, pub = _keypair()
    validator = _validator(pub)

    with pytest.raises(PermissionError):
        validator.validate(None)


def test_validator_rejects_non_bearer_header() -> None:
    _, pub = _keypair()
    validator = _validator(pub)

    with pytest.raises(PermissionError):
        validator.validate("Basic Zm9vOmJhcg==")


def test_validator_rejects_wrong_audience() -> None:
    priv, pub = _keypair()
    validator = _validator(pub, app_id="app-1")

    with pytest.raises(PermissionError) as excinfo:
        validator.validate(f"Bearer {_token(priv, aud='someone-else')}")

    # A mismatch is a misconfiguration, and the operator cannot fix it without
    # both halves: the app id Azure addressed the activity to, and the one this
    # bridge was registered with.
    message = str(excinfo.value)
    assert "someone-else" in message
    assert "app-1" in message


def test_audience_mismatch_message_survives_an_unreadable_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The mismatch message reads the audience back out of the token. A token
    that decodes for verification but not for inspection must still produce the
    rejection, not a second error on top of it."""
    priv, pub = _keypair()
    validator = _validator(pub, app_id="app-1")
    token = _token(priv, aud="someone-else")

    original = jwt.decode

    def _decode(*args: Any, **kwargs: Any) -> Any:
        if kwargs.get("options", {}).get("verify_aud") is False:
            raise jwt.DecodeError("unreadable")
        return original(*args, **kwargs)

    monkeypatch.setattr(jwt, "decode", _decode)

    with pytest.raises(PermissionError) as excinfo:
        validator.validate(f"Bearer {token}")

    assert "app-1" in str(excinfo.value)


def test_the_audience_quoted_back_is_a_signature_verified_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The rejection message names the audience the token carries, so that
    value must not come from an unverified parse — otherwise the text
    explaining why an attacker was rejected is written by the attacker.

    Every decode in the validator carries a key and checks the signature; only
    the audience claim, the one already known to mismatch, is relaxed.
    """
    priv, pub = _keypair()
    validator = _validator(pub, app_id="app-1")
    seen: list[dict[str, Any]] = []

    original = jwt.decode

    def _decode(*args: Any, **kwargs: Any) -> Any:
        seen.append(dict(kwargs.get("options") or {}))
        assert len(args) > 1 and args[1], "decoded with no key"
        return original(*args, **kwargs)

    monkeypatch.setattr(jwt, "decode", _decode)

    with pytest.raises(PermissionError):
        validator.validate(f"Bearer {_token(priv, aud='someone-else')}")

    assert seen, "the validator did not decode at all"
    assert not any(o.get("verify_signature") is False for o in seen)


def test_validator_rejects_expired_token() -> None:
    priv, pub = _keypair()
    validator = _validator(pub)

    with pytest.raises(jwt.ExpiredSignatureError):
        validator.validate(f"Bearer {_token(priv, expired=True)}")


def test_validator_rejects_wrong_issuer() -> None:
    priv, pub = _keypair()
    validator = _validator(pub)

    with pytest.raises(jwt.InvalidIssuerError):
        validator.validate(f"Bearer {_token(priv, iss='https://evil.example')}")


def test_validator_rejects_bad_signature() -> None:
    priv_signing, _ = _keypair()
    _, pub_other = _keypair()
    # Verify with a public key that does NOT match the signing key.
    validator = _validator(pub_other)

    with pytest.raises(jwt.InvalidSignatureError):
        validator.validate(f"Bearer {_token(priv_signing)}")
