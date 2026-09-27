"""Registration must not hold a pooled connection across the bridge fan-out.

`_resolve_registration_user_id` authenticates the registration token, and
`register_known_agents_bulk_endpoint` reads the parent and pre-checks names.
Both then hand off to `protocol.register_agent`, which joins a Matrix room and
creates an identity on every collaboration bridge. Nothing on this router
commits the request session, so a read left on it kept its connection checked
out for that whole handoff.

Registration is not a rare call in the shape that matters: a Switch Console
coming back reachable re-registers every agent on its host, which is dozens of
these at once against a pool 40 wide. So the property is asserted here rather
than reviewed — each test samples `pool.checkedout()` at the moment the
external work would begin, and expects nothing held.
"""

from __future__ import annotations

import hashlib
from typing import Any

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.api.handlers import (
    _resolve_registration_user_id,
    register_known_agents_bulk_endpoint,
)
from switch_core.bridges.agent.api.schemas import (
    BulkSubagentSpec,
    RegisterKnownAgentBulkRequest,
)
from switch_core.db.models import Agent, ApiKey, Client, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.user_store import UserStore

_TOKEN = "reg-token-for-the-pool-test"
_TOKEN_HASH = hashlib.sha256(_TOKEN.encode()).hexdigest()


def _pool(session_factory: async_sessionmaker[AsyncSession]) -> Any:
    return session_factory.kw["bind"].pool


class _UserStoreOnlyProtocol:
    """What `_resolve_registration_user_id` reads off the protocol service."""

    def __init__(self) -> None:
        self.user_store = UserStore()


class _PoolProbeProtocol:
    """A protocol service whose `register_agent` reports the pool's state.

    The real one joins Matrix and fans identities out across every bridge.
    Here it only records how many connections are checked out when it is
    reached, which is the number the reads before it are responsible for.
    """

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self.agent_store = AgentStore()
        self.user_store = UserStore()
        self._pool = _pool(session_factory)
        self.checked_out: int | None = None
        self.registered: list[str] = []

    async def register_agent(self, *, name: str, **kwargs: Any) -> Any:
        if self.checked_out is None:
            self.checked_out = self._pool.checkedout()
        self.registered.append(name)
        return type("R", (), {"agent_id": f"id-{name}", "api_key": f"key-{name}"})()


async def _seed(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    with_parent: bool = False,
) -> tuple[str, str | None]:
    """A user holding a personal registration key, and optionally an agent to
    parent a batch of subagents on. Committed and the session closed, so the
    setup holds nothing the assertion could mistake for the handler's.
    """
    async with session_factory() as session:
        user = User(name="registrar", email="registrar@example.com", role="user")
        session.add(user)
        await session.flush()
        key = ApiKey(
            user_id=user.id,
            key_hash=_TOKEN_HASH,
            encrypted_key="x",
            label="registration",
            type="registration",
        )
        session.add(key)
        await session.flush()
        parent_id: str | None = None
        if with_parent:
            client = Client(
                matrix_user_id="@parent-agent:test",
                display_name="parent-agent",
                type="agent",
            )
            session.add(client)
            await session.flush()
            parent = Agent(
                name="parent-agent",
                description="d",
                agent_type="claude-code",
                connector_type="mcp",
                integration_profile={},
                client_id=client.id,
                api_key_id=key.id,
                owner_id=user.id,
                metadata_={
                    "known_agent_type": "claude-code",
                    # Inherited by every subagent in the batch, which is one of
                    # the reads that has to happen before the loop starts.
                    "known_agent_options": {"repo_dir": "/srv/work"},
                },
            )
            session.add(parent)
            await session.flush()
            parent_id = parent.id
        await session.commit()
        return user.id, parent_id


class TestRegistrationTokenResolution:
    async def test_releases_its_connection_before_returning(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id, _ = await _seed(session_factory)

        owner_id = await _resolve_registration_user_id(
            authorization=f"Bearer {_TOKEN}",
            session_factory=session_factory,
            api_key_store=ApiKeyStore(),
            protocol=_UserStoreOnlyProtocol(),  # type: ignore[arg-type]
        )

        assert owner_id == user_id
        assert _pool(session_factory).checkedout() == 0, (
            "the registration token lookup is still holding a pooled connection "
            "after resolving — it would stay held through register_agent"
        )

    async def test_a_bad_token_is_still_a_401(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The short session must not swallow the rejection, and must not leak
        # a connection on the way out of it either.
        await _seed(session_factory)

        with pytest.raises(HTTPException) as exc:
            await _resolve_registration_user_id(
                authorization="Bearer not-a-real-token",
                session_factory=session_factory,
                api_key_store=ApiKeyStore(),
                protocol=_UserStoreOnlyProtocol(),  # type: ignore[arg-type]
            )

        assert exc.value.status_code == 401
        assert _pool(session_factory).checkedout() == 0


class TestBulkSubagentRegistration:
    async def test_reads_are_done_before_the_first_registration(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id, parent_id = await _seed(session_factory, with_parent=True)
        assert parent_id is not None
        protocol = _PoolProbeProtocol(session_factory)

        response = await register_known_agents_bulk_endpoint(
            req=RegisterKnownAgentBulkRequest(
                parent_agent_id=parent_id,
                agent_type="claude-code",
                subagents=[
                    BulkSubagentSpec(subagent_name="alpha", description="a"),
                    BulkSubagentSpec(subagent_name="beta", description="b"),
                ],
            ),
            owner_id=user_id,
            protocol=protocol,  # type: ignore[arg-type]
            session_factory=session_factory,
        )

        assert protocol.registered == ["parent-agent.alpha", "parent-agent.beta"]
        assert [r.subagent_name for r in response.results] == ["alpha", "beta"]
        assert protocol.checked_out == 0, (
            "the parent read and the name pre-check are holding a connection "
            "into the registration loop"
        )
