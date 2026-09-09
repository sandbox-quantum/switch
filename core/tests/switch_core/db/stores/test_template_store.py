"""The template registry's storage layer, against real Postgres.

The load-bearing property is that a document survives storage untouched: the
registry keeps templates for formats it does not parse, so anything it does to
the bytes on the way in or out is a bug.
"""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Template, User
from switch_core.db.stores.template_store import TemplateStore

_STORE = TemplateStore()

# A document with a params block, CRLF line endings, trailing whitespace, tabs,
# unicode and no trailing newline — every one of which a "helpful" normaliser
# would quietly rewrite.
_AWKWARD_DOCUMENT = (
    "params:\r\n"
    "  owner:\r\n"
    "    type: string\r\n"
    "\tdescription: tab-indented on purpose   \r\n"
    "room:\r\n"
    '  name: "{owner} — café ☕"\r\n'
    "  description: |\n"
    "    trailing spaces follow:   \n"
    "    and a tab:\there\n"
    "  agents: []"
)


async def _make_user(session: AsyncSession, name: str) -> User:
    user = User(name=name, email=f"{name}@test", role="user", password_hash="x")
    session.add(user)
    await session.flush()
    return user


async def _make_template(
    session: AsyncSession,
    *,
    owner_id: str,
    name: str,
    description: str = "d",
    kind: str = "room",
    content: str = "room:\n  name: r\n",
) -> Template:
    return await _STORE.create(
        session,
        Template(
            owner_id=owner_id,
            name=name,
            description=description,
            kind=kind,
            content=content,
        ),
    )


class TestTemplateStoreRoundTrip:
    async def test_document_is_stored_byte_identical(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _make_user(session, "alice")
            created = await _make_template(
                session, owner_id=owner.id, name="awkward", content=_AWKWARD_DOCUMENT
            )
            await session.commit()

        # A second session, so the assertion reads from Postgres rather than
        # from the identity map that just wrote it.
        async with session_factory() as session:
            fetched = await _STORE.get(session, created.id)
            assert fetched is not None
            assert fetched.content == _AWKWARD_DOCUMENT

    async def test_a_document_the_server_cannot_parse_is_still_stored(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Kind-agnostic storage: unknown kinds and unparseable text both keep."""
        garbage = "this: is: not: valid: yaml: at: all\n\t- [unclosed"
        async with session_factory() as session:
            owner = await _make_user(session, "alice")
            created = await _make_template(
                session,
                owner_id=owner.id,
                name="future-format",
                kind="constellation",
                content=garbage,
            )
            await session.commit()

        async with session_factory() as session:
            fetched = await _STORE.get(session, created.id)
            assert fetched is not None
            assert fetched.content == garbage
            assert fetched.kind == "constellation"

    async def test_new_template_starts_at_version_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _make_user(session, "alice")
            created = await _make_template(session, owner_id=owner.id, name="t")
            await session.commit()
            await session.refresh(created)
            assert created.version == 1


class TestTemplateStoreListing:
    async def test_lists_templates_from_every_owner(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The registry is a server-wide catalogue, not a per-user shelf."""
        async with session_factory() as session:
            alice = await _make_user(session, "alice")
            bob = await _make_user(session, "bob")
            await _make_template(session, owner_id=alice.id, name="alice-room")
            await _make_template(session, owner_id=bob.id, name="bob-room")

            listed = {t.name for t in await _STORE.list_all(session)}
            assert listed == {"alice-room", "bob-room"}

    async def test_search_matches_name_and_description(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _make_user(session, "alice")
            await _make_template(
                session, owner_id=owner.id, name="deploy-room", description="unrelated"
            )
            await _make_template(
                session,
                owner_id=owner.id,
                name="unrelated",
                description="for DEPLOYing things",
            )
            await _make_template(
                session, owner_id=owner.id, name="other", description="nothing here"
            )

            hits = {t.name for t in await _STORE.list_all(session, query="deploy")}
            assert hits == {"deploy-room", "unrelated"}

    async def test_search_treats_wildcards_as_literal_text(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`%` is a character someone typed, not a match-everything operator."""
        async with session_factory() as session:
            owner = await _make_user(session, "alice")
            await _make_template(session, owner_id=owner.id, name="100%-coverage")
            await _make_template(session, owner_id=owner.id, name="plain")

            hits = {t.name for t in await _STORE.list_all(session, query="%")}
            assert hits == {"100%-coverage"}

    async def test_filters_by_kind_and_owner(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            alice = await _make_user(session, "alice")
            bob = await _make_user(session, "bob")
            await _make_template(session, owner_id=alice.id, name="a-room", kind="room")
            await _make_template(
                session, owner_id=alice.id, name="a-group", kind="group"
            )
            await _make_template(session, owner_id=bob.id, name="b-room", kind="room")

            by_kind = {t.name for t in await _STORE.list_all(session, kind="room")}
            assert by_kind == {"a-room", "b-room"}

            by_owner = {
                t.name for t in await _STORE.list_all(session, owner_id=alice.id)
            }
            assert by_owner == {"a-room", "a-group"}


class TestTemplateStoreNaming:
    async def test_one_owner_cannot_reuse_a_name(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _make_user(session, "alice")
            await _make_template(session, owner_id=owner.id, name="deploy-room")

            with pytest.raises(ValueError, match="already have a template named"):
                await _make_template(session, owner_id=owner.id, name="deploy-room")

    async def test_a_clash_leaves_the_session_usable(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The savepoint's whole point: the caller can carry on after the error."""
        async with session_factory() as session:
            owner = await _make_user(session, "alice")
            await _make_template(session, owner_id=owner.id, name="deploy-room")
            with pytest.raises(ValueError):
                await _make_template(session, owner_id=owner.id, name="deploy-room")

            await _make_template(session, owner_id=owner.id, name="something-else")
            assert len(await _STORE.list_all(session)) == 2

    async def test_two_owners_may_share_a_name(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            alice = await _make_user(session, "alice")
            bob = await _make_user(session, "bob")
            await _make_template(session, owner_id=alice.id, name="deploy-room")
            await _make_template(session, owner_id=bob.id, name="deploy-room")

            assert len(await _STORE.list_all(session)) == 2


class TestTemplateStoreUpdate:
    async def test_replacing_content_bumps_the_version(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _make_user(session, "alice")
            created = await _make_template(session, owner_id=owner.id, name="t")
            await session.commit()

            updated = await _STORE.update_fields(
                session, created.id, content="room:\n  name: changed\n"
            )
            assert updated.version == 2
            assert updated.content == "room:\n  name: changed\n"

    async def test_metadata_only_edit_leaves_the_version_alone(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _make_user(session, "alice")
            created = await _make_template(session, owner_id=owner.id, name="t")
            await session.commit()

            updated = await _STORE.update_fields(
                session, created.id, description="a better description"
            )
            assert updated.version == 1
            assert updated.description == "a better description"

    async def test_rewriting_identical_content_is_not_a_new_revision(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _make_user(session, "alice")
            created = await _make_template(
                session, owner_id=owner.id, name="t", content="room:\n  name: r\n"
            )
            await session.commit()

            updated = await _STORE.update_fields(
                session, created.id, content="room:\n  name: r\n"
            )
            assert updated.version == 1

    async def test_renaming_onto_a_name_you_already_use_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _make_user(session, "alice")
            await _make_template(session, owner_id=owner.id, name="taken")
            other = await _make_template(session, owner_id=owner.id, name="free")
            await session.commit()

            with pytest.raises(ValueError, match="already have a template named"):
                await _STORE.update_fields(session, other.id, name="taken")

    async def test_update_of_a_missing_template_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            with pytest.raises(ValueError, match="Template not found"):
                await _STORE.update_fields(session, "nope", description="x")


class TestTemplateStoreDelete:
    async def test_delete_removes_the_template(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _make_user(session, "alice")
            created = await _make_template(session, owner_id=owner.id, name="t")

            await _STORE.delete(session, created.id)
            assert await _STORE.get(session, created.id) is None
            assert await _STORE.list_all(session) == []

    async def test_delete_of_a_missing_template_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            with pytest.raises(ValueError, match="Template not found"):
                await _STORE.delete(session, "nope")
