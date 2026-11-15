"""`VerifiedTokens`: a controller access token is verified once, and its
expiry is still checked on every use."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.management import tokens

SECRET = "s" * 48


def _token(controller_id: str = "c1") -> str:
    token, _ = tokens.mint_access_token(
        secret=SECRET,
        controller_id=controller_id,
        tenant_id="t1",
        owner_id="o1",
        now=datetime.now(UTC),
    )
    return token


@pytest.fixture
def decodes(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """The tokens PyJWT was asked to decode."""
    seen: list[str] = []
    decode = tokens.jwt.decode

    def counted(token: str, *args: Any, **kwargs: Any) -> Any:
        seen.append(token)
        return decode(token, *args, **kwargs)

    monkeypatch.setattr(tokens.jwt, "decode", counted)
    return seen


def test_a_token_is_decoded_once(decodes: list[str]) -> None:
    verified = tokens.VerifiedTokens(secret=SECRET)
    token = _token()

    first = verified.verify(token)
    again = verified.verify(token)

    assert first == again == tokens.AccessTokenClaims("c1", "t1", "o1")
    assert len(decodes) == 1


def test_a_kept_token_is_refused_once_it_expires(
    decodes: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    verified = tokens.VerifiedTokens(secret=SECRET)
    token = _token()
    verified.verify(token)

    later = tokens.time.time() + tokens.ACCESS_TOKEN_LIFETIME.total_seconds() + 1
    monkeypatch.setattr(tokens, "time", SimpleNamespace(time=lambda: later))
    monkeypatch.setattr(
        tokens.jwt.api_jwt, "datetime", _Frozen(datetime.fromtimestamp(later, UTC))
    )

    with pytest.raises(tokens.AccessTokenExpired):
        verified.verify(token)


def test_an_altered_token_is_not_taken_for_a_kept_one() -> None:
    verified = tokens.VerifiedTokens(secret=SECRET)
    token = _token()
    verified.verify(token)

    with pytest.raises(tokens.AccessTokenInvalid):
        verified.verify(token[:-2] + ("AA" if not token.endswith("AA") else "BB"))


def test_it_keeps_no_more_than_its_bound(decodes: list[str]) -> None:
    verified = tokens.VerifiedTokens(secret=SECRET, max_entries=2)
    first, second, third = _token("c1"), _token("c2"), _token("c3")
    for token in (first, second, third):
        verified.verify(token)

    verified.verify(third)
    verified.verify(first)

    assert len(decodes) == 4


class _Frozen:
    """PyJWT's view of `datetime`, with `now` fixed: it checks `exp` against
    its own clock, not the one this module keeps."""

    def __init__(self, now: datetime) -> None:
        self._now = now

    def now(self, tz: Any = None) -> datetime:
        return self._now

    def __getattr__(self, name: str) -> Any:
        return getattr(datetime, name)
