from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import (
    MessagingInstall,
    MessagingInstallState,
    require_tenant_id,
)

#: How long a customer has to finish the platform's half of the flow. Long
#: enough for a real person to read a consent screen and pick a workspace,
#: short enough that a state captured from a browser's history or a proxy log
#: is worthless by the time anyone reads it.
STATE_TTL = timedelta(minutes=10)


class MessagingInstallClaimedError(RuntimeError):
    """Another tenant has already installed the app into this workspace.

    Worth its own type because it is the one install failure that is not a
    mistake by the caller and cannot be retried into working. What it discloses
    — that *somebody* holds this workspace — is deliberate: the alternative is
    accepting a second claim and delivering that workspace's messages to
    whichever tenant the router happened to pick.
    """


class MessagingInstallStateError(RuntimeError):
    """A state could not be redeemed: already used, expired, or not ours."""


class MessagingInstallStore:
    async def start_install(
        self, session: AsyncSession, *, platform: str, user_id: str
    ) -> MessagingInstallState:
        """Record an install about to be attempted, and return the row to sign.

        `tenant_id` is left to the model's default, which reads the tenant
        bound to this session — the caller does not get to name one. That is
        the whole reason the start leg is authenticated and the callback is
        not: this is where the tenant is decided.
        """
        state = MessagingInstallState(
            platform=platform,
            created_by_user_id=user_id,
            expires_at=datetime.now(UTC) + STATE_TTL,
        )
        session.add(state)
        await session.flush()
        return state

    async def redeem_state(
        self, session: AsyncSession, *, state_id: str, platform: str
    ) -> MessagingInstallState:
        """Burn a state, or raise. Exactly one caller can succeed.

        The check and the write are one statement on purpose. Reading the row,
        deciding it is unused and then updating it leaves a window in which two
        callbacks both read `consumed_at IS NULL` — and the whole reason this
        row exists is to make a replayed state fail. `expires_at` is in the
        same predicate for the same reason.

        Scoped to the bound tenant as well, which the signature has already
        established: a state signed for one tenant and naming a row belonging
        to another matches nothing, so RLS is a second, independent check on
        the first.
        """
        result = await session.execute(
            update(MessagingInstallState)
            .where(
                MessagingInstallState.id == state_id,
                MessagingInstallState.tenant_id == require_tenant_id(),
                MessagingInstallState.platform == platform,
                MessagingInstallState.consumed_at.is_(None),
                MessagingInstallState.expires_at > datetime.now(UTC),
            )
            .values(consumed_at=datetime.now(UTC))
            .returning(MessagingInstallState)
        )
        state = result.scalars().one_or_none()
        if state is None:
            raise MessagingInstallStateError(
                "this install link has already been used or has expired. Start "
                "the install again from Switch."
            )
        return state

    async def record_install(
        self,
        session: AsyncSession,
        *,
        platform: str,
        external_workspace_id: str,
        encrypted_bot_token: str,
        scopes: str,
        user_id: str,
    ) -> MessagingInstall:
        """Claim a workspace for the bound tenant.

        The claim is the insert: `(platform, external_workspace_id)` is unique
        across the deployment, so the database decides who holds a workspace
        rather than a read followed by a write that cannot be made atomic with
        it. A second tenant's install therefore fails here, loudly, instead of
        producing an event with two possible destinations.
        """
        install = MessagingInstall(
            platform=platform,
            external_workspace_id=external_workspace_id,
            encrypted_bot_token=encrypted_bot_token,
            scopes=scopes,
            status="active",
            installed_by_user_id=user_id,
        )
        session.add(install)
        try:
            await session.flush()
        except IntegrityError as exc:
            if "uq_messaging_installs_workspace" not in str(exc.orig):
                raise
            raise MessagingInstallClaimedError(
                f"the {platform} workspace {external_workspace_id} is already "
                "connected to Switch. Remove the existing install before "
                "connecting it again."
            ) from exc
        return install

    async def get_for_workspace(
        self, session: AsyncSession, *, platform: str, external_workspace_id: str
    ) -> MessagingInstall | None:
        """The bound tenant's install of one workspace, if it is theirs.

        Deliberately still scoped, even though the unique constraint means at
        most one row exists deployment-wide: the caller is an inbound webhook
        that resolved a tenant from the workspace a moment ago, and this
        re-reading it under RLS is what makes a mistake there a miss rather
        than a cross-tenant read.
        """
        result = await session.execute(
            select(MessagingInstall).where(
                MessagingInstall.platform == platform,
                MessagingInstall.external_workspace_id == external_workspace_id,
            )
        )
        return result.scalars().one_or_none()

    async def attach_bridge(
        self, session: AsyncSession, *, install_id: str, bridge_id: str
    ) -> MessagingInstall:
        """Point an install at the bridge now serving it."""
        install = await session.get(MessagingInstall, install_id)
        if install is None:
            raise MessagingInstallStateError(f"install not found: {install_id}")
        install.bridge_id = bridge_id
        await session.flush()
        return install
