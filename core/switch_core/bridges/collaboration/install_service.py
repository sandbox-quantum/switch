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

import logging
from collections.abc import Mapping
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.adapter import CollaborationAdapter
from switch_core.bridges.collaboration.install import (
    InboundWebhook,
    MessagingAppInstaller,
    MessagingInstallerRegistry,
    WebhookEndpoint,
    oauth_callback_path,
    public_url,
)
from switch_core.bridges.collaboration.install_state import (
    InstallState,
    mint,
    verify,
)
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.crypto import decrypt_token, encrypt_token
from switch_core.db.models import MessagingInstall
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.messaging_event_store import MessagingEventReceiptStore
from switch_core.db.stores.messaging_install_store import (
    INSTALL_ACTIVE,
    INSTALL_DISCONNECTED,
    INSTALL_REVOKED,
    MessagingInstallStore,
)
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
class WebhookTarget:
    """Where one verified event goes: a tenant, a bridge, and its live adapter.

    `platform` is carried rather than passed alongside because it is part of
    the answer: the same workspace id could in principle be issued by two
    platforms, and every row written about this delivery is keyed by the pair.
    """

    tenant_id: str
    platform: str
    bridge_id: str
    adapter: CollaborationAdapter


class InstallPlatformMismatch(RuntimeError):
    """A state minted for one platform arrived at another's callback.

    Only reachable with a valid signature, so this is not an attack so much as
    a deployment that has crossed its own wires — but it would otherwise redeem
    a real state against the wrong installer, and the store's own platform
    predicate would then refuse it with a message about expiry that is not
    true.
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
        public_origin: str,
        secret: str,
    ) -> None:
        self._session_factory = session_factory
        self._store = store
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
        state = await self._store.start_install(
            session, platform=platform, user_id=user_id
        )
        token = mint(
            InstallState(
                tenant_id=state.tenant_id, state_id=state.id, platform=platform
            ),
            secret=self._secret,
        )
        return installer.authorize_url(
            state=token, redirect_uri=self._redirect_uri(platform)
        )

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
            async with tenant_session(
                self._session_factory, state.tenant_id
            ) as session:
                burnt = await self._store.redeem_state(
                    session, state_id=state.state_id, platform=platform
                )
                await session.commit()

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
                    encrypted_bot_token=encrypt_token(grant.bot_token, self._secret),
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

    async def list_installs(self, session: AsyncSession) -> list[MessagingInstall]:
        """The bound tenant's installs, for the operator's own list.

        On the caller's session like `begin`, and scoped by it: there is no
        tenant argument because there is no tenant to choose.
        """
        return await self._store.list_for_tenant(session)

    # ── Ending an install ────────────────────────────────────────────────────

    async def disconnect(self, *, tenant_id: str, install_id: str) -> MessagingInstall:
        """End an install because somebody here said to.

        Idempotent: disconnecting an install that has already ended returns it
        unchanged. An operator can reach this for a row the platform's own
        `app_uninstalled` ended a second earlier, and that is not an error to
        show them.

        **Removing the bridge detaches every room that used it**, which become
        internal-only. That is the honest consequence of disconnecting a
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
            if token is not None:
                await self._installers.get(platform).revoke(
                    bot_token=decrypt_token(token, self._secret)
                )

            async with tenant_session(self._session_factory, tenant_id) as session:
                ended = await self._store.end(
                    session, install_id=install_id, status=INSTALL_DISCONNECTED
                )
                await session.commit()

            if bridge_id is not None:
                await self._lifecycle.remove(bridge_id)

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
                await self._lifecycle.remove(bridge_id)

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
    # posts to Matrix before replying turns one slow room into duplicate
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

    async def resolve(self, *, platform: str, event: InboundWebhook) -> WebhookTarget:
        """Turn a workspace id into the one bridge entitled to the event.

        The tenant comes from the exempt lookup (`db/tenant_lookup.py`), which
        is the only way to answer it: the caller authenticated to nothing, and
        every table that could say is scoped. The install row is then read
        *again* under that tenant rather than returned by the lookup — a
        deliberate second check, so a wrong answer above is a miss here instead
        of a cross-tenant read.
        """
        installer = self._installers.get(platform)
        workspace_id = installer.workspace_of_event(event.payload)

        tenant_id = await tenant_of_messaging_install(
            self._session_factory, platform, workspace_id
        )
        if tenant_id is None:
            raise WebhookWorkspaceUnknown(
                f"no tenant has installed Switch into {platform} workspace "
                f"{workspace_id}"
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
        return WebhookTarget(
            tenant_id=tenant_id,
            platform=platform,
            bridge_id=install.bridge_id,
            adapter=adapter,
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
