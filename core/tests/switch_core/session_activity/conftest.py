from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass

import pytest
from sqlalchemy import insert
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.addressing import AddressingPolicy
from switch_core.db.models import (
    Agent,
    ApiKey,
    Client,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    Room,
    User,
    room_agents,
)
from switch_core.session_activity.listener import Change, SessionActivityListener
from switch_core.session_activity.service import SessionActivityService
from switch_core.tenant_context import current_tenant_id

AGENT = "agent-demo"


async def make_agent(
    db, agent_id: str, *, policy: AddressingPolicy | None = None
) -> str:
    """Create an agent and its owner; returns the owner's user id."""
    suffix = uuid.uuid4().hex[:8]
    user = User(
        id=f"owner-{suffix}", name="Owner", email=f"{suffix}@example.test", role="user"
    )
    db.add(user)
    await db.flush()
    key = ApiKey(
        user_id=user.id,
        key_hash=uuid.uuid4().hex,
        encrypted_key="",
        label="fixture",
        type="agent",
    )
    client = Client(
        matrix_user_id=f"@{agent_id}:example.test", display_name=agent_id, type="agent"
    )
    db.add_all([key, client])
    await db.flush()
    db.add(
        Agent(
            id=agent_id,
            name=agent_id,
            description="test agent",
            agent_type="session_addressable",
            connector_type="codex",
            integration_profile={},
            client_id=client.id,
            api_key_id=key.id,
            owner_id=user.id,
            addressing_policy=policy.model_dump() if policy is not None else None,
        )
    )
    await db.flush()
    return user.id


async def make_room(db, *, member: str | None) -> str:
    suffix = uuid.uuid4().hex[:8]
    room = Room(matrix_room_id=f"!{suffix}:test", name=f"room-{suffix}", description="")
    db.add(room)
    await db.flush()
    if member is not None:
        await db.execute(insert(room_agents).values(room_id=room.id, agent_id=member))
    return room.id


async def make_person(db, *, claimed_by: str | None) -> str:
    """A person on a messaging platform; returns the Switch identity they answer as."""
    suffix = uuid.uuid4().hex[:8]
    bridge_client = Client(
        matrix_user_id=f"@bridge-{suffix}:test", display_name="bridge", type="bridge"
    )
    person = Client(
        matrix_user_id=f"@person-{suffix}:test", display_name="person", type="user"
    )
    db.add_all([bridge_client, person])
    await db.flush()
    bridge = CollaborationBridge(
        type="slack", display_name="Slack", client_id=bridge_client.id, status="active"
    )
    db.add(bridge)
    await db.flush()
    account = ExternalUser(
        bridge_id=bridge.id,
        external_user_id=f"U{suffix}",
        external_username=f"person-{suffix}",
        client_id=person.id,
    )
    db.add(account)
    await db.flush()
    if claimed_by is not None:
        db.add(ExternalUserClaim(external_user_id=account.id, user_id=claimed_by))
        await db.flush()
    return person.matrix_user_id


@dataclass(frozen=True)
class People:
    owner: str
    stranger: str


@pytest.fixture
async def people(session_factory) -> People:
    """The agent's owner and an unrelated person, as Switch identities."""
    async with session_factory() as db, db.begin():
        owner_id = await make_agent(db, AGENT)
        owner = await make_person(db, claimed_by=owner_id)
        stranger = await make_person(db, claimed_by=None)
    return People(owner=owner, stranger=stranger)


@pytest.fixture
async def service(session_factory, people) -> SessionActivityService:
    return SessionActivityService(session_factory)


class Recorder:
    """What the listener pushed for the test's tenant, in arrival order."""

    def __init__(self) -> None:
        self.seen: list[Change] = []
        self.resyncs = 0

    async def on_change(self, change: Change) -> None:
        self.seen.append(change)

    async def on_resync(self) -> None:
        self.resyncs += 1

    async def expect(self, expected: list[tuple[str, str]]) -> list[Change]:
        """Wait for exactly these (kind, key) changes, and no more."""
        deadline = asyncio.get_running_loop().time() + 5
        while len(self.seen) < len(expected):
            assert asyncio.get_running_loop().time() < deadline, self.seen
            await asyncio.sleep(0.02)
        # Long enough for a stray extra announcement to arrive and be caught.
        await asyncio.sleep(0.2)
        assert [(c.kind, c.key) for c in self.seen] == expected
        return self.seen


@pytest.fixture
async def changes(postgres_url) -> AsyncIterator[Recorder]:
    tenant = current_tenant_id()
    assert tenant is not None
    listener = SessionActivityListener(
        lambda: create_async_engine(postgres_url, poolclass=NullPool)
    )
    recorder = Recorder()
    unsubscribe = listener.subscribe(tenant, recorder.on_change, recorder.on_resync)
    await listener.start()
    try:
        await asyncio.wait_for(listener.connected.wait(), 5)
        yield recorder
    finally:
        unsubscribe()
        await listener.stop()
