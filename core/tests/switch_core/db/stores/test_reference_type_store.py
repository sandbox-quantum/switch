from __future__ import annotations

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Reference, ReferenceType, User
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore


async def _make_user(session: AsyncSession, name: str) -> User:
    user = User(name=name, email=f"{name}@example.invalid", role="user")
    session.add(user)
    await session.flush()
    return user


def _type(
    slug: str,
    owner_id: str,
    *,
    read_visibility: str = "private",
    write_visibility: str = "private",
) -> ReferenceType:
    return ReferenceType(
        type=slug,
        owner_id=owner_id,
        read_visibility=read_visibility,
        write_visibility=write_visibility,
        display_name=slug.replace("_", " ").title(),
        instructions=f"Use {slug} links.",
        value_hint=f"Paste {slug} URLs.",
    )


def _reference(type_: str, owner_id: str) -> Reference:
    return Reference(
        owner_id=owner_id,
        read_visibility="private",
        write_visibility="private",
        type=type_,
        name=f"{type_} ref",
        description="",
        instructions="",
        value={"urls": ["https://example.invalid/doc"]},
    )


class TestReferenceTypeStore:
    async def test_create_and_get(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = ReferenceTypeStore()
        async with session_factory() as session:
            user = await _make_user(session, "ada")
            created = await store.create(session, _type("notion", user.id))
            await session.commit()

            assert created.type == "notion"
            assert created.created_at is not None

            loaded = await store.get(session, "notion")
            assert loaded is not None
            assert loaded.owner_id == user.id
            assert loaded.display_name == "Notion"
            assert loaded.value_hint == "Paste notion URLs."
            assert await store.get(session, "nope") is None

    async def test_get_many(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = ReferenceTypeStore()
        async with session_factory() as session:
            user = await _make_user(session, "ada")
            for slug in ("notion", "linear", "figma"):
                await store.create(session, _type(slug, user.id))
            await session.commit()

            found = await store.get_many(session, ["notion", "figma", "absent"])
            assert {rt.type for rt in found} == {"notion", "figma"}
            assert await store.get_many(session, []) == []

    async def test_duplicate_slug_raises_value_error_and_keeps_session_usable(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A clashing slug is a ValueError the gateway turns into a 400, not a 500."""
        store = ReferenceTypeStore()
        async with session_factory() as session:
            ada = await _make_user(session, "ada")
            grace = await _make_user(session, "grace")
            await store.create(session, _type("notion", ada.id))
            await session.commit()

            with pytest.raises(
                ValueError, match="Reference type 'notion' already exists"
            ):
                await store.create(session, _type("notion", grace.id))

            # The savepoint means the surrounding transaction survives the clash.
            await store.create(session, _type("linear", grace.id))
            await session.commit()
            assert {rt.type for rt in await store.list_all(session)} == {
                "notion",
                "linear",
            }
            notion = await store.get(session, "notion")
            assert notion is not None
            assert notion.owner_id == ada.id

    async def test_integrity_error_that_is_not_a_duplicate_propagates(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """An unknown owner is a foreign-key violation, not a slug clash."""
        store = ReferenceTypeStore()
        async with session_factory() as session:
            with pytest.raises(IntegrityError):
                await store.create(session, _type("notion", "no-such-user"))

    async def test_list_for_user_filters_by_owner_and_public_read(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = ReferenceTypeStore()
        async with session_factory() as session:
            ada = await _make_user(session, "ada")
            grace = await _make_user(session, "grace")
            await store.create(session, _type("ada_private", ada.id))
            await store.create(
                session, _type("ada_public", ada.id, read_visibility="public")
            )
            await store.create(session, _type("grace_private", grace.id))
            await store.create(
                session, _type("grace_public", grace.id, read_visibility="public")
            )
            await session.commit()

            assert {rt.type for rt in await store.list_for_user(session, ada.id)} == {
                "ada_private",
                "ada_public",
                "grace_public",
            }
            assert {rt.type for rt in await store.list_for_user(session, grace.id)} == {
                "grace_private",
                "grace_public",
                "ada_public",
            }

    async def test_list_for_user_none_returns_public_rows_only(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """An ownerless principal sees public types and nothing else."""
        store = ReferenceTypeStore()
        async with session_factory() as session:
            ada = await _make_user(session, "ada")
            await store.create(session, _type("ada_private", ada.id))
            await store.create(
                session, _type("ada_public", ada.id, read_visibility="public")
            )
            await session.commit()

            assert {rt.type for rt in await store.list_for_user(session, None)} == {
                "ada_public"
            }

    async def test_list_all_returns_every_row(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = ReferenceTypeStore()
        async with session_factory() as session:
            assert await store.list_all(session) == []
            ada = await _make_user(session, "ada")
            await store.create(session, _type("ada_private", ada.id))
            await store.create(
                session, _type("ada_public", ada.id, read_visibility="public")
            )
            await session.commit()

            assert {rt.type for rt in await store.list_all(session)} == {
                "ada_private",
                "ada_public",
            }

    async def test_update_fields_updates_only_what_is_passed(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = ReferenceTypeStore()
        async with session_factory() as session:
            ada = await _make_user(session, "ada")
            await store.create(session, _type("notion", ada.id))
            await session.commit()

            updated = await store.update_fields(
                session,
                "notion",
                display_name="Notion Workspace",
                read_visibility="public",
                write_visibility="public",
            )
            await session.commit()

            assert updated.display_name == "Notion Workspace"
            assert updated.read_visibility == "public"
            assert updated.write_visibility == "public"
            assert updated.instructions == "Use notion links."
            assert updated.value_hint == "Paste notion URLs."
            assert updated.type == "notion"

    async def test_update_fields_on_missing_type_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = ReferenceTypeStore()
        async with session_factory() as session:
            with pytest.raises(ValueError, match="Reference type not found: notion"):
                await store.update_fields(session, "notion", display_name="X")

    async def test_delete_removes_the_row(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = ReferenceTypeStore()
        async with session_factory() as session:
            ada = await _make_user(session, "ada")
            await store.create(session, _type("notion", ada.id))
            await session.commit()

            await store.delete(session, "notion")
            await session.commit()
            assert await store.get(session, "notion") is None

    async def test_delete_missing_type_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = ReferenceTypeStore()
        async with session_factory() as session:
            with pytest.raises(ValueError, match="Reference type not found: notion"):
                await store.delete(session, "notion")

    async def test_count_references_of_type(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = ReferenceTypeStore()
        references = ReferenceStore()
        async with session_factory() as session:
            ada = await _make_user(session, "ada")
            await store.create(session, _type("notion", ada.id))
            await references.create(session, _reference("notion", ada.id))
            await references.create(session, _reference("notion", ada.id))
            await references.create(session, _reference("github", ada.id))
            await session.commit()

            assert await store.count_references_of_type(session, "notion") == 2
            assert await store.count_references_of_type(session, "github") == 1
            assert await store.count_references_of_type(session, "unused") == 0
