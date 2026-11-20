"""`_find_existing_bot` must tell "no such bot" apart from "the lookup failed".

It used to wrap its whole paged lookup in `except Exception: pass` and return
None, so a session expiry, a 500 or a network blip looked exactly like a bot
that does not exist yet. Both callers read that None as "create the bot", the
create then failed with a username-taken error, and the real cause — that the
lookup failed — was never recorded. A genuine miss still returns None; a real
failure now propagates.
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
            url="http://mattermost.invalid",
            admin_user="admin",
            admin_password="pw",
            team_name="team",
        )
    )


def _stub_mm_api(adapter: MattermostAdapter, fake: Any) -> None:
    adapter._mm_api = fake  # type: ignore[method-assign]


async def test_returns_the_matching_bot() -> None:
    adapter = _adapter()

    async def fake(method: str, endpoint: str, data: Any = None) -> Any:
        return [
            {"username": "other", "user_id": "u-other", "delete_at": 0},
            {"username": "worker", "user_id": "u-worker", "delete_at": 0},
        ]

    _stub_mm_api(adapter, fake)

    bot = await adapter._find_existing_bot("worker")
    assert bot is not None
    assert bot["user_id"] == "u-worker"


async def test_re_enables_a_soft_deleted_bot_before_returning_it() -> None:
    adapter = _adapter()
    calls: list[tuple[str, str]] = []

    async def fake(method: str, endpoint: str, data: Any = None) -> Any:
        calls.append((method, endpoint))
        if method == "get":
            return [{"username": "worker", "user_id": "u-worker", "delete_at": 123}]
        return {}

    _stub_mm_api(adapter, fake)

    bot = await adapter._find_existing_bot("worker")
    assert bot is not None
    assert ("post", "/bots/u-worker/enable") in calls


async def test_pages_until_the_bot_is_found() -> None:
    adapter = _adapter()

    async def fake(method: str, endpoint: str, data: Any = None) -> Any:
        if "page=0" in endpoint:
            return [
                {"username": f"b{i}", "user_id": str(i), "delete_at": 0}
                for i in range(200)
            ]
        return [{"username": "worker", "user_id": "u-worker", "delete_at": 0}]

    _stub_mm_api(adapter, fake)

    bot = await adapter._find_existing_bot("worker")
    assert bot is not None
    assert bot["user_id"] == "u-worker"


async def test_missing_bot_returns_none() -> None:
    adapter = _adapter()

    async def fake(method: str, endpoint: str, data: Any = None) -> Any:
        return []

    _stub_mm_api(adapter, fake)

    assert await adapter._find_existing_bot("worker") is None


async def test_a_lookup_failure_propagates_rather_than_looking_like_a_miss() -> None:
    adapter = _adapter()

    async def fake(method: str, endpoint: str, data: Any = None) -> Any:
        raise RuntimeError("mattermost session expired")

    _stub_mm_api(adapter, fake)

    with pytest.raises(RuntimeError, match="session expired"):
        await adapter._find_existing_bot("worker")


async def test_a_failure_re_enabling_a_soft_deleted_bot_propagates() -> None:
    adapter = _adapter()

    async def fake(method: str, endpoint: str, data: Any = None) -> Any:
        if method == "get":
            return [{"username": "worker", "user_id": "u-worker", "delete_at": 123}]
        raise RuntimeError("mattermost rejected the enable request")

    _stub_mm_api(adapter, fake)

    with pytest.raises(RuntimeError, match="rejected the enable"):
        await adapter._find_existing_bot("worker")


async def test_a_failed_lookup_does_not_make_identity_creation_create_a_bot() -> None:
    """The reason the swallow mattered: the caller must not read a failed
    lookup as "no such bot" and mint a second bot under the same username."""
    adapter = _adapter()
    adapter._admin_driver = object()  # type: ignore[assignment]
    adapter._main_loop = asyncio.get_running_loop()
    calls: list[tuple[str, str]] = []

    async def fake(method: str, endpoint: str, data: Any = None) -> Any:
        calls.append((method, endpoint))
        raise RuntimeError("mattermost session expired")

    _stub_mm_api(adapter, fake)

    with pytest.raises(RuntimeError, match="session expired"):
        await adapter._create_agent_identity("worker", "a Switch agent")
    assert not [call for call in calls if call[0] == "post"]
