"""`ProtocolService.list_all_references` — the agent-facing reference search.

The interesting behaviour here is authorization (the agent acts as its owner,
and an agent owned by a non-admin must never see a stranger's private
reference) and the shape of the rows it hands an agent, so this runs the real
`ResourceService`/`ReferenceStore` against real PostgreSQL. Only the agent
lookup is faked: building an `Agent` row means dragging in a Client and an
ApiKey, and none of that participates in the behaviour under test.
"""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.bridges.resource.service import ResourceService
from switch_core.db.models import Reference, Room, User
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore
from switch_core.db.stores.room_link_store import RoomLinkStore

T_OLD = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)


class _FakeAgentStore:
    """Maps agent_id -> owner_id without needing the Client/ApiKey rows."""

    def __init__(self, owners: dict[str, str | None]) -> None:
        self._owners = owners

    async def get(self, _session: Any, agent_id: str) -> Any:
        if agent_id not in self._owners:
            return None
        return SimpleNamespace(id=agent_id, owner_id=self._owners[agent_id])


def _build_service(
    session_factory: async_sessionmaker[AsyncSession],
    owners: dict[str, str | None],
) -> ProtocolService:
    svc = object.__new__(ProtocolService)
    svc.connections = ConnectionRegistry()
    svc.session_factory = session_factory  # type: ignore[assignment]
    svc.agent_store = _FakeAgentStore(owners)  # type: ignore[assignment]
    svc.resource_service = ResourceService(
        reference_store=ReferenceStore(),
        reference_type_store=ReferenceTypeStore(),
        document_store=DocumentStore(),
        package_store=PackageStore(),
        room_link_store=RoomLinkStore(),
        session_factory=session_factory,
    )
    return svc


async def _make_user(session: AsyncSession, *, name: str, role: str = "user") -> User:
    user = User(name=name, email=f"{name}@example.invalid", role=role)
    session.add(user)
    await session.flush()
    return user


async def _make_reference(
    session: AsyncSession,
    *,
    owner: User,
    name: str,
    type: str = "github",
    read_visibility: str = "private",
    created_at: datetime = T_OLD,
) -> Reference:
    ref = Reference(
        owner_id=owner.id,
        read_visibility=read_visibility,
        write_visibility="private" if read_visibility == "private" else "public",
        type=type,
        name=name,
        description=f"{name} description",
        instructions=f"use {name}",
        value={"token": "placeholder"},
        created_at=created_at,
    )
    session.add(ref)
    await session.flush()
    return ref


class TestListAllReferencesAuthz:
    async def test_non_admin_owner_never_sees_a_strangers_private_reference(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            alice = await _make_user(session, name="alice")
            bob = await _make_user(session, name="bob")
            own = await _make_reference(session, owner=alice, name="alice-private")
            shared = await _make_reference(
                session, owner=bob, name="bob-public", read_visibility="public"
            )
            await _make_reference(session, owner=bob, name="bob-private")
            await session.commit()

        svc = _build_service(session_factory, {"agent-1": alice.id})

        rows = await svc.list_all_references("agent-1", None, None, None, None)

        assert {r["id"] for r in rows} == {own.id, shared.id}

    async def test_admin_owner_sees_a_strangers_private_reference(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            alice = await _make_user(session, name="alice")
            root = await _make_user(session, name="root", role="admin")
            secret = await _make_reference(session, owner=alice, name="alice-private")
            await session.commit()

        svc = _build_service(session_factory, {"agent-root": root.id})

        rows = await svc.list_all_references("agent-root", None, None, None, None)

        assert [r["id"] for r in rows] == [secret.id]
        assert rows[0]["owner_name"] == "alice"

    @pytest.mark.parametrize(
        ("owners", "agent_id", "match"),
        [
            ({"agent-orphan": None}, "agent-orphan", "has no owner_id"),
            ({}, "nope", "Unknown agent"),
        ],
        ids=["ownerless-agent", "unknown-agent"],
    )
    async def test_an_agent_without_a_principal_raises(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        owners: dict[str, str | None],
        agent_id: str,
        match: str,
    ) -> None:
        """An agent that resolves to no owner has no principal to read as, so
        the search must fail loud.

        Returning `[]` would read as "there are no references", which is the
        silent-degradation the project rules forbid.
        """
        svc = _build_service(session_factory, owners)

        with pytest.raises(ValueError, match=match):
            await svc.list_all_references(agent_id, None, None, None, None)


class TestListAllReferencesShape:
    async def test_row_carries_the_metadata_but_never_the_value(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`value` holds the secrets/urls; discovery must not leak it."""
        async with session_factory() as session:
            alice = await _make_user(session, name="alice")
            ref = await _make_reference(session, owner=alice, name="deploy-key")
            await session.commit()

        svc = _build_service(session_factory, {"agent-1": alice.id})

        rows = await svc.list_all_references("agent-1", None, None, None, None)

        assert len(rows) == 1
        assert set(rows[0]) == {
            "id",
            "type",
            "name",
            "description",
            "owner_name",
            "read_visibility",
            "write_visibility",
            "created_at",
        }
        assert rows[0]["id"] == ref.id
        assert rows[0]["name"] == "deploy-key"
        assert rows[0]["owner_name"] == "alice"
        assert rows[0]["read_visibility"] == "private"

    async def test_filters_narrow_the_result(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            alice = await _make_user(session, name="alice")
            wanted = await _make_reference(
                session, owner=alice, name="prod-repo", type="github"
            )
            await _make_reference(session, owner=alice, name="prod-board", type="jira")
            await _make_reference(
                session, owner=alice, name="staging-repo", type="github"
            )
            await session.commit()

        svc = _build_service(session_factory, {"agent-1": alice.id})

        rows = await svc.list_all_references("agent-1", "PROD", "github", None, None)

        assert [r["id"] for r in rows] == [wanted.id]

    async def test_owner_name_filter_is_exact_and_unknown_names_yield_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            alice = await _make_user(session, name="alice")
            bob = await _make_user(session, name="bob")
            bobs = await _make_reference(
                session, owner=bob, name="bob-public", read_visibility="public"
            )
            await _make_reference(session, owner=alice, name="alice-private")
            await session.commit()

        svc = _build_service(session_factory, {"agent-1": alice.id})

        assert [
            r["id"]
            for r in await svc.list_all_references("agent-1", None, None, "bob", None)
        ] == [bobs.id]
        assert (
            await svc.list_all_references("agent-1", None, None, "nobody", None) == []
        )


class TestAttachedToCurrentRoom:
    async def test_key_is_absent_when_there_is_no_current_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """An absent key must never be readable as "not attached"."""
        async with session_factory() as session:
            alice = await _make_user(session, name="alice")
            await _make_reference(session, owner=alice, name="ref")
            await session.commit()

        svc = _build_service(session_factory, {"agent-1": alice.id})

        rows = await svc.list_all_references("agent-1", None, None, None, None)

        assert "attached_to_current_room" not in rows[0]

    async def test_reports_true_only_for_the_references_in_that_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            alice = await _make_user(session, name="alice")
            attached = await _make_reference(session, owner=alice, name="attached")
            loose = await _make_reference(session, owner=alice, name="loose")
            room = Room(
                matrix_room_id="!current:test", name="Current", description="room"
            )
            other = Room(matrix_room_id="!other:test", name="Other", description="room")
            session.add_all([room, other])
            await session.flush()
            store = ReferenceStore()
            await store.attach_to_room(session, room.id, attached.id)
            # Attached elsewhere: must still read as false for the current room.
            await store.attach_to_room(session, other.id, loose.id)
            await session.commit()
            room_id = room.id

        svc = _build_service(session_factory, {"agent-1": alice.id})

        rows = await svc.list_all_references("agent-1", None, None, None, room_id)

        by_id = {r["id"]: r for r in rows}
        assert by_id[attached.id]["attached_to_current_room"] is True
        assert by_id[loose.id]["attached_to_current_room"] is False
