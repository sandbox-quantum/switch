"""Removing a member hands what they own in the workspace to an heir
(`organization_access.remove_membership`), so nothing there is left owned by
someone who can no longer reach it: the admin removing them, or, for a
removal from outside the workspace, its longest-standing other admin."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    AuditEvent,
    Document,
    Package,
    Reference,
    ReferenceType,
    Room,
    Template,
    TenantMember,
)
from switch_core.db.session_scope import tenant_session
from switch_core.organization_access import removal_heir
from tests.switch_core.gateway.test_tenant_api_routes import (
    TENANT_A,
    TENANT_B,
    _app,
    _client,
    _make_member,
    _make_tenant,
    _token,
)


def _library_document(owner_id: str, room_id: str | None = None) -> Document:
    return Document(
        owner_id=owner_id,
        room_id=room_id,
        read_visibility="public",
        write_visibility="private",
        name=f"doc-{uuid.uuid4().hex[:6]}",
        description="",
        instructions="",
        content="",
    )


def _room(owner_id: str, metadata: dict[str, str] | None = None) -> Room:
    return Room(
        transport_room_id=f"!{uuid.uuid4().hex}:test",
        name=f"room-{uuid.uuid4().hex[:6]}",
        description="",
        owner_id=owner_id,
        created_by=owner_id,
        read_visibility="private",
        metadata_=metadata,
    )


async def test_the_admin_removing_a_member_takes_over_what_they_own(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _make_tenant(session_factory, TENANT_A)
    admin_id = await _make_member(
        session_factory, name="remover", tenant_id=TENANT_A, role="admin"
    )
    member_id = await _make_member(
        session_factory, name="leaving", tenant_id=TENANT_A, role="member"
    )
    async with tenant_session(session_factory, TENANT_A) as session:
        package = Package(
            owner_id=member_id,
            name="kit",
            description="",
            instructions="",
            read_visibility="private",
            write_visibility="private",
        )
        reference = Reference(
            owner_id=member_id,
            read_visibility="private",
            write_visibility="private",
            type="url",
            name="link",
            description="",
            instructions="",
            value={"url": "https://example.test"},
        )
        room = _room(member_id)
        chat = _room(member_id, {"chat_operation_id": "op"})
        library = _library_document(member_id)
        template = Template(
            owner_id=member_id, name="plan", description="", kind="room", content="x"
        )
        clashing = Template(
            owner_id=member_id, name="same", description="", kind="room", content="y"
        )
        admins = Template(
            owner_id=admin_id, name="same", description="", kind="room", content="z"
        )
        clashing_elsewhere = Template(
            owner_id=member_id,
            name="elsewhere",
            description="",
            kind="room",
            content="w",
        )
        reference_type = ReferenceType(
            type="ticket",
            owner_id=member_id,
            read_visibility="public",
            write_visibility="private",
            display_name="Ticket",
            instructions="",
            value_hint="",
        )
        session.add_all(
            [
                package,
                reference,
                reference_type,
                room,
                chat,
                library,
                template,
                clashing,
                clashing_elsewhere,
                admins,
            ]
        )
        await session.flush()
        in_chat = _library_document(member_id, room_id=chat.id)
        session.add(in_chat)
        await session.commit()
        handed = {
            Package: package.id,
            Reference: reference.id,
            Room: room.id,
            Document: library.id,
            Template: template.id,
        }
        kept = {Room: chat.id, Document: in_chat.id, Template: clashing.id}
        kept_elsewhere = clashing_elsewhere.id
    # Template names are unique per owner across workspaces, and the removal's
    # session can't see this one in another workspace.
    await _make_tenant(session_factory, TENANT_B)
    async with tenant_session(session_factory, TENANT_B) as session:
        session.add(
            Template(
                owner_id=admin_id,
                name="elsewhere",
                description="",
                kind="room",
                content="v",
            )
        )
        await session.commit()

    token = _token(admin_id, "remover@example.invalid", TENANT_A)
    async with _client(_app(session_factory), token) as client:
        preview = await client.get(f"/tenants/{TENANT_A}/members/{member_id}/removal")
        response = await client.delete(f"/tenants/{TENANT_A}/members/{member_id}")
    assert preview.status_code == 200, preview.text
    assert response.status_code == 200, response.text
    heir = preview.json()["handed_over_to"]
    assert heir["user_id"] == admin_id
    assert heir["name"] and heir["email"]
    assert response.json() == {
        "ok": True,
        "warning": None,
        "handed_over_to": heir,
        "handed_over": {
            "room": 1,
            "package": 1,
            "reference": 1,
            "reference_type": 1,
            "document": 1,
            "template": 1,
        },
    }

    async with tenant_session(session_factory, TENANT_A) as session:
        for model, row_id in handed.items():
            owner = await session.scalar(
                select(model.owner_id).where(model.id == row_id)
            )
            assert owner == admin_id, model.__name__
        for model, row_id in kept.items():
            owner = await session.scalar(
                select(model.owner_id).where(model.id == row_id)
            )
            assert owner == member_id, model.__name__
        assert (
            await session.scalar(
                select(Template.owner_id).where(Template.id == kept_elsewhere)
            )
            == member_id
        )
        assert (
            await session.scalar(
                select(ReferenceType.owner_id).where(ReferenceType.type == "ticket")
            )
            == admin_id
        )
        typed = await session.scalar(
            select(AuditEvent).where(
                AuditEvent.action == "ownership.transferred",
                AuditEvent.target_type == "reference_type",
            )
        )
        assert typed is not None and typed.target_id == "ticket"
        moved = await session.scalar(
            select(AuditEvent).where(AuditEvent.target_id == package.id)
        )
        assert moved is not None
        assert moved.action == "ownership.transferred"
        assert moved.actor_user_id == admin_id
        assert moved.details is not None
        assert moved.details["reason"] == "member_removed"
        removal = await session.scalar(
            select(AuditEvent).where(
                AuditEvent.action == "member.removed",
                AuditEvent.target_id == member_id,
            )
        )
        assert removal is not None and removal.details is not None
        assert removal.details["handed_over_to"] == admin_id
        assert removal.details["handed_over"] == {
            "room": 1,
            "package": 1,
            "reference": 1,
            "reference_type": 1,
            "document": 1,
            "template": 1,
        }


async def test_from_outside_the_workspace_the_longest_standing_admin_takes_over(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The server's operator removing someone without being a member, or the
    organization's directory removing them, leaves no remover in the
    workspace to take over: its longest-standing other admin does."""
    await _make_tenant(session_factory, TENANT_A)
    joined = datetime(2026, 1, 1, tzinfo=UTC)
    later = await _make_member(
        session_factory, name="later-admin", tenant_id=TENANT_A, role="admin"
    )
    first = await _make_member(
        session_factory, name="first-admin", tenant_id=TENANT_A, role="admin"
    )
    leaving = await _make_member(
        session_factory, name="leaving", tenant_id=TENANT_A, role="admin"
    )
    outsider = "operator-without-a-membership"
    async with tenant_session(session_factory, TENANT_A) as session:
        for user_id, when in (
            (leaving, joined - timedelta(days=9)),
            (first, joined),
            (later, joined + timedelta(days=1)),
        ):
            row = await session.get(TenantMember, (TENANT_A, user_id))
            assert row is not None
            row.created_at = when  # type: ignore[assignment]
        await session.commit()

        assert (
            await removal_heir(session, TENANT_A, leaving, outsider, lock=True) == first
        )
        assert await removal_heir(session, TENANT_A, leaving, None, lock=True) == first
        assert await removal_heir(session, TENANT_A, leaving, later, lock=True) == later
        assert await removal_heir(session, TENANT_A, leaving, None, lock=False) == first


async def test_with_no_other_admin_what_they_own_stays_theirs(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _make_tenant(session_factory, TENANT_A)
    leaving = await _make_member(
        session_factory, name="leaving", tenant_id=TENANT_A, role="member"
    )
    async with tenant_session(session_factory, TENANT_A) as session:
        assert await removal_heir(session, TENANT_A, leaving, None, lock=True) is None


async def test_an_admin_leaving_is_told_who_takes_over_before_and_after(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Leaving leaves no remover to take over: the longest-standing other
    admin does, and both the preview and the removal name them."""
    await _make_tenant(session_factory, TENANT_A)
    first = await _make_member(
        session_factory, name="first-admin", tenant_id=TENANT_A, role="admin"
    )
    leaving = await _make_member(
        session_factory, name="leaving", tenant_id=TENANT_A, role="admin"
    )
    async with tenant_session(session_factory, TENANT_A) as session:
        session.add(_room(leaving))
        await session.commit()

    token = _token(leaving, "leaving@example.invalid", TENANT_A)
    async with _client(_app(session_factory), token) as client:
        preview = await client.get(f"/tenants/{TENANT_A}/members/{leaving}/removal")
        response = await client.delete(f"/tenants/{TENANT_A}/members/{leaving}")
    assert preview.status_code == 200, preview.text
    assert response.status_code == 200, response.text
    assert preview.json()["handed_over_to"]["user_id"] == first
    body = response.json()
    assert body["handed_over_to"] == preview.json()["handed_over_to"]
    assert body["handed_over"] == {"room": 1}


async def test_the_preview_of_removing_a_non_member_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _make_tenant(session_factory, TENANT_A)
    admin_id = await _make_member(
        session_factory, name="admin", tenant_id=TENANT_A, role="admin"
    )
    token = _token(admin_id, "admin@example.invalid", TENANT_A)
    async with _client(_app(session_factory), token) as client:
        response = await client.get(f"/tenants/{TENANT_A}/members/nobody/removal")
    assert response.status_code == 404, response.text
