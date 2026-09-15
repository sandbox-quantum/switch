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

#: An install that is serving. The only status the workspace uniqueness index
#: covers, so it is also the answer to "who holds this workspace".
INSTALL_ACTIVE = "active"

#: Ended here, by someone who decided to. The bridge is gone with it.
INSTALL_DISCONNECTED = "disconnected"

#: Ended there: the platform told us the app was removed or its token killed.
#: Distinct from `disconnected` because an operator whose bridge stopped
#: working needs to know whether it was news or a decision.
INSTALL_REVOKED = "revoked"


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


class MessagingInstallNotFound(RuntimeError):
    """No install of that id is visible to the tenant bound on this session.

    "Not visible" rather than "does not exist", and the two are deliberately
    not distinguished: the reads here are scoped, so an id belonging to
    another tenant misses exactly as an invented one does. Telling them apart
    would be a way to ask whether an id exists elsewhere.
    """


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
        across the deployment among active rows, so the database decides who
        holds a workspace rather than a read followed by a write that cannot be
        made atomic with it. A second tenant's install therefore fails here,
        loudly, instead of producing an event with two possible destinations.

        Installs that have ended are not in the index, so re-installing a
        workspace somebody released is an ordinary insert and needs no check of
        its own.
        """
        install = MessagingInstall(
            platform=platform,
            external_workspace_id=external_workspace_id,
            encrypted_bot_token=encrypted_bot_token,
            scopes=scopes,
            status=INSTALL_ACTIVE,
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
                "connected to Switch. Disconnect the existing install — from "
                "the organisation that holds it, which may not be yours — "
                "before connecting it again."
            ) from exc
        return install

    async def get_for_workspace(
        self, session: AsyncSession, *, platform: str, external_workspace_id: str
    ) -> MessagingInstall | None:
        """The bound tenant's live install of one workspace, if it is theirs.

        Deliberately still scoped, even though the unique index means at most
        one active row exists deployment-wide: the caller is an inbound webhook
        that resolved a tenant from the workspace a moment ago, and re-reading
        it under RLS is what makes a mistake there a miss rather than a
        cross-tenant read.

        The status predicate matches the index's and `tenant_of_messaging_
        install`'s. Without it a workspace installed, removed and installed
        again returns two rows and this raises — an outage for the live
        install, caused by the ended one.
        """
        result = await session.execute(
            select(MessagingInstall).where(
                MessagingInstall.platform == platform,
                MessagingInstall.external_workspace_id == external_workspace_id,
                MessagingInstall.status == INSTALL_ACTIVE,
            )
        )
        return result.scalars().one_or_none()

    async def get_for_bridge(
        self, session: AsyncSession, *, bridge_id: str
    ) -> MessagingInstall | None:
        """The live install a bridge was built for, if it was built for one.

        Asked from the other direction than the rest of this store, and by
        something that does not otherwise know installs exist: the bridge
        delete endpoint, which has to refuse rather than tear down a bridge
        whose credential is a token nobody here has revoked.

        Live installs only. An ended one has already released its pointer, so a
        row matching here is always a bridge that is still somebody's install.
        """
        result = await session.execute(
            select(MessagingInstall).where(
                MessagingInstall.bridge_id == bridge_id,
                MessagingInstall.status == INSTALL_ACTIVE,
            )
        )
        return result.scalars().one_or_none()

    async def get(self, session: AsyncSession, *, install_id: str) -> MessagingInstall:
        """One of the bound tenant's installs, by id, or raise."""
        install = await session.get(MessagingInstall, install_id)
        if install is None:
            raise MessagingInstallNotFound(
                f"no install {install_id} belongs to this organisation"
            )
        return install

    async def list_for_tenant(self, session: AsyncSession) -> list[MessagingInstall]:
        """Every install this tenant has ever made, newest first.

        Ended ones included, and that is the point of the method rather than a
        side effect. An operator looking at this list is usually looking at it
        because something stopped working, and a list of only the live installs
        answers "there is nothing here" to the question "what happened to the
        one that was here yesterday".
        """
        result = await session.execute(
            select(MessagingInstall).order_by(
                MessagingInstall.installed_at.desc(), MessagingInstall.id
            )
        )
        return list(result.scalars())

    async def end(
        self, session: AsyncSession, *, install_id: str, status: str
    ) -> MessagingInstall:
        """Mark an install finished, and discard the credential and bridge with it.

        `status` says which of the two ways it ended — see
        `INSTALL_DISCONNECTED` and `INSTALL_REVOKED`. Anything else is a
        programming error rather than a state the column may hold: the
        uniqueness index reads `status = 'active'`, so a typo here would leave
        a row that is neither serving nor releasing its workspace.

        **Ending an install twice is success.** The platform retries the event
        that says an app was uninstalled, and an operator can click disconnect
        on a row a retry has already ended; both must reach the same place.
        That is also why this is an ordinary read-then-write rather than the
        single conditional statement `redeem_state` uses — there is no race to
        lose here, because two writers racing to end the same install both want
        what the other is doing.
        """
        if status not in (INSTALL_DISCONNECTED, INSTALL_REVOKED):
            raise ValueError(
                f"{status!r} is not a way an install can end; expected "
                f"{INSTALL_DISCONNECTED!r} or {INSTALL_REVOKED!r}"
            )
        install = await self.get(session, install_id=install_id)
        if install.status != INSTALL_ACTIVE:
            return install

        install.status = status
        install.ended_at = datetime.now(UTC)
        # The token is worthless the moment the platform is told so, and a
        # worthless credential still reads like a live one to whoever finds
        # the dump. Keeping the row is the record; keeping the secret is not
        # part of it.
        install.encrypted_bot_token = None
        # And the pointer goes with it, because the bridge is about to. The
        # foreign key has no `ON DELETE`, so a row still naming the bridge is
        # what would refuse its deletion.
        install.bridge_id = None
        await session.flush()
        return install

    async def attach_bridge(
        self, session: AsyncSession, *, install_id: str, bridge_id: str
    ) -> MessagingInstall:
        """Point an install at the bridge now serving it."""
        install = await self.get(session, install_id=install_id)
        install.bridge_id = bridge_id
        await session.flush()
        return install
