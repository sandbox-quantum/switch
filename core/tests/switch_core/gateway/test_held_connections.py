"""No gateway request holds two pooled connections at once (CHOO-3198).

A request that keeps its first connection while it waits for a second one from
the same pool is the shape that starves the pool under load: every connection
ends up held by a request waiting for another, nobody can give one back, and
after the pool timeout they all fail together. The same goes for a connection
held while the request waits on something that is not the database at all: a
messaging platform, Matrix, or bcrypt.

These drive the real routes through the real authentication and admin
dependencies, against real Postgres, and count connections where every path
meets: the pool (`tests/switch_core/pool_checkouts.py`). Two contracts:

- no request ever holds more than one connection at a time;
- every platform call, Matrix call and bcrypt call happens holding none, and
  bcrypt runs off the event loop.
"""

from __future__ import annotations

import secrets
import threading
from collections.abc import AsyncIterator, Callable
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest
from fastapi import Depends, FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    ApiKey,
    Client,
    CollaborationBridge,
    Room,
    TenantMember,
    User,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import auth as gateway_auth
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.agents import router as agents_router
from switch_core.gateway.auth import (
    create_jwt,
    get_current_user,
    get_tenant_is_admin,
    hash_password,
)
from switch_core.gateway.auth_routes import router as auth_router
from switch_core.gateway.collaborations import router as bridges_router
from switch_core.gateway.hosted_machines import hosted_settings
from switch_core.gateway.rooms import router as rooms_router
from switch_core.keys import Keyring
from switch_core.room_service import RoomService
from tests.switch_core.pool_checkouts import PoolCheckouts

# Made for each run, so nothing secret-looking is committed.
_SECRET = secrets.token_hex(32)
_KEYRING = Keyring.parse("test:" + _SECRET, legacy_secret=None)
_PASSWORD = secrets.token_urlsafe(16)


class _Calls:
    """What the fakes below were asked, with the connections held at the time."""

    def __init__(self, tracker: PoolCheckouts) -> None:
        self._tracker = tracker
        self.held: list[tuple[str, int]] = []

    def record(self, what: str) -> None:
        self.held.append((what, self._tracker.held_now()))


class _Provisioning:
    """Matrix, as `RoomService` sees it."""

    def __init__(self, calls: _Calls) -> None:
        self._calls = calls

    async def invite_to_room(self, transport_room_id: str, user_id: str) -> None:
        self._calls.record("matrix invite")

    async def kick_user(self, transport_room_id: str, user_id: str) -> None:
        self._calls.record("matrix kick")

    async def delete_room(self, transport_room_id: str) -> None:
        self._calls.record("matrix delete")


class _RunningClients:
    def __init__(self, by_agent: dict[str, Any]) -> None:
        self._by_agent = by_agent

    def get_by_agent_id(self, agent_id: str) -> Any:
        return self._by_agent.get(agent_id)

    def get(self, client_id: str) -> Any:
        return next(
            (c for c in self._by_agent.values() if c.client_id == client_id), None
        )

    def get_by_type(self, client_type: str, tenant_id: str) -> list[Any]:
        return []


class _Adapter:
    """A messaging platform's adapter: every call is a network round trip."""

    def __init__(self, calls: _Calls) -> None:
        self._calls = calls

    async def search_directory_users(self, query: str) -> list[Any]:
        self._calls.record("platform directory search")
        return [
            SimpleNamespace(
                external_user_id="U1",
                username=query,
                display_name=query,
                email=None,
            )
        ]

    async def home_deeplink(self) -> str | None:
        return None

    async def install_links(self) -> list[Any]:
        return []

    async def install_note(self) -> str | None:
        return None

    places_app_in_teams = False

    async def attention(self) -> str | None:
        return None

    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        self._calls.record("platform channel deeplink")
        return None

    def channel_ids_refused(self) -> str | None:
        return None


class _CollabLifecycle:
    def __init__(self, calls: _Calls) -> None:
        self._calls = calls
        self.calls = calls
        self._adapter = _Adapter(calls)

    def get_adapter(self, bridge_id: str) -> _Adapter:
        return self._adapter

    def get(self, bridge_id: str) -> Any:
        async def ensure_external_user(**_: Any) -> Any:
            self._calls.record("provision external user")
            raise ValueError("refused by the test")

        return SimpleNamespace(ensure_external_user=ensure_external_user)

    def supports_channel_creation(self, bridge_type: str) -> bool:
        return True

    def supports_directory_search(self, bridge_type: str) -> bool:
        return True

    async def check_edited_connection_config(self, **_: Any) -> None:
        self._calls.record("platform credential check")

    async def check_start_guards(self, **_: Any) -> None:
        self._calls.record("start guards")

    def editable_config_keys(
        self, bridge_type: str, connection_config: dict[str, object]
    ) -> frozenset[str] | None:
        return None

    async def check_config_edit(self, **_: Any) -> None:
        self._calls.record("platform edit check")

    async def restart(self, bridge_id: str) -> None:
        self._calls.record("bridge restart")

    def note_preconfigured(self, bridge_id: str, value: bool) -> None:
        pass

    async def remove(self, bridge_id: str) -> None:
        self._calls.record("bridge remove")


class _Protocol:
    """The parts of `AgentCore` the routes under test reach.

    `delete_agent` does what the real one does to the pool: opens a session of
    its own, then calls out to every bridge.
    """

    def __init__(
        self, calls: _Calls, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        self.room_role_store = RoomRoleStore()
        self.agent_store = AgentStore()
        self.connections = SimpleNamespace(live_connection_ids=lambda: set())
        self._calls = calls
        self._session_factory = session_factory

    async def delete_agent(
        self, *, agent_id: str | None = None, agent_name: str | None = None
    ) -> None:
        async with self._session_factory() as session:
            await AgentStore().get(session, agent_id or "")
        self._calls.record("bridge identity removal")

    async def get_agent_statuses_by_ids_in_session(
        self, session: AsyncSession, room_id: str, agent_ids: list[str]
    ) -> dict[str, Any]:
        return {}


def _config() -> SimpleNamespace:
    return SimpleNamespace(
        keyring=_KEYRING,
        gateway_cookie_secure=False,
        gateway_tenant_choice_enabled=False,
        gateway_password_login_enabled=True,
        gateway_signup_open=True,
        gateway_signup_max_per_hour=100,
    )


def _app(
    session_factory: async_sessionmaker[AsyncSession],
    tracker: PoolCheckouts,
    *,
    room_service: RoomService,
    collab: _CollabLifecycle,
    extra: Callable[[FastAPI], None] | None = None,
) -> Any:
    calls = collab.calls

    async def _session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(rooms_router, prefix="/rooms")
    app.include_router(bridges_router, prefix="/bridges")
    app.include_router(auth_router)
    app.include_router(agents_router, prefix="/agents")
    if extra is not None:
        extra(app)
    overrides: dict[Callable[..., Any], Callable[..., Any]] = {
        gw_deps.get_session: _session,
        gw_deps.get_system_session: _session,
        gw_deps.get_session_factory: lambda: session_factory,
        gw_deps.get_user_store: UserStore,
        gw_deps.get_room_store: RoomStore,
        gw_deps.get_bridge_store: CollaborationBridgeStore,
        gw_deps.get_external_user_store: ExternalUserStore,
        gw_deps.get_room_service: lambda: room_service,
        gw_deps.get_collab_lifecycle: lambda: collab,
        gw_deps.get_protocol: lambda: _Protocol(calls, session_factory),
        gw_deps.get_agent_store: AgentStore,
        gw_deps.get_config: _config,
        hosted_settings: lambda: None,
    }
    app.dependency_overrides.update(overrides)
    return tracker.wrap(app)


def _client(app: Any, user: User) -> httpx.AsyncClient:
    token = create_jwt(user.id, user.email, user.role, _KEYRING, TENANT_ZERO_ID)
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        cookies={"switch_auth": token},
    )


async def _admin(session_factory: async_sessionmaker[AsyncSession]) -> User:
    """A workspace owner: a plain user whose admin bit comes from membership,
    so `get_tenant_is_admin` has to read it."""
    async with session_factory() as session:
        user = User(
            name="owner",
            email="owner@example.com",
            role="user",
            password_hash=hash_password(_PASSWORD),
        )
        session.add(user)
        await session.flush()
        session.add(
            TenantMember(tenant_id=TENANT_ZERO_ID, user_id=user.id, role="owner")
        )
        await session.commit()
        return user


async def _agent(session: AsyncSession, owner: User, name: str) -> tuple[Agent, Any]:
    key = ApiKey(
        user_id=owner.id,
        key_hash=f"hash-{name}",
        encrypted_key="enc",
        label=name,
        type="agent",
    )
    client = Client(transport_user_id=f"@{name}:test", display_name=name, type="agent")
    session.add_all([key, client])
    await session.flush()
    agent = Agent(
        name=name,
        description="d",
        agent_type="session_addressable",
        connector_type="claude_code",
        integration_profile={},
        client_id=client.id,
        api_key_id=key.id,
        owner_id=owner.id,
    )
    session.add(agent)
    await session.flush()
    running = SimpleNamespace(
        client_id=client.id, transport_user_id=client.transport_user_id
    )
    return agent, running


async def _room(session: AsyncSession, owner: User, name: str) -> Room:
    room = Room(
        transport_room_id=f"!{name}:test",
        name=name,
        description="d",
        owner_id=owner.id,
    )
    session.add(room)
    await session.flush()
    return room


def _room_service(
    session_factory: async_sessionmaker[AsyncSession],
    calls: _Calls,
    collab: _CollabLifecycle,
    running: dict[str, Any],
) -> RoomService:
    return RoomService(
        provisioning=_Provisioning(calls),  # type: ignore[arg-type]
        room_store=RoomStore(),
        agent_store=AgentStore(),
        client_lifecycle=_RunningClients(running),  # type: ignore[arg-type]
        collab_lifecycle=collab,  # type: ignore[arg-type]
        collab_bridge_store=CollaborationBridgeStore(),
        resource_service=None,  # type: ignore[arg-type]
        session_factory=session_factory,
        room_cache=MagicMock(),
    )


def _assert_one_at_a_time(tracker: PoolCheckouts, calls: _Calls) -> None:
    assert tracker.scopes, "no request was counted; the tracker is not wired"
    assert [(s.label, s.peak) for s in tracker.over()] == []
    assert [(what, held) for what, held in calls.held if held] == []


class TestTheGuardItself:
    async def test_it_catches_a_request_that_takes_a_second_connection(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        pool_checkouts: PoolCheckouts,
    ) -> None:
        # The shape this whole file exists to forbid, written out on purpose:
        # read on the request's session, then open another before committing.
        # If this stops reporting 2, every other assertion here is vacuous.
        user = await _admin(session_factory)
        calls = _Calls(pool_checkouts)
        collab = _CollabLifecycle(calls)

        def held_and_wait(app: FastAPI) -> None:
            @app.get("/held-and-wait")
            async def held_and_wait(
                session: AsyncSession = Depends(gw_deps.get_session),
                _user: User = Depends(get_current_user),
                _is_admin: bool = Depends(get_tenant_is_admin),
            ) -> dict[str, bool]:
                await RoomStore().get(session, "nothing")
                async with session_factory() as other:
                    await RoomStore().get(other, "nothing")
                return {"ok": True}

        app = _app(
            session_factory,
            pool_checkouts,
            room_service=_room_service(session_factory, calls, collab, {}),
            collab=collab,
            extra=held_and_wait,
        )
        async with _client(app, user) as client:
            assert (await client.get("/held-and-wait")).status_code == 200

        assert [(s.label, s.peak) for s in pool_checkouts.over()] == [
            ("GET /held-and-wait", 2)
        ]


class TestRoomRoutes:
    async def test_room_writes_hold_one_connection_at_a_time(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        pool_checkouts: PoolCheckouts,
    ) -> None:
        user = await _admin(session_factory)
        async with session_factory() as session:
            room = await _room(session, user, "main")
            doomed = await _room(session, user, "doomed")
            bulk = await _room(session, user, "bulk")
            agent, running = await _agent(session, user, "helper")
            await session.commit()
        calls = _Calls(pool_checkouts)
        collab = _CollabLifecycle(calls)
        app = _app(
            session_factory,
            pool_checkouts,
            room_service=_room_service(
                session_factory, calls, collab, {agent.id: running}
            ),
            collab=collab,
        )

        async with _client(app, user) as client:
            responses = [
                await client.patch(f"/rooms/{room.id}", json={"name": "renamed"}),
                await client.put(
                    f"/rooms/{room.id}/protection", json={"protection_config": {}}
                ),
                await client.put(
                    f"/rooms/{room.id}/observe", json={"observe_config": {}}
                ),
                await client.post(
                    f"/rooms/{room.id}/agents", json={"agent_ids": [agent.id]}
                ),
                await client.patch(
                    f"/rooms/{room.id}/agents/{agent.id}",
                    json={"receives_join_events": True},
                ),
                await client.delete(f"/rooms/{room.id}/agents/{agent.id}"),
                await client.post(f"/rooms/{room.id}/archive"),
                await client.post(f"/rooms/{room.id}/unarchive"),
                await client.get(f"/rooms/{room.id}"),
                await client.post(
                    "/rooms/bulk-archive",
                    json={"room_ids": [bulk.id], "archived": True},
                ),
                await client.delete(f"/rooms/{doomed.id}"),
                await client.post("/rooms/bulk-delete", json={"room_ids": [bulk.id]}),
            ]

        assert [r.status_code for r in responses] == [200] * len(responses), [
            r.text for r in responses if r.status_code != 200
        ]
        # The Matrix side was really reached, so "held nothing" means something.
        assert {what for what, _ in calls.held} >= {
            "matrix invite",
            "matrix kick",
            "matrix delete",
        }
        _assert_one_at_a_time(pool_checkouts, calls)


class TestAgentRoutes:
    async def test_deleting_an_agent_holds_one_connection_at_a_time(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        pool_checkouts: PoolCheckouts,
    ) -> None:
        user = await _admin(session_factory)
        async with session_factory() as session:
            by_id, _ = await _agent(session, user, "by-id")
            await _agent(session, user, "by-name")
            await session.commit()
        calls = _Calls(pool_checkouts)
        collab = _CollabLifecycle(calls)
        app = _app(
            session_factory,
            pool_checkouts,
            room_service=_room_service(session_factory, calls, collab, {}),
            collab=collab,
        )

        async with _client(app, user) as client:
            responses = [
                await client.delete(f"/agents/{by_id.id}"),
                await client.delete("/agents/by-name/by-name"),
            ]

        assert [r.status_code for r in responses] == [200, 200]
        assert [what for what, _ in calls.held] == ["bridge identity removal"] * 2
        _assert_one_at_a_time(pool_checkouts, calls)


class TestBridgeRoutes:
    async def _bridge(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> CollaborationBridge:
        async with session_factory() as session:
            client = Client(
                transport_user_id="@bridge:test", display_name="bridge", type="bridge"
            )
            session.add(client)
            await session.flush()
            bridge = CollaborationBridge(
                type="slack",
                display_name="Slack",
                connection_config={"bot_token": "xoxb-old"},
                client_id=client.id,
                status="running",
            )
            session.add(bridge)
            await session.commit()
            return bridge

    async def test_platform_calls_are_made_holding_no_connection(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        pool_checkouts: PoolCheckouts,
    ) -> None:
        user = await _admin(session_factory)
        bridge = await self._bridge(session_factory)
        calls = _Calls(pool_checkouts)
        collab = _CollabLifecycle(calls)
        app = _app(
            session_factory,
            pool_checkouts,
            room_service=_room_service(session_factory, calls, collab, {}),
            collab=collab,
        )

        async with _client(app, user) as client:
            edited = await client.patch(
                f"/bridges/{bridge.id}",
                json={
                    "agent_greetings_enabled": False,
                    "connection_config": {"bot_token": "xoxb-new"},
                },
            )
            searched = await client.get(
                f"/bridges/{bridge.id}/directory", params={"query": "ada"}
            )
            claimed = await client.post(
                f"/bridges/{bridge.id}/identities",
                json={"external_user_id": "U1", "username": "ada"},
            )
            deleted = await client.delete(f"/bridges/{bridge.id}")

        assert edited.status_code == 200, edited.text
        assert searched.status_code == 200, searched.text
        # The fake refuses to provision, so the claim stops at 409 — after the
        # directory search and the provisioning attempt, which is what counts.
        assert claimed.status_code == 409, claimed.text
        assert deleted.status_code == 200, deleted.text
        assert [what for what, _ in calls.held] == [
            "platform credential check",
            "start guards",
            "platform edit check",
            "bridge restart",
            "platform directory search",
            "platform directory search",
            "provision external user",
            "bridge remove",
        ]
        _assert_one_at_a_time(pool_checkouts, calls)

    async def test_a_refused_credential_edit_writes_nothing(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        pool_checkouts: PoolCheckouts,
    ) -> None:
        # The credential check now runs after the read's transaction ends, so
        # the writes that used to precede it inside that transaction moved after
        # it. A refusal must still leave every field as it was.
        from switch_core.bridges.collaboration.models import BridgeCredentialError

        user = await _admin(session_factory)
        bridge = await self._bridge(session_factory)
        calls = _Calls(pool_checkouts)
        collab = _CollabLifecycle(calls)

        async def refuse(**_: Any) -> None:
            raise BridgeCredentialError("invalid_auth")

        collab.check_edited_connection_config = refuse  # type: ignore[method-assign]
        app = _app(
            session_factory,
            pool_checkouts,
            room_service=_room_service(session_factory, calls, collab, {}),
            collab=collab,
        )

        async with _client(app, user) as client:
            response = await client.patch(
                f"/bridges/{bridge.id}",
                json={
                    "agent_greetings_enabled": False,
                    "connection_config": {"bot_token": "xoxb-bad"},
                },
            )

        assert response.status_code == 400
        async with session_factory() as session:
            stored = await CollaborationBridgeStore().get(session, bridge.id)
        assert stored is not None
        assert stored.agent_greetings_enabled is bridge.agent_greetings_enabled
        assert stored.connection_config == {"bot_token": "xoxb-old"}


class TestPasswordRoutes:
    @pytest.fixture
    def bcrypt_calls(
        self, monkeypatch: pytest.MonkeyPatch, pool_checkouts: PoolCheckouts
    ) -> list[tuple[str, bool, int]]:
        """Each bcrypt call: which, whether it ran on the event loop's thread,
        and the connections the request held at the time."""
        seen: list[tuple[str, bool, int]] = []
        real_hash = gateway_auth.hash_password
        real_verify = gateway_auth.verify_password

        def on_loop() -> bool:
            return threading.current_thread() is threading.main_thread()

        def hash_password(password: str) -> str:
            seen.append(("hash", on_loop(), pool_checkouts.held_now()))
            return real_hash(password)

        def verify_password(password: str, password_hash: str | None) -> bool:
            seen.append(("verify", on_loop(), pool_checkouts.held_now()))
            return real_verify(password, password_hash)

        monkeypatch.setattr(gateway_auth, "hash_password", hash_password)
        monkeypatch.setattr(gateway_auth, "verify_password", verify_password)
        return seen

    async def test_bcrypt_runs_off_the_loop_holding_no_connection(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        pool_checkouts: PoolCheckouts,
        bcrypt_calls: list[tuple[str, bool, int]],
    ) -> None:
        user = await _admin(session_factory)
        async with session_factory() as session:
            operator = User(name="op", email="op@example.com", role="admin")
            session.add(operator)
            await session.flush()
            session.add(
                TenantMember(
                    tenant_id=TENANT_ZERO_ID, user_id=operator.id, role="member"
                )
            )
            await session.commit()
        calls = _Calls(pool_checkouts)
        collab = _CollabLifecycle(calls)
        app = _app(
            session_factory,
            pool_checkouts,
            room_service=_room_service(session_factory, calls, collab, {}),
            collab=collab,
        )

        async with _client(app, user) as client:
            login = await client.post(
                "/auth/login", json={"email": user.email, "password": _PASSWORD}
            )
            wrong = await client.post(
                "/auth/login", json={"email": user.email, "password": "nope-nope"}
            )
            changed = await client.put(
                "/auth/me/password",
                json={"current_password": _PASSWORD, "new_password": "a new one!"},
            )
            signed_up = await client.post(
                "/auth/signup",
                json={"email": "new@example.com", "password": "a password!"},
            )
        async with _client(app, operator) as client:
            created = await client.post(
                "/users",
                json={
                    "name": "made",
                    "email": "made@example.com",
                    "password": "a password!",
                    "role": "user",
                },
            )

        assert login.status_code == 200, login.text
        assert wrong.status_code == 401, wrong.text
        assert changed.status_code == 200, changed.text
        assert signed_up.status_code == 201, signed_up.text
        assert created.status_code == 200, created.text
        assert bcrypt_calls == [
            ("verify", False, 0),
            ("verify", False, 0),
            ("verify", False, 0),
            ("hash", False, 0),
            ("hash", False, 0),
            ("hash", False, 0),
        ]
        _assert_one_at_a_time(pool_checkouts, calls)
