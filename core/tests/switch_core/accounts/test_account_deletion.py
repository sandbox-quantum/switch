"""Deleting your own account.

Against a real database, because the whole difficulty is the schema: every
column that points at a user either goes, passes to someone else, or is
cleared, or the final `DELETE FROM users` fails on a foreign key. The services
with side effects outside the database — stopping an agent, revoking service
sign-ins at a vendor — are fakes that do only the row work they are trusted
to do.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.accounts.deletion import (
    USER_REFERENCES,
    AccountDeletion,
    Workspace,
)
from switch_core.bridges.resource.service import ResourceService
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    ApiKey,
    AuditEvent,
    Client,
    CloudMachine,
    Invitation,
    MessagingInstall,
    OidcIdentity,
    Reference,
    Room,
    Template,
    Tenant,
    TenantMember,
    User,
    WorkspaceServiceSetting,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore
from switch_core.db.stores.room_link_store import RoomLinkStore
from switch_core.db.stores.template_store import TemplateStore
from switch_core.db.stores.user_store import UserStore
from switch_core.tenant_context import current_tenant_id

ADMIN_EMAIL = "admin@switch.local"


class _Protocol:
    """Deletes the agent's row as `AgentCore.delete_agent` does, without the
    process it would stop."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory
        self.deleted: list[str] = []
        self.api_key_cache = self

    def invalidate(self, _key_hash: str) -> None:
        pass

    async def delete_agent(self, *, agent_id: str) -> None:
        tenant_id = current_tenant_id()
        assert tenant_id is not None
        async with tenant_session(self._session_factory, tenant_id) as session:
            agent = await session.get(Agent, agent_id)
            assert agent is not None
            client_id = agent.client_id
            await session.execute(delete(Agent).where(Agent.id == agent_id))
            await session.execute(delete(Client).where(Client.id == client_id))
            await session.commit()
        self.deleted.append(agent_id)


class _Broker:
    async def remove_connections(self, _session: AsyncSession, _user_id: str) -> list:
        return []

    async def finish_disconnect(self, *_args: Any) -> None:
        return None

    async def revoke_pending(self, *_args: Any) -> bool:
        return False


class _Rooms:
    def __init__(self) -> None:
        self.archived: list[str] = []

    async def set_room_archived(self, room_id: str, archived: bool) -> None:
        assert archived
        self.archived.append(room_id)


class _SignInFlows:
    async def discard_for_user(self, *_args: Any) -> None:
        pass


def _deletion(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[AccountDeletion, _Protocol, _Rooms]:
    protocol = _Protocol(session_factory)
    rooms = _Rooms()
    deletion = AccountDeletion(
        session_factory=session_factory,
        protocol=protocol,  # type: ignore[arg-type]
        management=None,
        broker=_Broker(),  # type: ignore[arg-type]
        resources=ResourceService(
            reference_store=ReferenceStore(),
            reference_type_store=ReferenceTypeStore(),
            document_store=DocumentStore(),
            package_store=PackageStore(),
            room_link_store=RoomLinkStore(),
            session_factory=session_factory,
        ),
        rooms=rooms,  # type: ignore[arg-type]
        sign_in_flows=_SignInFlows(),  # type: ignore[arg-type]
        users=UserStore(),
        agents=AgentStore(),
        api_keys=ApiKeyStore(),
        templates=TemplateStore(),
        admin_email=ADMIN_EMAIL,
    )
    return deletion, protocol, rooms


async def _user(session: AsyncSession, name: str, role: str = "user") -> User:
    user = User(name=name, email=f"{name}@example.test", role=role)
    session.add(user)
    await session.flush()
    return user


async def _member(session: AsyncSession, tenant_id: str, user: User, role: str) -> None:
    session.add(TenantMember(tenant_id=tenant_id, user_id=user.id, role=role))
    await session.flush()


async def _agent(
    session: AsyncSession, tenant_id: str, owner: User, name: str
) -> Agent:
    client = Client(
        tenant_id=tenant_id,
        transport_user_id=f"@{name}-{uuid.uuid4().hex[:6]}:test",
        display_name=name,
        type="agent",
    )
    key = ApiKey(
        tenant_id=tenant_id,
        user_id=owner.id,
        key_hash=uuid.uuid4().hex,
        encrypted_key="enc",
        label=name,
        type="agent",
    )
    session.add_all([client, key])
    await session.flush()
    agent = Agent(
        tenant_id=tenant_id,
        name=name,
        description=name,
        agent_type="always_on",
        connector_type="claude_code",
        integration_profile={"connection_model": "always_on"},
        client_id=client.id,
        api_key_id=key.id,
        owner_id=owner.id,
    )
    session.add(agent)
    await session.flush()
    return agent


async def _invitation(session: AsyncSession, tenant_id: str, by: User) -> Invitation:
    invitation = Invitation(
        tenant_id=tenant_id,
        role="member",
        email="someone@example.test",
        token_hash=uuid.uuid4().hex,
        expires_at=datetime.now(UTC) + timedelta(days=7),
        uses_remaining=1,
        created_by=by.id,
    )
    session.add(invitation)
    await session.flush()
    return invitation


async def test_account_deletion_covers_every_user_reference(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Every foreign key to `users` is in `USER_REFERENCES`, and the ones it
    leaves to the database really are cascades or clears there."""
    async with session_factory() as session:
        rows = (
            await session.execute(
                text(
                    """
                    SELECT cl.relname, att.attname, c.confdeltype::text
                    FROM pg_constraint c
                    JOIN pg_class cl ON cl.oid = c.conrelid
                    JOIN pg_class ref ON ref.oid = c.confrelid
                    JOIN unnest(c.conkey) AS k(attnum) ON true
                    JOIN pg_attribute att
                      ON att.attrelid = c.conrelid AND att.attnum = k.attnum
                    WHERE c.contype = 'f' AND ref.relname = 'users'
                    """
                )
            )
        ).all()
    found = {(table, column): action for table, column, action in rows}
    assert set(found) == set(USER_REFERENCES), (
        "accounts/deletion.py must say what happens to every column that "
        f"points at a user; missing: {set(found) - set(USER_REFERENCES)}, "
        f"stale: {set(USER_REFERENCES) - set(found)}"
    )
    for key, handling in USER_REFERENCES.items():
        if handling == "database cascades":
            assert found[key] == "c", key
        elif handling == "database clears":
            assert found[key] == "n", key


async def test_the_servers_admin_account_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    deletion, _, _ = _deletion(session_factory)
    async with session_factory() as session:
        admin = await _user(session, "admin", role="admin")
        await session.commit()
        assert "administrator" in (await deletion.refusal(session, admin, []) or "")


async def test_the_only_owner_of_a_shared_workspace_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    deletion, _, _ = _deletion(session_factory)
    async with session_factory() as session:
        owner = await _user(session, "owner")
        other = await _user(session, "other")
        await _member(session, TENANT_ZERO_ID, owner, "owner")
        await _member(session, TENANT_ZERO_ID, other, "member")
        await session.commit()
        reason = await deletion.refusal(
            session, owner, [Workspace(TENANT_ZERO_ID, "Acme", "owner")]
        )
    assert reason is not None and "only owner of Acme" in reason


async def test_an_owner_demoted_after_the_refusals_stops_the_deletion(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The refusals pass with two owners; the other owner is demoted before
    the membership goes. The check is made again under the owners' lock, in
    the transaction that would delete the membership, and stops there."""
    deletion, _, _ = _deletion(session_factory)
    async with session_factory() as session:
        leaving = await _user(session, "leaving-owner")
        other = await _user(session, "other-owner")
        await _member(session, TENANT_ZERO_ID, leaving, "owner")
        await _member(session, TENANT_ZERO_ID, other, "owner")
        await session.commit()
        workspaces = [Workspace(TENANT_ZERO_ID, "Acme", "owner")]
        assert await deletion.refusal(session, leaving, workspaces) is None

        demoted = await session.get(TenantMember, (TENANT_ZERO_ID, other.id))
        assert demoted is not None
        demoted.role = "member"
        await session.commit()

        with pytest.raises(RuntimeError, match="no owner"):
            await deletion.delete(session, leaving, workspaces)

    async with session_factory() as session:
        kept = await session.get(TenantMember, (TENANT_ZERO_ID, leaving.id))
        assert kept is not None and kept.role == "owner"


async def test_a_connected_workspace_nobody_else_is_in_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    deletion, _, _ = _deletion(session_factory)
    async with session_factory() as session:
        alone = await _user(session, "alone")
        await _member(session, TENANT_ZERO_ID, alone, "owner")
        session.add(
            MessagingInstall(
                tenant_id=TENANT_ZERO_ID,
                platform="slack",
                external_workspace_id="T1",
                scopes="chat:write",
                status="active",
                installed_by_user_id=alone.id,
            )
        )
        await session.commit()
        reason = await deletion.refusal(
            session, alone, [Workspace(TENANT_ZERO_ID, "Solo", "owner")]
        )
    assert reason is not None and "Slack" in reason


async def test_deleting_a_member_hands_over_and_clears_what_others_need(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    deletion, protocol, rooms = _deletion(session_factory)
    async with session_factory() as session:
        owner = await _user(session, "owner")
        leaving = await _user(session, "leaving")
        await _member(session, TENANT_ZERO_ID, owner, "owner")
        await _member(session, TENANT_ZERO_ID, leaving, "member")
        agent = await _agent(session, TENANT_ZERO_ID, leaving, "helper")
        invitation = await _invitation(session, TENANT_ZERO_ID, leaving)
        shared_room = Room(
            transport_room_id=f"!{uuid.uuid4().hex}:test",
            name="team",
            description="team",
            created_by=leaving.id,
            owner_id=leaving.id,
        )
        chat = Room(
            transport_room_id=f"!{uuid.uuid4().hex}:test",
            name="Welcome",
            description="chat",
            created_by=leaving.id,
            owner_id=leaving.id,
            read_visibility="private",
            write_visibility="private",
        )
        session.add_all([shared_room, chat])
        template = Template(
            owner_id=leaving.id,
            name="mine",
            description="",
            kind="room",
            content="room:\n",
        )
        reference = Reference(
            owner_id=leaving.id,
            read_visibility="private",
            write_visibility="private",
            type="url",
            name="doc",
            description="",
            instructions="",
            value={"url": "https://example.test"},
        )
        session.add_all([template, reference])
        session.add(
            ApiKey(
                user_id=leaving.id,
                key_hash=uuid.uuid4().hex,
                encrypted_key="enc",
                label="mine",
                type="user",
            )
        )
        session.add(OidcIdentity(user_id=leaving.id, iss="https://idp", sub="s1"))
        session.add(
            WorkspaceServiceSetting(
                tenant_id=TENANT_ZERO_ID,
                service="github",
                enabled=False,
                updated_by=leaving.id,
            )
        )
        await session.commit()
        ids = {
            "user": leaving.id,
            "owner": owner.id,
            "agent": agent.id,
            "invitation": invitation.id,
            "shared_room": shared_room.id,
            "chat": chat.id,
            "template": template.id,
            "reference": reference.id,
        }

    workspaces = [Workspace(TENANT_ZERO_ID, "Default", "member")]
    async with session_factory() as session:
        user = await session.get(User, ids["user"])
        assert user is not None
        assert await deletion.refusal(session, user, workspaces) is None
        await deletion.delete(session, user, workspaces)

    assert protocol.deleted == [ids["agent"]]
    assert rooms.archived == [ids["chat"]]
    async with session_factory() as session:
        assert await session.get(User, ids["user"]) is None
        assert (
            await session.scalar(
                select(Invitation.created_by).where(Invitation.id == ids["invitation"])
            )
        ) == ids["owner"]
        assert (
            await session.scalar(
                select(WorkspaceServiceSetting.updated_by).where(
                    WorkspaceServiceSetting.service == "github"
                )
            )
        ) == ids["owner"]
        room = await session.scalar(select(Room).where(Room.id == ids["shared_room"]))
        assert room is not None and room.owner_id is None and room.created_by is None
        assert (
            await session.scalar(
                select(Template.id).where(Template.id == ids["template"])
            )
            is None
        )
        assert (
            await session.scalar(
                select(Reference.id).where(Reference.id == ids["reference"])
            )
            is None
        )
        assert (
            await session.scalar(select(ApiKey.id).where(ApiKey.user_id == ids["user"]))
            is None
        )
        assert (
            await session.scalar(
                select(OidcIdentity.id).where(OidcIdentity.user_id == ids["user"])
            )
            is None
        )
        assert (
            await session.scalar(
                select(AuditEvent.action).where(AuditEvent.target_id == ids["user"])
            )
        ) == "account.deleted"


async def test_a_workspace_left_empty_stays_with_nothing_pointing_at_the_person(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    deletion, _, _ = _deletion(session_factory)
    solo = f"solo-{uuid.uuid4().hex[:6]}"
    async with session_factory() as session:
        session.add(Tenant(id=solo, slug=solo, name="Solo"))
        await session.flush()
        alone = await _user(session, "alone")
        user_id = alone.id
        await session.commit()
    async with tenant_session(session_factory, solo) as session:
        await _member(session, solo, alone, "owner")
        await _invitation(session, solo, alone)
        await session.commit()

    workspaces = [Workspace(solo, "Solo", "owner")]
    async with session_factory() as session:
        user = await session.get(User, user_id)
        assert user is not None
        assert await deletion.refusal(session, user, workspaces) is None
        await deletion.delete(session, user, workspaces)

    async with session_factory() as session:
        assert await session.get(User, user_id) is None
        assert await session.get(Tenant, solo) is not None
    async with tenant_session(session_factory, solo) as session:
        assert await session.scalar(select(Invitation.id)) is None
        assert await session.scalar(select(TenantMember.user_id)) is None


@pytest.mark.parametrize("state", ["ready", "stopped"])
async def test_an_account_with_a_cloud_machine_is_refused(
    session_factory: async_sessionmaker[AsyncSession], state: str
) -> None:
    deletion, _, _ = _deletion(session_factory)
    async with session_factory() as session:
        user = await _user(session, "cloudy")
        session.add(
            CloudMachine(
                id=uuid.uuid4().hex,
                owner_id=user.id,
                state=state,
                active_at=datetime.now(UTC),
            )
        )
        await session.commit()
        reason = await deletion.refusal(session, user, [])
    assert reason is not None and "cloud machine" in reason
