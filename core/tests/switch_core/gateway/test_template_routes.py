"""The template registry's HTTP surface, against real Postgres and real stores.

These cover the acceptance conditions for the registry: a document survives the
round trip unchanged, the catalogue shows every owner's templates, and deleting
someone else's is refused.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.stores.template_store import TemplateStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.schemas import (
    TemplateCreateRequest,
    TemplateUpdateRequest,
)
from switch_core.gateway.templates import (
    create_template,
    delete_template,
    get_template,
    get_template_content,
    list_templates,
    patch_template,
)
from tests.switch_core.gateway.agent_route_harness import add_user

_TEMPLATE_STORE = TemplateStore()
_USER_STORE = UserStore()

# Awkward on purpose: CRLF, a tab, trailing spaces, unicode, no final newline.
_AWKWARD_DOCUMENT = (
    "params:\r\n"
    "  owner:\r\n"
    "    type: string\r\n"
    "room:\r\n"
    '  name: "{owner} — café ☕"   \r\n'
    "  description: |\n"
    "    tabbed:\there\n"
    "  agents: []"
)


def _config(**overrides: object) -> SwitchConfig:
    base: dict[str, object] = {
        "db_host": "localhost",
        "db_port": "5432",
        "db_user": "u",
        "db_password": "p",
        "db_name": "d",
        "matrix_server_name": "test",
        "agent_registration_token": "t",
        "jwt_secret_key": "s",
        "gateway_admin_email": "admin@test",
        "gateway_admin_password": "pw",
    }
    base.update(overrides)
    return SwitchConfig(**base)  # type: ignore[arg-type]


async def _create(
    session: AsyncSession,
    user: object,
    *,
    name: str,
    description: str = "d",
    kind: str = "room",
    content: str = "room:\n  name: r\n",
    config: SwitchConfig | None = None,
) -> object:
    return await create_template(
        TemplateCreateRequest(
            name=name, description=description, kind=kind, content=content
        ),
        session,
        _TEMPLATE_STORE,
        _USER_STORE,
        config or _config(),
        user,  # type: ignore[arg-type]
    )


class TestUploadAndFetch:
    async def test_a_document_round_trips_byte_identical(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="alice")
            await session.commit()

            created = await _create(
                session, owner, name="awkward", content=_AWKWARD_DOCUMENT
            )

            fetched = await get_template(
                created.id,  # type: ignore[attr-defined]
                session,
                _TEMPLATE_STORE,
                _USER_STORE,
                owner,
            )
            assert fetched.content == _AWKWARD_DOCUMENT

            raw = await get_template_content(
                created.id,  # type: ignore[attr-defined]
                session,
                _TEMPLATE_STORE,
                owner,
            )
            assert raw.body.decode("utf-8") == _AWKWARD_DOCUMENT
            assert raw.media_type == "application/x-yaml"

    async def test_upload_reports_the_owner_and_starts_at_version_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="alice")
            await session.commit()

            created = await _create(session, owner, name="t")
            assert created.owner_name == "alice"  # type: ignore[attr-defined]
            assert created.version == 1  # type: ignore[attr-defined]

    async def test_size_is_measured_in_bytes_not_characters(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="alice")
            await session.commit()

            created = await _create(session, owner, name="t", content="☕")
            assert created.size_bytes == 3  # type: ignore[attr-defined]

    async def test_reusing_your_own_name_is_a_conflict(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="alice")
            await session.commit()
            await _create(session, owner, name="deploy-room")

            with pytest.raises(HTTPException) as exc:
                await _create(session, owner, name="deploy-room")
            assert exc.value.status_code == 409

    async def test_fetching_a_missing_template_is_a_404(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="alice")
            await session.commit()

            with pytest.raises(HTTPException) as exc:
                await get_template("nope", session, _TEMPLATE_STORE, _USER_STORE, owner)
            assert exc.value.status_code == 404


class TestSizeLimit:
    async def test_an_oversize_upload_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="alice")
            await session.commit()

            with pytest.raises(HTTPException) as exc:
                await _create(
                    session,
                    owner,
                    name="huge",
                    content="x" * 101,
                    config=_config(template_max_bytes=100),
                )
            assert exc.value.status_code == 413
            assert "over the 100-byte limit" in exc.value.detail

    async def test_nothing_is_stored_when_an_upload_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="alice")
            await session.commit()

            with pytest.raises(HTTPException):
                await _create(
                    session,
                    owner,
                    name="huge",
                    content="x" * 101,
                    config=_config(template_max_bytes=100),
                )
            assert await _TEMPLATE_STORE.list_all(session) == []

    async def test_the_limit_counts_bytes_so_multibyte_text_cannot_slip_past(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Ten ☕ is ten characters but thirty bytes."""
        async with session_factory() as session:
            owner = await add_user(session, name="alice")
            await session.commit()

            with pytest.raises(HTTPException) as exc:
                await _create(
                    session,
                    owner,
                    name="coffee",
                    content="☕" * 10,
                    config=_config(template_max_bytes=20),
                )
            assert exc.value.status_code == 413


class TestCatalogue:
    async def test_every_owners_templates_are_listed(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            alice = await add_user(session, name="alice")
            bob = await add_user(session, name="bob")
            await session.commit()
            await _create(session, alice, name="alice-room")
            await _create(session, bob, name="bob-room")

            # Listed identically whoever is asking.
            for caller in (alice, bob):
                listed = await list_templates(
                    session, _TEMPLATE_STORE, _USER_STORE, caller
                )
                assert {t.name for t in listed} == {"alice-room", "bob-room"}
                assert {t.owner_name for t in listed} == {"alice", "bob"}

    async def test_listing_omits_the_document_bodies(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="alice")
            await session.commit()
            await _create(session, owner, name="t", content=_AWKWARD_DOCUMENT)

            listed = await list_templates(session, _TEMPLATE_STORE, _USER_STORE, owner)
            assert not hasattr(listed[0], "content")
            assert listed[0].size_bytes == len(_AWKWARD_DOCUMENT.encode("utf-8"))

    async def test_search_matches_name_and_description(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="alice")
            await session.commit()
            await _create(session, owner, name="deploy-room", description="x")
            await _create(session, owner, name="other", description="for DEPLOYing")
            await _create(session, owner, name="unrelated", description="x")

            hits = await list_templates(
                session, _TEMPLATE_STORE, _USER_STORE, owner, q="deploy"
            )
            assert {t.name for t in hits} == {"deploy-room", "other"}

    async def test_filters_by_kind(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="alice")
            await session.commit()
            await _create(session, owner, name="a", kind="room")
            await _create(session, owner, name="b", kind="group")

            hits = await list_templates(
                session, _TEMPLATE_STORE, _USER_STORE, owner, kind="group"
            )
            assert {t.name for t in hits} == {"b"}


class TestOwnership:
    async def test_deleting_someone_elses_template_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            alice = await add_user(session, name="alice")
            bob = await add_user(session, name="bob")
            await session.commit()
            created = await _create(session, alice, name="alice-room")

            with pytest.raises(HTTPException) as exc:
                await delete_template(
                    created.id,  # type: ignore[attr-defined]
                    session,
                    _TEMPLATE_STORE,
                    bob,
                )
            assert exc.value.status_code == 403
            assert await _TEMPLATE_STORE.get(session, created.id) is not None  # type: ignore[attr-defined]

    async def test_editing_someone_elses_template_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            alice = await add_user(session, name="alice")
            bob = await add_user(session, name="bob")
            await session.commit()
            created = await _create(session, alice, name="alice-room")

            with pytest.raises(HTTPException) as exc:
                await patch_template(
                    created.id,  # type: ignore[attr-defined]
                    TemplateUpdateRequest(content="room:\n  name: hijacked\n"),
                    session,
                    _TEMPLATE_STORE,
                    _USER_STORE,
                    _config(),
                    bob,
                )
            assert exc.value.status_code == 403

    async def test_anyone_may_read_anyone_elses_template(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Ownership governs change, not visibility."""
        async with session_factory() as session:
            alice = await add_user(session, name="alice")
            bob = await add_user(session, name="bob")
            await session.commit()
            created = await _create(
                session, alice, name="alice-room", content=_AWKWARD_DOCUMENT
            )

            fetched = await get_template(
                created.id,  # type: ignore[attr-defined]
                session,
                _TEMPLATE_STORE,
                _USER_STORE,
                bob,
            )
            assert fetched.content == _AWKWARD_DOCUMENT

    async def test_an_owner_may_delete_their_own(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            alice = await add_user(session, name="alice")
            await session.commit()
            created = await _create(session, alice, name="alice-room")

            result = await delete_template(
                created.id,  # type: ignore[attr-defined]
                session,
                _TEMPLATE_STORE,
                alice,
            )
            assert result.deleted_id == created.id  # type: ignore[attr-defined]
            assert await _TEMPLATE_STORE.get(session, created.id) is None  # type: ignore[attr-defined]

    async def test_an_admin_may_delete_anyones(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            alice = await add_user(session, name="alice")
            admin = await add_user(session, name="root", role="admin")
            await session.commit()
            created = await _create(session, alice, name="alice-room")

            await delete_template(
                created.id,  # type: ignore[attr-defined]
                session,
                _TEMPLATE_STORE,
                admin,
            )
            assert await _TEMPLATE_STORE.get(session, created.id) is None  # type: ignore[attr-defined]

    async def test_deleting_a_missing_template_is_a_404(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            alice = await add_user(session, name="alice")
            await session.commit()

            with pytest.raises(HTTPException) as exc:
                await delete_template("nope", session, _TEMPLATE_STORE, alice)
            assert exc.value.status_code == 404


class TestUpdate:
    async def test_replacing_content_bumps_the_version(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            alice = await add_user(session, name="alice")
            await session.commit()
            created = await _create(session, alice, name="t")

            updated = await patch_template(
                created.id,  # type: ignore[attr-defined]
                TemplateUpdateRequest(content="room:\n  name: changed\n"),
                session,
                _TEMPLATE_STORE,
                _USER_STORE,
                _config(),
                alice,
            )
            assert updated.version == 2
            assert updated.content == "room:\n  name: changed\n"

    async def test_a_metadata_edit_leaves_the_version_alone(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            alice = await add_user(session, name="alice")
            await session.commit()
            created = await _create(session, alice, name="t")

            updated = await patch_template(
                created.id,  # type: ignore[attr-defined]
                TemplateUpdateRequest(description="clearer"),
                session,
                _TEMPLATE_STORE,
                _USER_STORE,
                _config(),
                alice,
            )
            assert updated.version == 1
            assert updated.description == "clearer"

    async def test_an_oversize_replacement_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            alice = await add_user(session, name="alice")
            await session.commit()
            created = await _create(session, alice, name="t", content="small")

            with pytest.raises(HTTPException) as exc:
                await patch_template(
                    created.id,  # type: ignore[attr-defined]
                    TemplateUpdateRequest(content="x" * 101),
                    session,
                    _TEMPLATE_STORE,
                    _USER_STORE,
                    _config(template_max_bytes=100),
                    alice,
                )
            assert exc.value.status_code == 413
            stored = await _TEMPLATE_STORE.get(session, created.id)  # type: ignore[attr-defined]
            assert stored is not None and stored.content == "small"

    async def test_renaming_onto_a_name_you_already_use_is_a_conflict(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            alice = await add_user(session, name="alice")
            await session.commit()
            await _create(session, alice, name="taken")
            other = await _create(session, alice, name="free")

            with pytest.raises(HTTPException) as exc:
                await patch_template(
                    other.id,  # type: ignore[attr-defined]
                    TemplateUpdateRequest(name="taken"),
                    session,
                    _TEMPLATE_STORE,
                    _USER_STORE,
                    _config(),
                    alice,
                )
            assert exc.value.status_code == 409
