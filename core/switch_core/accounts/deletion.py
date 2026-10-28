"""A person deleting their own Switch account.

Everything they own goes, and everything that only names them stops naming
them, so the `users` row can be deleted without any foreign key holding it
back. What other people depend on is handed over or kept: rooms they created
stay, with no owner, for the workspace's admins to manage, and the invitations,
join domains and messaging installs they set up pass to another owner of the
workspace.

Nothing is deleted until every refusal has been checked, so a refused deletion
leaves the account exactly as it was. The refusals are the cases where going
ahead would strand something nobody else could reach:

- the server's own administrator account, which the server recreates on every
  start anyway;
- a workspace with other people in it whose only owner is this person;
- a cloud machine, whose teardown is driven from its row;
- an active messaging app installed in a workspace nobody else is in, which
  would keep receiving messages for no one.

A workspace the person is alone in is left empty rather than deleted: the
schema cannot delete a workspace yet.

`USER_REFERENCES` names every column that points at a user and how this module
deals with it; a test holds it to the database, so a new column that points at
a user cannot be added without saying what happens to it here.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, Protocol

from sqlalchemy import delete, func, or_, select, update

from switch_core.bridges.resource.service import ReferenceTypeInUseError
from switch_core.connections.broker import ServiceError
from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import (
    AgentController,
    AgentControllerEnrollmentCode,
    AgentControllerOperation,
    AgentDefinition,
    CloudMachine,
    Document,
    Invitation,
    MachineWorkspace,
    MessagingInstall,
    MessagingInstallState,
    OidcIdentity,
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
    TenantJoinDomain,
    TenantMember,
    User,
    WorkspaceServiceSetting,
)
from switch_core.db.session_scope import tenant_session
from switch_core.tenant_context import tenant_scope

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.bridges.agent.protocol.agent_core import AgentCore
    from switch_core.bridges.resource.service import ResourceService
    from switch_core.connections.broker import ServiceBroker
    from switch_core.connections.sign_in_flows import SignInFlows
    from switch_core.db.stores.agent_store import AgentStore
    from switch_core.db.stores.api_key_store import ApiKeyStore
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
    ("template_installs", "owner_id"): "database cascades",
    ("external_user_claims", "user_id"): "database cascades",
    ("chat_operations", "user_id"): "database cascades",
    ("chat_hidden", "user_id"): "database cascades",
    ("chat_owner_grants", "user_id"): "database cascades",
    ("service_connections", "user_id"): "database cascades",
    ("sign_in_flows", "user_id"): "database cascades",
    ("clients", "user_id"): "database clears",
}


class ControllerRevoker(Protocol):
    """Revokes a machine, as removing it in Switch Console does. Agent
    management's, handed over by the wiring: core does not import it."""

    async def revoke_controller(
        self, session: AsyncSession, tenant_id: str, owner_id: str, controller_id: str
    ) -> None: ...


class AccountDeletionRefused(Exception):
    """Deleting the account would strand something; the message says what to
    do first, in words for the person."""


@dataclass(frozen=True)
class Workspace:
    id: str
    name: str
    role: str


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
    agents: AgentStore
    api_keys: ApiKeyStore
    templates: TemplateStore
    admin_email: str

    async def refusal(
        self, session: AsyncSession, user: User, workspaces: list[Workspace]
    ) -> str | None:
        """Why the account cannot be deleted now, or None when it can."""
        if user.role == "admin" or user.email.lower() == self.admin_email.lower():
            return (
                "This is the server's administrator account, which can't be "
                "deleted. The server recreates it every time it starts."
            )
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
        for workspace in workspaces:
            reason = await self._workspace_refusal(user, workspace)
            if reason is not None:
                return reason
        return None

    async def _workspace_refusal(self, user: User, workspace: Workspace) -> str | None:
        async with tenant_session(self.session_factory, workspace.id) as session:
            members = await self.users.list_tenant_members(session)
            alone = all(member.id == user.id for member, _ in members)
            if (
                not alone
                and workspace.role == "owner"
                and await self.users.count_owners(session) <= 1
            ):
                return (
                    f"You're the only owner of {workspace.name}, which has other "
                    "members. Make one of them an owner first."
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

    async def delete(
        self, session: AsyncSession, user: User, workspaces: list[Workspace]
    ) -> None:
        """Delete the account. `session` is the caller's, and carries the
        deletion of the rows that belong to no workspace; the caller has
        checked `refusal` first."""
        user_id = user.id
        for workspace in workspaces:
            await self._leave_workspace(user_id, workspace)
        await self._hand_over_server_settings(session, user_id)
        await session.execute(
            delete(OidcIdentity).where(OidcIdentity.user_id == user_id)
        )
        await session.execute(
            delete(CloudMachine).where(
                CloudMachine.owner_id == user_id, CloudMachine.state == "deleted"
            )
        )
        await session.execute(delete(User).where(User.id == user_id))
        await session.commit()
        logger.info("Deleted the account of user %s", user_id)

    async def _hand_over_server_settings(
        self, session: AsyncSession, user_id: str
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
            select(User.id).where(func.lower(User.email) == self.admin_email.lower())
        )
        if admin_id is None:
            raise RuntimeError(
                f"The server's administrator account ({self.admin_email}) is missing, "
                "so the service apps a deleted account last saved have nobody to pass to."
            )
        await session.execute(
            update(ServiceAppCredential)
            .where(ServiceAppCredential.updated_by == user_id)
            .values(updated_by=admin_id)
        )

    async def _leave_workspace(self, user_id: str, workspace: Workspace) -> None:
        tenant_id = workspace.id
        async with tenant_session(self.session_factory, tenant_id) as session:
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

        async with tenant_session(self.session_factory, tenant_id) as session:
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
                actor_user_id=user_id,
                action=AuditAction.ACCOUNT_DELETED,
                target_type="user",
                target_id=user_id,
                details={
                    "role": workspace.role,
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

    async def _successor(self, session: AsyncSession, user_id: str) -> str | None:
        """Who takes over what the workspace still needs from this person: an
        owner, else an admin, else nobody when they are alone in it."""
        ranked = sorted(
            (
                (membership.role, member.id)
                for member, membership in await self.users.list_tenant_members(session)
                if member.id != user_id
            ),
            key=lambda entry: {"owner": 0, "admin": 1}.get(entry[0], 2),
        )
        if not ranked or ranked[0][0] not in {"owner", "admin"}:
            return None
        return ranked[0][1]

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
                heir = await session.scalar(
                    select(Reference.owner_id).where(Reference.type == slug).limit(1)
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
