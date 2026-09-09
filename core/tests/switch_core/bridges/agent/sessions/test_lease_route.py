"""The lease route: who may run a session, and what they may do with it.

Exercised through the real router against real Postgres, because the things
worth pinning here are the ones the route decides — which status code and which
contract code come back, whether the epoch changed, and what got written. Only
the authenticated agent is substituted, since the middleware that resolves it is
tested elsewhere.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.api_key_cache import ApiKeyCache
from switch_core.bridges.agent.app import install_exception_handlers
from switch_core.bridges.agent.auth import (
    BearerAuthMiddleware,
    _is_public_path,
    get_agent_from_scope,
)
from switch_core.bridges.agent.dependencies import (
    get_session,
    get_session_lease_service,
)
from switch_core.bridges.agent.sessions.errors import STATUS_BY_CODE, SessionApiError
from switch_core.bridges.agent.sessions.lease_service import SessionLeaseService
from switch_core.bridges.agent.sessions.routes import router
from switch_core.db.models import (
    Agent,
    ApiKey,
    Client,
    HostSession,
    SessionLease,
    SessionRoomAssociation,
    User,
)
from switch_core.db.stores.session_lease_store import SessionLeaseStore
from switch_core.db.stores.session_store import SessionStore


async def _make_agent(session: AsyncSession) -> Agent:
    """Minimal User → ApiKey → Client → Agent chain (sessions.agent_id FK)."""
    name = f"agent-{uuid.uuid4().hex[:8]}"
    user = User(name=name, email=f"{name}@test", role="user", password_hash="x")
    session.add(user)
    await session.flush()
    api_key = ApiKey(
        user_id=user.id,
        key_hash=f"hash-{name}",
        encrypted_key="enc",
        label=name,
        type="agent",
    )
    client = Client(matrix_user_id=f"@{name}:test", display_name=name, type="agent")
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        name=name,
        description=f"{name} desc",
        agent_type="always_on",
        connector_type="claude_code",
        integration_profile={"connection_model": "always_on"},
        client_id=client.id,
        api_key_id=api_key.id,
    )
    session.add(agent)
    await session.flush()
    return agent


class _Caller:
    """The app under test, plus the agent its requests arrive as.

    `as_agent` swaps the caller without rebuilding anything, which is how the
    foreign-agent case is written: the same session id, a different token.
    """

    def __init__(
        self, client: httpx.AsyncClient, app: FastAPI, agent: Agent, other: Agent
    ) -> None:
        self.client = client
        self.app = app
        self.agent = agent
        self.other = other

    def as_agent(self, agent: Agent) -> None:
        self.app.dependency_overrides[get_agent_from_scope] = lambda: agent

    async def lease(self, session_id: str, **body: object) -> httpx.Response:
        return await self.client.post(
            f"/agent/v1/sessions/{session_id}/lease", json=body
        )


@pytest_asyncio.fixture
async def agents(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[tuple[Agent, Agent]]:
    async with session_factory() as session:
        first = await _make_agent(session)
        second = await _make_agent(session)
        await session.commit()
        yield first, second


@pytest_asyncio.fixture
async def caller(
    session_factory: async_sessionmaker[AsyncSession],
    agents: tuple[Agent, Agent],
) -> AsyncIterator[_Caller]:
    """The app driven in-process on the test's own event loop.

    Not `TestClient`: it runs the app in a second loop, and the engine these
    tests read the database with is bound to this one.
    """
    agent, other = agents
    app = FastAPI()
    install_exception_handlers(app)
    app.include_router(router)

    async def _db() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = _db
    app.dependency_overrides[get_agent_from_scope] = lambda: agent
    app.dependency_overrides[get_session_lease_service] = lambda: SessionLeaseService(
        SessionStore(), SessionLeaseStore()
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://agent-bridge"
    ) as client:
        yield _Caller(client, app, agent, other)


class TestAcquiring:
    async def test_a_first_claim_registers_the_session_and_mints_an_epoch(
        self, caller: _Caller
    ) -> None:
        resp = await caller.lease("s1", hostId="host-a")

        assert resp.status_code == 200
        body = resp.json()
        assert body["sessionId"] == "s1"
        assert body["hostId"] == "host-a"
        assert body["epoch"]
        assert body["displaced"] is None

    async def test_the_session_row_is_written_by_the_lease_and_nothing_else(
        self, caller: _Caller, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The contract has no "create session" call. This is it."""
        await caller.lease("s1", hostId="host-a")

        async with session_factory() as session:
            record = await session.get(HostSession, "s1")
            assert record is not None
            assert record.agent_id == caller.agent.id
            assert record.host_id == "host-a"

    async def test_the_host_does_not_get_to_choose_its_own_epoch(
        self, caller: _Caller
    ) -> None:
        """An epoch in the body is a renewal claim, never an assignment.

        A host that could name its generation could name the one it was just
        displaced from, and the fence the server puts in front of a stale host
        would be a fence the stale host holds the key to.
        """
        resp = await caller.lease("s1", hostId="host-a", epoch="chosen-by-me")

        assert resp.status_code == 409
        assert resp.json()["code"] == "STALE_EPOCH"

    async def test_two_sessions_of_one_agent_get_different_epochs(
        self, caller: _Caller
    ) -> None:
        first = (await caller.lease("s1", hostId="host-a")).json()["epoch"]
        second = (await caller.lease("s2", hostId="host-a")).json()["epoch"]

        assert first != second


class TestRenewing:
    async def test_a_renewal_keeps_the_epoch(self, caller: _Caller) -> None:
        epoch = (await caller.lease("s1", hostId="host-a")).json()["epoch"]

        resp = await caller.lease("s1", hostId="host-a", epoch=epoch)

        assert resp.status_code == 200
        assert resp.json()["epoch"] == epoch

    async def test_a_renewal_moves_the_heartbeat_forward(
        self, caller: _Caller, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        epoch = (await caller.lease("s1", hostId="host-a")).json()["epoch"]
        async with session_factory() as session:
            before = (await session.get(SessionLease, "s1")).last_seen_at

        await caller.lease("s1", hostId="host-a", epoch=epoch)

        async with session_factory() as session:
            after = (await session.get(SessionLease, "s1")).last_seen_at
        assert after > before

    async def test_a_renewal_under_a_displaced_epoch_is_refused(
        self, caller: _Caller
    ) -> None:
        """What a displaced host finds out with.

        Nothing tells it it lost the session — the epoch changing under it is
        the notification, and this is where it reads it.
        """
        stale = (await caller.lease("s1", hostId="host-a")).json()["epoch"]
        await caller.lease("s1", hostId="host-b", takeover=True)

        resp = await caller.lease("s1", hostId="host-a", epoch=stale)

        assert resp.status_code == 409
        body = resp.json()
        assert body["code"] == "STALE_EPOCH"
        assert body["retryable"] is False

    async def test_a_renewal_by_a_host_that_never_held_it_is_refused(
        self, caller: _Caller
    ) -> None:
        epoch = (await caller.lease("s1", hostId="host-a")).json()["epoch"]

        resp = await caller.lease("s1", hostId="host-b", epoch=epoch)

        assert resp.status_code == 409
        assert resp.json()["code"] == "STALE_EPOCH"


class TestOneHolder:
    async def test_a_second_live_host_is_refused(self, caller: _Caller) -> None:
        await caller.lease("s1", hostId="host-a")

        resp = await caller.lease("s1", hostId="host-b")

        assert resp.status_code == 409
        body = resp.json()
        assert body["code"] == "LEASE_HELD"
        assert body["retryable"] is True
        assert "host-a" in body["message"]

    async def test_the_refused_claim_leaves_the_incumbent_untouched(
        self, caller: _Caller, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        epoch = (await caller.lease("s1", hostId="host-a")).json()["epoch"]

        await caller.lease("s1", hostId="host-b")

        async with session_factory() as session:
            lease = await session.get(SessionLease, "s1")
            assert lease.host_id == "host-a"
            assert lease.epoch == epoch

    async def test_takeover_displaces_the_holder_under_a_new_epoch(
        self, caller: _Caller, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        first = (await caller.lease("s1", hostId="host-a")).json()["epoch"]

        resp = await caller.lease("s1", hostId="host-b", takeover=True)

        assert resp.status_code == 200
        body = resp.json()
        assert body["displaced"] == "host-a"
        assert body["epoch"] != first
        async with session_factory() as session:
            lease = await session.get(SessionLease, "s1")
            assert lease.host_id == "host-b"
            assert lease.epoch == body["epoch"]
            assert (await session.get(HostSession, "s1")).host_id == "host-b"

    async def test_a_lease_whose_holder_stopped_beating_is_free(
        self, caller: _Caller, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """No takeover flag, and no reaper either.

        A host that died holds a row nobody is behind. Making its successor ask
        for a takeover would mean the flag is set on the ordinary restart path,
        which is exactly where it stops meaning anything.
        """
        await caller.lease("s1", hostId="host-a")
        async with session_factory() as session:
            lease = await session.get(SessionLease, "s1")
            lease.last_seen_at = datetime.now(UTC) - (
                SessionLeaseStore.LEASE_TTL + timedelta(seconds=1)
            )
            await session.commit()

        resp = await caller.lease("s1", hostId="host-b")

        assert resp.status_code == 200
        assert resp.json()["displaced"] == "host-a"


class TestOwnership:
    async def test_another_agents_session_is_not_leasable(
        self, caller: _Caller
    ) -> None:
        """A session id is host-generated and not a secret.

        The binding to an agent is the only thing between a session and whoever
        guesses its id, so this is refused before liveness is even considered.
        """
        await caller.lease("s1", hostId="host-a")

        caller.as_agent(caller.other)
        resp = await caller.lease("s1", hostId="host-b")

        assert resp.status_code == 403
        body = resp.json()
        assert body["code"] == "NOT_AUTHORIZED"
        assert body["retryable"] is False

    async def test_takeover_does_not_cross_the_agent_boundary(
        self, caller: _Caller
    ) -> None:
        """`takeover` says "displace a peer of mine", not "displace anyone"."""
        await caller.lease("s1", hostId="host-a")

        caller.as_agent(caller.other)
        resp = await caller.lease("s1", hostId="host-b", takeover=True)

        assert resp.status_code == 403
        assert resp.json()["code"] == "NOT_AUTHORIZED"

    async def test_two_agents_may_hold_leases_on_their_own_sessions(
        self, caller: _Caller
    ) -> None:
        assert (await caller.lease("s1", hostId="host-a")).status_code == 200

        caller.as_agent(caller.other)
        assert (await caller.lease("s2", hostId="host-b")).status_code == 200


class TestReclaimingAfterARestart:
    """A host that dies inside the TTL has to be able to get its session back.

    Its epoch went with its memory, so it must acquire rather than renew, and
    the lease row it left is still well inside the 90s window. If that needed
    `takeover: true`, the flag would be set on every ordinary restart and would
    stop distinguishing the case it exists for.
    """

    async def test_the_same_host_reacquires_without_asking_for_a_takeover(
        self, caller: _Caller
    ) -> None:
        first = (await caller.lease("s1", hostId="host-a")).json()["epoch"]

        resp = await caller.lease("s1", hostId="host-a")

        assert resp.status_code == 200
        body = resp.json()
        assert body["epoch"] != first
        assert body["displaced"] is None, (
            "a host reclaiming its own session took it from nobody; reporting "
            "itself would make every restart look like a takeover"
        )

    async def test_the_epoch_the_dead_process_held_is_dead_with_it(
        self, caller: _Caller
    ) -> None:
        """Reacquiring is not renewing: whatever the old process still had in
        flight is fenced out, which is the whole reason to mint a new epoch."""
        first = (await caller.lease("s1", hostId="host-a")).json()["epoch"]
        await caller.lease("s1", hostId="host-a")

        resp = await caller.lease("s1", hostId="host-a", epoch=first)

        assert resp.status_code == 409
        assert resp.json()["code"] == "STALE_EPOCH"

    async def test_a_different_host_still_has_to_ask(self, caller: _Caller) -> None:
        await caller.lease("s1", hostId="host-a")

        assert (await caller.lease("s1", hostId="host-b")).status_code == 409


class TestALeaseReachesNoRoom:
    """A regression guard, load-bearing from S4 onwards.

    Publication authority is a server-owned association written by something
    that is not this route and does not exist yet, so this cannot fail today for
    the reason it names. It is here to fail the first time a lease path grows a
    shortcut into a room.
    """

    async def test_no_lease_path_creates_a_room_association(
        self, caller: _Caller, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await caller.lease("s1", hostId="host-a")
        await caller.lease("s1", hostId="host-b", takeover=True)
        epoch = (await caller.lease("s2", hostId="host-b")).json()["epoch"]
        await caller.lease("s2", hostId="host-b", epoch=epoch)

        async with session_factory() as session:
            associations = await session.scalar(
                select(func.count()).select_from(SessionRoomAssociation)
            )
        assert associations == 0


class TestTheDoor:
    def test_the_lease_route_is_not_publicly_reachable(self) -> None:
        assert _is_public_path("/agent/v1/sessions/s1/lease") is False

    async def test_an_unknown_field_is_refused_rather_than_ignored(
        self, caller: _Caller
    ) -> None:
        """`extra="forbid"`, so a host that misspells `takeover` is told.

        Silently ignoring it would mean a takeover request that quietly became
        a refusal, which reads to the host as a lease it cannot ever get.
        """
        resp = await caller.lease("s1", hostId="host-a", takeOver=True)

        assert resp.status_code == 422

    async def test_renew_and_takeover_together_are_refused(
        self, caller: _Caller
    ) -> None:
        """ "Renew, or take it back if I lost it" is two requests, not one.

        Resolving it either way is silent: a renewal that became a takeover
        hands back an epoch the host did not ask to keep, and a takeover that
        became a renewal drops the flag.
        """
        epoch = (await caller.lease("s1", hostId="host-a")).json()["epoch"]

        resp = await caller.lease("s1", hostId="host-a", epoch=epoch, takeover=True)

        assert resp.status_code == 422
        assert resp.json()["code"] == "INVALID_REQUEST"

    def test_every_error_this_route_raises_has_a_status(self) -> None:
        """`SessionApiError` validates its code against the table, so a code
        with no status cannot be constructed rather than rendering as a 500."""
        with pytest.raises(ValueError):
            SessionApiError("NOT_A_CODE", "…", retryable=False)

        assert STATUS_BY_CODE["LEASE_HELD"] == 409
        assert STATUS_BY_CODE["STALE_EPOCH"] == 409
        assert STATUS_BY_CODE["NOT_AUTHORIZED"] == 403


class TestEveryFailureWearsTheEnvelope:
    """§6.2 is what the host decodes, and it has one decoder per route family.

    A rejected token or a malformed body arriving as `{"detail": ...}` has no
    `code` in it, so the host falls through to unknown-error at the two moments
    the cause is most obvious. Both doors are ahead of the handler, so neither
    is covered by the handler raising `SessionApiError`.
    """

    async def test_a_request_with_no_token_still_answers_in_the_envelope(
        self,
    ) -> None:
        app = FastAPI()
        install_exception_handlers(app)
        app.include_router(router)
        app.add_middleware(
            BearerAuthMiddleware,
            agent_store=None,  # type: ignore[arg-type]
            api_key_store=None,  # type: ignore[arg-type]
            api_key_cache=ApiKeyCache(ttl_seconds=0, max_entries=1),
            session_factory=None,  # type: ignore[arg-type]
        )

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://agent-bridge"
        ) as client:
            resp = await client.post(
                "/agent/v1/sessions/s1/lease", json={"hostId": "host-a"}
            )

        assert resp.status_code == 401
        body = resp.json()
        assert body["code"] == "NOT_AUTHORIZED"
        assert body["retryable"] is False

    async def test_every_other_route_keeps_the_shape_it_had(self) -> None:
        """The envelope is scoped to the contract's paths on purpose.

        Every existing agent-bridge client reads `{"detail": ...}`, and this
        middleware is also the MCP door.
        """
        app = FastAPI()
        install_exception_handlers(app)
        app.add_middleware(
            BearerAuthMiddleware,
            agent_store=None,  # type: ignore[arg-type]
            api_key_store=None,  # type: ignore[arg-type]
            api_key_cache=ApiKeyCache(ttl_seconds=0, max_entries=1),
            session_factory=None,  # type: ignore[arg-type]
        )

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://agent-bridge"
        ) as client:
            resp = await client.get("/agents/a1/rooms")

        assert resp.status_code == 401
        assert "code" not in resp.text

    async def test_a_malformed_body_answers_in_the_envelope(
        self, caller: _Caller
    ) -> None:
        resp = await caller.client.post(
            "/agent/v1/sessions/s1/lease", json={"epoch": 4}
        )

        assert resp.status_code == 422
        body = resp.json()
        assert body["code"] == "INVALID_REQUEST"
        assert body["retryable"] is False

    async def test_a_route_this_server_does_not_have_answers_in_the_envelope(
        self, caller: _Caller
    ) -> None:
        """Version skew is the case this one is for.

        A host built against a later slice posts to a route this Switch has not
        grown yet. It authenticates, so the middleware passes it through, and
        the router raises. Answering `{"detail": "Not Found"}` there sends the
        host to unknown-error at the moment the cause is most diagnosable.
        """
        resp = await caller.client.post(
            "/agent/v1/sessions/s1/events", json={"events": []}
        )

        assert resp.status_code == 404
        assert resp.json()["code"] == "NOT_FOUND"

    async def test_the_wrong_method_answers_in_the_envelope(
        self, caller: _Caller
    ) -> None:
        """405 has no contract code, so it gets the least specific honest one.

        What matters is that there is a `code` at all: the router raises
        Starlette's `HTTPException`, not FastAPI's subclass, and a handler
        registered against the subclass never sees it.
        """
        resp = await caller.client.get("/agent/v1/sessions/s1/lease")

        assert resp.status_code == 405
        assert resp.json()["code"] == "INVALID_REQUEST"
