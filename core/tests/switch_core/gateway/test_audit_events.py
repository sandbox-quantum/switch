"""The workspace audit log: which gateway actions leave an `audit_events` row,
who can read the log back, and that the runtime role cannot rewrite it."""

from __future__ import annotations

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import AuditEvent
from switch_core.db.session_scope import tenant_session
from switch_core.gateway import api_keys
from tests.conftest import RLSHarness
from tests.switch_core.gateway.test_tenant_api_routes import (
    TENANT_A,
    TENANT_B,
    _app,
    _client,
    _fake_protocol,
    _make_member,
    _make_tenant,
    _token,
)


async def _events(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str
) -> list[AuditEvent]:
    async with session_factory() as session:
        result = await session.execute(
            select(AuditEvent)
            .where(AuditEvent.tenant_id == tenant_id)
            .order_by(AuditEvent.occurred_at)
        )
        return list(result.scalars().all())


async def _owner(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str, name: str
) -> tuple[str, str]:
    await _make_tenant(session_factory, tenant_id)
    owner_id = await _make_member(
        session_factory, name=name, tenant_id=tenant_id, role="owner"
    )
    return owner_id, _token(owner_id, f"{name}@example.invalid", tenant_id)


class TestMembershipEvents:
    async def test_a_role_change_is_recorded_with_both_roles(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner_id, token = await _owner(session_factory, TENANT_A, "audit-owner")
        member_id = await _make_member(
            session_factory, name="audit-member", tenant_id=TENANT_A, role="member"
        )

        async with _client(_app(session_factory), token) as client:
            response = await client.patch(
                f"/tenants/{TENANT_A}/members/{member_id}", json={"role": "admin"}
            )
        assert response.status_code == 200, response.text

        [event] = await _events(session_factory, TENANT_A)
        assert event.action == AuditAction.MEMBER_ROLE_CHANGED
        assert event.actor_user_id == owner_id
        assert event.target_type == "user"
        assert event.target_id == member_id
        assert event.details == {"from": "member", "to": "admin"}

    async def test_setting_the_same_role_records_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _, token = await _owner(session_factory, TENANT_A, "audit-owner")
        member_id = await _make_member(
            session_factory, name="audit-member", tenant_id=TENANT_A, role="member"
        )

        async with _client(_app(session_factory), token) as client:
            response = await client.patch(
                f"/tenants/{TENANT_A}/members/{member_id}", json={"role": "member"}
            )
        assert response.status_code == 200, response.text

        assert await _events(session_factory, TENANT_A) == []

    async def test_removing_a_member_is_recorded(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner_id, token = await _owner(session_factory, TENANT_A, "audit-owner")
        member_id = await _make_member(
            session_factory, name="audit-member", tenant_id=TENANT_A, role="member"
        )

        async with _client(_app(session_factory), token) as client:
            response = await client.delete(f"/tenants/{TENANT_A}/members/{member_id}")
        assert response.status_code in (200, 204), response.text

        [event] = await _events(session_factory, TENANT_A)
        assert event.action == AuditAction.MEMBER_REMOVED
        assert event.actor_user_id == owner_id
        assert event.target_id == member_id
        assert event.details is not None
        assert event.details["role"] == "member"

    async def test_a_refused_change_records_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner_id, token = await _owner(session_factory, TENANT_A, "sole-owner")

        async with _client(_app(session_factory), token) as client:
            response = await client.patch(
                f"/tenants/{TENANT_A}/members/{owner_id}", json={"role": "member"}
            )
        assert response.status_code == 409

        assert await _events(session_factory, TENANT_A) == []


class TestInvitationEvents:
    async def test_creating_and_revoking_an_invitation_are_both_recorded(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner_id, token = await _owner(session_factory, TENANT_A, "audit-owner")

        async with _client(_app(session_factory), token) as client:
            created = await client.post(
                f"/tenants/{TENANT_A}/invitations", json={"role": "member"}
            )
            assert created.status_code == 201, created.text
            invitation_id = created.json()["id"]
            revoked = await client.delete(
                f"/tenants/{TENANT_A}/invitations/{invitation_id}"
            )
            assert revoked.status_code == 200, revoked.text

        events = await _events(session_factory, TENANT_A)
        assert [e.action for e in events] == [
            AuditAction.INVITATION_CREATED,
            AuditAction.INVITATION_REVOKED,
        ]
        assert {e.target_id for e in events} == {invitation_id}
        assert {e.actor_user_id for e in events} == {owner_id}
        assert events[0].details is not None
        assert events[0].details["role"] == "member"


class TestApiKeyEvents:
    async def test_create_reveal_and_delete_are_recorded_without_the_key(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(api_keys, "get_protocol", _fake_protocol)
        user_id, token = await _owner(session_factory, TENANT_A, "key-owner")
        app = _app(session_factory)
        app.include_router(api_keys.router, prefix="/api-keys")

        async with _client(app, token) as client:
            created = await client.post("/api-keys", json={"label": "laptop"})
            assert created.status_code == 200, created.text
            key_id = created.json()["id"]
            plaintext = created.json()["key"]
            revealed = await client.get(f"/api-keys/{key_id}/reveal")
            assert revealed.status_code == 200, revealed.text
            deleted = await client.delete(f"/api-keys/{key_id}")
            assert deleted.status_code == 200, deleted.text

        events = await _events(session_factory, TENANT_A)
        assert [e.action for e in events] == [
            AuditAction.API_KEY_CREATED,
            AuditAction.API_KEY_REVEALED,
            AuditAction.API_KEY_DELETED,
        ]
        assert {e.target_id for e in events} == {key_id}
        assert {e.actor_user_id for e in events} == {user_id}
        for event in events:
            assert plaintext not in str(event.details)


class TestReadingTheLog:
    async def test_admins_read_their_own_tenant_newest_first(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner_id, token = await _owner(session_factory, TENANT_A, "audit-owner")
        await _make_tenant(session_factory, TENANT_B)
        for tenant_id, action in (
            (TENANT_A, AuditAction.JOIN_DOMAIN_ADDED),
            (TENANT_B, AuditAction.TENANT_CREATED),
            (TENANT_A, AuditAction.JOIN_DOMAIN_REMOVED),
        ):
            async with tenant_session(session_factory, tenant_id) as session:
                await record_audit_event(
                    session,
                    tenant_id=tenant_id,
                    actor_user_id=owner_id,
                    action=action,
                    target_type="join_domain",
                    target_id="example.invalid",
                    details=None,
                )
                await session.commit()

        async with _client(_app(session_factory), token) as client:
            response = await client.get(f"/tenants/{TENANT_A}/audit-events")
            assert response.status_code == 200, response.text
            rows = response.json()
            assert [r["action"] for r in rows] == [
                AuditAction.JOIN_DOMAIN_REMOVED,
                AuditAction.JOIN_DOMAIN_ADDED,
            ]

            older = await client.get(
                f"/tenants/{TENANT_A}/audit-events",
                params={"before": rows[0]["occurred_at"]},
            )
            assert older.status_code == 200, older.text
            assert [r["action"] for r in older.json()] == [
                AuditAction.JOIN_DOMAIN_ADDED
            ]

            other_tenant = await client.get(f"/tenants/{TENANT_B}/audit-events")
            assert other_tenant.status_code in (403, 404)

    async def test_a_plain_member_cannot_read_the_log(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        member_id = await _make_member(
            session_factory, name="audit-member", tenant_id=TENANT_A, role="member"
        )
        token = _token(member_id, "audit-member@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.get(f"/tenants/{TENANT_A}/audit-events")

        assert response.status_code == 403


@pytest.mark.no_ambient_tenant
class TestAppendOnly:
    async def _seed(self, rls_harness: RLSHarness) -> None:
        await _make_tenant(rls_harness.owner, TENANT_A)
        await _make_tenant(rls_harness.owner, TENANT_B)
        async with tenant_session(rls_harness.restricted, TENANT_A) as session:
            await record_audit_event(
                session,
                tenant_id=TENANT_A,
                actor_user_id=None,
                action=AuditAction.TENANT_CREATED,
                target_type="tenant",
                target_id=TENANT_A,
                details=None,
            )
            await session.commit()

    async def test_the_runtime_role_can_insert_and_read_its_own_tenant(
        self, rls_harness: RLSHarness
    ) -> None:
        await self._seed(rls_harness)

        async with tenant_session(rls_harness.restricted, TENANT_A) as session:
            mine = (await session.execute(select(AuditEvent))).scalars().all()
        async with tenant_session(rls_harness.restricted, TENANT_B) as session:
            theirs = (await session.execute(select(AuditEvent))).scalars().all()

        assert [e.action for e in mine] == [AuditAction.TENANT_CREATED]
        assert theirs == []

    @pytest.mark.parametrize(
        "statement",
        ["UPDATE audit_events SET action = 'rewritten'", "DELETE FROM audit_events"],
    )
    async def test_the_runtime_role_cannot_rewrite_history(
        self, rls_harness: RLSHarness, statement: str
    ) -> None:
        await self._seed(rls_harness)

        async with tenant_session(rls_harness.restricted, TENANT_A) as session:
            with pytest.raises(ProgrammingError, match="permission denied"):
                await session.execute(text(statement))

        async with rls_harness.owner() as session:
            [event] = (await session.execute(select(AuditEvent))).scalars().all()
        assert event.action == AuditAction.TENANT_CREATED
