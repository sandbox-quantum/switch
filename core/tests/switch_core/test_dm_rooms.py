from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.collaboration.adapter import CollaborationAdapter
from switch_core.bridges.collaboration.models import ChannelCreationUnsupported
from switch_core.room_service import RoomCreateConfig, RoomService

# A DM room is a 1:1 "direct" room provisioned outbound onto a bridge (on Slack,
# a private channel with the one user invited). It must have exactly one agent
# and one user, and creation fails loudly if that user is not known to the
# bridge — there is no way to invite a never-seen Slack user.


def _dm_config(*, agent_ids: list[str], user_names: list[str]) -> RoomCreateConfig:
    return RoomCreateConfig(
        name="DM",
        description="d",
        agent_ids=agent_ids,
        user_names=user_names,
        channel_type="direct",
        bridge_id="bridge-1",
    )


# ── 1:1 validation ───────────────────────────────────────────────────────────


def test_validate_dm_room_rejects_multiple_agents() -> None:
    cfg = _dm_config(agent_ids=["a1", "a2"], user_names=["u1"])
    with pytest.raises(ValueError, match="exactly one agent"):
        RoomService._validate_dm_room(object.__new__(RoomService), cfg, ["a1", "a2"])


def test_validate_dm_room_rejects_multiple_users() -> None:
    cfg = _dm_config(agent_ids=["a1"], user_names=["u1", "u2"])
    with pytest.raises(ValueError, match="exactly one user"):
        RoomService._validate_dm_room(object.__new__(RoomService), cfg, ["a1"])


def test_validate_dm_room_rejects_zero_users() -> None:
    cfg = _dm_config(agent_ids=["a1"], user_names=[])
    with pytest.raises(ValueError, match="exactly one user"):
        RoomService._validate_dm_room(object.__new__(RoomService), cfg, ["a1"])


def test_validate_dm_room_accepts_one_to_one() -> None:
    cfg = _dm_config(agent_ids=["a1"], user_names=["u1"])
    # Exactly one agent and one user — no raise.
    RoomService._validate_dm_room(object.__new__(RoomService), cfg, ["a1"])


# ── Unknown-user failure on create ───────────────────────────────────────────


class _FakeSessionCM:
    async def __aenter__(self) -> _FakeSessionCM:
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False

    async def commit(self) -> None:
        return None


class _FakeAgentStore:
    def __init__(self, names: dict[str, str]) -> None:
        self._names = names

    async def get(self, session: Any, agent_id: str) -> Any:
        return SimpleNamespace(id=agent_id, name=self._names[agent_id])


class _FakeBridge:
    def __init__(self, known: dict[str, str]) -> None:
        self._known = known
        self.dm_calls: list[dict[str, str]] = []

        async def create_dm_channel(
            *, agent_name: str, user_name: str, user_external_id: str
        ) -> str:
            self.dm_calls.append(
                {
                    "agent_name": agent_name,
                    "user_name": user_name,
                    "user_external_id": user_external_id,
                }
            )
            return "C-DM"

        self.adapter = SimpleNamespace(create_dm_channel=create_dm_channel)

    async def resolve_external_user_id_map(
        self, user_names: list[str]
    ) -> dict[str, str]:
        return {n: self._known[n] for n in user_names if n in self._known}


class _FakeLifecycle:
    def __init__(self, bridges: dict[str, Any]) -> None:
        self._bridges = bridges

    def get(self, bridge_id: str) -> Any:
        return self._bridges.get(bridge_id)


class _FakeBridgeStore:
    """Reports a connection an operator has left able to create channels, so
    these tests exercise the DM path rather than the capability guard."""

    def __init__(self, *, channel_creation_enabled: bool) -> None:
        self._enabled = channel_creation_enabled

    async def get(self, session: Any, bridge_id: str) -> Any:
        return SimpleNamespace(
            id=bridge_id,
            display_name=bridge_id,
            channel_creation_enabled=self._enabled,
        )


def _dm_service(
    *, known_users: dict[str, str], channel_creation_enabled: bool = True
) -> tuple[RoomService, _FakeBridge]:
    bridge = _FakeBridge(known_users)
    svc = object.__new__(RoomService)
    svc._session_factory = lambda: _FakeSessionCM()  # type: ignore[assignment]
    svc._agent_store = _FakeAgentStore({"a1": "agent.bot"})  # type: ignore[assignment]
    svc._collab_lifecycle = _FakeLifecycle({"bridge-1": bridge})  # type: ignore[assignment]
    svc._collab_bridge_store = _FakeBridgeStore(  # type: ignore[assignment]
        channel_creation_enabled=channel_creation_enabled
    )
    return svc, bridge


async def test_create_dm_room_fails_when_user_unknown_to_bridge() -> None:
    svc, bridge = _dm_service(known_users={})

    with pytest.raises(ValueError, match="no user 'ghost' is known"):
        await svc.create_room(_dm_config(agent_ids=["a1"], user_names=["ghost"]))

    # We never tried to create a channel for an unreachable user.
    assert bridge.dm_calls == []


async def test_create_dm_room_refused_when_operator_withheld_channel_creation() -> None:
    # Opening a DM makes a conversation on the platform just as a channel does,
    # so the operator's switch governs it too.
    svc, bridge = _dm_service(
        known_users={"alice": "U1"}, channel_creation_enabled=False
    )

    with pytest.raises(ChannelCreationUnsupported, match="turned off"):
        await svc.create_room(_dm_config(agent_ids=["a1"], user_names=["alice"]))

    assert bridge.dm_calls == []


# ── Base adapter (non-Slack platforms) ───────────────────────────────────────


async def test_base_adapter_rejects_dm_channel_creation() -> None:
    # The default raises so platforms whose DMs are user-initiated (Mattermost)
    # fail loud rather than silently no-op.
    with pytest.raises(ChannelCreationUnsupported, match="cannot create DM channels"):
        await CollaborationAdapter.create_dm_channel(
            SimpleNamespace(),
            agent_name="a",
            user_name="u",
            user_external_id="U1",
        )
