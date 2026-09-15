"""`_find_existing_bot` must tell "no such bot" apart from "the lookup failed".

It used to wrap its whole paged lookup in `except Exception: pass` and return
None, so a session expiry, a 500 or a network blip looked exactly like a bot
that does not exist yet. Both callers read that None as "create the bot", the
create then failed with a username-taken error, and the real cause — that the
lookup failed — was never recorded. A genuine miss still returns None; a real
failure now propagates (CHOO-451).
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)


def _adapter() -> MattermostAdapter:
    return MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm",
            admin_user="admin",
            admin_password="pw",
            team_name="team",
        )
    )


def _find(adapter: MattermostAdapter, username: str) -> dict[str, Any] | None:
    return asyncio.run(adapter._find_existing_bot(username))


def test_returns_the_matching_bot() -> None:
    adapter = _adapter()

    def fake_mm_api(method: str, endpoint: str, data: Any = None) -> Any:
        return [
            {"username": "other", "user_id": "u-other", "delete_at": 0},
            {"username": "worker", "user_id": "u-worker", "delete_at": 0},
        ]

    adapter._mm_api = fake_mm_api  # type: ignore[assignment]

    bot = _find(adapter, "worker")

    assert bot is not None
    assert bot["user_id"] == "u-worker"


def test_re_enables_a_soft_deleted_bot_before_returning_it() -> None:
    adapter = _adapter()
    calls: list[tuple[str, str]] = []

    def fake_mm_api(method: str, endpoint: str, data: Any = None) -> Any:
        calls.append((method, endpoint))
        if method == "get":
            return [{"username": "worker", "user_id": "u-worker", "delete_at": 123}]
        return {}

    adapter._mm_api = fake_mm_api  # type: ignore[assignment]

    bot = _find(adapter, "worker")

    assert bot is not None
    assert ("post", "/bots/u-worker/enable") in calls


def test_pages_until_the_bot_is_found() -> None:
    adapter = _adapter()

    def fake_mm_api(method: str, endpoint: str, data: Any = None) -> Any:
        if "page=0" in endpoint:
            return [{"username": f"b{i}", "user_id": str(i)} for i in range(200)]
        return [{"username": "worker", "user_id": "u-worker", "delete_at": 0}]

    adapter._mm_api = fake_mm_api  # type: ignore[assignment]

    bot = _find(adapter, "worker")

    assert bot is not None
    assert bot["user_id"] == "u-worker"


def test_missing_bot_returns_none() -> None:
    adapter = _adapter()

    def fake_mm_api(method: str, endpoint: str, data: Any = None) -> Any:
        return []

    adapter._mm_api = fake_mm_api  # type: ignore[assignment]

    assert _find(adapter, "worker") is None


def test_a_lookup_failure_propagates_rather_than_looking_like_a_miss() -> None:
    adapter = _adapter()

    def fake_mm_api(method: str, endpoint: str, data: Any = None) -> Any:
        raise RuntimeError("mattermost session expired")

    adapter._mm_api = fake_mm_api  # type: ignore[assignment]

    with pytest.raises(RuntimeError, match="session expired"):
        _find(adapter, "worker")
