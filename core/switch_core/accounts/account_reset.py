"""Wiping a test account, on a server that allows it.

For test and canary servers, where the same person signs up again and again.
Deleting an account (`deletion.py`) keeps what other people depend on and
leaves a workspace that still has rooms or a messaging app; a reset first
disconnects the messaging apps and deletes every room of each workspace the
person is alone in, so the account's deletion takes those workspaces with it,
and then deletes the organizations left empty.

It only ever wipes what the person is alone in, and never the server's default
workspace. From any other workspace, shared or the default one, the person
just leaves, as an account deletion does. An organization is deleted only when
every workspace in it is wiped and nobody else is in it; otherwise it stays,
and the person only leaves it. Every refusal is checked before anything
changes.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from sqlalchemy import select

from switch_core.accounts.deletion import FORMER_MEMBER, Workspace
from switch_core.accounts.workspace_deletion import refusal as workspace_refusal
from switch_core.db.models import (
    TENANT_ZERO_ID,
    MessagingInstall,
    OrganizationAppCredential,
    OrganizationMember,
    OrganizationServiceSetting,
    Room,
    Tenant,
)
from switch_core.db.session_scope import organization_session, tenant_session
from switch_core.db.stores.messaging_install_store import INSTALL_ACTIVE
from switch_core.db.tenant_lookup import tenants_of_organization
from switch_core.tenant_context import tenant_scope

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.accounts.deletion import AccountDeletion
    from switch_core.bridges.collaboration.install_service import (
        MessagingInstallService,
    )
    from switch_core.db.models import User
    from switch_core.db.stores.organization_store import OrganizationStore
    from switch_core.db.stores.user_store import UserStore
    from switch_core.room_service import RoomService


@dataclass
class AccountReset:
    session_factory: async_sessionmaker[AsyncSession]
    users: UserStore
    organizations: OrganizationStore
    installs: MessagingInstallService | None
    rooms: RoomService
    deletion: AccountDeletion

    async def refusal(
        self, session: AsyncSession, user: User, workspaces: list[Workspace]
    ) -> tuple[str | None, list[Workspace], list[str]]:
        """Why the account cannot be reset, or None, with the workspaces it
        would wipe and the organizations it would delete. `session` is the
        caller's, as `AccountDeletion.refusal` takes it."""
        wiped: list[Workspace] = []
        organization_ids: set[str] = set()
        for workspace in workspaces:
            if workspace.role == FORMER_MEMBER or workspace.id == TENANT_ZERO_ID:
                continue
            async with tenant_session(self.session_factory, workspace.id) as scoped:
                members = await self.users.list_tenant_members(scoped)
                if any(member.id != user.id for member, _ in members):
                    continue
                if self.installs is None and await scoped.scalar(
                    select(MessagingInstall.id).where(
                        MessagingInstall.status == INSTALL_ACTIVE
                    )
                ):
                    return (
                        f"{workspace.name} is connected to a messaging app this "
                        "server can't disconnect. Disconnect it first.",
                        [],
                        [],
                    )
                # Of what the deletion refuses a workspace for, `empty` removes
                # all but the organization's last admin.
                reason = await self.deletion.organization_refusal(
                    scoped, user, workspace.id
                )
                if reason is not None:
                    return reason, [], []
                tenant = await scoped.get(Tenant, workspace.id)
                if tenant is None:
                    raise RuntimeError(
                        f"Workspace {workspace.id} vanished during lookup"
                    )
                if tenant.organization_id is not None:
                    organization_ids.add(tenant.organization_id)
            wiped.append(workspace)
        reason = await self.deletion.refusal(
            session, user, [w for w in workspaces if w not in wiped]
        )
        if reason is not None:
            return reason, [], []
        wiped_ids = {workspace.id for workspace in wiped}
        deleted: list[str] = []
        for organization_id in sorted(organization_ids):
            if (
                not set(
                    await tenants_of_organization(self.session_factory, organization_id)
                )
                <= wiped_ids
            ):
                continue
            async with organization_session(
                self.session_factory, organization_id
            ) as scoped:
                if await scoped.scalar(
                    select(OrganizationMember.user_id).where(
                        OrganizationMember.organization_id == organization_id,
                        OrganizationMember.user_id != user.id,
                    )
                ):
                    continue
                if await scoped.scalar(
                    select(OrganizationAppCredential.organization_id).where(
                        OrganizationAppCredential.organization_id == organization_id
                    )
                ) or await scoped.scalar(
                    select(OrganizationServiceSetting.organization_id).where(
                        OrganizationServiceSetting.organization_id == organization_id
                    )
                ):
                    return (
                        "Your organization has service apps or settings of its "
                        "own. Remove them first.",
                        [],
                        [],
                    )
            deleted.append(organization_id)
        return None, wiped, deleted

    async def empty(self, workspaces: list[Workspace]) -> None:
        """Disconnect every messaging app in `workspaces` and delete every
        room, archived ones too."""
        for workspace in workspaces:
            async with tenant_session(self.session_factory, workspace.id) as session:
                install_ids = list(
                    await session.scalars(
                        select(MessagingInstall.id).where(
                            MessagingInstall.tenant_id == workspace.id,
                            MessagingInstall.status == INSTALL_ACTIVE,
                        )
                    )
                )
            for install_id in install_ids:
                assert self.installs is not None, "checked by refusal"
                await self.installs.disconnect(
                    tenant_id=workspace.id, install_id=install_id
                )
            async with tenant_session(self.session_factory, workspace.id) as session:
                room_ids = list(
                    await session.scalars(
                        select(Room.id).where(Room.tenant_id == workspace.id)
                    )
                )
            with tenant_scope(workspace.id):
                for room_id in room_ids:
                    await self.rooms.delete_room(room_id, retire_channel=False)

    async def delete_organizations(
        self, user_id: str, workspaces: list[Workspace], organization_ids: list[str]
    ) -> None:
        """After the account's deletion: confirm its workspaces went with it,
        then delete the organizations they belonged to."""
        for workspace in workspaces:
            async with tenant_session(self.session_factory, workspace.id) as session:
                if await session.get(Tenant, workspace.id) is None:
                    continue
                reason = await workspace_refusal(session, workspace.id, user_id)
            raise RuntimeError(
                f"Resetting user {user_id} left workspace {workspace.id} in "
                f"place: {reason}"
            )
        for organization_id in organization_ids:
            async with organization_session(
                self.session_factory, organization_id
            ) as session:
                await self.organizations.delete_empty(session, organization_id)
                await session.commit()
