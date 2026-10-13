"""The two legs of an install, and the order they have to happen in.

An install is one operation split across two requests that share no session,
no origin and no credential — only the state token. The first leg is
authenticated and decides the tenant; the second is a stranger arriving from
the platform. Everything here is about that asymmetry.

The finishing order is load-bearing and not the obvious one:

1. **Verify the signature, then bind the tenant.** Nothing before this touches
   the database, because until the signature verifies there is no tenant to
   bind and RLS would refuse every statement anyway.
2. **Burn the state, and commit.** Before talking to the platform, not after.
   Redeeming first would leave a window in which a replayed callback is still
   redeemable, and burning inside the same transaction as the rest would hold
   a row lock across a call to someone else's API. The cost is that a platform
   outage burns the link — the customer starts a ten-second flow again, and
   the property we keep in exchange is that a captured state is worth nothing.
3. **Exchange the code**, which is the only network call.
4. **Ask the approver to confirm**, on a page naming the Switch organisation
   and who started the install. Whoever approved on the platform need not be
   whoever started the flow — the consent link can be sent to anyone — so
   nothing is claimed until they choose Connect. The grant waits in the page,
   sealed, and the choice is recorded once.
5. **Claim the workspace**, which is where a workspace already held by another
   tenant fails, in the database rather than in a check above it.
6. **Register the bridge** from the rendered connection config, exactly as if
   an operator had typed the token in, and point the install row at it.

Step 6 last is deliberate too: a bridge that exists with no install row behind
it is an orphan nothing can revoke, whereas an install row with no bridge is a
recorded credential waiting to be used, which is a state the schema already
allows for.

**Ending one runs the same steps backwards, and there are two ways in.** An
operator disconnects here, or the platform tells us the app is gone. They
differ in exactly one step — whether there is a live token to revoke — and in
nothing else, because both have to leave the same state behind: no bridge, no
stored credential, a released workspace and a row saying what happened. A
deployment that handled only the first would go on holding a dead token and a
claim on a workspace whose owner believes they have left.

The revoking order is: tell the platform first, then destroy things. A
revocation we do not understand then leaves the install exactly as it was and
the operator can try again, where the other order would have removed the
bridge and left a working key into a customer's workspace in whatever dump was
taken next.

Then the row, and the bridge last — the reverse of the building order and for
the same reason read backwards. The install's pointer at the bridge is a real
foreign key, so the row has to let go before the bridge can be deleted at all;
and if the deletion then fails, what is left is a bridge with no credential
that an operator can see and remove, rather than an install still claiming a
workspace it has already been thrown out of.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import OrderedDict
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.adapter import (
    PlatformAdapter,
    SupportsSharedConnection,
)
from switch_core.bridges.collaboration.install import (
    ClaimAnswer,
    ClaimProposal,
    InboundWebhook,
    InstallClaim,
    InstallGrant,
    MessagingAppInstaller,
    MessagingInstallerRegistry,
    MessagingInstallError,
    WebhookEndpoint,
    oauth_callback_path,
    public_url,
)
from switch_core.bridges.collaboration.install_confirmation import (
    CONFIRM_TTL,
    InstallTicket,
    open_ticket,
    seal,
)
from switch_core.bridges.collaboration.install_state import (
    InstallState,
    mint,
    mint_compact,
    verify,
    verify_compact,
)
from switch_core.bridges.collaboration.lifecycle_service import (
    BridgeClaimConflict,
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeStartRefused,
)
from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import (
    MessagingInstall,
    MessagingInstallState,
    Room,
    Tenant,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.messaging_event_store import MessagingEventReceiptStore
from switch_core.db.stores.messaging_install_store import (
    INSTALL_ACTIVE,
    INSTALL_DISCONNECTED,
    INSTALL_REVOKED,
    MessagingInstallClaimedError,
    MessagingInstallStateError,
    MessagingInstallStore,
)
from switch_core.db.stores.user_store import UserStore
from switch_core.db.tenant_lookup import tenant_of_messaging_install
from switch_core.keys import Keyring
from switch_core.tenant_context import no_tenant, tenant_scope

logger = logging.getLogger(__name__)


class WebhookWorkspaceUnknown(RuntimeError):
    """An authentic event named a workspace no tenant here has installed.

    Ordinary rather than alarming: an app left in a workspace whose install was
    removed goes on posting for as long as someone leaves it there. It is still
    an error here, because a resolver that returned nothing would make "nobody
    holds this" and "here is where it goes" the same shape — but it is one the
    route absorbs rather than reports, since the platform cannot fix it and
    telling it repeatedly that its posts fail is held against the app itself.
    """


class WebhookWorkspaceUnowned(WebhookWorkspaceUnknown):
    """No tenant holds the workspace at all — the routine case of the two.

    Split from the scoped re-read missing, which is a lookup disagreeing with
    itself and always worth a warning. This one is an app sitting in a
    workspace nobody installed it into, which on some platforms is most of
    what it hears.
    """

    def __init__(self, message: str, *, workspace_id: str) -> None:
        super().__init__(message)
        self.workspace_id = workspace_id


class RoomDetacher(Protocol):
    """Detaches the one room a bridge holds for a workspace that is leaving it."""

    async def unlink_bridge_channel(
        self, bridge_id: str, external_channel_id: str
    ) -> None: ...


#: How long an unowned workspace's drops are remembered, and how many
#: workspaces at most. Long enough to span a migration's two notices; bounded
#: because an app sitting in unclaimed chats sees an open-ended set of them.
_RECENT_DROP_TTL = 300.0
_RECENT_DROPS_MAX = 1000

#: How long an event carrying a claim waits for its bridge to start before the
#: platform is told to retry. The claim is the event that provisions the chat's
#: room, and a bridge still starting has nothing to provision it with.
_BRIDGE_START_WAIT = 2.0
_BRIDGE_START_POLL = 0.05


class WebhookBridgeUnavailable(RuntimeError):
    """The workspace resolves to a tenant, and nothing is running to take it.

    Transient by nature — a bridge mid-restart, or one that has not been built
    for a recorded install yet — so it is worth telling the platform to try
    again rather than swallowing the event.
    """


@dataclass(frozen=True)
class Revocation:
    """A platform saying, in an ordinary event, that an install is over."""

    workspace_id: str
    reason: str


@dataclass(frozen=True)
class ClaimLink:
    """What a person needs to claim a chat: the link, and the bare code.

    The link adds the bot to a group and claims it in one step. A channel has
    no such link — Telegram carries no state when a bot is added to one — so
    the code is posted there by hand, as `/connect <code>`, after adding the
    bot by its handle.
    """

    url: str
    code: str
    bot_handle: str


@dataclass(frozen=True)
class WebhookTarget:
    """Where one verified event goes: a tenant, a bridge, and its live adapter.

    `platform` is carried rather than passed alongside because it is part of
    the answer: the same workspace id could in principle be issued by two
    platforms, and every row written about this delivery is keyed by the pair.
    """

    tenant_id: str
    platform: str
    bridge_id: str
    adapter: PlatformAdapter


@dataclass(frozen=True)
class PendingInstall:
    """A redeemed grant waiting for the approver's Connect or Cancel.

    Everything the confirmation page shows, and the sealed `ticket` its forms
    send back. `requested_by` is the email of whoever started the install.
    """

    platform: str
    workspace_name: str
    external_workspace_id: str
    organisation: str
    requested_by: str
    ticket: str


class InstallPlatformMismatch(RuntimeError):
    """A state minted for one platform arrived at another's callback.

    Only reachable with a valid signature, so this is not an attack so much as
    a deployment that has crossed its own wires — but it would otherwise redeem
    a real state against the wrong installer, and the store's own platform
    predicate would then refuse it with a message about expiry that is not
    true.
    """


class InstallClaimNotPermitted(RuntimeError):
    """The person who minted a claim may not make the install it would make.

    Connecting a further chat to a tenant's existing connection is a member's
    action — a chat is a room, and rooms are members' — but the first claim
    creates the connection itself, which is an admin's. Checked when the claim
    is redeemed and not only when it was minted, because whether a connection
    exists can change in the ten minutes between the two.
    """


class InstallClaimRepeated(RuntimeError):
    """A claim arrived again after it had already connected its workspace.

    The platform re-sends an event it thinks went unanswered, and the retried
    claim finds its state burnt. Told apart from a claim that genuinely came
    too late, because answering a retry with "that link has expired" in a chat
    it has just connected would be telling the person something false.
    """


class MessagingInstallService:
    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        store: MessagingInstallStore,
        receipts: MessagingEventReceiptStore,
        installers: MessagingInstallerRegistry,
        lifecycle: CollaborationBridgeLifecycleService,
        # Defaulted because only a claim-based platform asks either: who may
        # turn it on, and which room a chat that leaves takes with it. A
        # deployment, or a test, with none of those platforms passes neither.
        users: UserStore = UserStore(),
        rooms: RoomDetacher | None = None,
        public_origin: str,
        keyring: Keyring,
    ) -> None:
        self._session_factory = session_factory
        self._store = store
        self._users = users
        self._rooms = rooms
        # (platform, workspace id) -> (events dropped, when the last was), in
        # order of that last drop. Ids and counts only: nothing an unowned
        # workspace said is kept.
        self._recent_drops: OrderedDict[tuple[str, str], tuple[int, float]] = (
            OrderedDict()
        )
        self._receipts = receipts
        self._installers = installers
        self._lifecycle = lifecycle
        self._public_origin = public_origin
        self._keyring = keyring
        # Burnt claim states awaiting an answer: state id -> (chat, when). See
        # `propose`.
        self._proposals: dict[str, tuple[str, float]] = {}

    def _redirect_uri(self, platform: str) -> str:
        """Where the platform sends the browser back to.

        Built from the public origin rather than from the incoming request,
        because the two legs arrive on different hostnames and the platform
        compares this string byte for byte against the one registered with the
        app. Deriving it from `request.url` would produce the gateway's
        hostname on the first leg and a redirect the platform refuses.
        """
        return public_url(self._public_origin, oauth_callback_path(platform))

    def installer(self, platform: str) -> MessagingAppInstaller:
        return self._installers.get(platform)

    def platforms(self) -> list[str]:
        return self._installers.platforms()

    async def begin(self, session: AsyncSession, *, platform: str, user_id: str) -> str:
        """Start an install and return where to send the browser.

        Runs on the caller's own scoped session, so the tenant recorded is the
        tenant they are authenticated for and there is no parameter through
        which they could name another.
        """
        installer = self._installers.get(platform)
        token = await self._mint_state(session, platform=platform, user_id=user_id)
        return installer.authorize_url(
            state=token, redirect_uri=self._redirect_uri(platform)
        )

    async def begin_claim(
        self, session: AsyncSession, *, platform: str, user_id: str
    ) -> ClaimLink:
        """`begin`, for a platform installed by claim: the link and its code."""
        installer = self._installers.get(platform)
        token = await self._mint_state(session, platform=platform, user_id=user_id)
        return ClaimLink(
            url=installer.authorize_url(
                state=token, redirect_uri=self._redirect_uri(platform)
            ),
            code=token,
            bot_handle=installer.bot_handle(),
        )

    async def _mint_state(
        self, session: AsyncSession, *, platform: str, user_id: str
    ) -> str:
        installer = self._installers.get(platform)
        state = await self._store.start_install(
            session, platform=platform, user_id=user_id
        )
        signed = InstallState(
            tenant_id=state.tenant_id, state_id=state.id, platform=platform
        )
        if installer.state_format == "compact":
            return mint_compact(signed, keyring=self._keyring)
        return mint(signed, keyring=self._keyring)

    async def platform_connected(self, session: AsyncSession, *, platform: str) -> bool:
        """Whether the bound tenant already has a bridge for a claim-based platform.

        The line between an admin's action and a member's: connecting a chat
        while there is none creates the tenant's connection; every other chat
        is a room.
        """
        return (
            await self._store.bridge_for_platform(session, platform=platform)
            is not None
        )

    async def install_platform(self, session: AsyncSession, *, install_id: str) -> str:
        """Which platform one of the bound tenant's installs belongs to, or raise."""
        return (await self._store.get(session, install_id=install_id)).platform

    async def complete(
        self, *, platform: str, code: str, state_token: str
    ) -> PendingInstall:
        """Redeem the platform's code and return what the approver must confirm.

        The caller is unauthenticated: everything trusted here comes out of the
        signature on `state_token` or out of the platform's own response.
        Nothing is claimed yet — see `confirm`.
        """
        installer = self._installers.get(platform)
        state = verify(state_token, keyring=self._keyring)
        if state.platform != platform:
            raise InstallPlatformMismatch(
                f"an install state for {state.platform} was presented to the "
                f"{platform} callback"
            )

        with tenant_scope(state.tenant_id):
            burnt = await self._burn(state)

            grant = await installer.redeem(
                code=code, redirect_uri=self._redirect_uri(platform)
            )

            # Refused here rather than after the approver has chosen Connect on
            # a page offering a workspace that cannot be had. `confirm` checks
            # again, since the workspace may be claimed in between. The
            # tenant's own tokenless install is no rival: approving it again
            # refreshes it (`_refresh_own_install`).
            own = await self._own_tokenless_install(
                tenant_id=state.tenant_id, platform=platform, grant=grant
            )
            try:
                await self._lifecycle.reject_claim_conflict(
                    platform,
                    installer.connection_config(grant),
                    exclude_bridge_id=own.bridge_id if own is not None else None,
                )
            except BridgeClaimConflict as exc:
                raise MessagingInstallClaimedError(str(exc)) from exc

            async with tenant_session(
                self._session_factory, state.tenant_id
            ) as session:
                tenant = await session.get(Tenant, state.tenant_id)
                requester = await session.get(User, burnt.created_by_user_id)
                if tenant is None or requester is None:
                    raise RuntimeError(
                        f"install state {state.state_id} names a tenant or user "
                        "that no longer exists"
                    )
                organisation = tenant.name
                requested_by = requester.email

        return PendingInstall(
            platform=platform,
            workspace_name=grant.workspace_name,
            external_workspace_id=grant.external_workspace_id,
            organisation=organisation,
            requested_by=requested_by,
            ticket=seal(
                InstallTicket(
                    tenant_id=state.tenant_id,
                    state_id=state.state_id,
                    platform=platform,
                    grant=grant,
                ),
                keyring=self._keyring,
            ),
        )

    async def confirm(self, *, platform: str, ticket: str) -> MessagingInstall:
        """The approver chose Connect: claim the workspace and build its bridge."""
        opened = self._open(platform, ticket)
        installer = self._installers.get(platform)
        grant = opened.grant

        with tenant_scope(opened.tenant_id):
            async with tenant_session(
                self._session_factory, opened.tenant_id
            ) as session:
                decided = await self._store.decide_state(
                    session,
                    state_id=opened.state_id,
                    platform=platform,
                    window=CONFIRM_TTL,
                )
                await session.commit()

            if grant.bot_token is None:
                refreshed = await self._refresh_own_install(
                    tenant_id=opened.tenant_id, platform=platform, grant=grant
                )
                if refreshed is not None:
                    return refreshed

            connection_config = installer.connection_config(grant)

            # Before the install is recorded: registering the bridge re-checks
            # this, but a refusal there would leave an active install with no
            # bridge, holding the workspace for nothing.
            try:
                await self._lifecycle.reject_claim_conflict(platform, connection_config)
            except BridgeClaimConflict as exc:
                raise MessagingInstallClaimedError(str(exc)) from exc

            async with tenant_session(
                self._session_factory, opened.tenant_id
            ) as session:
                install = await self._store.record_install(
                    session,
                    platform=platform,
                    external_workspace_id=grant.external_workspace_id,
                    encrypted_bot_token=self._encrypted_token(grant),
                    scopes=grant.scopes,
                    platform_data=grant.platform_data,
                    user_id=decided.created_by_user_id,
                )
                install_id = install.id
                await session.commit()

            try:
                bridge = await self._lifecycle.register(
                    bridge_type=platform,
                    display_name=grant.workspace_name,
                    connection_config=connection_config,
                    # Off, though the granted scopes would allow it. Nobody was
                    # asked: an install has no registration form, and letting
                    # an app create channels in a customer's workspace is a
                    # decision someone should make rather than inherit.
                    channel_creation_enabled=False,
                    # A person installed the app: this is them connecting their
                    # platform, which is exactly what onboarding measures.
                    preconfigured=False,
                )
            except Exception as exc:
                # An active install with no bridge would hold the workspace,
                # refusing every reinstall until someone disconnected it by
                # hand — a platform blip during the credential check would be
                # enough. Ending it releases the workspace for the retry.
                async with tenant_session(
                    self._session_factory, opened.tenant_id
                ) as session:
                    await self._store.end(
                        session, install_id=install_id, status=INSTALL_DISCONNECTED
                    )
                    await session.commit()
                logger.warning(
                    "Ended %s install %s for workspace %s: its bridge could not "
                    "be registered (%s)",
                    platform,
                    install_id,
                    grant.external_workspace_id,
                    exc,
                )
                if isinstance(exc, BridgeCredentialError):
                    raise MessagingInstallError(
                        f"{exc} Start the install again from Switch."
                    ) from exc
                raise

            async with tenant_session(
                self._session_factory, opened.tenant_id
            ) as session:
                attached = await self._store.attach_bridge(
                    session, install_id=install_id, bridge_id=bridge.id
                )
                await record_audit_event(
                    session,
                    tenant_id=opened.tenant_id,
                    actor_user_id=decided.created_by_user_id,
                    action=AuditAction.MESSAGING_INSTALL_CONNECTED,
                    target_type="messaging_install",
                    target_id=install_id,
                    details={
                        "platform": platform,
                        "external_workspace_id": grant.external_workspace_id,
                        "workspace_name": grant.workspace_name,
                        "bridge_id": bridge.id,
                        "scopes": grant.scopes,
                    },
                )
                await session.commit()

            logger.info(
                "Installed %s workspace %s for tenant %s as bridge %s",
                platform,
                grant.external_workspace_id,
                opened.tenant_id,
                bridge.id,
            )
            return attached

    async def cancel(self, *, platform: str, ticket: str) -> InstallGrant:
        """The approver chose Cancel: give the credential back, then record it.

        The token is revoked only when no active install holds the workspace.
        A platform hands the same bot token to every install of one app into
        one workspace, so revoking it while another install holds that
        workspace would cut that install off.

        The decision commits only once the revocation has succeeded. The token
        is stored nowhere else, so a cancel recorded ahead of a failed
        revocation would leave a live credential nothing could reach again.
        Until the commit the state row stays locked, so a Connect submitted
        meanwhile waits for this outcome rather than racing it.
        """
        opened = self._open(platform, ticket)
        grant = opened.grant

        with tenant_scope(opened.tenant_id):
            async with tenant_session(
                self._session_factory, opened.tenant_id
            ) as session:
                await self._store.decide_state(
                    session,
                    state_id=opened.state_id,
                    platform=platform,
                    window=CONFIRM_TTL,
                )
                if grant.bot_token is not None:
                    with no_tenant():
                        holder = await tenant_of_messaging_install(
                            self._session_factory,
                            platform,
                            grant.external_workspace_id,
                        )
                    if holder is None:
                        await self._installers.get(platform).revoke(
                            bot_token=grant.bot_token
                        )
                await session.commit()

        logger.info(
            "Install of %s workspace %s for tenant %s was cancelled by its approver",
            platform,
            grant.external_workspace_id,
            opened.tenant_id,
        )
        return grant

    def _open(self, platform: str, ticket: str) -> InstallTicket:
        opened = open_ticket(ticket, keyring=self._keyring)
        if opened.platform != platform:
            raise InstallPlatformMismatch(
                f"an install confirmation for {opened.platform} was presented to "
                f"the {platform} callback"
            )
        return opened

    async def _own_tokenless_install(
        self, *, tenant_id: str, platform: str, grant: InstallGrant
    ) -> MessagingInstall | None:
        """The tenant's live install of a tokenless grant's workspace, if any.

        None for a grant with a token, which `_refresh_own_install` never
        refreshes and the claim check should therefore see as it is.
        """
        if grant.bot_token is not None:
            return None
        async with tenant_session(self._session_factory, tenant_id) as session:
            return await self._store.get_for_workspace(
                session,
                platform=platform,
                external_workspace_id=grant.external_workspace_id,
            )

    async def _refresh_own_install(
        self, *, tenant_id: str, platform: str, grant: InstallGrant
    ) -> MessagingInstall | None:
        """Take a repeated approval of the tenant's own live install as a refresh.

        For a platform with no per-install token, the same organisation
        approving again — for new permissions, a newer app, or to restore an
        approval it withdrew — must not be refused as "already connected" by
        its own install. Read under the tenant, so another tenant's install of
        the workspace is invisible here and still refused by the claim below.
        The bridge is restarted so it checks the approval afresh.

        A platform with a token is left to the claim: its bridge holds the old
        token, and swapping it is not something this does.
        """
        async with tenant_session(self._session_factory, tenant_id) as session:
            existing = await self._store.get_for_workspace(
                session,
                platform=platform,
                external_workspace_id=grant.external_workspace_id,
            )
            if existing is None:
                return None
            refreshed = await self._store.refresh(
                session,
                install_id=existing.id,
                scopes=grant.scopes,
                platform_data=grant.platform_data,
            )
            await session.commit()
        if refreshed.bridge_id is not None:
            try:
                await self._lifecycle.restart(refreshed.bridge_id)
            except Exception as error:
                logger.exception(
                    "Bridge %s did not restart after %s workspace %s was approved "
                    "again",
                    refreshed.bridge_id,
                    platform,
                    grant.external_workspace_id,
                )
                raise MessagingInstallError(
                    "Switch recorded the approval, but the connection could not "
                    f"restart to use it ({error}). It is stopped until Switch "
                    "restarts or the approval is given again."
                ) from error
        logger.info(
            "Refreshed the install of %s workspace %s for tenant %s after it was "
            "approved again",
            platform,
            grant.external_workspace_id,
            tenant_id,
        )
        return refreshed

    async def refuse_uninstalled_bridge(
        self,
        *,
        bridge_id: str,
        tenant_id: str,
        bridge_type: str,
        connection_config: Mapping[str, object],
    ) -> None:
        """Refuse a bridge on the deployment's credential that no install of its
        tenant built. A start guard, so a refused bridge never runs.

        Such a bridge reaches whatever workspace its config names through the
        one credential every tenant shares, so naming a workspace is not
        evidence of owning it. The tenant's live install of that workspace is:
        it came from the platform's own consent screen, and the unique index
        lets only one tenant hold a workspace. The install's bridge pointer is
        still empty while the install flow registers the bridge, which is what
        the empty case admits.
        """
        if bridge_type not in self._installers.platforms():
            return
        workspace_id = self._installers.get(bridge_type).workspace_of_bridge(
            connection_config
        )
        if workspace_id is None:
            return
        async with tenant_session(self._session_factory, tenant_id) as session:
            install = await self._store.get_for_workspace(
                session, platform=bridge_type, external_workspace_id=workspace_id
            )
        if install is None or install.bridge_id not in (None, bridge_id):
            raise BridgeStartRefused(
                f"Bridge {bridge_id} names {bridge_type} workspace {workspace_id}, "
                "which its tenant has not installed this deployment's app into. "
                "A bridge on that app is created by installing it, and serves "
                "only what it was installed into."
            )

    async def propose(self, *, platform: str, claim: InstallClaim) -> ClaimProposal:
        """Spend a claim's state on asking its chat, and say what it would connect.

        The claim-based counterpart of `complete`: verify, then burn the state
        and commit before anything else, so a code seen in the chat — in the
        claim itself, or behind the proposal's buttons — is dead from here on.
        The burnt state is then held for this one chat, and only an answer from
        it can decide it (see `connect`). Held in memory: the app runs on one
        pod, and a restart costs an unanswered proposal, whose answer is then
        refused as expired.

        Everything `connect` would refuse is refused here first, so a chat is
        only asked about a claim that can still succeed.
        """
        installer = self._installers.get(platform)
        state = verify_compact(claim.token, platform=platform, keyring=self._keyring)
        await installer.require_claimant_may_connect(claim)
        chat_id = claim.grant.external_workspace_id

        with tenant_scope(state.tenant_id):
            holder = await tenant_of_messaging_install(
                self._session_factory, platform, chat_id
            )
            if holder == state.tenant_id:
                raise InstallClaimRepeated(
                    f"the {platform} workspace {chat_id} is already connected to "
                    "this organisation"
                )
            if holder is not None:
                raise MessagingInstallClaimedError(
                    f"the {platform} workspace {chat_id} is already connected to Switch"
                )
            try:
                burnt = await self._burn(state)
            except MessagingInstallStateError:
                if self._proposed_chat(state.state_id) == chat_id:
                    raise InstallClaimRepeated(
                        f"the {platform} workspace {chat_id} was already asked "
                        "about this claim"
                    ) from None
                raise
            self._proposals[state.state_id] = (chat_id, time.monotonic())

            async with tenant_session(
                self._session_factory, state.tenant_id
            ) as session:
                if (
                    await self._store.bridge_for_platform(session, platform=platform)
                    is None
                ):
                    await self._require_admin(session, burnt, platform)
                tenant = await session.get(Tenant, state.tenant_id)
                requester = await session.get(User, burnt.created_by_user_id)
                if tenant is None or requester is None:
                    raise RuntimeError(
                        f"install state {state.state_id} names a tenant or user "
                        "that no longer exists"
                    )
                return ClaimProposal(
                    organisation=tenant.name, requested_by=requester.name
                )

    async def decline(self, *, platform: str, claim: InstallClaim) -> None:
        """An admin of the chat chose Cancel: decide the state, connect nothing."""
        installer = self._installers.get(platform)
        state = verify_compact(claim.token, platform=platform, keyring=self._keyring)
        with tenant_scope(state.tenant_id):
            await self._decide(installer, state, claim)
        logger.info(
            "Declined a %s claim of workspace %s for tenant %s",
            platform,
            claim.grant.external_workspace_id,
            state.tenant_id,
        )

    async def connect(self, *, platform: str, claim: InstallClaim) -> MessagingInstall:
        """An admin of the chat chose Connect: install the workspace it names.

        The counterpart of `confirm`. There is no code to exchange — the event
        is the grant — and what differs after that is the bridge.

        **A claim-based platform shares one bridge per tenant.** Identities are
        held per bridge, so a bridge per chat would have every person link
        themselves again in every chat. The first chat registers the bridge
        and each later one attaches to it.

        That makes the first connection a race: two landing together would each
        find no bridge and each register one. So the lookup, the insert, the
        registration and the attachment happen inside one transaction holding
        an advisory lock on the tenant and platform, and a second one waits
        and then finds the bridge the first one made. Holding the transaction
        across registration has a second benefit: a registration that fails
        rolls the install back with it, rather than leaving a workspace claimed
        by a tenant with no bridge to deliver its events to.
        """
        installer = self._installers.get(platform)
        state = verify_compact(claim.token, platform=platform, keyring=self._keyring)
        chat_id = claim.grant.external_workspace_id

        with tenant_scope(state.tenant_id):
            if (
                await tenant_of_messaging_install(
                    self._session_factory, platform, chat_id
                )
                == state.tenant_id
            ):
                raise InstallClaimRepeated(
                    f"the {platform} workspace {chat_id} was already connected by "
                    "this claim"
                )
            decided = await self._decide(installer, state, claim)

            async with tenant_session(
                self._session_factory, state.tenant_id
            ) as session:
                await self._lock_platform(session, state.tenant_id, platform)
                bridge_id = await self._store.bridge_for_platform(
                    session, platform=platform
                )
                if bridge_id is None:
                    await self._require_admin(session, decided, platform)

                install = await self._store.record_install(
                    session,
                    platform=platform,
                    external_workspace_id=chat_id,
                    encrypted_bot_token=self._encrypted_token(claim.grant),
                    scopes=claim.grant.scopes,
                    platform_data=claim.grant.platform_data,
                    user_id=decided.created_by_user_id,
                )

                if bridge_id is None:
                    bridge = await self._lifecycle.register(
                        bridge_type=platform,
                        display_name=claim.grant.workspace_name,
                        connection_config=installer.connection_config(claim.grant),
                        channel_creation_enabled=False,
                        # Someone here connected a chat, as with an OAuth install.
                        preconfigured=False,
                    )
                    bridge_id = bridge.id

                attached = await self._store.attach_bridge(
                    session, install_id=install.id, bridge_id=bridge_id
                )
                await record_audit_event(
                    session,
                    tenant_id=state.tenant_id,
                    actor_user_id=decided.created_by_user_id,
                    action=AuditAction.MESSAGING_INSTALL_CONNECTED,
                    target_type="messaging_install",
                    target_id=install.id,
                    details={
                        "platform": platform,
                        "external_workspace_id": chat_id,
                        "workspace_name": claim.grant.workspace_name,
                        "bridge_id": bridge_id,
                        "scopes": claim.grant.scopes,
                        "claimed_by": claim.claimant,
                    },
                )
                await session.commit()

            logger.info(
                "Connected %s workspace %s for tenant %s on bridge %s",
                platform,
                chat_id,
                state.tenant_id,
                bridge_id,
            )
            return attached

    def _proposed_chat(self, state_id: str) -> str | None:
        """The chat a burnt state was proposed in, while it can be answered."""
        held = self._proposals.get(state_id)
        if held is None:
            return None
        chat_id, proposed_at = held
        if time.monotonic() - proposed_at > CONFIRM_TTL.total_seconds():
            del self._proposals[state_id]
            return None
        return chat_id

    async def _decide(
        self,
        installer: MessagingAppInstaller,
        state: InstallState,
        claim: InstallClaim,
    ) -> MessagingInstallState:
        """Take an answer to a proposal, once, from an admin of its own chat.

        Refused as expired when the state was proposed in another chat, or not
        proposed at all here: a code copied out of one chat cannot be answered
        from another. Who answered is checked before the state is decided, so
        a refused press leaves the proposal for an admin to answer.
        """
        if self._proposed_chat(state.state_id) != claim.grant.external_workspace_id:
            raise MessagingInstallStateError(
                "this claim was not proposed in this chat, or its proposal has "
                "expired. Start again from Switch."
            )
        await installer.require_claimant_may_connect(claim)
        async with tenant_session(self._session_factory, state.tenant_id) as session:
            decided = await self._store.decide_state(
                session,
                state_id=state.state_id,
                platform=state.platform,
                window=CONFIRM_TTL,
            )
            await session.commit()
        self._proposals.pop(state.state_id, None)
        return decided

    @staticmethod
    async def _lock_platform(
        session: AsyncSession, tenant_id: str, platform: str
    ) -> None:
        """Serialise the changes to which installs share a tenant's bridge.

        Held by a first claim across looking up and registering the bridge.
        """
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:key))"),
            {"key": f"messaging-install-claim:{tenant_id}:{platform}"},
        )

    async def _release_bridge(
        self, *, platform: str, bridge_id: str, workspace_id: str
    ) -> None:
        """Remove the bridge an install built, or detach one chat's room.

        A bridge built for one install goes with it, which is every OAuth
        install. A claim-based platform's bridge is the tenant's connection
        rather than any chat's, and outlives the last of them until an admin
        deletes it: a chat ending detaches only its own room, whoever ended it.
        """
        if self._installers.get(platform).installs_by_claim:
            if self._rooms is None:
                raise RuntimeError(
                    f"{platform} is installed by claim, so ending one of its "
                    "installs detaches a room, and this install service was "
                    "built with nothing to detach it with"
                )
            await self._rooms.unlink_bridge_channel(bridge_id, workspace_id)
            return
        await self._lifecycle.remove(bridge_id)

    async def resolve_started(
        self, *, platform: str, workspace_id: str
    ) -> WebhookTarget:
        """`resolve_by_workspace`, waiting for a bridge still starting.

        For a connecting answer. The admin's Connect is the event that
        provisions its chat's room, and a bridge is launched before it is
        started: its adapter is given the callbacks that provision anything in
        the bridge's own task, a few reads after launch, and until then it is
        refused as unavailable. That gap is open when the press has just
        registered the bridge, when Telegram retries it while the bridge is
        still coming up, and when it lands on a bridge that is restarting.

        Only a connecting answer waits; every other event is refused straight
        away. Past the wait the platform is told to retry, and the retry — a
        repeated answer, since the install is committed — waits again.
        """
        deadline = time.monotonic() + _BRIDGE_START_WAIT
        while True:
            try:
                return await self.resolve_by_workspace(
                    platform=platform, workspace_id=workspace_id
                )
            except WebhookBridgeUnavailable:
                if time.monotonic() >= deadline:
                    raise
            await asyncio.sleep(_BRIDGE_START_POLL)

    async def _burn(self, state: InstallState) -> MessagingInstallState:
        """Redeem a verified state, and commit, before anything else happens.

        Shared by both ways an install completes, and in its own transaction
        for the reason the module docstring gives: a replay must fail even if
        everything after this does.
        """
        async with tenant_session(self._session_factory, state.tenant_id) as session:
            burnt = await self._store.redeem_state(
                session, state_id=state.state_id, platform=state.platform
            )
            await session.commit()
        return burnt

    def _encrypted_token(self, grant: InstallGrant) -> str | None:
        """The grant's credential as stored, or `None` if it carries none.

        A grant with no token is a platform whose credential is
        deployment-level (Discord, Telegram), not per-install; there is nothing
        to encrypt and the column is nullable for it.
        """
        if grant.bot_token is None:
            return None
        return self._keyring.encrypt(grant.bot_token)

    async def _require_admin(
        self, session: AsyncSession, burnt: MessagingInstallState, platform: str
    ) -> None:
        user = await session.get(User, burnt.created_by_user_id)
        if user is None or not await self._users.administers(session, user):
            raise InstallClaimNotPermitted(
                f"connecting the first {platform} chat turns {platform} on for "
                "this organisation, which only an admin can do. Ask an admin to "
                "connect it, or to connect any chat first."
            )

    async def list_installs(self, session: AsyncSession) -> list[MessagingInstall]:
        """The bound tenant's installs, for the operator's own list.

        On the caller's session like `begin`, and scoped by it: there is no
        tenant argument because there is no tenant to choose.
        """
        return await self._store.list_for_tenant(session)

    async def install_names(self, session: AsyncSession) -> dict[str, str]:
        """What a person calls each of the bound tenant's installs that still
        has a name, by install id.

        A claimed chat is a room, so it is called what its room is called. An
        OAuth install is its own bridge, named for the workspace it came from.
        An ended install has let go of both and is left to be shown by its id.
        """
        names: dict[str, str] = {}
        for install_id, platform, room, bridge in await self._store.names_for_tenant(
            session
        ):
            name = room if self._installs_by_claim(platform) else bridge
            if name:
                names[install_id] = name
        return names

    async def chat_rooms(self, session: AsyncSession) -> dict[str, Room]:
        """The room each of the bound tenant's claimed chats still has, by
        install id. An ended chat has let go of its room and is absent."""
        return await self._store.rooms_for_tenant(session)

    def _installs_by_claim(self, platform: str) -> bool:
        try:
            return self._installers.get(platform).installs_by_claim
        except MessagingInstallError:
            return False

    # ── Ending an install ────────────────────────────────────────────────────

    async def disconnect(self, *, tenant_id: str, install_id: str) -> MessagingInstall:
        """End an install because somebody here said to.

        Idempotent: disconnecting an install that has already ended returns it
        unchanged. An operator can reach this for a row the platform's own
        `app_uninstalled` ended a second earlier, and that is not an error to
        show them.

        **Removing an OAuth install's bridge detaches every room that used
        it**, which become internal-only; a claimed chat detaches only its own. That is the honest consequence of disconnecting a
        messaging app and it is not softened here — but it is the reason this
        is an explicit action with a confirmation in front of it rather than
        something inferred.
        """
        async with tenant_session(self._session_factory, tenant_id) as session:
            install = await self._store.get(session, install_id=install_id)
            platform = install.platform
            workspace_id = install.external_workspace_id
            bridge_id = install.bridge_id
            token = install.encrypted_bot_token
            already_ended = install.status != INSTALL_ACTIVE

        if already_ended:
            logger.info(
                "Install %s of %s workspace %s had already ended; nothing to do",
                install_id,
                platform,
                workspace_id,
            )
            async with tenant_session(self._session_factory, tenant_id) as session:
                return await self._store.get(session, install_id=install_id)

        with tenant_scope(tenant_id):
            installer = self._installers.get(platform)
            if token is not None:
                await installer.revoke(bot_token=self._keyring.decrypt(token))
            elif (
                installer.installs_by_claim
                or bridge_id is None
                or not self._lifecycle.is_connected(bridge_id)
            ):
                # A tokenless install has nothing to revoke, and a connected
                # bridge lets go of the platform itself as it is removed. One
                # that is not running, or still starting, cannot, so the
                # installer does it. So does a claimed chat, whose bridge is
                # the tenant's and is not removed with it.
                await installer.release(external_workspace_id=workspace_id)

            async with tenant_session(self._session_factory, tenant_id) as session:
                ended = await self._store.end(
                    session, install_id=install_id, status=INSTALL_DISCONNECTED
                )
                await session.commit()

            if bridge_id is not None:
                await self._release_bridge(
                    platform=platform, bridge_id=bridge_id, workspace_id=workspace_id
                )

        logger.info(
            "Disconnected %s workspace %s for tenant %s",
            platform,
            workspace_id,
            tenant_id,
        )
        return ended

    async def revoked(self, *, platform: str, workspace_id: str, reason: str) -> None:
        """End an install because the platform said it is over.

        Resolves the workspace itself rather than going through `resolve`,
        which is built for delivering an event and insists on a running bridge.
        Here a missing bridge is beside the point: the news is that the install
        is finished, and a deployment that could only record that while the
        bridge happened to be up would keep the dead ones it most needs to
        clear.

        A workspace that resolves to nobody is the ordinary case, not a fault.
        The platform retries these events, so the second delivery arrives after
        the first has already ended the install.

        No revocation call: the token this would revoke is the one the platform
        has just told us it killed.
        """
        tenant_id = await tenant_of_messaging_install(
            self._session_factory, platform, workspace_id
        )
        if tenant_id is None:
            logger.info(
                "Ignoring end-of-install for %s workspace %s (%s): no tenant "
                "holds it, so it has already ended",
                platform,
                workspace_id,
                reason,
            )
            return

        with tenant_scope(tenant_id):
            async with tenant_session(self._session_factory, tenant_id) as session:
                install = await self._store.get_for_workspace(
                    session, platform=platform, external_workspace_id=workspace_id
                )
                if install is None:
                    logger.warning(
                        "End-of-install for %s workspace %s resolved to tenant "
                        "%s and could not then be read as that tenant",
                        platform,
                        workspace_id,
                        tenant_id,
                    )
                    return
                install_id = install.id
                bridge_id = install.bridge_id

            async with tenant_session(self._session_factory, tenant_id) as session:
                await self._store.end(
                    session, install_id=install_id, status=INSTALL_REVOKED
                )
                await session.commit()

            if bridge_id is not None:
                await self._release_bridge(
                    platform=platform, bridge_id=bridge_id, workspace_id=workspace_id
                )

        logger.warning(
            "Ended the install of %s workspace %s for tenant %s: %s",
            platform,
            workspace_id,
            tenant_id,
            reason,
        )

    # ── Inbound events ───────────────────────────────────────────────────────
    #
    # The other direction, and the one that runs constantly. Three steps, kept
    # separate because each answers to something different:
    #
    # `authenticate` is pure and does no I/O, so a request that cannot prove
    # itself is refused without this deployment doing any work on its behalf.
    # `resolve` is two indexed reads and decides *whose* event this is.
    # `deliver` is the handling, which can take as long as the work takes.
    #
    # The split is what lets the route acknowledge in time. Slack gives three
    # seconds and retries what it does not get an answer to, so a handler that
    # posts to the room before replying turns one slow room into duplicate
    # messages. Everything up to and including `resolve` is fast enough to
    # answer inside, and `deliver` runs after the response has gone.

    def _webhook_installer(
        self, platform: str, endpoint: WebhookEndpoint
    ) -> MessagingAppInstaller:
        """The installer for a webhook request, or the same refusal as no app.

        An endpoint the platform's app does not post to does not exist, and is
        answered exactly as a platform with no app registered is — before
        anything reads the request.
        """
        installer = self._installers.get(platform)
        if endpoint not in installer.webhook_endpoints:
            raise MessagingInstallError(
                f"the {platform} app does not post to {endpoint}"
            )
        return installer

    def unsigned_handshake(
        self,
        *,
        platform: str,
        endpoint: WebhookEndpoint,
        query: Mapping[str, str],
    ) -> str | None:
        """The answer to a platform's unsigned URL check, if this request is one.

        The one thing answered before verification, and only because it cannot
        be verified by design; see `MessagingAppInstaller.unsigned_handshake`.
        """
        installer = self._webhook_installer(platform, endpoint)
        return installer.unsigned_handshake(endpoint=endpoint, query=query)

    async def authenticate(
        self,
        *,
        platform: str,
        endpoint: WebhookEndpoint,
        headers: Mapping[str, str],
        query: Mapping[str, str],
        body: bytes,
    ) -> list[InboundWebhook]:
        """Prove an inbound request came from the platform, and read it.

        Verification is first and unconditional. Nothing above it inspects the
        body, so an unsigned request cannot pick which parser runs, and nothing
        is logged from it either — it is a stranger's bytes until this passes.
        """
        installer = self._webhook_installer(platform, endpoint)
        await installer.verify_webhook(
            endpoint=endpoint, headers=headers, query=query, body=body
        )
        return installer.parse_webhook(
            endpoint=endpoint, headers=headers, query=query, body=body
        )

    def revocation(self, *, platform: str, event: InboundWebhook) -> Revocation | None:
        """Whether this event is the platform ending the install, and for whom.

        Asked before `resolve` and not after, because the two disagree about
        what a missing bridge means. `resolve` insists on one, and the event
        most worth reading here is precisely the one that arrives when the
        bridge is on its way out — so an uninstall routed through the ordinary
        path would be dropped exactly when it mattered.

        Pure, like `authenticate`: it reads the payload and nothing else, so
        the route can answer the platform before any of the work begins.
        """
        installer = self._installers.get(platform)
        reason = installer.revocation_of_event(event.payload)
        if reason is None:
            return None
        return Revocation(
            workspace_id=installer.workspace_of_event(event.payload), reason=reason
        )

    def claim_of(self, *, platform: str, event: InboundWebhook) -> InstallClaim | None:
        """Whether this event asks for its workspace to be installed.

        Asked before `resolve` for the mirror of the reason `revocation` is:
        the workspace a claim names is not installed yet, so resolving it first
        would drop the one event that could install it.
        """
        return self._installers.get(platform).claim_of_event(event.payload)

    def answer_of(self, *, platform: str, event: InboundWebhook) -> ClaimAnswer | None:
        """Whether this event answers a proposal; asked before `resolve` too."""
        return self._installers.get(platform).answer_of_event(event.payload)

    async def resolve(self, *, platform: str, event: InboundWebhook) -> WebhookTarget:
        """Turn a webhook event's workspace into the bridge entitled to it."""
        return await self.resolve_by_workspace(
            platform=platform,
            workspace_id=self.workspace_of(platform=platform, event=event),
        )

    def workspace_of(self, *, platform: str, event: InboundWebhook) -> str:
        """The workspace a webhook event is for, as its platform names it.

        Raises `WebhookPayloadError` for an event that names none.
        """
        return self._installers.get(platform).workspace_of_event(event.payload)

    async def resolve_by_workspace(
        self, *, platform: str, workspace_id: str
    ) -> WebhookTarget:
        """Turn a workspace id into the one bridge entitled to its events.

        The tenant comes from the exempt lookup (`db/tenant_lookup.py`), which
        is the only way to answer it: the caller authenticated to nothing, and
        every table that could say is scoped. The install row is then read
        *again* under that tenant rather than returned by the lookup — a
        deliberate second check, so a wrong answer above is a miss here instead
        of a cross-tenant read.

        Split from `resolve` so a caller that already holds the workspace id
        reaches it without a webhook: the Discord shared connection reads the
        guild id straight off the Gateway event, and calling this keeps the
        exempt-lookup caller inside this already-allowlisted module and inherits
        the scoped re-read for free.
        """
        tenant_id = await tenant_of_messaging_install(
            self._session_factory, platform, workspace_id
        )
        if tenant_id is None:
            raise WebhookWorkspaceUnowned(
                f"no tenant has installed Switch into {platform} workspace "
                f"{workspace_id}",
                workspace_id=workspace_id,
            )

        async with tenant_session(self._session_factory, tenant_id) as session:
            install = await self._store.get_for_workspace(
                session, platform=platform, external_workspace_id=workspace_id
            )
        if install is None:
            raise WebhookWorkspaceUnknown(
                f"the install of {platform} workspace {workspace_id} resolved to "
                f"tenant {tenant_id} and could not then be read as that tenant"
            )
        if install.bridge_id is None:
            raise WebhookBridgeUnavailable(
                f"the install of {platform} workspace {workspace_id} has no "
                "bridge yet, so there is nothing to deliver its events to"
            )

        adapter = self._lifecycle.get_adapter(install.bridge_id)
        if adapter is None or not self._lifecycle.is_connected(install.bridge_id):
            raise WebhookBridgeUnavailable(
                f"bridge {install.bridge_id}, which serves {platform} workspace "
                f"{workspace_id}, is not running"
            )
        # Normally attached already, as it started. This covers one that
        # started before the platform's shared connection was up and that the
        # walk on connect did not reach. Here rather than at dispatch so a
        # connection that is not ready is refused while the platform can still
        # be told to retry.
        connection = self._installers.get(platform).shared_connection()
        if connection is not None and isinstance(adapter, SupportsSharedConnection):
            adapter.attach_shared_connection(connection)
        return WebhookTarget(
            tenant_id=tenant_id,
            platform=platform,
            bridge_id=install.bridge_id,
            adapter=adapter,
        )

    async def follow_migration(
        self, *, platform: str, event: InboundWebhook, target: WebhookTarget
    ) -> None:
        """Move the install to its workspace's new id, if the event says so.

        After `resolve`, which found the tenant by the old id, and before the
        event is delivered, whose handler moves the room the same way. Awaited
        rather than deferred: until the row moves, every event from the new id
        resolves to nobody and is dropped.

        Messages from the new id that were dropped before this ran are lost;
        the recently-dropped list is how that is said rather than guessed.
        """
        migration = self._installers.get(platform).migration_of_event(event.payload)
        if migration is None:
            return
        old_id, new_id = migration
        with tenant_scope(target.tenant_id):
            async with tenant_session(
                self._session_factory, target.tenant_id
            ) as session:
                moved = await self._store.move_workspace(
                    session,
                    platform=platform,
                    from_workspace_id=old_id,
                    to_workspace_id=new_id,
                )
                await session.commit()
        if moved is None:
            return
        logger.info(
            "The %s install of workspace %s followed it to %s (tenant %s)",
            platform,
            old_id,
            new_id,
            target.tenant_id,
        )
        dropped = self._recent_drops.pop((platform, new_id), None)
        if dropped is not None:
            logger.error(
                "%d %s event(s) from workspace %s were dropped as unowned before "
                "its install followed it from %s; they are lost",
                dropped[0],
                platform,
                new_id,
                old_id,
            )

    def note_unowned(self, *, platform: str, workspace_id: str) -> bool:
        """Remember an unowned drop, and say whether it is routine here.

        Remembered as an id and a count for a few minutes, so a migration can
        tell whether it lost anything; see `follow_migration`. Routine or not
        is the installer's `expects_unowned_events`, and decides whether the
        route warns or only counts.
        """
        now = time.monotonic()
        while self._recent_drops:
            _, (_, last_seen) = next(iter(self._recent_drops.items()))
            if now - last_seen < _RECENT_DROP_TTL:
                break
            self._recent_drops.popitem(last=False)
        key = (platform, workspace_id)
        count, _ = self._recent_drops.pop(key, (0, now))
        self._recent_drops[key] = (count + 1, now)
        if len(self._recent_drops) > _RECENT_DROPS_MAX:
            self._recent_drops.popitem(last=False)
        return self._installers.get(platform).expects_unowned_events

    async def unowned(
        self, *, platform: str, workspace_id: str, event: InboundWebhook
    ) -> None:
        """Let the installer answer an unowned event, after the platform has been."""

        async def still_unowned() -> bool:
            return (
                await tenant_of_messaging_install(
                    self._session_factory, platform, workspace_id
                )
                is None
            )

        await self._installers.get(platform).on_unowned_event(
            workspace_id=workspace_id,
            payload=event.payload,
            still_unowned=still_unowned,
        )

    async def deliver(self, target: WebhookTarget, event: InboundWebhook) -> None:
        """Hand a resolved event to the bridge, at most once.

        Claiming comes first and the dispatch second, so a retry that arrives
        while the first delivery is still working finds the event taken and
        stops. That ordering is the whole of the deduplication: the platform
        sends the same event again whenever it is not answered in time, and
        the payload of a retry is identical to the original, so nothing later
        in the stack could tell it from someone saying the same thing twice.

        An event the platform does not number is dispatched without a claim.
        That is not a weaker guarantee quietly accepted — Slack numbers what it
        retries, so an envelope with no id is one that arrives exactly once.

        The dispatch itself runs with **nothing bound**, which is not an
        oversight. A bridge that receives over a socket dispatches from a task
        that binds no tenant, and every handler below it binds the tenant of
        the room it is acting on. Binding here would make the two delivery
        paths differ in the one respect that decides who a message reaches, and
        would hide a handler that had forgotten to bind for itself — for
        exactly as long as it took someone to receive the same event over a
        socket instead.
        """
        if event.external_event_id is None:
            await self._dispatch(target, event)
            return

        async with tenant_session(self._session_factory, target.tenant_id) as session:
            receipt = await self._receipts.claim(
                session,
                platform=target.platform,
                external_event_id=event.external_event_id,
            )
            if receipt is None:
                logger.info(
                    "Dropped a repeat delivery of %s event %s to bridge %s "
                    "(attempt %s); it has already been taken",
                    target.platform,
                    event.external_event_id,
                    target.bridge_id,
                    event.delivery_attempt,
                )
                return
            receipt_id = receipt.id
            # Before the dispatch, not with it. The index entry this writes is
            # what a concurrent retry collides with, and an uncommitted one
            # makes that retry wait for the turn instead of losing to it.
            await session.commit()

        await self._dispatch(target, event)

        async with tenant_session(self._session_factory, target.tenant_id) as session:
            await self._receipts.mark_handled(session, receipt_id=receipt_id)
            pruned = await self._receipts.prune(session)
            await session.commit()
        if pruned:
            logger.info(
                "Pruned %s expired messaging event receipts for tenant %s",
                pruned,
                target.tenant_id,
            )

    async def answer(
        self, target: WebhookTarget, event: InboundWebhook
    ) -> dict[str, Any] | None:
        """Handle an event the platform waits on, and return its answer.

        No receipt, unlike `deliver`: a platform that retries one of these
        does so because it never saw the answer, and the retry has to be given
        one rather than dropped as a duplicate. Handling the same press twice
        is the adapter's to make harmless, and on Teams it already is.
        """
        return await self._dispatch(target, event)

    async def _dispatch(
        self, target: WebhookTarget, event: InboundWebhook
    ) -> dict[str, Any] | None:
        with no_tenant():
            return await target.adapter.dispatch_event(
                envelope_type=event.envelope_type, payload=event.payload
            )
