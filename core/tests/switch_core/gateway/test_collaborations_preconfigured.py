"""The gateway's side of `preconfigured`: the setup step sets it when it
registers the bundled Mattermost, marks a bridge it registered before the flag
existed, and reads it back to know whether it still has to."""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import CollaborationBridge
from switch_core.gateway.collaborations import (
    create_bridge,
    list_bridges,
    update_bridge,
)
from switch_core.gateway.schemas import BridgeCreateRequest, BridgeUpdateRequest
from tests.switch_core.gateway.test_collaborations_authz import (
    _BRIDGE_STORE,
    _ROOM_STORE,
    _admin,
    _make_bridge,
    _NoRunningBridges,
)


class _Lifecycle(_NoRunningBridges):
    """Records what the endpoints tell the running bridges."""

    def __init__(self, registered: CollaborationBridge | None = None) -> None:
        self.registered = registered
        self.register_kwargs: dict[str, Any] = {}
        self.noted: list[tuple[str, bool]] = []
        self.restarted: list[str] = []

    async def register(self, **kwargs: Any) -> CollaborationBridge:
        self.register_kwargs = kwargs
        assert self.registered is not None
        return self.registered

    def note_preconfigured(self, bridge_id: str, preconfigured: bool) -> None:
        self.noted.append((bridge_id, preconfigured))

    async def restart(self, bridge_id: str) -> None:
        self.restarted.append(bridge_id)


def _request(**overrides: Any) -> BridgeCreateRequest:
    body: dict[str, Any] = {
        "bridge_type": "mattermost",
        "display_name": "Mattermost",
        "connection_config": {"url": "http://mattermost.invalid"},
    }
    body.update(overrides)
    return BridgeCreateRequest(**body)


class TestRegistering:
    async def test_the_setup_steps_flag_reaches_the_lifecycle(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge = await _BRIDGE_STORE.get(session, await _make_bridge(session))
            await session.commit()
        assert bridge is not None
        lifecycle = _Lifecycle(registered=bridge)

        async with session_factory() as session:
            await create_bridge(
                _request(preconfigured=True),
                session,
                _BRIDGE_STORE,
                lifecycle,  # type: ignore[arg-type]
                _admin(),
            )

        assert lifecycle.register_kwargs["preconfigured"] is True

    async def test_a_person_registering_one_leaves_it_off(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Nobody but the setup step sends it, so a request without it is a
        person connecting their platform."""
        async with session_factory() as session:
            bridge = await _BRIDGE_STORE.get(session, await _make_bridge(session))
            await session.commit()
        lifecycle = _Lifecycle(registered=bridge)

        async with session_factory() as session:
            await create_bridge(
                _request(),
                session,
                _BRIDGE_STORE,
                lifecycle,  # type: ignore[arg-type]
                _admin(),
            )

        assert lifecycle.register_kwargs["preconfigured"] is False


class TestMarkingAnExistingBridge:
    async def test_it_is_stored_returned_and_told_to_the_running_bridge(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            await session.commit()
        lifecycle = _Lifecycle()

        async with session_factory() as session:
            detail = await update_bridge(
                bridge_id,
                BridgeUpdateRequest(preconfigured=True),
                session,
                _BRIDGE_STORE,
                _ROOM_STORE,
                lifecycle,  # type: ignore[arg-type]
                _admin(),
            )

        assert detail.preconfigured is True
        assert lifecycle.noted == [(bridge_id, True)]
        # Marking it changes no connection setting, so the bridge keeps running.
        assert lifecycle.restarted == []
        async with session_factory() as session:
            stored = await _BRIDGE_STORE.get(session, bridge_id)
        assert stored is not None and stored.preconfigured is True

    async def test_an_update_that_does_not_mention_it_leaves_it_alone(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            await _BRIDGE_STORE.set_preconfigured(session, bridge_id, True)
            await session.commit()
        lifecycle = _Lifecycle()

        async with session_factory() as session:
            detail = await update_bridge(
                bridge_id,
                BridgeUpdateRequest(agent_greetings_enabled=False),
                session,
                _BRIDGE_STORE,
                _ROOM_STORE,
                lifecycle,  # type: ignore[arg-type]
                _admin(),
            )

        assert detail.preconfigured is True
        assert lifecycle.noted == []


class TestReadingItBack:
    async def test_the_listing_says_which_bridges_are_preconfigured(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """What the setup step reads to decide whether it still has to mark
        one. A bridge that predates the column reads as not preconfigured."""
        async with session_factory() as session:
            bundled = await _make_bridge(session)
            added = await _make_bridge(session)
            await _BRIDGE_STORE.set_preconfigured(session, bundled, True)
            await session.commit()

        async with session_factory() as session:
            listed = await list_bridges(
                session,
                _BRIDGE_STORE,
                _ROOM_STORE,
                _NoRunningBridges(),  # type: ignore[arg-type]
                _admin(),
            )

        flags = {d.bridge_id: d.preconfigured for d in listed}
        assert flags[bundled] is True
        assert flags[added] is False
