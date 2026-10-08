"""A shared bridge is made by installing the app, and stays on what it was
installed into.

The deployment's own app is in every tenant's workspaces, so a shared bridge
reaches whatever its config names. Registering one by hand, or editing one to
name another workspace, would let a tenant admin put their rooms in somebody
else's. Both are refused before anything is stored.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.adapter import ConfigEditRefused
from switch_core.bridges.collaboration.lifecycle_service import BridgeClaimConflict
from switch_core.bridges.collaboration.models import (
    BridgeNotRunning,
    BridgeOperationError,
    BridgeStartRefused,
)
from switch_core.db.models import Client, CollaborationBridge, User
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.collaborations import create_bridge, update_bridge
from switch_core.gateway.schemas import BridgeCreateRequest, BridgeUpdateRequest

_BRIDGE_STORE = CollaborationBridgeStore()


class _Lifecycle:
    """Records what reached it; refuses any start when told to."""

    def __init__(
        self,
        *,
        refuse: bool = False,
        claimed: bool = False,
        editable: frozenset[str] | None = None,
        edit_refusal: Exception | None = None,
    ) -> None:
        self.refuse = refuse
        self.claimed = claimed
        self.editable = editable
        self.edit_refusal = edit_refusal
        self.channel_creation = False
        self.registered: list[dict[str, object]] = []
        self.checked: list[dict[str, Any]] = []
        self.edits_checked: list[dict[str, Any]] = []
        self.restarted: list[str] = []

    def editable_config_keys(
        self, bridge_type: str, connection_config: dict[str, object]
    ) -> frozenset[str] | None:
        return self.editable

    async def restart(self, bridge_id: str) -> None:
        self.restarted.append(bridge_id)

    def get_adapter(self, bridge_id: str) -> None:
        return None

    def supports_directory_search(self, bridge_type: str) -> bool:
        return False

    async def register(self, **kwargs: object) -> None:
        self.registered.append(kwargs)

    async def check_edited_connection_config(self, **kwargs: Any) -> None:
        if self.claimed:
            raise BridgeClaimConflict("Discord server 999 is already claimed")

    def supports_channel_creation(self, bridge_type: str) -> bool:
        return self.channel_creation

    async def check_start_guards(self, **kwargs: Any) -> None:
        self.checked.append(kwargs)
        if self.refuse:
            raise BridgeStartRefused("not installed for this tenant")

    async def check_config_edit(self, **kwargs: Any) -> None:
        self.edits_checked.append(kwargs)
        if self.edit_refusal is not None:
            raise self.edit_refusal


def _admin() -> User:
    return User(id="admin", name="admin", email="admin@example.test", role="admin")


async def _shared_bridge(
    session: AsyncSession,
    *,
    bridge_type: str = "discord",
    connection_config: dict[str, object] | None = None,
) -> str:
    client = Client(
        transport_user_id=f"@bridge-{uuid.uuid4().hex[:12]}:test",
        display_name="bridge client",
        type="bridge",
    )
    session.add(client)
    await session.flush()
    bridge = CollaborationBridge(
        type=bridge_type,
        display_name="Acme",
        client_id=client.id,
        status="active",
        connection_config=connection_config
        or {"guild_id": "111", "event_delivery": "shared"},
    )
    session.add(bridge)
    await session.flush()
    return bridge.id


async def _update(
    session_factory: async_sessionmaker[AsyncSession],
    bridge_id: str,
    lifecycle: _Lifecycle,
    connection_config: dict[str, object],
) -> HTTPException:
    async with session_factory() as session:
        with pytest.raises(HTTPException) as refused:
            await update_bridge(
                bridge_id=bridge_id,
                payload=BridgeUpdateRequest(connection_config=connection_config),
                session=session,
                bridge_store=_BRIDGE_STORE,
                room_store=RoomStore(),
                collab_lifecycle=lifecycle,  # type: ignore[arg-type]
                user=_admin(),
            )
    return refused.value


async def _stored_config(
    session_factory: async_sessionmaker[AsyncSession], bridge_id: str
) -> dict[str, object]:
    async with session_factory() as session:
        bridge = await _BRIDGE_STORE.get(session, bridge_id)
    assert bridge is not None
    return dict(bridge.connection_config or {})


async def test_a_shared_bridge_cannot_be_registered_by_hand() -> None:
    lifecycle = _Lifecycle()

    with pytest.raises(HTTPException) as refused:
        await create_bridge(
            req=BridgeCreateRequest(
                bridge_type="discord",
                display_name="Not mine",
                connection_config={"guild_id": "999", "event_delivery": "shared"},
            ),
            session=None,  # type: ignore[arg-type]
            bridge_store=_BRIDGE_STORE,
            collab_lifecycle=lifecycle,  # type: ignore[arg-type]
            user=_admin(),
        )

    assert refused.value.status_code == 422
    assert lifecycle.registered == []


async def test_a_shared_bridge_cannot_be_pointed_at_another_workspace(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        bridge_id = await _shared_bridge(session)
        await session.commit()
    lifecycle = _Lifecycle(refuse=True)

    refused = await _update(session_factory, bridge_id, lifecycle, {"guild_id": "999"})

    assert refused.status_code == 422
    # Asked with the config it would have stored, and nothing was stored.
    assert lifecycle.checked[0]["connection_config"]["guild_id"] == "999"
    assert (await _stored_config(session_factory, bridge_id))["guild_id"] == "111"


async def test_how_a_bridge_receives_events_cannot_be_changed(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        bridge_id = await _shared_bridge(session)
        await session.commit()
    lifecycle = _Lifecycle()

    refused = await _update(
        session_factory,
        bridge_id,
        lifecycle,
        {"event_delivery": "own_connection", "bot_token": "pasted-token"},
    )

    assert refused.status_code == 422
    assert (await _stored_config(session_factory, bridge_id))[
        "event_delivery"
    ] == "shared"


async def test_an_edit_cannot_claim_a_workspace_another_bridge_holds(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        bridge_id = await _shared_bridge(session)
        await session.commit()
    lifecycle = _Lifecycle(claimed=True)

    refused = await _update(session_factory, bridge_id, lifecycle, {"guild_id": "999"})

    assert refused.status_code == 400
    assert "already claimed" in str(refused.detail)
    assert (await _stored_config(session_factory, bridge_id))["guild_id"] == "111"


_TEAMS_SHARED = {
    "event_delivery": "shared",
    "tenant_id": "org-1",
    "service_url": "https://smba.trafficmanager.net/amer/",
}


async def test_settings_switch_manages_cannot_be_edited(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A shared Teams bridge's learned service URL decides where the
    deployment's Bot Connector token is sent; edited, it would send it to
    whoever the editor chose."""
    async with session_factory() as session:
        bridge_id = await _shared_bridge(
            session, bridge_type="teams", connection_config=dict(_TEAMS_SHARED)
        )
        await session.commit()
    lifecycle = _Lifecycle(editable=frozenset({"team_id"}))

    refused = await _update(
        session_factory,
        bridge_id,
        lifecycle,
        {"service_url": "https://attacker.example/"},
    )

    assert refused.status_code == 422
    assert "service_url" in str(refused.detail)
    assert (await _stored_config(session_factory, bridge_id))["service_url"] == (
        _TEAMS_SHARED["service_url"]
    )


async def test_an_editable_setting_and_unchanged_ones_go_through(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Sending back a setting unchanged, as a form that posts the whole config
    does, is not an edit to it."""
    async with session_factory() as session:
        bridge_id = await _shared_bridge(
            session, bridge_type="teams", connection_config=dict(_TEAMS_SHARED)
        )
        await session.commit()
    lifecycle = _Lifecycle(editable=frozenset({"team_id"}))

    async with session_factory() as session:
        await update_bridge(
            bridge_id=bridge_id,
            payload=BridgeUpdateRequest(
                connection_config={"team_id": "team-9", "tenant_id": "org-1"}
            ),
            session=session,
            bridge_store=_BRIDGE_STORE,
            room_store=RoomStore(),
            collab_lifecycle=lifecycle,  # type: ignore[arg-type]
            user=_admin(),
        )

    assert (await _stored_config(session_factory, bridge_id))["team_id"] == "team-9"
    assert lifecycle.restarted == [bridge_id]


async def test_the_running_bridge_is_asked_about_the_edit_as_it_would_be(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        bridge_id = await _shared_bridge(
            session, bridge_type="teams", connection_config=dict(_TEAMS_SHARED)
        )
        await session.commit()
    lifecycle = _Lifecycle(editable=frozenset({"team_id"}))

    async with session_factory() as session:
        await update_bridge(
            bridge_id=bridge_id,
            payload=BridgeUpdateRequest(connection_config={"team_id": "team-9"}),
            session=session,
            bridge_store=_BRIDGE_STORE,
            room_store=RoomStore(),
            collab_lifecycle=lifecycle,  # type: ignore[arg-type]
            user=_admin(),
        )

    [checked] = lifecycle.edits_checked
    assert checked["bridge_id"] == bridge_id
    assert checked["current"] == _TEAMS_SHARED
    assert checked["connection_config"] == {**_TEAMS_SHARED, "team_id": "team-9"}


@pytest.mark.parametrize(
    ("refusal", "status"),
    [
        (ConfigEditRefused("Switch is not in that team."), 422),
        (BridgeNotRunning("The connection is not running."), 503),
        (BridgeOperationError("Microsoft could not be asked."), 502),
    ],
)
async def test_an_edit_the_platform_refuses_is_not_stored(
    session_factory: async_sessionmaker[AsyncSession],
    refusal: Exception,
    status: int,
) -> None:
    """A default team Switch is not in would fail at the first new channel,
    long after the edit; refused here, nothing is stored or restarted."""
    async with session_factory() as session:
        bridge_id = await _shared_bridge(
            session, bridge_type="teams", connection_config=dict(_TEAMS_SHARED)
        )
        await session.commit()
    lifecycle = _Lifecycle(editable=frozenset({"team_id"}), edit_refusal=refusal)

    refused = await _update(
        session_factory, bridge_id, lifecycle, {"team_id": "team-9"}
    )

    assert refused.status_code == status
    assert str(refusal) in str(refused.detail)
    assert "team_id" not in await _stored_config(session_factory, bridge_id)
    assert lifecycle.restarted == []


async def test_a_refused_edit_stores_none_of_the_rest_of_the_request(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Every check runs before any write, so a refused connection edit leaves
    the request's other changes unmade too — and no write holds the bridge's
    row locked while the platform is asked."""
    async with session_factory() as session:
        bridge_id = await _shared_bridge(
            session, bridge_type="teams", connection_config=dict(_TEAMS_SHARED)
        )
        await session.commit()
    lifecycle = _Lifecycle(
        editable=frozenset({"team_id"}),
        edit_refusal=ConfigEditRefused("Switch is not in that team."),
    )

    async with session_factory() as session:
        with pytest.raises(HTTPException) as refused:
            await update_bridge(
                bridge_id=bridge_id,
                payload=BridgeUpdateRequest(
                    agent_greetings_enabled=False,
                    connection_config={"team_id": "team-9"},
                ),
                session=session,
                bridge_store=_BRIDGE_STORE,
                room_store=RoomStore(),
                collab_lifecycle=lifecycle,  # type: ignore[arg-type]
                user=_admin(),
            )

    assert refused.value.status_code == 422
    async with session_factory() as session:
        bridge = await _BRIDGE_STORE.get(session, bridge_id)
    assert bridge is not None
    assert bridge.agent_greetings_enabled is True


async def test_choosing_a_default_team_turns_channel_creation_on(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """What the Teams panel sends: the default team and channel creation in
    one request, both stored once the team checks out."""
    async with session_factory() as session:
        bridge_id = await _shared_bridge(
            session, bridge_type="teams", connection_config=dict(_TEAMS_SHARED)
        )
        await session.commit()
    lifecycle = _Lifecycle(editable=frozenset({"team_id"}))
    lifecycle.channel_creation = True

    async with session_factory() as session:
        await update_bridge(
            bridge_id=bridge_id,
            payload=BridgeUpdateRequest(
                channel_creation_enabled=True, connection_config={"team_id": "team-9"}
            ),
            session=session,
            bridge_store=_BRIDGE_STORE,
            room_store=RoomStore(),
            collab_lifecycle=lifecycle,  # type: ignore[arg-type]
            user=_admin(),
        )

    async with session_factory() as session:
        bridge = await _BRIDGE_STORE.get(session, bridge_id)
    assert bridge is not None
    assert bridge.channel_creation_enabled is True
    assert bridge.connection_config["team_id"] == "team-9"
