from __future__ import annotations

import logging

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.resource.service import ResourceService
from switch_core.db.models import Reference, ReferenceType, Room, User
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore
from switch_core.db.stores.room_link_store import RoomLinkStore

SERVICE_LOGGER = "switch_core.bridges.resource.service"


@pytest.fixture
def service(session_factory: async_sessionmaker[AsyncSession]) -> ResourceService:
    return ResourceService(
        reference_store=ReferenceStore(),
        reference_type_store=ReferenceTypeStore(),
        document_store=DocumentStore(),
        package_store=PackageStore(),
        room_link_store=RoomLinkStore(),
        session_factory=session_factory,
    )


async def _make_user(session: AsyncSession, name: str) -> User:
    user = User(name=name, email=f"{name}@example.invalid", role="user")
    session.add(user)
    await session.flush()
    return user


@pytest_asyncio.fixture
async def users(
    session_factory: async_sessionmaker[AsyncSession],
) -> dict[str, str]:
    """Two ordinary users and one admin, by role name → id."""
    async with session_factory() as session:
        alice = await _make_user(session, "alice")
        bob = await _make_user(session, "bob")
        root = User(name="root", email="root@example.invalid", role="admin")
        session.add(root)
        await session.flush()
        ids = {"alice": alice.id, "bob": bob.id, "admin": root.id}
        await session.commit()
    return ids


async def _shadow_github(session: AsyncSession, owner_id: str) -> ReferenceType:
    """Write a row whose slug a built-in already owns.

    ``create_reference_type`` refuses this, so it can only arise one way: a
    future release adding a built-in over a slug a user already holds. The store
    is the honest way to reach that state.
    """
    return await ReferenceTypeStore().create(
        session,
        ReferenceType(
            type="github",
            owner_id=owner_id,
            read_visibility="public",
            write_visibility="private",
            display_name="Not GitHub",
            instructions="Shadow instructions.",
            value_hint="Shadow hint.",
        ),
    )


async def _make_room(session: AsyncSession, name: str) -> Room:
    room = Room(
        matrix_room_id=f"!{name}:example.invalid",
        name=name,
        description="",
    )
    session.add(room)
    await session.flush()
    return room


class TestResolution:
    async def test_builtin_wins_a_slug_collision(
        self,
        service: ResourceService,
        session_factory: async_sessionmaker[AsyncSession],
        users: dict[str, str],
    ) -> None:
        async with session_factory() as session:
            await _shadow_github(session, users["alice"])
            await session.commit()

        async with session_factory() as session:
            payload = await service.resolve_types_for_payload(session, {"github"})
            assert payload["github"]["display_name"] == "GitHub"
            assert payload["github"]["origin"] == "builtin"
            assert "Shadow instructions." not in payload["github"]["instructions"]

            views = await service.list_reference_types_for_principal(
                session, user_id=users["alice"], is_admin=False
            )
            github = [v for v in views if v.spec.type == "github"]
            assert len(github) == 1
            assert github[0].is_builtin is True
            assert github[0].owner_id is None

    async def test_log_builtin_shadowing_reports_the_row(
        self,
        service: ResourceService,
        session_factory: async_sessionmaker[AsyncSession],
        users: dict[str, str],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        async with session_factory() as session:
            await _shadow_github(session, users["alice"])
            await session.commit()

        with caplog.at_level(logging.ERROR, logger=SERVICE_LOGGER):
            async with session_factory() as session:
                await service.log_builtin_shadowing(session)

        records = [r for r in caplog.records if r.levelno == logging.ERROR]
        assert len(records) == 1
        assert "github" in records[0].getMessage()
        assert users["alice"] in records[0].getMessage()

    async def test_shadowed_row_stays_manageable(
        self,
        service: ResourceService,
        session_factory: async_sessionmaker[AsyncSession],
        users: dict[str, str],
    ) -> None:
        async with session_factory() as session:
            await _shadow_github(session, users["alice"])
            # A reference of the *built-in* github resolves against the
            # built-in, so it must not block deleting the shadowed row.
            await service.create_reference(
                session,
                owner_id=users["bob"],
                is_admin=False,
                read_visibility="private",
                write_visibility="private",
                type="github",
                name="A repo",
                description="",
                instructions="",
                value={"urls": ["https://example.invalid/org/repo"]},
            )
            await session.commit()

        async with session_factory() as session:
            owned = await service.list_owned_reference_types(
                session, user_id=users["alice"], is_admin=False
            )
            assert [(r.row.type, r.shadowed_by_builtin) for r in owned] == [
                ("github", True)
            ]

            updated = await service.update_reference_type(
                session,
                "github",
                user_id=users["alice"],
                is_admin=False,
                display_name="Renamed",
            )
            assert updated.display_name == "Renamed"

            await service.delete_reference_type(
                session, "github", user_id=users["alice"], is_admin=False
            )
            await session.commit()

        async with session_factory() as session:
            assert (
                await service.list_owned_reference_types(
                    session, user_id=users["alice"], is_admin=False
                )
                == []
            )

    async def test_unreadable_type_is_unknown_and_leaks_no_slugs(
        self,
        service: ResourceService,
        session_factory: async_sessionmaker[AsyncSession],
        users: dict[str, str],
    ) -> None:
        async with session_factory() as session:
            await service.create_reference_type(
                session,
                owner_id=users["alice"],
                type="alice_private",
                display_name="Alice private",
                instructions="i",
                value_hint="h",
                read_visibility="private",
                write_visibility="private",
            )
            await service.create_reference_type(
                session,
                owner_id=users["bob"],
                type="bob_public",
                display_name="Bob public",
                instructions="i",
                value_hint="h",
                read_visibility="public",
                write_visibility="private",
            )
            await session.commit()

        async with session_factory() as session:
            with pytest.raises(ValueError) as excinfo:
                await service.resolve_type_for_principal(
                    session, "alice_private", user_id=users["bob"], is_admin=False
                )
        message = str(excinfo.value)
        assert "Unknown reference type 'alice_private'" in message
        assert "bob_public" in message
        # The private slug appears once — named because the caller asked for it,
        # never as part of the enumeration of what exists.
        assert message.count("alice_private") == 1

    async def test_admin_resolves_another_users_private_type(
        self,
        service: ResourceService,
        session_factory: async_sessionmaker[AsyncSession],
        users: dict[str, str],
    ) -> None:
        async with session_factory() as session:
            await service.create_reference_type(
                session,
                owner_id=users["alice"],
                type="alice_private",
                display_name="Alice private",
                instructions="i",
                value_hint="h",
                read_visibility="private",
                write_visibility="private",
            )
            await session.commit()

        async with session_factory() as session:
            spec = await service.resolve_type_for_principal(
                session, "alice_private", user_id=users["admin"], is_admin=True
            )
        assert spec.display_name == "Alice private"

    async def test_ownerless_principal_sees_builtins_and_public_rows_only(
        self,
        service: ResourceService,
        session_factory: async_sessionmaker[AsyncSession],
        users: dict[str, str],
    ) -> None:
        async with session_factory() as session:
            await service.create_reference_type(
                session,
                owner_id=users["alice"],
                type="alice_private",
                display_name="Alice private",
                instructions="i",
                value_hint="h",
                read_visibility="private",
                write_visibility="private",
            )
            await service.create_reference_type(
                session,
                owner_id=users["alice"],
                type="alice_public",
                display_name="Alice public",
                instructions="i",
                value_hint="h",
                read_visibility="public",
                write_visibility="private",
            )
            await session.commit()

        async with session_factory() as session:
            views = await service.list_reference_types_for_principal(
                session, user_id=None, is_admin=False
            )
        slugs = {v.spec.type for v in views}
        assert "alice_public" in slugs
        assert "alice_private" not in slugs
        assert {"google_drive", "confluence", "github", "jira"} <= slugs


class TestUnresolvableSlugs:
    async def test_resolve_display_names_omits_a_miss(
        self,
        service: ResourceService,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        async with session_factory() as session:
            names = await service.resolve_display_names(
                session, {"jira", "never_registered"}
            )
        assert names == {"jira": "Jira"}

    async def test_resolve_types_for_payload_flags_a_miss_and_logs(
        self,
        service: ResourceService,
        session_factory: async_sessionmaker[AsyncSession],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        with caplog.at_level(logging.ERROR, logger=SERVICE_LOGGER):
            async with session_factory() as session:
                payload = await service.resolve_types_for_payload(
                    session, {"jira", "never_registered"}
                )

        assert payload["jira"].get("missing") is None
        entry = payload["never_registered"]
        assert entry["missing"] is True
        assert entry["origin"] == "unknown"
        assert entry["display_name"] == "never_registered"
        assert "never_registered" in entry["instructions"]

        errors = [r for r in caplog.records if r.levelno == logging.ERROR]
        assert len(errors) == 1
        assert "never_registered" in errors[0].getMessage()

    async def test_room_payload_flags_an_unregistered_type(
        self,
        service: ResourceService,
        session_factory: async_sessionmaker[AsyncSession],
        users: dict[str, str],
    ) -> None:
        """A reference whose slug resolves to nothing is delivered flagged, not
        dropped: the schema permits the state (``references.type`` has no FK)."""
        references = ReferenceStore()
        async with session_factory() as session:
            room = await _make_room(session, "orphan-type")
            ref = await references.create(
                session,
                Reference(
                    owner_id=users["alice"],
                    read_visibility="private",
                    write_visibility="private",
                    type="never_registered",
                    name="Orphan",
                    description="",
                    instructions="",
                    value={"urls": ["https://example.invalid/x"]},
                ),
            )
            await references.attach_to_room(session, room.id, ref.id)
            await session.commit()
            room_id = room.id

        async with session_factory() as session:
            payload = await service.list_room_resources(session, room_id)
        assert payload["reference_types"]["never_registered"]["missing"] is True


class TestPrivateTypeStillReachesAgents:
    async def test_room_payload_carries_a_private_types_instructions(
        self,
        service: ResourceService,
        session_factory: async_sessionmaker[AsyncSession],
        users: dict[str, str],
    ) -> None:
        """``read_visibility`` gates who may *pick* and *enumerate* a
        type, never delivery of its metadata for a reference already attached to
        a room. The attachment is the grant. Withholding the instructions would
        ship an agent a reference it cannot act on while looking healthy — the
        silent-degradation tier CLAUDE.md forbids. Do not "fix" this into a
        visibility filter.
        """
        async with session_factory() as session:
            await service.create_reference_type(
                session,
                owner_id=users["alice"],
                type="alice_private",
                display_name="Alice Private Type",
                instructions="Fetch it with the internal tool.",
                value_hint="h",
                read_visibility="private",
                write_visibility="private",
            )
            room = await _make_room(session, "shared")
            ref = await service.create_reference(
                session,
                owner_id=users["alice"],
                is_admin=False,
                read_visibility="private",
                write_visibility="private",
                type="alice_private",
                name="Alice ref",
                description="",
                instructions="",
                value={"urls": ["https://example.invalid/doc"]},
            )
            await service.attach_reference_to_room(
                session, room.id, ref.id, user_id=users["alice"]
            )
            await session.commit()
            room_id = room.id

        async with session_factory() as session:
            payload = await service.list_room_resources(session, room_id)

        entry = payload["reference_types"]["alice_private"]
        assert entry["display_name"] == "Alice Private Type"
        assert entry["instructions"] == "Fetch it with the internal tool."
        assert entry["origin"] == "user"
        assert entry.get("missing") is None

        # And the type stays unpickable by anyone else.
        async with session_factory() as session:
            with pytest.raises(ValueError, match="Unknown reference type"):
                await service.resolve_type_for_principal(
                    session, "alice_private", user_id=users["bob"], is_admin=False
                )


class TestCreateReferenceType:
    async def test_non_admin_may_create_a_public_read_type(
        self,
        service: ResourceService,
        session_factory: async_sessionmaker[AsyncSession],
        users: dict[str, str],
    ) -> None:
        """Any authenticated user may create a type with the full read/write
        visibility pair, exactly like a Reference. There is no admin gate on
        ``read_visibility="public"``; the only pair rule is the existing
        write-implies-read invariant in ``authz.validate_visibility_pair``.

        The mitigation for user-authored, agent-facing instructions is
        disclosure (owner and built-in marker travel on the picker payload), not
        restriction. Adding an admin gate is a deliberate tightening — it means
        changing this test, not just the service.
        """
        async with session_factory() as session:
            created = await service.create_reference_type(
                session,
                owner_id=users["alice"],
                type="notion",
                display_name="Notion",
                instructions="Open the linked Notion pages.",
                value_hint="Paste Notion page links.",
                read_visibility="public",
                write_visibility="private",
            )
            await session.commit()

        assert created.type == "notion"
        assert created.read_visibility == "public"
        assert created.owner_id == users["alice"]

        # The one pair rule that does apply, for the same non-admin principal.
        async with session_factory() as session:
            with pytest.raises(ValueError, match="write_visibility=public"):
                await service.create_reference_type(
                    session,
                    owner_id=users["alice"],
                    type="linear",
                    display_name="Linear",
                    instructions="i",
                    value_hint="h",
                    read_visibility="private",
                    write_visibility="public",
                )

    async def test_builtin_slug_is_refused(
        self,
        service: ResourceService,
        session_factory: async_sessionmaker[AsyncSession],
        users: dict[str, str],
    ) -> None:
        async with session_factory() as session:
            with pytest.raises(ValueError, match="built-in reference type"):
                await service.create_reference_type(
                    session,
                    owner_id=users["alice"],
                    type="jira",
                    display_name="My Jira",
                    instructions="i",
                    value_hint="h",
                    read_visibility="private",
                    write_visibility="private",
                )

    @pytest.mark.parametrize(
        "slug",
        ["Notion", "n", "9lives", "my-type", "my type", "my_type!", "", "a" * 64],
    )
    async def test_invalid_slug_is_rejected_not_normalised(
        self,
        service: ResourceService,
        session_factory: async_sessionmaker[AsyncSession],
        users: dict[str, str],
        slug: str,
    ) -> None:
        async with session_factory() as session:
            with pytest.raises(ValueError, match="Invalid reference type"):
                await service.create_reference_type(
                    session,
                    owner_id=users["alice"],
                    type=slug,
                    display_name="X",
                    instructions="i",
                    value_hint="h",
                    read_visibility="private",
                    write_visibility="private",
                )

    async def test_duplicate_slug_is_refused(
        self,
        service: ResourceService,
        session_factory: async_sessionmaker[AsyncSession],
        users: dict[str, str],
    ) -> None:
        async with session_factory() as session:
            await service.create_reference_type(
                session,
                owner_id=users["alice"],
                type="notion",
                display_name="Notion",
                instructions="i",
                value_hint="h",
                read_visibility="public",
                write_visibility="private",
            )
            await session.commit()

        async with session_factory() as session:
            with pytest.raises(ValueError, match="already exists"):
                await service.create_reference_type(
                    session,
                    owner_id=users["bob"],
                    type="notion",
                    display_name="Bob's Notion",
                    instructions="i",
                    value_hint="h",
                    read_visibility="private",
                    write_visibility="private",
                )


class TestUpdateAndDeleteReferenceType:
    async def test_non_owner_cannot_update_or_delete(
        self,
        service: ResourceService,
        session_factory: async_sessionmaker[AsyncSession],
        users: dict[str, str],
    ) -> None:
        async with session_factory() as session:
            await service.create_reference_type(
                session,
                owner_id=users["alice"],
                type="notion",
                display_name="Notion",
                instructions="i",
                value_hint="h",
                read_visibility="public",
                write_visibility="private",
            )
            await session.commit()

        async with session_factory() as session:
            with pytest.raises(PermissionError):
                await service.update_reference_type(
                    session,
                    "notion",
                    user_id=users["bob"],
                    is_admin=False,
                    display_name="Hijacked",
                )
            with pytest.raises(PermissionError):
                await service.delete_reference_type(
                    session, "notion", user_id=users["bob"], is_admin=False
                )

    async def test_update_rejects_a_writable_but_unreadable_result(
        self,
        service: ResourceService,
        session_factory: async_sessionmaker[AsyncSession],
        users: dict[str, str],
    ) -> None:
        async with session_factory() as session:
            await service.create_reference_type(
                session,
                owner_id=users["alice"],
                type="notion",
                display_name="Notion",
                instructions="i",
                value_hint="h",
                read_visibility="public",
                write_visibility="public",
            )
            await session.commit()

        async with session_factory() as session:
            with pytest.raises(ValueError, match="write_visibility=public"):
                await service.update_reference_type(
                    session,
                    "notion",
                    user_id=users["alice"],
                    is_admin=False,
                    read_visibility="private",
                )

    async def test_delete_is_refused_while_references_exist(
        self,
        service: ResourceService,
        session_factory: async_sessionmaker[AsyncSession],
        users: dict[str, str],
    ) -> None:
        async with session_factory() as session:
            await service.create_reference_type(
                session,
                owner_id=users["alice"],
                type="notion",
                display_name="Notion",
                instructions="i",
                value_hint="h",
                read_visibility="private",
                write_visibility="private",
            )
            await service.create_reference(
                session,
                owner_id=users["alice"],
                is_admin=False,
                read_visibility="private",
                write_visibility="private",
                type="notion",
                name="A page",
                description="",
                instructions="",
                value={"urls": ["https://example.invalid/page"]},
            )
            await session.commit()

        async with session_factory() as session:
            with pytest.raises(ValueError, match="used by 1 reference"):
                await service.delete_reference_type(
                    session, "notion", user_id=users["alice"], is_admin=False
                )

    async def test_missing_type_raises(
        self,
        service: ResourceService,
        session_factory: async_sessionmaker[AsyncSession],
        users: dict[str, str],
    ) -> None:
        async with session_factory() as session:
            with pytest.raises(ValueError, match="Reference type not found"):
                await service.delete_reference_type(
                    session, "never_registered", user_id=users["alice"], is_admin=False
                )


class TestCreateReferenceResolvesItsType:
    async def test_unknown_type_is_refused(
        self,
        service: ResourceService,
        session_factory: async_sessionmaker[AsyncSession],
        users: dict[str, str],
    ) -> None:
        async with session_factory() as session:
            with pytest.raises(ValueError, match="Unknown reference type"):
                await service.create_reference(
                    session,
                    owner_id=users["alice"],
                    is_admin=False,
                    read_visibility="private",
                    write_visibility="private",
                    type="never_registered",
                    name="X",
                    description="",
                    instructions="",
                    value={"urls": ["https://example.invalid/x"]},
                )

    async def test_another_users_private_type_is_refused(
        self,
        service: ResourceService,
        session_factory: async_sessionmaker[AsyncSession],
        users: dict[str, str],
    ) -> None:
        async with session_factory() as session:
            await service.create_reference_type(
                session,
                owner_id=users["alice"],
                type="alice_private",
                display_name="Alice private",
                instructions="i",
                value_hint="h",
                read_visibility="private",
                write_visibility="private",
            )
            await session.commit()

        async with session_factory() as session:
            with pytest.raises(ValueError, match="Unknown reference type"):
                await service.create_reference(
                    session,
                    owner_id=users["bob"],
                    is_admin=False,
                    read_visibility="private",
                    write_visibility="private",
                    type="alice_private",
                    name="X",
                    description="",
                    instructions="",
                    value={"urls": ["https://example.invalid/x"]},
                )
