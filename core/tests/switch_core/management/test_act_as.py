"""A controller acting as the agents bound to it, and nothing else getting in.

The bearer middleware accepts a controller access token on the agent routes
for an agent bound to that controller now, and refuses it otherwise with
`not_assigned`; a controller-backed agent's own credential is refused with
`managed_by_controller`. Operations take the caller's room from
`X-Switch-Room-Id`. Against Postgres, through the real middleware.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from collections.abc import Iterator
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.auth import BearerAuthMiddleware, ControllerPrincipal
from switch_core.bridges.agent.operations import context as op_context
from switch_core.bridges.agent.operations import registry
from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    CallerSession,
    call_context,
)
from switch_core.bridges.agent.operations.definitions import connect_to_room
from switch_core.bridges.agent.protocol.agent_connections import ClientDeclaration
from switch_core.bridges.agent.protocol.controller_presence import Binding
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    AgentSession,
    ApiKey,
    Client,
    User,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.tenant_context import current_tenant_id
from tests.switch_core.management.harness import (
    EnrolledController,
    Harness,
    add_member,
    add_room,
    bearer,
    build_harness,
    cookies_for,
    definition,
    enroll_console,
    place_agent,
    provider,
    report_status,
)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


async def _agent_with_key(harness: Harness, owner: User, name: str) -> tuple[str, str]:
    """An agent with a real API key. Returns its id and the key."""
    key = secrets.token_urlsafe(32)
    async with harness.session_factory() as session:
        client = Client(
            type="agent", transport_user_id=f"@{name}:test", display_name=name
        )
        api_key = ApiKey(
            type="agent",
            key_hash=hashlib.sha256(key.encode()).hexdigest(),
            encrypted_key="",
            label=name,
            user_id=owner.id,
        )
        session.add_all([client, api_key])
        await session.flush()
        agent = Agent(
            name=name,
            description=f"{name} desc",
            agent_type="auto_session",
            connector_type="claude_code",
            integration_profile={"connection_model": "auto_session"},
            client_id=client.id,
            api_key_id=api_key.id,
            owner_id=owner.id,
        )
        session.add(agent)
        await session.commit()
        return agent.id, key


async def _adopt(
    harness: Harness, owner: User, controller: EnrolledController, agent_id: str
) -> None:
    async with harness.client() as client:
        await report_status(client, controller, 1, providers=[provider("claude")])
        adopted = await client.put(
            f"/gateway/management/agents/{agent_id}",
            json={
                "controller_id": controller.controller_id,
                "desired_state": "running",
                "definition": definition(),
            },
            cookies=cookies_for(owner),
        )
    assert adopted.status_code == 200, adopted.text


def _middleware(harness: Harness) -> tuple[BearerAuthMiddleware, dict[str, Any]]:
    captured: dict[str, Any] = {}

    async def _app(scope: Any, receive: Any, send: Any) -> None:
        captured["tenant_id"] = current_tenant_id()
        captured["agent"] = scope.get("agent")
        captured["controller"] = scope.get("controller")
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    mw = BearerAuthMiddleware(
        _app,
        agent_store=AgentStore(),
        api_key_store=ApiKeyStore(),
        api_key_cache=harness.cache,
        session_factory=harness.session_factory,
        controller_auth=harness.management.authenticator,
    )
    return mw, captured


async def _dispatch(
    mw: BearerAuthMiddleware,
    path: str,
    token: str,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, Any] | None]:
    async def receive() -> dict[str, Any]:
        return {"type": "http.request"}

    sent: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    raw = [(b"authorization", f"Bearer {token}".encode())]
    raw += [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    await mw({"type": "http", "path": path, "headers": raw}, receive, send)
    body = b"".join(m.get("body", b"") for m in sent[1:])
    return sent[0]["status"], (json.loads(body) if body else None)


def _code(result: tuple[int, dict[str, Any] | None]) -> tuple[int, str | None]:
    status, body = result
    return status, (body or {}).get("error", {}).get("code")


class TestTheAuthorizationMatrix:
    async def test_a_bound_agent_is_acted_as(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
        mw, captured = _middleware(harness)

        result = await _dispatch(mw, f"/agents/{agent_id}/ops", controller.access_token)

        assert result == (200, None)
        assert captured["agent"].id == agent_id
        assert captured["controller"] == ControllerPrincipal(
            controller_id=controller.controller_id,
            owner_id=owner.id,
            tenant_id=TENANT_ZERO_ID,
        )
        assert captured["tenant_id"] == TENANT_ZERO_ID
        # A controller token never becomes an agent key's cached answer.
        token_hash = hashlib.sha256(controller.access_token.encode()).hexdigest()
        assert harness.cache.get(token_hash) is None

    async def test_an_unmanaged_agent_is_not_assigned(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, _ = await _agent_with_key(harness, owner, "loose")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
        mw, _ = _middleware(harness)

        result = await _dispatch(
            mw, f"/agents/{agent_id}/message", controller.access_token
        )
        assert _code(result) == (403, "not_assigned")

    async def test_another_controllers_agent_is_not_assigned(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            mine = await enroll_console(harness, client, owner, "mine")
            theirs = await enroll_console(harness, client, owner, "theirs")
            agent_id = await place_agent(client, theirs, name="theirs-agent")
        mw, _ = _middleware(harness)

        result = await _dispatch(mw, f"/agents/{agent_id}/ops", mine.access_token)
        assert _code(result) == (403, "not_assigned")

    async def test_a_binding_in_another_tenant_is_not_assigned(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
        presence = harness.protocol.connections.controllers
        presence.bind(
            Binding(
                agent_id=agent_id,
                controller_id=controller.controller_id,
                tenant_id="another-tenant",
                auto_session=True,
                controller_name="machine",
                running=True,
            )
        )
        mw, _ = _middleware(harness)

        result = await _dispatch(mw, f"/agents/{agent_id}/ops", controller.access_token)
        assert _code(result) == (403, "not_assigned")

    async def test_a_revoked_controller_is_refused(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            await client.delete(
                f"/gateway/management/controllers/{controller.controller_id}",
                cookies=cookies_for(owner),
            )
        mw, _ = _middleware(harness)

        result = await _dispatch(mw, f"/agents/{agent_id}/ops", controller.access_token)
        assert _code(result) == (401, "controller_revoked")

    async def test_a_header_disagreeing_with_the_path_is_refused(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            first = await place_agent(client, controller, name="first")
            second = await place_agent(client, controller, name="second")
        mw, _ = _middleware(harness)

        disagree = await _dispatch(
            mw,
            f"/agents/{first}/ops",
            controller.access_token,
            {"X-Switch-Agent-Id": second},
        )
        agree = await _dispatch(
            mw,
            f"/agents/{first}/ops",
            controller.access_token,
            {"X-Switch-Agent-Id": first},
        )
        assert _code(disagree) == (400, "validation_error")
        assert agree == (200, None)

    async def test_agent_sessions_take_the_agent_from_the_header(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
        mw, captured = _middleware(harness)
        path = "/agent-sessions/session-1/started"

        named = await _dispatch(
            mw, path, controller.access_token, {"X-Switch-Agent-Id": agent_id}
        )
        agent = captured["agent"]
        unnamed = await _dispatch(mw, path, controller.access_token)
        participants = await _dispatch(
            mw,
            "/agents/rooms/some-room/participants",
            controller.access_token,
            {"X-Switch-Agent-Id": agent_id},
        )

        assert named == (200, None)
        assert agent.id == agent_id
        assert _code(unnamed) == (400, "validation_error")
        assert participants == (200, None)

    async def test_the_connection_surface_is_the_controller_streams(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
        mw, _ = _middleware(harness)

        for suffix in (
            "events",
            "notifications",
            "rooms/r/events",
            "connection/beat",
            "connection/placements",
            "connection/renew",
            "watch/heartbeat",
        ):
            result = await _dispatch(
                mw, f"/agents/{agent_id}/{suffix}", controller.access_token
            )
            assert _code(result) == (409, "managed_by_controller"), suffix
        for suffix in ("message", "rooms/r/media", "rooms/r/history", "leases/renew"):
            assert await _dispatch(
                mw, f"/agents/{agent_id}/{suffix}", controller.access_token
            ) == (200, None), suffix

    async def test_registration_and_other_routes_refuse_a_controller_token(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
        mw, _ = _middleware(harness)

        for path in ("/agents", "/agents/register-known", "/mcp/", "/version"):
            result = await _dispatch(mw, path, controller.access_token)
            assert _code(result) == (403, "forbidden"), path


class TestTheAgentsOwnCredential:
    async def test_is_refused_while_the_agent_is_controller_backed(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, key = await _agent_with_key(harness, owner, "adopted")
        mw, captured = _middleware(harness)
        before = await _dispatch(mw, f"/agents/{agent_id}/events", key)
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
        await _adopt(harness, owner, controller, agent_id)

        events = await _dispatch(mw, f"/agents/{agent_id}/events", key)
        message = await _dispatch(mw, f"/agents/{agent_id}/message", key)
        mcp = await _dispatch(mw, "/mcp/", key)
        async with harness.client() as client:
            removed = await client.delete(
                f"/gateway/management/agents/{agent_id}", cookies=cookies_for(owner)
            )
        after = await _dispatch(mw, f"/agents/{agent_id}/events", key)

        assert before == (200, None)
        assert _code(events) == (409, "managed_by_controller")
        assert _code(message) == (409, "managed_by_controller")
        assert _code(mcp) == (409, "managed_by_controller")
        assert removed.status_code == 200, removed.text
        assert after == (200, None)
        assert captured["agent"].id == agent_id

    async def test_binding_closes_the_connections_it_held(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, _ = await _agent_with_key(harness, owner, "adopted")
        registry_ = harness.protocol.connections
        conn = registry_.open(
            agent_id=agent_id,
            connection_id="watcher",
            scope="all",
            delivery_filter="all",
            spawn_capable=True,
            cursor=0,
            declaration=ClientDeclaration(),
            expected_generation=None,
        )
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
        await _adopt(harness, owner, controller, agent_id)

        assert registry_.get("watcher") is None
        assert conn.closure is not None and conn.closure.code == "closed"

    async def test_with_the_flag_off_nothing_is_refused(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, key = await _agent_with_key(harness, owner, "plain")
        harness.protocol.connections.controllers.bind(
            Binding(
                agent_id=agent_id,
                controller_id="c",
                tenant_id=TENANT_ZERO_ID,
                auto_session=True,
                controller_name="machine",
                running=True,
            )
        )
        captured: dict[str, Any] = {}

        async def _app(scope: Any, receive: Any, send: Any) -> None:
            captured["agent"] = scope.get("agent")
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b""})

        mw = BearerAuthMiddleware(
            _app,
            agent_store=AgentStore(),
            api_key_store=ApiKeyStore(),
            api_key_cache=harness.cache,
            session_factory=harness.session_factory,
        )
        assert await _dispatch(mw, f"/agents/{agent_id}/events", key) == (200, None)
        assert captured["agent"].id == agent_id


@pytest.fixture
def recorded_op(harness: Harness) -> Iterator[dict[str, Any]]:
    """An operation that reports the caller context it was given."""
    seen: dict[str, Any] = {}

    async def where_am_i() -> dict[str, Any]:
        seen["session_key"] = op_context.session_key()
        seen["reader"] = op_context.counting_reader()
        return {"room_id": await op_context.require_connected_room()}

    registry._REGISTRY["where_am_i"] = registry.Operation(
        name="where_am_i",
        fn=where_am_i,
        description="test",
        input_schema=registry._input_schema(where_am_i),
    )
    previous = op_context._protocol
    op_context.init_operations_protocol(harness.protocol)
    try:
        yield seen
    finally:
        registry._REGISTRY.pop("where_am_i", None)
        op_context._protocol = previous


class TestOperationsTakeTheRoomFromTheHeader:
    async def test_member_non_member_and_missing(
        self, harness: Harness, recorded_op: dict[str, Any]
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            member_room = await add_room(harness.session_factory, agent_id)
            other_room = await add_room(harness.session_factory, name="elsewhere")
            path = f"/agents/{agent_id}/ops/where_am_i"
            member = await client.post(
                path,
                json={},
                headers={
                    **controller.headers,
                    "X-Switch-Room-Id": member_room,
                    # Names the controller's local relay, not anything here.
                    "X-Switch-Connection-Id": "local-relay-connection",
                },
            )
            seen = dict(recorded_op)
            non_member = await client.post(
                path,
                json={},
                headers={**controller.headers, "X-Switch-Room-Id": other_room},
            )
            unknown = await client.post(
                path,
                json={},
                headers={**controller.headers, "X-Switch-Room-Id": "no-such-room"},
            )
            missing = await client.post(path, json={}, headers=controller.headers)

        binding = harness.protocol.connections.controllers.binding(agent_id)
        assert binding is not None
        holder = harness.protocol.connections.controllers.holder_id(binding)
        assert member.status_code == 200, member.text
        assert member.json() == {"result": {"room_id": member_room}}
        assert seen["session_key"] == holder
        assert seen["reader"].id == holder
        assert non_member.status_code == 403
        assert unknown.status_code == 404
        assert missing.status_code == 400
        assert "Not connected to a room" in missing.json()["detail"]

    async def test_connect_to_room_checks_membership_and_claims_nothing(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            room_id = await add_room(harness.session_factory, agent_id)
            outside = await add_room(harness.session_factory, name="elsewhere")
        protocol: Any = harness.protocol

        async def _nothing(*_args: Any, **_kwargs: Any) -> Any:
            return []

        async def _no_resources(_room_id: str) -> dict[str, Any]:
            return {
                "linked_rooms": [],
                "reference_types": [],
                "references": [],
                "documents": [],
                "packages": [],
            }

        protocol.list_participants = _nothing
        protocol.list_room_roles = _nothing
        protocol.list_room_resources = _no_resources
        presence = protocol.connections.controllers
        binding = presence.binding(agent_id)
        assert binding is not None
        holder = presence.holder_id(binding)
        context = CallContext(
            agent_id=agent_id,
            session_key=holder,
            session=CallerSession(id=holder, host_id="", epoch="", room_id=None),
        )
        previous = op_context._protocol
        op_context.init_operations_protocol(protocol)
        try:
            with call_context(context):
                result = await connect_to_room(room_id)
                with pytest.raises(ValueError):
                    await connect_to_room(outside)
        finally:
            op_context._protocol = previous

        assert result["room_id"] == room_id
        assert result["warning"] is None
        assert protocol.connections.placements(agent_id) == {}
        assert protocol.connections.for_agent(agent_id) == []
        async with harness.session_factory() as session:
            rows = (
                await session.execute(
                    select(AgentSession).where(AgentSession.agent_id == agent_id)
                )
            ).all()
        assert rows == []


def test_bearer() -> None:
    assert bearer("t") == {"Authorization": "Bearer t"}
