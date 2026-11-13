"""`ManagementAuthenticator.signature_valid` on the real class: the
locked-out-address path checks a token's signature and expiry with no
database read (merge defect: it read a `_token_secret` main had removed)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, cast

from switch_core.management import tokens
from switch_core.management.auth import ManagementAuthenticator

SECRET = "s" * 48


def _authenticator() -> ManagementAuthenticator:
    # The signature check touches none of these; a database read would fail.
    unused = cast(Any, object())
    return ManagementAuthenticator(
        session_factory=unused,
        controllers=unused,
        token_secret=SECRET,
        presence=unused,
        auth_cache=unused,
    )


def _token(*, secret: str = SECRET, now: datetime | None = None) -> str:
    token, _ = tokens.mint_access_token(
        secret=secret,
        controller_id="c1",
        tenant_id="t1",
        owner_id="o1",
        now=now or datetime.now(UTC),
    )
    return token


def test_a_token_minted_with_the_secret_is_valid() -> None:
    assert _authenticator().signature_valid(_token()) is True


def test_a_token_minted_with_another_secret_is_not() -> None:
    assert _authenticator().signature_valid(_token(secret="x" * 48)) is False


def test_a_tampered_token_is_not() -> None:
    token = _token()
    tampered = token[:-2] + ("AA" if not token.endswith("AA") else "BB")
    assert _authenticator().signature_valid(tampered) is False


def test_an_expired_token_is_not() -> None:
    old = datetime.now(UTC) - tokens.ACCESS_TOKEN_LIFETIME - timedelta(minutes=5)
    assert _authenticator().signature_valid(_token(now=old)) is False


def test_garbage_is_not() -> None:
    assert _authenticator().signature_valid("not-a-token") is False
