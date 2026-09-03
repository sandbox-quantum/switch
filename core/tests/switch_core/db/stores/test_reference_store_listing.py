"""`ReferenceStore.list_readable_with_owner_names` filtering/visibility/ordering,
and the idempotent room attach that backs re-attaching an already-attached
reference.

Real PostgreSQL (per the project rule): `ilike ... escape`, the `created_at
DESC, id ASC` tiebreak and `ON CONFLICT DO NOTHING` on the composite primary
key are all database behaviours, and none of them would be exercised by a mock.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Reference, Room, User, room_references
from switch_core.db.stores.reference_store import ReferenceStore

# Fixed instants so ordering assertions do not depend on insertion timing.
T_OLD = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
T_MID = datetime(2024, 6, 1, 12, 0, tzinfo=UTC)
T_NEW = datetime(2024, 9, 1, 12, 0, tzinfo=UTC)


@pytest.fixture
def store() -> ReferenceStore:
    return ReferenceStore()


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
    created_at: datetime = T_MID,
    reference_id: str | None = None,
) -> Reference:
    ref = Reference(
        owner_id=owner.id,
        read_visibility=read_visibility,
        write_visibility="private" if read_visibility == "private" else "public",
        type=type,
        name=name,
        description=f"{name} description",
        instructions=f"use {name}",
        value={"url": f"https://example.invalid/{name}"},
        created_at=created_at,
    )
    if reference_id is not None:
        ref.id = reference_id
    session.add(ref)
    await session.flush()
    return ref


async def _make_room(session: AsyncSession, *, matrix_room_id: str, name: str) -> Room:
    room = Room(matrix_room_id=matrix_room_id, name=name, description="room")
    session.add(room)
    await session.flush()
    return room


class TestListReadableFilters:
    async def test_no_filters_returns_everything_readable(
        self, store: ReferenceStore, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            alice = await _make_user(session, name="alice")
            bob = await _make_user(session, name="bob")
            mine = await _make_reference(session, owner=alice, name="mine")
            shared = await _make_reference(
                session, owner=bob, name="shared", read_visibility="public"
            )
            await _make_reference(session, owner=bob, name="bobs-secret")
            await session.commit()

            found = await store.list_readable_with_owner_names(
                session, alice.id, is_admin=False
            )

            assert {ref.id for ref, _ in found} == {mine.id, shared.id}
            assert {ref.id: owner for ref, owner in found} == {
                mine.id: "alice",
                shared.id: "bob",
            }

    async def test_name_contains_is_a_case_insensitive_literal_substring(
        self, store: ReferenceStore, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The needle is matched as text: folded for case, wrapped in `%…%`, and
        with every LIKE metacharacter in it escaped to a literal.
        """
        names = [
            "PROD Deploy Key",
            "prod runbook",
            "staging runbook",
            "switch-payments-api",
            "switch-rooms-api",
            "100%-coverage",
            "100 coverage",
            "ci_token",
            "ciXtoken",
            "domain\\account",
            "domain-account",
        ]
        cases: list[tuple[str, set[str]]] = [
            # Case is folded on both sides of the comparison.
            ("prod", {"PROD Deploy Key", "prod runbook"}),
            ("PROD", {"PROD Deploy Key", "prod runbook"}),
            # `%…%` wrapping: the needle is not anchored to the start of a name.
            ("payment", {"switch-payments-api"}),
            # `%` is a literal, not "any run of characters".
            ("100%-", {"100%-coverage"}),
            # `_` is a literal, not "any single character".
            ("ci_token", {"ci_token"}),
            # A `\` in the needle is a literal, not an escape of what follows.
            ("domain\\account", {"domain\\account"}),
            # An empty needle is a substring of every name, not an error.
            ("", set(names)),
            # An all-metacharacter needle is a search for those characters.
            ("%", {"100%-coverage"}),
            ("_", {"ci_token"}),
            ("%%", set()),
        ]
        async with session_factory() as session:
            alice = await _make_user(session, name="alice")
            for name in names:
                await _make_reference(session, owner=alice, name=name)
            await session.commit()

            for needle, expected in cases:
                found = await store.list_readable_with_owner_names(
                    session, alice.id, is_admin=False, name_contains=needle
                )
                assert {ref.name for ref, _ in found} == expected, (
                    f"name_contains={needle!r}"
                )

    async def test_type_filter_is_an_exact_slug(
        self, store: ReferenceStore, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            alice = await _make_user(session, name="alice")
            gh = await _make_reference(session, owner=alice, name="repo", type="github")
            await _make_reference(session, owner=alice, name="board", type="jira")
            # Exact, not a substring: "git" must not match "github".
            await session.commit()

            found = await store.list_readable_with_owner_names(
                session, alice.id, is_admin=False, type="github"
            )
            prefix = await store.list_readable_with_owner_names(
                session, alice.id, is_admin=False, type="git"
            )

            assert [ref.id for ref, _ in found] == [gh.id]
            assert prefix == []

    async def test_owner_name_filter_is_exact_and_unknown_names_yield_nothing(
        self, store: ReferenceStore, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            alice = await _make_user(session, name="alice")
            bob = await _make_user(session, name="bob")
            bobs = await _make_reference(
                session, owner=bob, name="bob-public", read_visibility="public"
            )
            await _make_reference(session, owner=alice, name="alice-private")
            await session.commit()

            found = await store.list_readable_with_owner_names(
                session, alice.id, is_admin=False, owner_name="bob"
            )
            prefix = await store.list_readable_with_owner_names(
                session, alice.id, is_admin=False, owner_name="bo"
            )
            unknown = await store.list_readable_with_owner_names(
                session, alice.id, is_admin=False, owner_name="nobody"
            )

            assert found == [(bobs, "bob")]
            assert prefix == []
            assert unknown == []

    async def test_filters_are_anded(
        self, store: ReferenceStore, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A row matching one filter but not the other is excluded."""
        async with session_factory() as session:
            alice = await _make_user(session, name="alice")
            both = await _make_reference(
                session, owner=alice, name="deploy-key", type="github"
            )
            # Right name, wrong type.
            await _make_reference(
                session, owner=alice, name="deploy-key-jira", type="jira"
            )
            # Right type, wrong name.
            await _make_reference(
                session, owner=alice, name="read-token", type="github"
            )
            await session.commit()

            found = await store.list_readable_with_owner_names(
                session,
                alice.id,
                is_admin=False,
                name_contains="deploy",
                type="github",
            )

            assert [ref.id for ref, _ in found] == [both.id]


class TestListReadableVisibility:
    async def test_owner_sees_their_private_row_and_a_stranger_does_not(
        self, store: ReferenceStore, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            alice = await _make_user(session, name="alice")
            bob = await _make_user(session, name="bob")
            secret = await _make_reference(
                session, owner=alice, name="secret", read_visibility="private"
            )
            await session.commit()

            mine = await store.list_readable_with_owner_names(
                session, alice.id, is_admin=False
            )
            theirs = await store.list_readable_with_owner_names(
                session, bob.id, is_admin=False
            )

            assert mine == [(secret, "alice")]
            assert theirs == []

    async def test_public_row_is_visible_to_everyone_paired_with_its_owner(
        self, store: ReferenceStore, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A reader who does not own the row still gets the owner's name."""
        async with session_factory() as session:
            alice = await _make_user(session, name="alice")
            bob = await _make_user(session, name="bob")
            shared = await _make_reference(
                session, owner=bob, name="shared", read_visibility="public"
            )
            await session.commit()

            for viewer in (alice, bob):
                found = await store.list_readable_with_owner_names(
                    session, viewer.id, is_admin=False
                )
                assert found == [(shared, "bob")]

    async def test_admin_sees_another_users_private_row(
        self, store: ReferenceStore, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`is_admin=True` drops the owner/visibility clause entirely."""
        async with session_factory() as session:
            alice = await _make_user(session, name="alice")
            root = await _make_user(session, name="root", role="admin")
            secret = await _make_reference(
                session, owner=alice, name="secret", read_visibility="private"
            )
            await session.commit()

            as_user = await store.list_readable_with_owner_names(
                session, root.id, is_admin=False
            )
            as_admin = await store.list_readable_with_owner_names(
                session, root.id, is_admin=True
            )

            assert as_user == []
            assert as_admin == [(secret, "alice")]

    async def test_admin_bypass_still_honours_the_other_filters(
        self, store: ReferenceStore, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            alice = await _make_user(session, name="alice")
            root = await _make_user(session, name="root", role="admin")
            wanted = await _make_reference(
                session, owner=alice, name="prod-key", type="github"
            )
            await _make_reference(session, owner=alice, name="prod-board", type="jira")
            await session.commit()

            found = await store.list_readable_with_owner_names(
                session,
                root.id,
                is_admin=True,
                name_contains="prod",
                type="github",
            )

            assert [ref.id for ref, _ in found] == [wanted.id]


class TestListReadableOrdering:
    async def test_newest_first(
        self, store: ReferenceStore, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            alice = await _make_user(session, name="alice")
            # Inserted oldest-last so insertion order cannot pass by accident.
            mid = await _make_reference(
                session, owner=alice, name="mid", created_at=T_MID
            )
            new = await _make_reference(
                session, owner=alice, name="new", created_at=T_NEW
            )
            old = await _make_reference(
                session, owner=alice, name="old", created_at=T_OLD
            )
            await session.commit()

            found = await store.list_readable_with_owner_names(
                session, alice.id, is_admin=False
            )

            assert [ref.id for ref, _ in found] == [new.id, mid.id, old.id]

    async def test_identical_created_at_breaks_the_tie_on_id_ascending(
        self, store: ReferenceStore, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Rows sharing an instant come back in a stable, defined order.

        Without the `id ASC` tiebreak Postgres may return the group in any
        order, which would make a caller's paging or diffing flap.
        """
        async with session_factory() as session:
            alice = await _make_user(session, name="alice")
            # Ids chosen so ascending-id disagrees with insertion order.
            await _make_reference(
                session,
                owner=alice,
                name="tie-c",
                created_at=T_MID,
                reference_id="ref-c",
            )
            await _make_reference(
                session,
                owner=alice,
                name="tie-a",
                created_at=T_MID,
                reference_id="ref-a",
            )
            await _make_reference(
                session,
                owner=alice,
                name="tie-b",
                created_at=T_MID,
                reference_id="ref-b",
            )
            # A newer row still sorts ahead of the whole tied group.
            await _make_reference(
                session,
                owner=alice,
                name="newer",
                created_at=T_NEW,
                reference_id="ref-z",
            )
            await session.commit()

            found = await store.list_readable_with_owner_names(
                session, alice.id, is_admin=False
            )

            assert [ref.id for ref, _ in found] == ["ref-z", "ref-a", "ref-b", "ref-c"]


class TestAttachToRoomIsIdempotent:
    async def test_attaching_twice_leaves_exactly_one_link(
        self, store: ReferenceStore, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Attaching a reference already attached to the room is a no-op.

        `room_references` is keyed on (room_id, reference_id): the second
        attach must neither add a row nor abort the surrounding transaction.
        """
        async with session_factory() as session:
            alice = await _make_user(session, name="alice")
            ref = await _make_reference(session, owner=alice, name="repo")
            room = await _make_room(
                session, matrix_room_id="!attach-twice:test", name="Attach Twice"
            )
            await session.commit()

            await store.attach_to_room(session, room.id, ref.id)
            await store.attach_to_room(session, room.id, ref.id)
            await session.commit()

            count = await session.scalar(
                select(func.count())
                .select_from(room_references)
                .where(
                    room_references.c.room_id == room.id,
                    room_references.c.reference_id == ref.id,
                )
            )
            assert count == 1
            # The transaction is still usable — an aborted one would raise here.
            assert await store.is_attached_to_room(session, room.id, ref.id) is True
            assert [r.id for r in await store.list_for_room(session, room.id)] == [
                ref.id
            ]

    async def test_detach_after_a_double_attach_removes_the_link(
        self, store: ReferenceStore, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The no-op must not have written a second, invisible row."""
        async with session_factory() as session:
            alice = await _make_user(session, name="alice")
            ref = await _make_reference(session, owner=alice, name="repo")
            room = await _make_room(
                session, matrix_room_id="!detach:test", name="Detach"
            )
            await session.commit()

            await store.attach_to_room(session, room.id, ref.id)
            await store.attach_to_room(session, room.id, ref.id)
            await store.detach_from_room(session, room.id, ref.id)
            await session.commit()

            assert await store.is_attached_to_room(session, room.id, ref.id) is False
