"""A failed bot lookup raises instead of reporting the bot as missing.

``_find_existing_bot`` used to wrap its paged lookup in a blanket
``except Exception: pass`` and return ``None``. A session expiry, a 500 or a
network blip was indistinguishable from "no such bot", so the callers went on
to create the bot and failed with a username-taken error that hid the cause.
"""

from __future__ import annotations

from typing import Any

import pytest

from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)


def _adapter() -> MattermostAdapter:
    return MattermostAdapter(
        config=MattermostConnectionConfig(
            url="https://mm.example",
            admin_user="a",
            admin_password="p",
            team_name="t",
        )
    )


async def test_lookup_failure_raises_rather_than_reporting_missing() -> None:
    adapter = _adapter()

    def boom(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("500 from Mattermost")

    adapter._mm_api = boom  # type: ignore[method-assign]

    with pytest.raises(RuntimeError, match="bot lookup for 'switch-admin' failed"):
        await adapter._find_existing_bot("switch-admin")


async def test_absent_bot_still_returns_none() -> None:
    adapter = _adapter()
    calls: list[str] = []

    def fake(method: str, endpoint: str, data: Any = None) -> Any:
        calls.append(endpoint)
        return [{"username": "someone-else", "user_id": "u1"}]

    adapter._mm_api = fake  # type: ignore[method-assign]

    assert await adapter._find_existing_bot("switch-admin") is None
    assert len(calls) == 1


async def test_existing_bot_is_returned() -> None:
    adapter = _adapter()

    def fake(method: str, endpoint: str, data: Any = None) -> Any:
        return [{"username": "switch-admin", "user_id": "u1", "delete_at": 0}]

    adapter._mm_api = fake  # type: ignore[method-assign]

    found = await adapter._find_existing_bot("switch-admin")
    assert found is not None
    assert found["user_id"] == "u1"
