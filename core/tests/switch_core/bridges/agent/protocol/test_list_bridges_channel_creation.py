"""`list_bridges` says whether a room made on each bridge can have a channel.

One answer, so an agent does not spend a `create_room` call finding out: the
platform's ceiling, the operator's switch and what the connection still lacks,
a Microsoft Teams default team, all have to allow it.
"""

from __future__ import annotations

from collections.abc import Mapping
from types import SimpleNamespace
from typing import Any

from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.collaboration.teams.adapter import TeamsAdapter


class _Session:
    async def __aenter__(self) -> _Session:
        return self

    async def __aexit__(self, *_: object) -> None:
        return None


class _Bridges:
    def __init__(self, bridges: list[Any]) -> None:
        self._bridges = bridges

    async def get_all(self, session: object) -> list[Any]:
        return self._bridges


class _Lifecycle:
    """Answers as the registered Teams adapter class does."""

    def supports_channel_creation(self, bridge_type: str) -> bool:
        return True

    def supports_private_channels(self, bridge_type: str) -> bool:
        return True

    def channel_creation_blocker(
        self, bridge_type: str, connection_config: Mapping[str, object]
    ) -> str | None:
        return TeamsAdapter.channel_creation_blocker(connection_config)


def _bridge(bridge_id: str, *, enabled: bool, config: dict[str, object]) -> Any:
    return SimpleNamespace(
        id=bridge_id,
        type="teams",
        display_name=bridge_id,
        status="active",
        is_default=False,
        channel_creation_enabled=enabled,
        connection_config=config,
    )


async def test_a_teams_connection_with_no_default_team_cannot_create_channels() -> None:
    shared = {"event_delivery": "shared", "tenant_id": "org"}
    core = object.__new__(AgentCore)
    core.session_factory = _Session  # type: ignore[assignment]
    core.bridge_store = _Bridges(  # type: ignore[assignment]
        [
            _bridge("no-default", enabled=True, config=shared),
            _bridge("ready", enabled=True, config={**shared, "team_id": "team-1"}),
            _bridge("turned-off", enabled=False, config={**shared, "team_id": "t"}),
        ]
    )
    core.collab_lifecycle = _Lifecycle()  # type: ignore[assignment]

    listed = {b["id"]: b for b in await core.list_bridges()}

    assert {
        bridge_id: (b["can_create_channels"], b["can_create_private_channels"])
        for bridge_id, b in listed.items()
    } == {
        "no-default": (False, False),
        "ready": (True, True),
        "turned-off": (False, False),
    }
