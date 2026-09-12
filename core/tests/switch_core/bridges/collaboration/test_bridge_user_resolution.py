"""User resolution on a bridge: directory hits persist, and a Switch user
resolves to their platform identity claims-first.

A directory hit used to answer the caller and leave no record, so the next
step that read the database (room membership, addressing, export) did not see
the person the resolution had just found. These tests pin the persisted-hit
behaviour and the claims-first `resolve_switch_user` path.
"""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.bridges.collaboration.models import DirectoryUser
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Client,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    User,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.external_user_store import ExternalUserStore


class _DirectoryAdapter:
    """Serves one directory; counts lookups so the DB fast path is provable."""

    def __init__(self, directory: list[DirectoryUser]) -> None:
        self.directory = directory
        self.searches: list[str] = []

    async def search_directory_users(self, query: str) -> list[DirectoryUser]:
        self.searches.append(query)
        return self.directory

    def prime_mention_targets(self, targets: dict[str, str]) -> None:
        pass


class _FakeLifecycle:
    """Creates a real Client row (the ExternalUser FK needs one) and hands
    back its id the way `create_and_start` does."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._sf = session_factory

    async def create_and_start(
        self, *, client_type: str, display_name: str, localpart: str
    ):
        async with self._sf() as session:
            client = Client(
                matrix_user_id=f"@{localpart}:test.local",
                display_name=display_name,
                type=client_type,
            )
            session.add(client)
            await session.commit()

            class _Handle:
                client_id = client.id
                matrix_user_id = client.matrix_user_id

            return _Handle()


async def _seed_bridge(session_factory) -> str:
    async with session_factory() as session:
        bridge_client = Client(
            matrix_user_id="@bridge:test.local",
            display_name="bridge",
            type="collaboration_bridge",
        )
        session.add(bridge_client)
        await session.flush()
        bridge = CollaborationBridge(
            type="slack",
            display_name="Slack",
            client_id=bridge_client.id,
            status="active",
        )
        session.add(bridge)
        await session.commit()
        return bridge.id


def _core(
    session_factory,
    bridge_id: str,
    adapter: _DirectoryAdapter,
) -> BridgeCore:
    core = object.__new__(BridgeCore)
    core._bridge_id = bridge_id
    core._bridge_type = "slack"
    core._adapter = adapter
    core._session_factory = session_factory
    core._external_user_store = ExternalUserStore()
    core._agent_store = AgentStore()
    core._client_lifecycle = _FakeLifecycle(session_factory)
    core._user_puppets = {}
    core._puppet_locks = {}
    core._puppet_matrix_ids = set()
    core._bridge_tenant_id = TENANT_ZERO_ID
    return core


CAROL = DirectoryUser(
    external_user_id="U-carol",
    username="carol",
    display_name="Carol",
    email="carol@example.com",
)


@pytest.mark.asyncio
async def test_directory_hit_is_persisted(session_factory):
    bridge_id = await _seed_bridge(session_factory)
    adapter = _DirectoryAdapter([CAROL])
    core = _core(session_factory, bridge_id, adapter)

    resolved = await core.resolve_external_user_id_map(["carol"])
    assert resolved == {"carol": "U-carol"}

    async with session_factory() as session:
        row = await ExternalUserStore().get_by_external_id(
            session, bridge_id, "U-carol"
        )
    assert row is not None
    assert row.external_username == "carol"

    # Second resolution answers from the database, not the platform.
    resolved_again = await core.resolve_external_user_id_map(["carol"])
    assert resolved_again == {"carol": "U-carol"}
    assert adapter.searches == ["carol"]


@pytest.mark.asyncio
async def test_directory_matches_email_case_insensitively(session_factory):
    bridge_id = await _seed_bridge(session_factory)
    core = _core(session_factory, bridge_id, _DirectoryAdapter([CAROL]))

    resolved = await core.resolve_external_user_id_map(["Carol@Example.COM"])
    assert resolved == {"Carol@Example.COM": "U-carol"}


@pytest.mark.asyncio
async def test_resolve_switch_user_prefers_claimed_identity(session_factory):
    bridge_id = await _seed_bridge(session_factory)
    adapter = _DirectoryAdapter([CAROL])
    core = _core(session_factory, bridge_id, adapter)

    async with session_factory() as session:
        user = User(name="alice", email="alice@example.com", role="member")
        user_client = Client(
            matrix_user_id="@abel:test.local",
            display_name="abel.dantas",
            type="external_user",
        )
        session.add_all([user, user_client])
        await session.flush()
        ext = ExternalUser(
            bridge_id=bridge_id,
            external_user_id="U-abel",
            external_username="abel.dantas",
            client_id=user_client.id,
        )
        session.add(ext)
        await session.flush()
        session.add(ExternalUserClaim(external_user_id=ext.id, user_id=user.id))
        await session.commit()
        user_id = user.id

    found = await core.resolve_switch_user(
        user_id, name="alice", email="alice@example.com"
    )
    assert found is not None
    assert found.external_username == "abel.dantas"
    # The claim answered; the platform was never asked.
    assert adapter.searches == []


@pytest.mark.asyncio
async def test_resolve_switch_user_falls_back_to_name_then_email(session_factory):
    bridge_id = await _seed_bridge(session_factory)
    core = _core(session_factory, bridge_id, _DirectoryAdapter([CAROL]))

    async with session_factory() as session:
        user = User(name="nomatch", email="carol@example.com", role="member")
        session.add(user)
        await session.commit()
        user_id = user.id

    found = await core.resolve_switch_user(
        user_id, name="nomatch", email="carol@example.com"
    )
    assert found is not None
    assert found.external_user_id == "U-carol"


@pytest.mark.asyncio
async def test_resolve_switch_user_none_when_unknown(session_factory):
    bridge_id = await _seed_bridge(session_factory)
    core = _core(session_factory, bridge_id, _DirectoryAdapter([]))

    async with session_factory() as session:
        user = User(name="ghost", email="ghost@example.com", role="member")
        session.add(user)
        await session.commit()
        user_id = user.id

    assert (
        await core.resolve_switch_user(user_id, name="ghost", email="ghost@example.com")
    ) is None
