from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from switch_core.bridges.collaboration.bridge_core import BridgeCore

# On startup BridgeCore hands the adapter the bridge's channels so channel
# capture can self-heal (Teams recreates Graph subscriptions; other adapters
# no-op). Only rows with both an external channel id and a channel type are
# forwarded.


class _FakeSession:
    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *exc: Any) -> bool:
        return False


def _room(external_channel_id: str | None, channel_type: str | None) -> SimpleNamespace:
    return SimpleNamespace(
        external_channel_id=external_channel_id, channel_type=channel_type
    )


async def test_ensure_channel_captures_forwards_valid_channels() -> None:
    passed: list[list[tuple[str, str]]] = []

    class _RoomStore:
        async def get_by_bridge(self, session: Any, bridge_id: str) -> list[Any]:
            assert bridge_id == "bridge-1"
            return [
                _room("19:a@thread.tacv2", "channel_public"),
                _room("19:b@thread.tacv2", "channel_private"),
                _room(None, "channel_public"),  # no channel id -> skipped
                _room("19:c@thread.tacv2", None),  # no channel type -> skipped
            ]

    class _Adapter:
        async def ensure_channel_subscriptions(
            self, channels: list[tuple[str, str]]
        ) -> None:
            passed.append(channels)

    bridge = SimpleNamespace(
        _session_factory=_FakeSession,
        _room_store=_RoomStore(),
        _adapter=_Adapter(),
        _bridge_id="bridge-1",
    )

    await BridgeCore._ensure_channel_captures(bridge)

    assert passed == [
        [
            ("19:a@thread.tacv2", "channel_public"),
            ("19:b@thread.tacv2", "channel_private"),
        ]
    ]


async def test_ensure_channel_captures_noop_without_channels() -> None:
    calls: list[Any] = []

    class _RoomStore:
        async def get_by_bridge(self, session: Any, bridge_id: str) -> list[Any]:
            return [_room(None, None)]

    class _Adapter:
        async def ensure_channel_subscriptions(
            self, channels: list[tuple[str, str]]
        ) -> None:
            calls.append(channels)

    bridge = SimpleNamespace(
        _session_factory=_FakeSession,
        _room_store=_RoomStore(),
        _adapter=_Adapter(),
        _bridge_id="bridge-1",
    )

    await BridgeCore._ensure_channel_captures(bridge)

    assert calls == []
