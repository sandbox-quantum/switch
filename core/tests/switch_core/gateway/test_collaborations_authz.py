"""Security regression tests for retiring the unauthenticated /collab
bridge-admin API (CHOO-1251, H5).

The old `/collab` mount let anyone list/delete/register collaboration bridges
with no credentials: it sat on the Bearer-auth bypass list and its handlers
carried no authorization. The fix removes `/collab` entirely and routes all
bridge administration through the already admin-gated
`/gateway/collaborations`, adding the one capability the gateway lacked
(nominating a default bridge).

These tests lock in three properties:
1. `/collab` is gone — not in the auth-bypass list, and its modules deleted.
2. Every collaboration write route on the gateway requires an admin (the
   route dependency is `require_admin`), and every route requires at least
   authentication.
3. The new set-default behaviour is correct against real Postgres.
"""

from __future__ import annotations

import importlib
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.auth import PUBLIC_PATH_PREFIXES
from switch_core.db.models import Client, CollaborationBridge, User
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.auth import get_current_user, require_admin
from switch_core.gateway.collaborations import router, set_default_bridge

_BRIDGE_STORE = CollaborationBridgeStore()
_ROOM_STORE = RoomStore()


def _dependency_calls(dependant: object) -> list[object]:
    """All dependency callables reachable from a route, recursively."""
    calls = [dependant.call]  # type: ignore[attr-defined]
    for sub in dependant.dependencies:  # type: ignore[attr-defined]
        calls.extend(_dependency_calls(sub))
    return calls


# ── 1. /collab is retired ────────────────────────────────────────────────────


def test_collab_not_on_auth_bypass_list() -> None:
    assert "/collab" not in PUBLIC_PATH_PREFIXES


def test_collab_api_module_is_gone() -> None:
    # The unauthenticated bridge-admin app and its wiring were deleted; importing
    # them must fail rather than silently resurrect a second admin surface.
    for module in (
        "switch_core.bridges.collaboration.api",
        "switch_core.bridges.collaboration.app",
        "switch_core.bridges.collaboration.dependencies",
    ):
        with pytest.raises(ModuleNotFoundError):
            importlib.import_module(module)


# ── 2. gateway collaboration routes are authorized ───────────────────────────


WRITE_METHODS = {"POST", "PATCH", "PUT", "DELETE"}


def test_bridge_write_routes_require_admin() -> None:
    """EVERY state-changing route must be gated on require_admin — a bridge is an
    unowned, workspace-wide integration holding platform secrets, so there is no
    owner to scope mutation to.

    Derived from the router rather than a hand-listed set: a new write route that
    forgets the gate fails here instead of shipping open.
    """
    unguarded = sorted(
        f"{sorted(route.methods & WRITE_METHODS)} {route.path}"
        for route in router.routes
        if route.methods & WRITE_METHODS
        and require_admin not in _dependency_calls(route.dependant)
    )
    assert not unguarded, (
        f"collaboration write routes missing require_admin: {unguarded}"
    )


def test_known_bridge_write_routes_are_present() -> None:
    """Guard against the check above passing vacuously if a route is renamed or
    dropped: the four writes we know about must still exist."""
    routes = {(frozenset(r.methods) & WRITE_METHODS, r.path) for r in router.routes}
    assert (frozenset({"POST"}), "") in routes  # create
    assert (frozenset({"POST"}), "/{bridge_id}/default") in routes  # set-default
    assert (frozenset({"PATCH"}), "/{bridge_id}") in routes  # update
    assert (frozenset({"DELETE"}), "/{bridge_id}") in routes  # delete


def test_every_collaboration_route_requires_authentication() -> None:
    """No route may fall back to the old unauthenticated behaviour: each must
    depend on get_current_user directly or via require_admin."""
    for route in router.routes:
        calls = _dependency_calls(route.dependant)
        assert get_current_user in calls or require_admin in calls, (
            f"{sorted(route.methods)} {route.path} is not authenticated"
        )


# ── 3. set-default behaviour ─────────────────────────────────────────────────


async def _make_bridge(session: AsyncSession, *, is_default: bool = False) -> str:
    client = Client(
        matrix_user_id=f"@bridge-{uuid.uuid4().hex[:12]}:test",
        display_name="bridge client",
        type="bridge",
        password="x",
    )
    session.add(client)
    await session.flush()
    bridge = CollaborationBridge(
        type="mattermost",
        display_name="MM",
        client_id=client.id,
        status="active",
        is_default=is_default,
    )
    session.add(bridge)
    await session.flush()
    return bridge.id


def _admin() -> User:
    return User(id="admin-1", name="admin", email="admin@test", role="admin")


class _NoRunningBridges:
    """Stands in for the lifecycle service, which the endpoint consults only to
    ask a live adapter for its workspace link. Nothing is running here, so it
    reports no adapter and the response carries no `home_url` — the same path a
    stopped bridge takes in production."""

    def get_adapter(self, bridge_id: str) -> None:
        return None


async def test_set_default_promotes_and_demotes(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        first = await _make_bridge(session, is_default=True)
        second = await _make_bridge(session, is_default=False)
        await session.commit()

    async with session_factory() as session:
        detail = await set_default_bridge(
            second,
            session,
            _BRIDGE_STORE,
            _ROOM_STORE,
            _NoRunningBridges(),  # type: ignore[arg-type]
            _admin(),
        )
        assert detail.bridge_id == second
        assert detail.is_default is True

    async with session_factory() as session:
        assert (await _BRIDGE_STORE.get(session, second)).is_default is True
        # The previous default was demoted — a single-default invariant holds.
        assert (await _BRIDGE_STORE.get(session, first)).is_default is False


async def test_set_default_unknown_bridge_is_404(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        with pytest.raises(HTTPException) as exc:
            await set_default_bridge(
                "does-not-exist",
                session,
                _BRIDGE_STORE,
                _ROOM_STORE,
                _NoRunningBridges(),  # type: ignore[arg-type]
                _admin(),
            )
        assert exc.value.status_code == 404
