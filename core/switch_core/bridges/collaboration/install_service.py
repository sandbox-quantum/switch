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
4. **Claim the workspace**, which is where a workspace already held by another
   tenant fails, in the database rather than in a check above it.
5. **Register the bridge** from the rendered connection config, exactly as if
   an operator had typed the token in, and point the install row at it.

Step 5 last is deliberate too: a bridge that exists with no install row behind
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
from typing import Protocol

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.adapter import (
    PlatformAdapter,
    SupportsSharedConnection,
)
from switch_core.bridges.collaboration.install import (
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
from switch_core.bridges.collaboration.install_state import (
    InstallState,
    mint,
    mint_compact,
    verify,
    verify_compact,
)
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.models import BridgeStartRefused
from switch_core.crypto import decrypt_token, encrypt_token
from switch_core.db.models import MessagingInstall, MessagingInstallState, Room, User
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.messaging_event_store import MessagingEventReceiptStore
from switch_core.db.stores.messaging_install_store import (
    INSTALL_ACTIVE,
    INSTALL_DISCONNECTED,
    INSTALL_REVOKED,
    MessagingInstallStateError,
    MessagingInstallStore,
)
from switch_core.db.stores.user_store import UserStore
from switch_core.db.tenant_lookup import tenant_of_messaging_install
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
        users: UserStore,
        rooms: RoomDetacher,
        public_origin: str,
        secret: str,
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
        self._secret = secret

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
            return mint_compact(signed, secret=self._secret)
        return mint(signed, secret=self._secret)

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
    ) -> MessagingInstall:
        """Finish an install begun elsewhere, on behalf of nobody in particular.

        The caller is unauthenticated: everything trusted here comes out of the
        signature on `state_token` or out of the platform's own response.
        """
        installer = self._installers.get(platform)
        state = verify(state_token, secret=self._secret)
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

            async with tenant_session(
                self._session_factory, state.tenant_id
            ) as session:
                install = await self._store.record_install(
                    session,
                    platform=platform,
                    external_workspace_id=grant.external_workspace_id,
                    encrypted_bot_token=self._encrypted_token(grant),
                    scopes=grant.scopes,
                    user_id=burnt.created_by_user_id,
                )
                install_id = install.id
                await session.commit()

            bridge = await self._lifecycle.register(
                bridge_type=platform,
                display_name=grant.workspace_name,
                connection_config=installer.connection_config(grant),
                # Off, though the granted scopes would allow it. Nobody was
                # asked: an install has no registration form, and letting an
                # app create channels in a customer's workspace is a decision
                # someone should make rather than inherit.
                channel_creation_enabled=False,
                # A person installed the app: this is them connecting their
                # platform, which is exactly what onboarding measures.
                preconfigured=False,
            )

            async with tenant_session(
                self._session_factory, state.tenant_id
            ) as session:
                attached = await self._store.attach_bridge(
                    session, install_id=install_id, bridge_id=bridge.id
                )
                await session.commit()

            logger.info(
                "Installed %s workspace %s for tenant %s as bridge %s",
                platform,
                grant.external_workspace_id,
                state.tenant_id,
                bridge.id,
            )
            return attached

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

    async def claim(self, *, platform: str, claim: InstallClaim) -> MessagingInstall:
        """Install a workspace from an event that carried a signed claim.

        The counterpart of `complete` for a platform with no OAuth leg, and it
        keeps the same first two steps: verify the signature, then burn the
        state and commit before anything else. There is no code to exchange —
        the event is the grant — and what differs after that is the bridge.

        **A claim-based platform shares one bridge per tenant.** Identities are
        held per bridge, so a bridge per chat would have every person link
        themselves again in every chat. The first claim registers the bridge
        and each later one attaches to it.

        That makes the first claim a race: two landing together would each
        find no bridge and each register one. So the lookup, the insert, the
        registration and the attachment happen inside one transaction holding
        an advisory lock on the tenant and platform, and a second claim waits
        and then finds the bridge the first one made. Holding the transaction
        across registration has a second benefit: a registration that fails
        rolls the install back with it, rather than leaving a workspace claimed
        by a tenant with no bridge to deliver its events to.

        Who posted the claim is checked against the chat before the state is
        burnt, so a refused attempt leaves the code for someone who may use it.
        """
        installer = self._installers.get(platform)
        state = verify_compact(claim.token, platform=platform, secret=self._secret)
        await installer.require_claimant_may_connect(claim)

        with tenant_scope(state.tenant_id):
            try:
                burnt = await self._burn(state)
            except MessagingInstallStateError:
                holder = await tenant_of_messaging_install(
                    self._session_factory,
                    platform,
                    claim.grant.external_workspace_id,
                )
                if holder == state.tenant_id:
                    raise InstallClaimRepeated(
                        f"the {platform} workspace "
                        f"{claim.grant.external_workspace_id} was already "
                        "connected by this claim"
                    ) from None
                raise

            async with tenant_session(
                self._session_factory, state.tenant_id
            ) as session:
                await self._lock_platform(session, state.tenant_id, platform)
                bridge_id = await self._store.bridge_for_platform(
                    session, platform=platform
                )
                if bridge_id is None:
                    await self._require_admin(session, burnt, platform)

                install = await self._store.record_install(
                    session,
                    platform=platform,
                    external_workspace_id=claim.grant.external_workspace_id,
                    encrypted_bot_token=self._encrypted_token(claim.grant),
                    scopes=claim.grant.scopes,
                    user_id=burnt.created_by_user_id,
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
                await session.commit()

            logger.info(
                "Claimed %s workspace %s for tenant %s on bridge %s",
                platform,
                claim.grant.external_workspace_id,
                state.tenant_id,
                bridge_id,
            )
            return attached

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
            await self._rooms.unlink_bridge_channel(bridge_id, workspace_id)
            return
        await self._lifecycle.remove(bridge_id)

    async def await_bridge_start(self, target: WebhookTarget) -> None:
        """Wait for the bridge an event carrying a claim resolved to, to start.

        A claim is the event that provisions its chat's room, and a bridge is
        launched before it is started: its adapter is given the callbacks that
        provision anything in the bridge's own task, a few reads after launch.
        Handed a claim in that gap, the adapter has nothing to provision the
        room with. That gap is open when a claim has just registered the
        bridge, when Telegram retries such a claim while the bridge is still
        coming up, and when a claim lands on a bridge that is restarting.

        Only an event carrying a claim waits; every other event is delivered
        as it always was. Past the wait the platform is told to retry, and the
        retry — a repeated claim, since the install is committed — waits again.
        """
        deadline = time.monotonic() + _BRIDGE_START_WAIT
        while not self._lifecycle.is_connected(target.bridge_id):
            if time.monotonic() >= deadline:
                raise WebhookBridgeUnavailable(
                    f"bridge {target.bridge_id}, which a {target.platform} claim "
                    "resolved to, is still starting"
                )
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
        return encrypt_token(grant.bot_token, self._secret)

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
                await installer.revoke(bot_token=decrypt_token(token, self._secret))
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

    def authenticate(
        self,
        *,
        platform: str,
        endpoint: WebhookEndpoint,
        headers: Mapping[str, str],
        body: bytes,
    ) -> InboundWebhook:
        """Prove an inbound request came from the platform, and read it.

        Verification is first and unconditional. Nothing above it inspects the
        body, so an unsigned request cannot pick which parser runs, and nothing
        is logged from it either — it is a stranger's bytes until this passes.
        """
        installer = self._installers.get(platform)
        installer.verify_webhook(headers=headers, body=body)
        return installer.parse_webhook(endpoint=endpoint, headers=headers, body=body)

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

    async def resolve(self, *, platform: str, event: InboundWebhook) -> WebhookTarget:
        """Turn a webhook event's workspace into the bridge entitled to it."""
        installer = self._installers.get(platform)
        workspace_id = installer.workspace_of_event(event.payload)
        return await self.resolve_by_workspace(
            platform=platform, workspace_id=workspace_id
        )

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
        if adapter is None:
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

    async def _dispatch(self, target: WebhookTarget, event: InboundWebhook) -> None:
        with no_tenant():
            await target.adapter.dispatch_event(
                envelope_type=event.envelope_type, payload=event.payload
            )
