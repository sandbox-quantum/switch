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
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.auth import PUBLIC_PATH_PREFIXES
from switch_core.bridges.collaboration.models import DirectoryUser
from switch_core.db.models import Client, CollaborationBridge, User
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.auth import get_current_user, require_admin
from switch_core.gateway.collaborations import (
    _require_directory_account,
    claim_bridge_identity,
    release_bridge_identity,
    router,
    set_default_bridge,
)
from switch_core.gateway.schemas import ClaimIdentityRequest

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

# Identity claiming (CHOO-2137) is the one collaboration write with an owner to
# scope to: the row it mutates is a link between a platform account and one
# Switch user, not part of the bridge itself, and a user must be able to claim
# their own without an admin. These routes carry a self-or-admin check inside
# the handler instead — asserted by
# `test_owner_scoped_identity_routes_check_self_or_admin` below, so the
# exemption cannot hide an unauthorized route.
_OWNER_SCOPED_PATHS = {
    "/{bridge_id}/identities",
    "/{bridge_id}/identities/{external_user_row_id}",
}


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
        and route.path not in _OWNER_SCOPED_PATHS
        and require_admin not in _dependency_calls(route.dependant)
    )
    assert not unguarded, (
        f"collaboration write routes missing require_admin: {unguarded}"
    )


def test_owner_scoped_exemptions_name_real_routes() -> None:
    """Guard the exemption list itself: a path that no longer exists would
    silently excuse nothing, or worse, a renamed route."""
    paths = {route.path for route in router.routes}
    assert _OWNER_SCOPED_PATHS <= paths


class TestIdentityRoutesAreSelfOrAdmin:
    """The check the require_admin exemption trades away moved into the
    handler; it did not disappear."""

    async def test_claiming_for_another_user_is_refused(self) -> None:
        with pytest.raises(HTTPException) as excinfo:
            await claim_bridge_identity(
                bridge_id="b1",
                payload=ClaimIdentityRequest(
                    external_user_id="U123",
                    username="them",
                    user_id="someone-else",
                ),
                session=object(),  # type: ignore[arg-type]
                bridge_store=_StubGet(object()),  # type: ignore[arg-type]
                external_user_store=_StubGet(None),  # type: ignore[arg-type]
                user_store=_StubGet(None),  # type: ignore[arg-type]
                collab_lifecycle=object(),  # type: ignore[arg-type]
                user=_user(id="me", role="user"),
            )
        assert excinfo.value.status_code == 403

    async def test_releasing_another_users_claim_is_refused(self) -> None:
        # Releasing names the claimant to drop; anyone else's claim on the same
        # account is not the caller's to touch.
        theirs = SimpleNamespace(id="ext-1", bridge_id="b1")
        with pytest.raises(HTTPException) as excinfo:
            await release_bridge_identity(
                bridge_id="b1",
                external_user_row_id="ext-1",
                session=object(),  # type: ignore[arg-type]
                external_user_store=_StubGet(theirs),  # type: ignore[arg-type]
                user_store=_StubGet(None),  # type: ignore[arg-type]
                user=_user(id="me", role="user"),
                user_id="someone-else",
            )
        assert excinfo.value.status_code == 403


class TestProvisioningNeedsARealAccount:
    """Claiming an account Switch has not seen mints a Matrix puppet, and the
    id comes from the request body. Anyone signed in may claim any *real*
    account — that is the point of non-exclusive claims — but conjuring rows
    for ids the platform has never heard of is a different thing."""

    async def test_account_in_the_directory_is_accepted(self) -> None:
        await _require_directory_account(
            _StubLifecycle([_directory_user("U123")]),
            bridge_id="b1",
            external_user_id="U123",
            username="someone",
        )

    async def test_invented_id_is_refused(self) -> None:
        with pytest.raises(HTTPException) as excinfo:
            await _require_directory_account(
                _StubLifecycle([_directory_user("U-real")]),
                bridge_id="b1",
                external_user_id="U-invented",
                username="someone",
            )
        assert excinfo.value.status_code == 404

    async def test_platform_without_a_directory_is_refused(self) -> None:
        # Nothing can be checked, so the person has to be seen speaking first
        # rather than have a puppet minted on their behalf.
        with pytest.raises(HTTPException) as excinfo:
            await _require_directory_account(
                _StubLifecycle(NotImplementedError("no searchable directory")),
                bridge_id="b1",
                external_user_id="U123",
                username="someone",
            )
        assert excinfo.value.status_code == 501

    async def test_stopped_bridge_is_refused(self) -> None:
        with pytest.raises(HTTPException) as excinfo:
            await _require_directory_account(
                _StubLifecycle(None),
                bridge_id="b1",
                external_user_id="U123",
                username="someone",
            )
        assert excinfo.value.status_code == 409


def _directory_user(external_user_id: str) -> DirectoryUser:
    return DirectoryUser(
        external_user_id=external_user_id,
        username="someone",
        display_name="Someone",
        email=None,
    )


class _StubLifecycle:
    """Holds an adapter that returns the given directory results, raises the
    given error, or is absent entirely (a stopped bridge)."""

    def __init__(self, result: list[DirectoryUser] | Exception | None) -> None:
        self._result = result

    def get_adapter(self, _bridge_id: str) -> object | None:
        return None if self._result is None else self

    async def search_directory_users(self, _query: str) -> list[DirectoryUser]:
        if isinstance(self._result, Exception):
            raise self._result
        assert self._result is not None
        return self._result


class _StubGet:
    def __init__(self, value: object) -> None:
        self._value = value

    async def get(self, *_args: object, **_kwargs: object) -> object:
        return self._value


def _user(*, id: str, role: str) -> SimpleNamespace:
    return SimpleNamespace(id=id, role=role, name=id)


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

    def supports_channel_creation(self, bridge_type: str) -> bool:
        """Answered from the registered adapter class in production, so it holds
        for a stopped bridge — which is the whole point of it not coming from a
        live adapter."""
        return True

    def supports_directory_search(self, bridge_type: str) -> bool:
        """Read from the adapter class for the same reason."""
        return True


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
