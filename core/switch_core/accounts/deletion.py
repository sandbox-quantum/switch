"""A person deleting their own Switch account.

Everything they own goes, and everything that only names them stops naming
them, so the `users` row can be deleted without any foreign key holding it
back. What other people depend on is handed over or kept: rooms they created
stay, with no owner, for the workspace's admins to manage, and the invitations,
join domains and messaging installs they set up pass to another admin of the
workspace.

What they said in rooms stays, as part of everyone else's conversations, but
no longer under their name: their messages, the copies stored for agents, the
member client that sent them and the Console chat descriptions that listed
them all name a `FORMER_MEMBER_NAME` instead. Invitations addressed to their
e-mail address are deleted in every workspace. A workspace admin can erase
the messages themselves (`retention/erasure.py`); the audit log keeps the
account's id (`docs/design/data-retention.md`).

Nothing is deleted until every refusal has been checked, so a refused deletion
leaves the account exactly as it was. The refusals are the cases where going
ahead would strand something nobody else could reach:

- the server's own administrator account, which the server recreates on every
  start anyway;
- a workspace with other people in it whose only admin is this person;
- an organization with other people in it whose only `org_admin` is this
  person;
- a cloud machine, whose teardown is driven from its row;
- an active messaging app installed in a workspace nobody else is in, which
  would keep receiving messages for no one.

A workspace the person is alone in is deleted once it is empty
(`workspace_deletion.py`). Rooms they created stay, so a workspace with any
room left, or anything else that refuses its deletion, is left empty instead,
for the operator to see.

A workspace the person has left, or been removed from, can still hold rows
that name them: removing a member deletes their keys and connections but not
what they own there. Those workspaces are found too (`with_former_workspaces`)
and cleared the same way, or the final `DELETE FROM users` would fail on a
foreign key after the other workspaces were already done.

`USER_REFERENCES` names every column that points at a user and how this module
deals with it; a test holds it to the database, so a new column that points at
a user cannot be added without saying what happens to it here.
"""

from __future__ import annotations

import logging
from contextlib import AsyncExitStack
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, Protocol

from sqlalchemy import Select, case, delete, exists, func, or_, select, update

from switch_core.accounts.workspace_deletion import (
    WorkspaceDeletionRefused,
    delete_workspace,
)
from switch_core.accounts.workspace_deletion import refusal as workspace_refusal
from switch_core.authz import ORGANIZATION_ADMIN_ROLE
from switch_core.bridges.resource.service import ReferenceTypeInUseError
from switch_core.connections.broker import ServiceError
from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.base import Base
from switch_core.db.models import (
    AgentController,
    AgentControllerEnrollmentCode,
    AgentControllerOperation,
    AgentDefinition,
    Client,
    CloudMachine,
    Document,
    Invitation,
    MachineWorkspace,
    MessagingInstall,
    MessagingInstallState,
    OidcIdentity,
    Organization,
    OrganizationMember,
    Package,
    Reference,
    ReferenceType,
    Room,
    SealedProviderLogin,
    ServiceAppCredential,
    ServiceGrant,
    ServiceTokenIssuance,
    Skill,
    Template,
    Tenant,
    TenantJoinDomain,
    TenantMember,
    User,
    WorkspaceServiceSetting,
)
from switch_core.db.rls_ddl import GLOBAL_TABLES
from switch_core.db.session_scope import organization_session, tenant_session
from switch_core.db.stores.erasure_store import FORMER_MEMBER_NAME, ErasureStore
from switch_core.db.tenant_lookup import all_tenant_ids
from switch_core.tenant_context import tenant_scope

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.bridges.agent.protocol.agent_core import AgentCore
    from switch_core.bridges.resource.service import ResourceService
    from switch_core.connections.broker import ServiceBroker
    from switch_core.connections.sign_in_flows import SignInFlows
    from switch_core.db.stores.agent_store import AgentStore
    from switch_core.db.stores.api_key_store import ApiKeyStore
    from switch_core.db.stores.organization_store import OrganizationStore
    from switch_core.db.stores.template_store import TemplateStore
    from switch_core.db.stores.user_store import UserStore
    from switch_core.room_service import RoomService

logger = logging.getLogger(__name__)

Handling = Literal[
    "deleted",
    "handed over",
    "cleared",
    "refused",
    "database cascades",
    "database clears",
]

# Every column with a foreign key to `users.id`, and what deleting the account
# does with it. `test_account_deletion_covers_every_user_reference` reads the
# database's own catalogue and fails on any column missing here.
USER_REFERENCES: dict[tuple[str, str], Handling] = {
    ("tenant_members", "user_id"): "deleted",
    ("oidc_identities", "user_id"): "deleted",
    ("api_keys", "user_id"): "deleted",
    ("cloud_machines", "owner_id"): "refused",
    ("machine_workspaces", "owner_id"): "deleted",
    ("invitations", "created_by"): "handed over",
    ("tenant_join_domains", "created_by"): "handed over",
    ("agents", "owner_id"): "deleted",
    ("skills", "created_by"): "cleared",
    ("rooms", "created_by"): "cleared",
    ("rooms", "owner_id"): "cleared",
    ("references", "owner_id"): "deleted",
    ("reference_types", "owner_id"): "deleted",
    ("documents", "owner_id"): "deleted",
    ("templates", "owner_id"): "deleted",
    ("packages", "owner_id"): "deleted",
    ("messaging_installs", "installed_by_user_id"): "handed over",
    ("messaging_install_states", "created_by_user_id"): "deleted",
    ("agent_controllers", "owner_id"): "deleted",
    ("agent_controller_enrollment_codes", "owner_id"): "deleted",
    ("agent_definitions", "owner_id"): "deleted",
    ("agent_controller_operations", "created_by"): "deleted",
    ("sealed_provider_logins", "sealed_by"): "deleted",
    ("service_grants", "created_by"): "deleted",
    ("workspace_service_settings", "updated_by"): "handed over",
    ("service_app_credentials", "updated_by"): "handed over",
    ("provider_connections", "user_id"): "database cascades",
    ("organization_members", "user_id"): "database cascades",
    ("template_installs", "owner_id"): "database cascades",
    ("external_user_claims", "user_id"): "database cascades",
    ("external_user_link_requests", "user_id"): "database cascades",
    ("external_user_link_requests", "requested_by_user_id"): "database clears",
    ("chat_operations", "user_id"): "database cascades",
    ("chat_hidden", "user_id"): "database cascades",
    ("chat_owner_grants", "user_id"): "database cascades",
    ("room_admins", "user_id"): "database cascades",
    ("room_admins", "granted_by"): "database clears",
    ("chat_reads", "user_id"): "database cascades",
    ("service_connections", "user_id"): "database cascades",
    ("sign_in_flows", "user_id"): "database cascades",
    # A schedule speaks for its author, so it goes with them.
    ("room_schedules", "author_id"): "database cascades",
    ("clients", "user_id"): "cleared",
    ("organization_app_credentials", "updated_by"): "database clears",
    ("organization_service_settings", "updated_by"): "database clears",
    ("tenant_retention_policies", "updated_by_user_id"): "database clears",
    ("person_erasures", "requested_by_user_id"): "database clears",
    ("hidden_official_templates", "hidden_by"): "database clears",
}


#: How many of the person's messages are renamed per transaction.
RENAME_BATCH = 1000

# The role recorded for a workspace the person is no longer a member of.
FORMER_MEMBER = "former member"


def _holds_rows_in_workspace(tenant_id: str, user_id: str) -> Select[tuple[bool]]:
    """Whether any row this module deals with in `tenant_id` names `user_id`.

    The columns come from `USER_REFERENCES`, so a column added there is
    probed here too. Membership is left out: a former member has none. Names
    its tenant as well as relying on the policy, so a connection the policy
    does not apply to cannot find another workspace's rows."""
    probes = [
        exists().where(
            Base.metadata.tables[table].c.tenant_id == tenant_id,
            Base.metadata.tables[table].c[column] == user_id,
        )
        for (table, column), handling in USER_REFERENCES.items()
        if table not in GLOBAL_TABLES
        and table != "tenant_members"
        and handling not in ("database cascades", "database clears")
    ]
    return select(or_(*probes))


def _reference_type_heir(slug: str, user_id: str) -> Select[tuple[str]]:
    """Who a reference type in use passes to: an admin of the workspace who
    has a reference of that type, else whoever owns the oldest such
    reference; ties go to the oldest reference, then the lowest id."""
    rank = case((TenantMember.role == "admin", 0), else_=1)
    return (
        select(Reference.owner_id)
        .outerjoin(
            TenantMember,
            (TenantMember.tenant_id == Reference.tenant_id)
            & (TenantMember.user_id == Reference.owner_id),
        )
        .where(Reference.type == slug, Reference.owner_id != user_id)
        .order_by(rank, Reference.created_at, Reference.id)
        .limit(1)
    )


async def workspaces_naming(
    session_factory: async_sessionmaker[AsyncSession],
    user_id: str,
    skip: set[str],
) -> list[str]:
    """Every workspace outside `skip` that still holds a row naming
    `user_id`, membership aside: what a former member left behind."""
    found = []
    for tenant_id in sorted(await all_tenant_ids(session_factory)):
        if tenant_id in skip:
            continue
        async with tenant_session(session_factory, tenant_id) as session:
            if await session.scalar(_holds_rows_in_workspace(tenant_id, user_id)):
                found.append(tenant_id)
    return found


async def delete_account_rows(
    session_factory: async_sessionmaker[AsyncSession],
    session: AsyncSession,
    user: User,
    admin_email: str,
) -> None:
    """Delete the `users` row and what only it holds outside every
    workspace, once no workspace row names the account any more. Invitations
    to its address go in every workspace, in their own transactions; the rest
    is on `session`, which the caller commits."""
    for tenant_id in sorted(await all_tenant_ids(session_factory)):
        async with (
            tenant_session(session_factory, tenant_id) as own,
            own.begin(),
        ):
            await own.execute(
                delete(Invitation).where(
                    Invitation.tenant_id == tenant_id,
                    func.lower(Invitation.email) == user.email.lower(),
                )
            )
    await _hand_over_server_settings(session, user.id, admin_email)
    await session.execute(delete(OidcIdentity).where(OidcIdentity.user_id == user.id))
    await session.execute(
        delete(CloudMachine).where(
            CloudMachine.owner_id == user.id, CloudMachine.state == "deleted"
        )
    )
    await session.execute(delete(User).where(User.id == user.id))


async def _hand_over_server_settings(
    session: AsyncSession, user_id: str, admin_email: str
) -> None:
    """A service app the person last saved for the whole server stays, as
    last saved by the server's administrator account, which outlives every
    other account."""
    saved = await session.scalar(
        select(ServiceAppCredential.service)
        .where(ServiceAppCredential.updated_by == user_id)
        .limit(1)
    )
    if saved is None:
        return
    admin_id = await session.scalar(
        select(User.id).where(func.lower(User.email) == admin_email.lower())
    )
    if admin_id is None:
        raise RuntimeError(
            f"The server's administrator account ({admin_email}) is missing, "
            "so the service apps a deleted account last saved have nobody to pass to."
        )
    await session.execute(
        update(ServiceAppCredential)
        .where(ServiceAppCredential.updated_by == user_id)
        .values(updated_by=admin_id)
    )


class TenantClients(Protocol):
    """Stops the clients the server runs for a deleted workspace, here and in
    every other process. The client lifecycle's."""

    async def reconcile_tenant(self, tenant_id: str) -> None: ...

    def announce(self, tenant_id: str) -> None: ...


class ControllerRevoker(Protocol):
    """Revokes a machine, as removing it in Switch Console does. Agent
    management's, handed over by the wiring: core does not import it."""

    async def revoke_controller(
        self, session: AsyncSession, tenant_id: str, owner_id: str, controller_id: str
    ) -> None: ...


class AccountDeletionRefused(Exception):
    """Deleting the account would strand something; the message says what to
    do first, in words for the person."""


class AccountDeletionIncomplete(Exception):
    """Deleting the account failed partway. Each workspace is left in its own
    transaction, so the ones in `completed` stay left; the account itself and
    every other workspace are as they were. The cause is chained."""

    def __init__(self, user_id: str, completed: list[Workspace]) -> None:
        super().__init__(
            f"Deleting the account of user {user_id} failed after leaving "
            f"{len(completed)} workspace(s)"
        )
        self.user_id = user_id
        self.completed = completed


@dataclass(frozen=True)
class Workspace:
    id: str
    name: str
    role: str


def is_server_administrator(user: User, admin_email: str) -> bool:
    """The server's administrator account: an operator, or the account at the
    configured admin e-mail, which the server recreates every time it starts,
    so it is never deleted."""
    return user.role == "admin" or user.email.lower() == admin_email.lower()


@dataclass
class AccountDeletion:
    session_factory: async_sessionmaker[AsyncSession]
    protocol: AgentCore
    management: ControllerRevoker | None
    broker: ServiceBroker
    resources: ResourceService
    rooms: RoomService
    sign_in_flows: SignInFlows
    users: UserStore
    organizations: OrganizationStore
    agents: AgentStore
    api_keys: ApiKeyStore
    templates: TemplateStore
    clients: TenantClients
    admin_email: str

    async def with_former_workspaces(
        self, user_id: str, workspaces: list[Workspace]
    ) -> list[Workspace]:
        """`workspaces`, the person's memberships, plus every other workspace
        that still holds a row naming them, as `FORMER_MEMBER`."""
        former: list[Workspace] = []
        for tenant_id in await workspaces_naming(
            self.session_factory, user_id, {workspace.id for workspace in workspaces}
        ):
            async with tenant_session(self.session_factory, tenant_id) as session:
                tenant = await session.get(Tenant, tenant_id)
                if tenant is None:
                    raise RuntimeError(f"Workspace {tenant_id} vanished during lookup")
                former.append(
                    Workspace(id=tenant_id, name=tenant.name, role=FORMER_MEMBER)
                )
        return [*workspaces, *former]

    async def refusal(
        self, session: AsyncSession, user: User, workspaces: list[Workspace]
    ) -> str | None:
        """Why the account cannot be deleted now, or None when it can."""
        reason = await self.refusal_besides_machines(user, workspaces)
        if reason is not None:
            return reason
        machine = await session.scalar(
            select(CloudMachine.id).where(
                CloudMachine.owner_id == user.id, CloudMachine.state != "deleted"
            )
        )
        if machine is not None:
            return (
                "Your account has a cloud machine. Deleting an account with a "
                "cloud machine isn't supported yet."
            )
        return None

    async def refusal_besides_machines(
        self, user: User, workspaces: list[Workspace]
    ) -> str | None:
        """`refusal`, for a caller that tears the account's cloud machines
        down itself."""
        if is_server_administrator(user, self.admin_email):
            return (
                "This is Switch's administrator account, which can't be "
                "deleted. Switch recreates it every time it starts."
            )
        for workspace in workspaces:
            reason = await self._workspace_refusal(user, workspace)
            if reason is not None:
                return reason
        return None

    async def _workspace_refusal(self, user: User, workspace: Workspace) -> str | None:
        async with tenant_session(self.session_factory, workspace.id) as session:
            organization_refusal = await self.organization_refusal(
                session, user, workspace.id
            )
            if organization_refusal is not None:
                return organization_refusal
            members = await self.users.list_tenant_members(session)
            # A former member is never alone in a workspace: what they left
            # there is handed over or cleared like anything else they left.
            alone = workspace.role != FORMER_MEMBER and all(
                member.id == user.id for member, _ in members
            )
            if (
                not alone
                and await self.users.tenant_role(session, workspace.id, user.id)
                == "admin"
                and await self.users.lock_admins(session) <= 1
            ):
                return (
                    f"You're the only admin of {workspace.name}, which has other "
                    "users. Make one of them an admin first."
                )
            if alone:
                platform = await session.scalar(
                    select(MessagingInstall.platform).where(
                        MessagingInstall.installed_by_user_id == user.id,
                        MessagingInstall.status == "active",
                    )
                )
                if platform is not None:
                    return (
                        f"{workspace.name} is connected to {platform.title()} and "
                        "nobody else is in it. Disconnect it first."
                    )
        return None

    async def organization_refusal(
        self, session: AsyncSession, user: User, tenant_id: str
    ) -> str | None:
        """Refuse the last `org_admin` of the organization `tenant_id` belongs
        to while anyone else is in it: nobody would be left to run it."""
        if (
            await self.users.organization_role(session, tenant_id, user.id)
            != ORGANIZATION_ADMIN_ROLE
        ):
            return None
        tenant = await session.get(Tenant, tenant_id)
        assert tenant is not None and tenant.organization_id is not None
        organization = await session.get(Organization, tenant.organization_id)
        assert organization is not None
        roles = set(
            await session.scalars(
                select(OrganizationMember.role).where(
                    OrganizationMember.organization_id == organization.id,
                    OrganizationMember.user_id != user.id,
                )
            )
        )
        if not roles or ORGANIZATION_ADMIN_ROLE in roles:
            return None
        return (
            f"You're the only organization admin of {organization.name}, which "
            "has other users. Make one of them an organization admin first."
        )

    async def delete(
        self,
        session: AsyncSession,
        user: User,
        workspaces: list[Workspace],
        actor_id: str,
    ) -> None:
        """Delete the account. `session` is the caller's, and carries the
        deletion of the rows that belong to no workspace; the caller has
        checked `refusal` first. `actor_id` is who asked: the person
        themselves, or the server's operator; each workspace's audit log names
        them.

        Raises `AccountDeletionRefused` before anything is changed if an
        organization's last `org_admin` check no longer holds, and
        `AccountDeletionIncomplete` when it fails partway."""
        user_id = user.id
        await self._leave_organizations_as_admin(user, workspaces)
        completed: list[Workspace] = []
        try:
            for workspace in workspaces:
                await self._leave_workspace(user, workspace, actor_id)
                completed.append(workspace)
            await delete_account_rows(
                self.session_factory, session, user, self.admin_email
            )
            await session.commit()
        except Exception as error:
            raise AccountDeletionIncomplete(user_id, completed) from error
        logger.info(
            "Deleted the account of user %s at the request of %s", user_id, actor_id
        )

    async def _leave_organizations_as_admin(
        self, user: User, workspaces: list[Workspace]
    ) -> None:
        """Take the person's `org_admin` rows away, each under the lock every
        write that could leave an organization without an `org_admin` takes
        (`OrganizationStore.lock_admins`), so `refusal` holds against another
        admin stepping down at the same moment. Every check runs before any
        row goes. Only Switch's rows go: a membership in a directory kept
        outside Switch (`organization_directory.py`) is the person's beyond
        Switch, and stays there."""
        organizations: dict[str, str] = {}
        for workspace in workspaces:
            async with tenant_session(self.session_factory, workspace.id) as session:
                tenant = await session.get(Tenant, workspace.id)
                if (
                    tenant is not None
                    and tenant.organization_id is not None
                    and await self.users.organization_role(
                        session, workspace.id, user.id
                    )
                    == ORGANIZATION_ADMIN_ROLE
                ):
                    organizations[tenant.organization_id] = workspace.name
        if not organizations:
            return
        async with AsyncExitStack() as stack:
            held = []
            for organization_id in sorted(organizations):
                session = await stack.enter_async_context(
                    organization_session(self.session_factory, organization_id)
                )
                held.append((organization_id, session))
                admins = await self.organizations.lock_admins(session, organization_id)
                still_admin = (
                    await self.organizations.role(session, organization_id, user.id)
                    == ORGANIZATION_ADMIN_ROLE
                )
                others = await session.scalar(
                    select(func.count())
                    .select_from(OrganizationMember)
                    .where(
                        OrganizationMember.organization_id == organization_id,
                        OrganizationMember.user_id != user.id,
                    )
                )
                if still_admin and admins <= 1 and others:
                    organization = await session.get(Organization, organization_id)
                    assert organization is not None
                    raise AccountDeletionRefused(
                        f"You're the only organization admin of {organization.name}, "
                        "which has other users. Make one of them an "
                        "organization admin first."
                    )
            for organization_id, session in held:
                await session.execute(
                    delete(OrganizationMember).where(
                        OrganizationMember.organization_id == organization_id,
                        OrganizationMember.user_id == user.id,
                    )
                )
                await session.commit()

    async def _leave_workspace(
        self, user: User, workspace: Workspace, actor_id: str
    ) -> None:
        user_id = user.id
        tenant_id = workspace.id
        async with tenant_session(self.session_factory, tenant_id) as session:
            await self._still_not_the_last_admin(
                session,
                user_id,
                workspace,
                "Nothing of theirs there has changed",
            )
            agent_ids = [
                agent.id for agent in await self.agents.get_by_owner(session, user_id)
            ]
            controller_ids = list(
                await session.scalars(
                    select(AgentController.id).where(
                        AgentController.owner_id == user_id
                    )
                )
            )
            chat_ids = list(
                await session.scalars(
                    select(Room.id).where(
                        Room.owner_id == user_id,
                        Room.read_visibility == "private",
                        Room.archived_at.is_(None),
                    )
                )
            )

        with tenant_scope(tenant_id):
            for agent_id in agent_ids:
                try:
                    await self.protocol.delete_agent(agent_id=agent_id)
                except ValueError:
                    # A sub-agent goes with its parent.
                    logger.info("Agent %s was already gone", agent_id)
            for room_id in chat_ids:
                await self.rooms.set_room_archived(room_id, True)

        if controller_ids:
            await self._revoke_controllers(tenant_id, user_id, controller_ids)

        member = await self._rename_messages(user_id, tenant_id)

        async with tenant_session(self.session_factory, tenant_id) as session:
            await self._still_not_the_last_admin(
                session,
                user_id,
                workspace,
                "Their agents there are already deleted, their chats archived "
                "and their messages renamed",
            )
            if member is not None:
                await self._retire_member(session, member, user.name)
            successor = await self._successor(session, user_id)
            try:
                removed_services = await self.broker.remove_connections(
                    session, user_id
                )
            except ServiceError as error:
                raise RuntimeError(
                    f"Could not remove the service connections of user {user_id} "
                    f"in workspace {tenant_id}: {error}"
                ) from error
            keys = await self.api_keys.get_by_user(session, user_id)
            key_hashes = [key.key_hash for key in keys]
            for key in keys:
                await self.api_keys.delete(session, key.id)
            await self.sign_in_flows.discard_for_user(session, user_id, None)

            await self._delete_resources(session, user_id)
            await self._release_rooms(session, user_id)
            await self._hand_over(session, user_id, successor)
            await self._delete_controllers(session, user_id, controller_ids)

            await record_audit_event(
                session,
                tenant_id=tenant_id,
                actor_user_id=actor_id,
                action=AuditAction.ACCOUNT_DELETED,
                target_type="user",
                target_id=user_id,
                details={
                    "role": await self.users.tenant_role(session, tenant_id, user_id),
                    "organization_role": await self.users.organization_role(
                        session, tenant_id, user_id
                    ),
                    "agents_deleted": len(agent_ids),
                    "machines_deleted": len(controller_ids),
                    "handed_to": successor,
                },
            )
            await session.execute(
                delete(TenantMember).where(
                    TenantMember.tenant_id == tenant_id, TenantMember.user_id == user_id
                )
            )
            await session.commit()

            for key_hash in key_hashes:
                self.protocol.api_key_cache.invalidate(key_hash)
            warning = await self.broker.finish_disconnect(
                session, user_id, removed_services
            )
            if warning:
                logger.warning(
                    "Deleting user %s left service sign-ins to revoke by hand in "
                    "workspace %s: %s",
                    user_id,
                    tenant_id,
                    warning,
                )

        if workspace.role != FORMER_MEMBER and successor is None:
            await self._close_if_empty(user_id, tenant_id, actor_id)

    async def _rename_messages(self, user_id: str, tenant_id: str) -> Client | None:
        """Rename what the person sent in the workspace from Switch Console,
        in batches of their own transactions so a long history holds no long
        lock. Returns their member client, or None if they never used one."""
        erasures = ErasureStore()
        async with tenant_session(self.session_factory, tenant_id) as session:
            member = await erasures.member_client_of(session, user_id)
        if member is None:
            return None
        while True:
            async with (
                tenant_session(self.session_factory, tenant_id) as session,
                session.begin(),
            ):
                renamed = await erasures.rename_sent_by(
                    session,
                    transport_user_id=member.transport_user_id,
                    name=FORMER_MEMBER_NAME,
                    limit=RENAME_BATCH,
                )
            if renamed < RENAME_BATCH:
                return member

    async def _retire_member(
        self, session: AsyncSession, member: Client, user_name: str
    ) -> None:
        """In the transaction that takes the person out of the workspace:
        rename anything sent since the batches, the agents' copies and the
        Console chat descriptions, then the member client itself, which
        unlinks it from the account."""
        erasures = ErasureStore()
        while (
            await erasures.rename_sent_by(
                session,
                transport_user_id=member.transport_user_id,
                name=FORMER_MEMBER_NAME,
                limit=RENAME_BATCH,
            )
            == RENAME_BATCH
        ):
            pass
        await erasures.rename_agent_copies(
            session, transport_user_id=member.transport_user_id, name=FORMER_MEMBER_NAME
        )
        await erasures.rename_in_console_chats(
            session,
            client_id=member.id,
            old_names={user_name, member.display_name},
            name=FORMER_MEMBER_NAME,
        )
        await erasures.retire_member_client(session, member.id, FORMER_MEMBER_NAME)

    async def _close_if_empty(
        self, user_id: str, tenant_id: str, actor_id: str
    ) -> None:
        """Delete a workspace the person leaves with nobody in it, once its
        tokens are revoked; leave it, saying why, when anything is left.
        Leaving it is never a reason to fail the account's deletion: the
        person has already left it, committed."""
        async with tenant_session(self.session_factory, tenant_id) as session:
            members = await self.users.list_tenant_members(session)
            if members:
                return
            reason = await workspace_refusal(session, tenant_id, user_id)
            if reason is not None:
                logger.info(
                    "Workspace %s is left empty, not deleted, with user %s: %s",
                    tenant_id,
                    user_id,
                    reason,
                )
                return
            try:
                key_hashes = await delete_workspace(
                    session, tenant_id, user_id, actor_id
                )
            except WorkspaceDeletionRefused as refused:
                # Something arrived since the check above.
                await session.rollback()
                logger.warning(
                    "Workspace %s is left empty, not deleted, with user %s: %s",
                    tenant_id,
                    user_id,
                    refused,
                )
                return
            await session.commit()
        for key_hash in key_hashes:
            self.protocol.api_key_cache.invalidate(key_hash)
        await self.clients.reconcile_tenant(tenant_id)
        self.clients.announce(tenant_id)
        logger.info(
            "Deleted workspace %s, emptied by deleting user %s", tenant_id, user_id
        )

    async def _still_not_the_last_admin(
        self, session: AsyncSession, user_id: str, workspace: Workspace, done: str
    ) -> None:
        """Check `refusal`'s last-admin rule again, with the admin rows locked:
        another admin may have been demoted or removed since `refusal` read
        them. It runs before anything in the workspace changes, and again in
        the transaction that removes the membership; `done` says, for the
        error, what has changed by then.

        Their own membership row decides, not `workspace.role`: that is the
        role they act with, which is `admin` for the organization's
        `org_admin` whatever their row says, and only an `admin` row counts
        towards keeping the workspace one."""
        if await self.users.tenant_role(session, workspace.id, user_id) != "admin":
            return
        members = await self.users.list_tenant_members(session)
        if all(member.id == user_id for member, _ in members):
            return
        if await self.users.lock_admins(session) <= 1:
            raise RuntimeError(
                f"Stopped deleting user {user_id} part-way: they became the only "
                f"admin of workspace {workspace.id}, which has other members, after "
                f"the deletion was checked. {done}; make another member an admin "
                "and delete the account again."
            )

    async def _successor(self, session: AsyncSession, user_id: str) -> str | None:
        """Who takes over what the workspace still needs from this person: an
        admin, else nobody when no other admin is in it. Among several, the
        longest-standing admin, then the lowest id, so the same workspace
        always picks the same person."""
        ranked = sorted(
            (membership.created_at, member.id)
            for member, membership in await self.users.list_tenant_members(session)
            if member.id != user_id and membership.role == "admin"
        )
        return ranked[0][1] if ranked else None

    async def _revoke_controllers(
        self, tenant_id: str, user_id: str, controller_ids: list[str]
    ) -> None:
        """Tell each of the person's machines it is revoked, as removing it in
        Switch Console does."""
        if self.management is None:
            return
        async with tenant_session(self.session_factory, tenant_id) as session:
            for controller_id in controller_ids:
                await self.management.revoke_controller(
                    session, tenant_id, user_id, controller_id
                )
            await session.commit()
            await self.broker.revoke_pending(
                session,
                (
                    ServiceTokenIssuance.principal == "controller",
                    ServiceTokenIssuance.controller_id.in_(controller_ids),
                ),
            )

    async def _delete_resources(self, session: AsyncSession, user_id: str) -> None:
        for package_id in await session.scalars(
            select(Package.id).where(Package.owner_id == user_id)
        ):
            await self.resources.delete_package(
                session, package_id, user_id=user_id, is_admin=False
            )
        for document_id in await session.scalars(
            select(Document.id).where(Document.owner_id == user_id)
        ):
            await self.resources.delete_document(
                session, document_id, user_id=user_id, is_admin=False
            )
        for reference_id in await session.scalars(
            select(Reference.id).where(Reference.owner_id == user_id)
        ):
            await self.resources.delete_reference(
                session, reference_id, user_id=user_id, is_admin=False
            )
        for slug in list(
            await session.scalars(
                select(ReferenceType.type).where(ReferenceType.owner_id == user_id)
            )
        ):
            try:
                await self.resources.delete_reference_type(
                    session, slug, user_id=user_id, is_admin=False
                )
            except ReferenceTypeInUseError:
                # Other people's references are of this type: it passes to one
                # of them rather than leaving their references with no type.
                heir = await session.scalar(_reference_type_heir(slug, user_id))
                if heir is None:
                    raise RuntimeError(
                        f"Reference type {slug} is in use but has no other "
                        "reference owner to pass to"
                    )
                await session.execute(
                    update(ReferenceType)
                    .where(ReferenceType.type == slug)
                    .values(owner_id=heir)
                )
        for template_id in list(
            await session.scalars(
                select(Template.id).where(Template.owner_id == user_id)
            )
        ):
            await self.templates.delete(session, template_id)

    async def _release_rooms(self, session: AsyncSession, user_id: str) -> None:
        await session.execute(
            update(Room).where(Room.owner_id == user_id).values(owner_id=None)
        )
        await session.execute(
            update(Room).where(Room.created_by == user_id).values(created_by=None)
        )
        await session.execute(
            update(Skill).where(Skill.created_by == user_id).values(created_by=None)
        )

    async def _hand_over(
        self, session: AsyncSession, user_id: str, successor: str | None
    ) -> None:
        """What the workspace keeps needing passes to `successor`; in a
        workspace left empty there is nobody to pass it to, and it goes."""
        if successor is not None:
            await session.execute(
                update(Invitation)
                .where(Invitation.created_by == user_id)
                .values(created_by=successor)
            )
            await session.execute(
                update(TenantJoinDomain)
                .where(TenantJoinDomain.created_by == user_id)
                .values(created_by=successor)
            )
            await session.execute(
                update(MessagingInstall)
                .where(MessagingInstall.installed_by_user_id == user_id)
                .values(installed_by_user_id=successor)
            )
            await session.execute(
                update(WorkspaceServiceSetting)
                .where(WorkspaceServiceSetting.updated_by == user_id)
                .values(updated_by=successor)
            )
        else:
            await session.execute(
                delete(Invitation).where(Invitation.created_by == user_id)
            )
            await session.execute(
                delete(TenantJoinDomain).where(TenantJoinDomain.created_by == user_id)
            )
            await session.execute(
                delete(MessagingInstall).where(
                    MessagingInstall.installed_by_user_id == user_id
                )
            )
            await session.execute(
                delete(WorkspaceServiceSetting).where(
                    WorkspaceServiceSetting.updated_by == user_id
                )
            )
        await session.execute(
            delete(MessagingInstallState).where(
                MessagingInstallState.created_by_user_id == user_id
            )
        )
        await session.execute(
            delete(ServiceGrant).where(ServiceGrant.created_by == user_id)
        )
        await session.execute(
            delete(MachineWorkspace).where(MachineWorkspace.owner_id == user_id)
        )

    async def _delete_controllers(
        self, session: AsyncSession, user_id: str, controller_ids: list[str]
    ) -> None:
        await session.execute(
            delete(AgentControllerOperation).where(
                or_(
                    AgentControllerOperation.created_by == user_id,
                    AgentControllerOperation.controller_id.in_(controller_ids),
                )
            )
        )
        await session.execute(
            delete(AgentControllerEnrollmentCode).where(
                or_(
                    AgentControllerEnrollmentCode.owner_id == user_id,
                    AgentControllerEnrollmentCode.controller_id.in_(controller_ids),
                )
            )
        )
        await session.execute(
            delete(SealedProviderLogin).where(
                or_(
                    SealedProviderLogin.sealed_by == user_id,
                    SealedProviderLogin.controller_id.in_(controller_ids),
                )
            )
        )
        await session.execute(
            delete(AgentDefinition).where(AgentDefinition.owner_id == user_id)
        )
        # Someone else's agent placed on one of these machines stays, unplaced.
        await session.execute(
            update(AgentDefinition)
            .where(AgentDefinition.controller_id.in_(controller_ids))
            .values(controller_id=None)
        )
        await session.execute(
            delete(AgentController).where(AgentController.owner_id == user_id)
        )
