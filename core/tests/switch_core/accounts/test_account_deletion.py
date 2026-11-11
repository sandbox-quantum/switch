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

from switch_core.accounts import deletion as deletion_module
from switch_core.accounts.deletion import (
    USER_REFERENCES,
    AccountDeletion,
    AccountDeletionIncomplete,
    Workspace,
)
from switch_core.bridges.resource.service import ResourceService
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    AgentEventRow,
    ApiKey,
    AuditEvent,
    Client,
    ClientRoom,
    CloudMachine,
    Invitation,
    Message,
    MessagingInstall,
    OidcIdentity,
    Organization,
    OrganizationMember,
    Reference,
    ReferenceType,
    Room,
    ServerAuditEvent,
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
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.organization_store import OrganizationStore
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


class _Clients:
    def __init__(self) -> None:
        self.reconciled: list[str] = []

    async def reconcile_tenant(self, tenant_id: str) -> None:
        self.reconciled.append(tenant_id)

    def announce(self, tenant_id: str) -> None:
        pass


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
        organizations=OrganizationStore(),
        agents=AgentStore(),
        api_keys=ApiKeyStore(),
        templates=TemplateStore(),
        clients=_Clients(),
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


async def test_the_only_admin_of_a_shared_workspace_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    deletion, _, _ = _deletion(session_factory)
    async with session_factory() as session:
        admin = await _user(session, "admin")
        other = await _user(session, "other")
        await _member(session, TENANT_ZERO_ID, admin, "admin")
        await _member(session, TENANT_ZERO_ID, other, "member")
        await session.commit()
        reason = await deletion.refusal(
            session, admin, [Workspace(TENANT_ZERO_ID, "Acme", "admin")]
        )
    assert reason is not None and "only admin of Acme" in reason


async def test_becoming_the_only_admin_after_the_check_stops_before_anything_changes(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The other admin was demoted after `refusal` passed: nothing of the
    person's in the workspace is deleted, archived or renamed."""
    deletion, protocol, _ = _deletion(session_factory)
    async with session_factory() as session:
        leaving = await _user(session, "leaving")
        other = await _user(session, "other")
        await _member(session, TENANT_ZERO_ID, leaving, "admin")
        await _member(session, TENANT_ZERO_ID, other, "member")
        agent = await _agent(session, TENANT_ZERO_ID, leaving, "helper")
        theirs = Client(
            transport_user_id=f"@switch-member-{leaving.id}:test",
            display_name="leaving",
            type="member",
            user_id=leaving.id,
        )
        room = Room(
            transport_room_id=f"!{uuid.uuid4().hex}:test", name="Chat", description=""
        )
        session.add_all([theirs, room])
        await session.flush()
        await MessageStore().create(
            session,
            Message(
                room_id=room.id,
                transport_event_id="$mine",
                sender_id=theirs.transport_user_id,
                sender_client_id=theirs.id,
                sender_name="leaving",
                event_type="m.room.message",
                content={"body": "hi", "sender_name": "leaving"},
            ),
            [],
        )
        await session.commit()
        leaving_id, agent_id = leaving.id, agent.id

    async with session_factory() as session:
        user = await session.get(User, leaving_id)
        assert user is not None
        with pytest.raises(AccountDeletionIncomplete) as raised:
            await deletion.delete(
                session,
                user,
                [Workspace(TENANT_ZERO_ID, "Acme", "admin")],
                actor_id=leaving_id,
            )

    assert "Nothing of theirs there has changed" in str(raised.value.__cause__)
    async with session_factory() as session:
        message = (await session.execute(select(Message))).scalar_one()
        assert message.sender_name == "leaving"
        assert await session.get(Agent, agent_id) is not None


async def test_an_org_admin_with_a_member_row_takes_no_admin_away(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The workspace lists its organization's `org_admin` as an admin, but
    their own row is a member's: deleting them leaves the workspace's one
    admin row where it was, so the last-admin rule has nothing to stop."""
    deletion, _, _ = _deletion(session_factory)
    async with session_factory() as session:
        org_admin = await _user(session, "org-admin")
        second = await _user(session, "second-org-admin")
        workspace_admin = await _user(session, "ws-admin")
        await _member(session, TENANT_ZERO_ID, org_admin, "member")
        await _member(session, TENANT_ZERO_ID, workspace_admin, "admin")
        await _organization_role(session, org_admin, "org_admin")
        await _organization_role(session, second, "org_admin")
        await session.commit()
        user_id = org_admin.id

    workspaces = [Workspace(TENANT_ZERO_ID, "Acme", "admin")]
    async with session_factory() as session:
        user = await session.get(User, user_id)
        assert user is not None
        assert await deletion.refusal(session, user, workspaces) is None
        await deletion.delete(session, user, workspaces, actor_id=user.id)

    async with session_factory() as session:
        assert await session.get(User, user_id) is None
        admins = await session.scalars(
            select(TenantMember.user_id).where(
                TenantMember.tenant_id == TENANT_ZERO_ID, TenantMember.role == "admin"
            )
        )
        assert list(admins) == [workspace_admin.id]


async def _organization_role(session: AsyncSession, user: User, role: str) -> None:
    """`user` holds `role` in tenant zero's organization, which shares its id."""
    session.add(
        OrganizationMember(organization_id=TENANT_ZERO_ID, user_id=user.id, role=role)
    )
    await session.flush()


async def test_the_only_org_admin_of_an_organization_with_others_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    deletion, _, _ = _deletion(session_factory)
    async with session_factory() as session:
        admin = await _user(session, "org-admin")
        other = await _user(session, "other")
        await _member(session, TENANT_ZERO_ID, admin, "admin")
        await _member(session, TENANT_ZERO_ID, other, "admin")
        await _organization_role(session, admin, "org_admin")
        await _organization_role(session, other, "member")
        await session.commit()
        reason = await deletion.refusal(
            session, admin, [Workspace(TENANT_ZERO_ID, "Acme", "admin")]
        )
    assert reason is not None and "only organization admin" in reason


async def test_an_org_admin_of_another_organization_does_not_count(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    deletion, _, _ = _deletion(session_factory)
    async with session_factory() as session:
        admin = await _user(session, "org-admin")
        other = await _user(session, "other")
        elsewhere = await _user(session, "elsewhere")
        await _member(session, TENANT_ZERO_ID, admin, "admin")
        await _member(session, TENANT_ZERO_ID, other, "admin")
        await _organization_role(session, admin, "org_admin")
        await _organization_role(session, other, "member")
        session.add(Organization(id="org-elsewhere", slug="org-elsewhere", name="Else"))
        await session.flush()
        session.add(
            OrganizationMember(
                organization_id="org-elsewhere", user_id=elsewhere.id, role="org_admin"
            )
        )
        await session.commit()
        reason = await deletion.refusal(
            session, admin, [Workspace(TENANT_ZERO_ID, "Acme", "admin")]
        )
    assert reason is not None and "only organization admin" in reason


async def test_an_org_admin_with_another_org_admin_beside_them_is_not_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    deletion, _, _ = _deletion(session_factory)
    async with session_factory() as session:
        admin = await _user(session, "org-admin")
        other = await _user(session, "other")
        await _member(session, TENANT_ZERO_ID, admin, "admin")
        await _member(session, TENANT_ZERO_ID, other, "admin")
        await _organization_role(session, admin, "org_admin")
        await _organization_role(session, other, "org_admin")
        await session.commit()
        reason = await deletion.refusal(
            session, admin, [Workspace(TENANT_ZERO_ID, "Acme", "admin")]
        )
    assert reason is None


async def test_a_connected_workspace_nobody_else_is_in_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    deletion, _, _ = _deletion(session_factory)
    async with session_factory() as session:
        alone = await _user(session, "alone")
        await _member(session, TENANT_ZERO_ID, alone, "admin")
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
            session, alone, [Workspace(TENANT_ZERO_ID, "Solo", "admin")]
        )
    assert reason is not None and "Slack" in reason


async def test_deleting_a_member_hands_over_and_clears_what_others_need(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    deletion, protocol, rooms = _deletion(session_factory)
    async with session_factory() as session:
        admin = await _user(session, "admin")
        leaving = await _user(session, "leaving")
        await _member(session, TENANT_ZERO_ID, admin, "admin")
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
            "admin": admin.id,
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
        await deletion.delete(session, user, workspaces, actor_id=user.id)

    assert protocol.deleted == [ids["agent"]]
    assert rooms.archived == [ids["chat"]]
    async with session_factory() as session:
        assert await session.get(User, ids["user"]) is None
        assert (
            await session.scalar(
                select(Invitation.created_by).where(Invitation.id == ids["invitation"])
            )
        ) == ids["admin"]
        assert (
            await session.scalar(
                select(WorkspaceServiceSetting.updated_by).where(
                    WorkspaceServiceSetting.service == "github"
                )
            )
        ) == ids["admin"]
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


async def test_a_workspace_left_empty_is_deleted_with_its_setup(
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
        await _member(session, solo, alone, "admin")
        await _invitation(session, solo, alone)
        await session.commit()

    workspaces = [Workspace(solo, "Solo", "admin")]
    async with session_factory() as session:
        user = await session.get(User, user_id)
        assert user is not None
        assert await deletion.refusal(session, user, workspaces) is None
        await deletion.delete(session, user, workspaces, actor_id=user.id)

    assert deletion.clients.reconciled == [solo]  # type: ignore[attr-defined]
    async with session_factory() as session:
        assert await session.get(User, user_id) is None
        assert await session.get(Tenant, solo) is None
    async with tenant_session(session_factory, solo) as session:
        assert await session.scalar(select(Invitation.id)) is None
        actions = set(
            await session.scalars(
                select(AuditEvent.action).where(AuditEvent.tenant_id == solo)
            )
        )
        assert actions == {"account.deleted", "tenant.deleted"}
    async with session_factory() as session:
        server_event = await session.scalar(
            select(ServerAuditEvent).where(ServerAuditEvent.target_id == solo)
        )
    assert server_event is not None
    assert server_event.action == "workspace.deleted"
    assert server_event.actor_user_id == user_id


async def test_a_workspace_that_gains_something_meanwhile_stays_and_the_account_goes(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Something arrives between the check that the workspace is empty and its
    deletion. The person has already left it, committed, so the workspace is
    kept, empty, and the account's deletion still finishes."""
    deletion, _, _ = _deletion(session_factory)
    solo = f"solo-{uuid.uuid4().hex[:6]}"
    async with session_factory() as session:
        session.add(Tenant(id=solo, slug=solo, name="Solo"))
        await session.flush()
        alone = await _user(session, "alone")
        user_id = alone.id
        await session.commit()
    async with tenant_session(session_factory, solo) as session:
        await _member(session, solo, alone, "admin")
        session.add(
            Room(
                tenant_id=solo,
                transport_room_id=f"!{uuid.uuid4().hex}:test",
                name="arrived",
                description="",
            )
        )
        await session.commit()

    async def found_empty(*_args: Any) -> None:
        return None

    monkeypatch.setattr(deletion_module, "workspace_refusal", found_empty)
    workspaces = [Workspace(solo, "Solo", "admin")]
    async with session_factory() as session:
        user = await session.get(User, user_id)
        assert user is not None
        await deletion.delete(session, user, workspaces, actor_id=user.id)

    async with session_factory() as session:
        assert await session.get(User, user_id) is None
        assert await session.get(Tenant, solo) is not None


async def test_a_workspace_left_with_a_room_stays_empty(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Rooms outlive the person who made them, so a workspace still holding
    one is left, with nobody in it, rather than deleted."""
    deletion, _, _ = _deletion(session_factory)
    solo = f"solo-{uuid.uuid4().hex[:6]}"
    async with session_factory() as session:
        session.add(Tenant(id=solo, slug=solo, name="Solo"))
        await session.flush()
        alone = await _user(session, "alone")
        user_id = alone.id
        await session.commit()
    async with tenant_session(session_factory, solo) as session:
        await _member(session, solo, alone, "admin")
        session.add(
            Room(
                tenant_id=solo,
                transport_room_id=f"!{uuid.uuid4().hex}:test",
                name="kept",
                description="",
                created_by=alone.id,
                owner_id=alone.id,
            )
        )
        await session.commit()

    workspaces = [Workspace(solo, "Solo", "admin")]
    async with session_factory() as session:
        user = await session.get(User, user_id)
        assert user is not None
        await deletion.delete(session, user, workspaces, actor_id=user.id)

    async with session_factory() as session:
        assert await session.get(Tenant, solo) is not None
    async with tenant_session(session_factory, solo) as session:
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
    assert reason is not None and "cloud device" in reason


async def test_a_messaging_app_left_in_a_workspace_since_emptied_does_not_refuse(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Removed from a workspace everyone has since left, the person is not
    "alone" in it: the app they installed there goes with the rest, rather
    than refusing a deletion they could not act on."""
    deletion, _, _ = _deletion(session_factory)
    empty = f"empty-{uuid.uuid4().hex[:6]}"
    async with session_factory() as session:
        session.add(Tenant(id=empty, slug=empty, name="Empty"))
        await session.flush()
        removed = await _user(session, "removed")
        removed_id = removed.id
        await session.commit()
    async with tenant_session(session_factory, empty) as session:
        session.add(
            MessagingInstall(
                tenant_id=empty,
                platform="slack",
                external_workspace_id="T-empty",
                scopes="chat:write",
                status="active",
                installed_by_user_id=removed_id,
            )
        )
        await session.commit()

    async with session_factory() as session:
        user = await session.get(User, removed_id)
        assert user is not None
        workspaces = await deletion.with_former_workspaces(user.id, [])
        assert [(w.id, w.role) for w in workspaces] == [(empty, "former member")]
        assert await deletion.refusal(session, user, workspaces) is None
        await deletion.delete(session, user, workspaces, actor_id=user.id)

    async with session_factory() as session:
        assert await session.get(User, removed_id) is None


async def test_a_workspace_the_person_was_removed_from_is_cleared_too(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Removing a member leaves what they own in that workspace; deleting
    their account later finds it there and deletes it, rather than failing on
    the foreign keys it holds."""
    deletion, _, _ = _deletion(session_factory)
    left = f"left-{uuid.uuid4().hex[:6]}"
    async with session_factory() as session:
        session.add(Tenant(id=left, slug=left, name="Left"))
        await session.flush()
        admin = await _user(session, "admin")
        removed = await _user(session, "removed")
        ids = {"admin": admin.id, "removed": removed.id}
        await session.commit()
    async with tenant_session(session_factory, left) as session:
        await _member(session, left, admin, "admin")
        invitation = await _invitation(session, left, removed)
        reference = Reference(
            tenant_id=left,
            owner_id=removed.id,
            read_visibility="public",
            write_visibility="private",
            type="url",
            name="kept",
            description="",
            instructions="",
            value={"url": "https://example.test"},
        )
        session.add(reference)
        await session.commit()
        ids["invitation"] = invitation.id
        ids["reference"] = reference.id

    async with session_factory() as session:
        user = await session.get(User, ids["removed"])
        assert user is not None
        workspaces = await deletion.with_former_workspaces(user.id, [])
        assert [(w.id, w.role) for w in workspaces] == [(left, "former member")]
        assert await deletion.refusal(session, user, workspaces) is None
        await deletion.delete(session, user, workspaces, actor_id=user.id)

    async with session_factory() as session:
        assert await session.get(User, ids["removed"]) is None
    async with tenant_session(session_factory, left) as session:
        assert await session.get(Reference, ids["reference"]) is None
        assert (
            await session.scalar(
                select(Invitation.created_by).where(Invitation.id == ids["invitation"])
            )
        ) == ids["admin"]


async def test_a_workspace_holding_nothing_of_the_person_is_not_touched(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    deletion, _, _ = _deletion(session_factory)
    other = f"other-{uuid.uuid4().hex[:6]}"
    async with session_factory() as session:
        session.add(Tenant(id=other, slug=other, name="Other"))
        await session.flush()
        stranger = await _user(session, "stranger")
        await session.commit()
        workspaces = await deletion.with_former_workspaces(stranger.id, [])
    assert all(w.id != other for w in workspaces)


def _reference_of(owner: User, slug: str, created_at: datetime) -> Reference:
    return Reference(
        owner_id=owner.id,
        read_visibility="public",
        write_visibility="private",
        type=slug,
        name=f"{owner.name}-{slug}",
        description="",
        instructions="",
        value={"value": "x"},
        created_at=created_at,
    )


@pytest.mark.parametrize("admin_has_one", [True, False])
async def test_a_reference_type_in_use_passes_to_an_admin_else_the_oldest_reference(
    session_factory: async_sessionmaker[AsyncSession], admin_has_one: bool
) -> None:
    """An admin with a reference of the type inherits it before any member
    does; with none, the owner of the oldest reference of it does."""
    deletion, _, _ = _deletion(session_factory)
    slug = f"ticket-{uuid.uuid4().hex[:6]}"
    start = datetime(2026, 1, 1, tzinfo=UTC)
    async with session_factory() as session:
        other_admin = await _user(session, "other-admin")
        leaving = await _user(session, "leaving")
        early = await _user(session, "early")
        late = await _user(session, "late")
        admin = await _user(session, "admin-member")
        await _member(session, TENANT_ZERO_ID, other_admin, "admin")
        await _member(session, TENANT_ZERO_ID, leaving, "member")
        await _member(session, TENANT_ZERO_ID, early, "member")
        await _member(session, TENANT_ZERO_ID, late, "member")
        await _member(session, TENANT_ZERO_ID, admin, "admin")
        session.add(
            ReferenceType(
                tenant_id=TENANT_ZERO_ID,
                type=slug,
                owner_id=leaving.id,
                read_visibility="public",
                write_visibility="private",
                display_name="Ticket",
                instructions="",
                value_hint="",
            )
        )
        session.add(_reference_of(late, slug, start + timedelta(days=2)))
        session.add(_reference_of(early, slug, start + timedelta(days=1)))
        if admin_has_one:
            session.add(_reference_of(admin, slug, start + timedelta(days=3)))
        await session.commit()
        expected = admin.id if admin_has_one else early.id
        leaving_id = leaving.id

    workspaces = [Workspace(TENANT_ZERO_ID, "Default", "member")]
    async with session_factory() as session:
        user = await session.get(User, leaving_id)
        assert user is not None
        await deletion.delete(session, user, workspaces, actor_id=user.id)

    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        assert (
            await session.scalar(
                select(ReferenceType.owner_id).where(ReferenceType.type == slug)
            )
        ) == expected


async def test_the_successor_is_the_longest_standing_admin_then_the_lowest_id(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    deletion, _, _ = _deletion(session_factory)
    joined = datetime(2026, 1, 1, tzinfo=UTC)
    async with session_factory() as session:
        leaving = await _user(session, "leaving")
        session.add(
            TenantMember(
                tenant_id=TENANT_ZERO_ID,
                user_id=leaving.id,
                role="admin",
                created_at=joined - timedelta(days=9),
            )
        )
        member = await _user(session, "member-first")
        session.add(
            TenantMember(
                tenant_id=TENANT_ZERO_ID,
                user_id=member.id,
                role="member",
                created_at=joined - timedelta(days=5),
            )
        )
        tied = [await _user(session, f"admin-{n}") for n in range(3)]
        for admin in tied:
            session.add(
                TenantMember(
                    tenant_id=TENANT_ZERO_ID,
                    user_id=admin.id,
                    role="admin",
                    created_at=joined,
                )
            )
        later = await _user(session, "admin-later")
        session.add(
            TenantMember(
                tenant_id=TENANT_ZERO_ID,
                user_id=later.id,
                role="admin",
                created_at=joined + timedelta(days=1),
            )
        )
        await session.commit()
        expected = min(admin.id for admin in tied)
        leaving_id = leaving.id

    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        assert await deletion._successor(session, leaving_id) == expected


async def test_a_deleted_accounts_messages_stay_under_former_member(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Their name leaves everything they sent from Switch Console, the agents'
    copies, the member client and the Console chat descriptions; what anyone
    else wrote, mentions and quotes of them included, is untouched."""
    monkeypatch.setattr(deletion_module, "RENAME_BATCH", 2)
    deletion, _, _ = _deletion(session_factory)
    async with session_factory() as session:
        admin = await _user(session, "admin")
        leaving = await _user(session, "leaving")
        await _member(session, TENANT_ZERO_ID, admin, "admin")
        await _member(session, TENANT_ZERO_ID, leaving, "member")
        agent = await _agent(session, TENANT_ZERO_ID, admin, "helper")
        theirs = Client(
            transport_user_id=f"@switch-member-{leaving.id}:test",
            display_name="leaving",
            type="member",
            user_id=leaving.id,
        )
        admins = Client(
            transport_user_id=f"@switch-member-{admin.id}:test",
            display_name="admin",
            type="member",
            user_id=admin.id,
        )
        chat = Room(
            transport_room_id=f"!{uuid.uuid4().hex}:test",
            name="Chat",
            description="Switch Console chat with helper, leaving, admin",
        )
        other_chat = Room(
            transport_room_id=f"!{uuid.uuid4().hex}:test",
            name="Other",
            description="Switch Console chat with helper, leaving",
        )
        session.add_all([theirs, admins, chat, other_chat])
        await session.flush()
        session.add(ClientRoom(client_id=theirs.id, room_id=chat.id))
        store = MessageStore()

        async def say(sender: Client, event_id: str, content: dict[str, Any]) -> None:
            await store.create(
                session,
                Message(
                    room_id=chat.id,
                    transport_event_id=event_id,
                    sender_id=sender.transport_user_id,
                    sender_client_id=sender.id,
                    sender_name=sender.display_name,
                    event_type="m.room.message",
                    content=content,
                ),
                [],
            )

        for i in range(3):
            await say(theirs, f"$mine-{i}", {"body": "hi", "sender_name": "leaving"})
        await say(
            theirs,
            "$command",
            {
                "command": "stop",
                "user_id": theirs.transport_user_id,
                "user_name": "leaving",
            },
        )
        await say(theirs, "$custom", {"com.switch.marker": True})
        await say(
            admins,
            "$admin",
            {"body": "as leaving said", "sender_name": "admin", "quote": "leaving"},
        )
        session.add(
            AgentEventRow(
                agent_id=agent.id,
                seq=1,
                room_id=chat.id,
                room_seq=1,
                message_key="$mine-0",
                type="message",
                payload={
                    "type": "message",
                    "payload": {
                        "sender": theirs.transport_user_id,
                        "sender_name": "leaving",
                        "body": "hi",
                    },
                },
                notifiable=True,
            )
        )
        await session.commit()
        ids = {
            "leaving": leaving.id,
            "theirs": theirs.id,
            "chat": chat.id,
            "other_chat": other_chat.id,
        }

    async with session_factory() as session:
        user = await session.get(User, ids["leaving"])
        assert user is not None
        workspaces = await deletion.with_former_workspaces(
            user.id, [Workspace(id=TENANT_ZERO_ID, name="Zero", role="member")]
        )
        await deletion.delete(session, user, workspaces, actor_id=user.id)

    async with session_factory() as session:
        rows = {
            m.transport_event_id: (m.sender_name, m.content)
            for m in (await session.execute(select(Message))).scalars()
        }
        client = await session.get(Client, ids["theirs"])
        chat_after = await session.get(Room, ids["chat"])
        other_after = await session.get(Room, ids["other_chat"])
        copy = (await session.execute(select(AgentEventRow))).scalar_one()
    for i in range(3):
        assert rows[f"$mine-{i}"] == (
            "Former member",
            {"body": "hi", "sender_name": "Former member"},
        )
    assert rows["$command"][1]["user_name"] == "Former member"
    assert rows["$custom"] == ("Former member", {"com.switch.marker": True})
    assert rows["$admin"] == (
        "admin",
        {"body": "as leaving said", "sender_name": "admin", "quote": "leaving"},
    )
    assert client is not None
    assert (client.display_name, client.user_id) == ("Former member", None)
    assert chat_after is not None and other_after is not None
    assert (
        chat_after.description
        == "Switch Console chat with helper, Former member, admin"
    )
    assert other_after.description == "Switch Console chat with helper, leaving"
    assert copy.payload["payload"]["sender_name"] == "Former member"


async def test_invitations_addressed_to_a_deleted_account_go_everywhere(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Live, expired or revoked, in a workspace they were in or one that only
    invited them; an invitation to anyone else stays."""
    deletion, _, _ = _deletion(session_factory)
    elsewhere = f"elsewhere-{uuid.uuid4().hex[:6]}"
    async with session_factory() as session:
        session.add(Tenant(id=elsewhere, slug=elsewhere, name="Elsewhere"))
        await session.flush()
        admin = await _user(session, "admin")
        leaving = await _user(session, "leaving")
        await _member(session, TENANT_ZERO_ID, admin, "admin")
        await _member(session, TENANT_ZERO_ID, leaving, "member")
        await session.commit()
        ids = {"admin": admin.id, "leaving": leaving.id}

    def invitation(tenant_id: str, email: str, **kwargs: Any) -> Invitation:
        return Invitation(
            tenant_id=tenant_id,
            role="member",
            email=email,
            token_hash=uuid.uuid4().hex,
            expires_at=kwargs.get("expires_at", datetime.now(UTC) + timedelta(days=7)),
            revoked_at=kwargs.get("revoked_at"),
            uses_remaining=1,
            created_by=ids["admin"],
        )

    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        session.add_all(
            [
                invitation(TENANT_ZERO_ID, "Leaving@Example.test"),
                invitation(TENANT_ZERO_ID, "someone@example.test"),
            ]
        )
        await session.commit()
    async with tenant_session(session_factory, elsewhere) as session:
        await _member(session, elsewhere, admin, "admin")
        session.add_all(
            [
                invitation(
                    elsewhere,
                    "leaving@example.test",
                    expires_at=datetime.now(UTC) - timedelta(days=1),
                ),
                invitation(
                    elsewhere, "leaving@example.test", revoked_at=datetime.now(UTC)
                ),
            ]
        )
        await session.commit()

    async with session_factory() as session:
        user = await session.get(User, ids["leaving"])
        assert user is not None
        workspaces = await deletion.with_former_workspaces(
            user.id, [Workspace(id=TENANT_ZERO_ID, name="Zero", role="member")]
        )
        await deletion.delete(session, user, workspaces, actor_id=user.id)

    left: list[str | None] = []
    for tenant_id in (TENANT_ZERO_ID, elsewhere):
        async with tenant_session(session_factory, tenant_id) as session:
            left += list(
                (
                    await session.execute(
                        select(Invitation.email).where(
                            Invitation.tenant_id == tenant_id
                        )
                    )
                ).scalars()
            )
    assert left == ["someone@example.test"]
