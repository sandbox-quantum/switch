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
"""

from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.install import (
    MessagingAppInstaller,
    MessagingInstallerRegistry,
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
from switch_core.crypto import encrypt_token
from switch_core.db.models import MessagingInstall
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.messaging_install_store import MessagingInstallStore
from switch_core.tenant_context import tenant_scope

logger = logging.getLogger(__name__)


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
        installers: MessagingInstallerRegistry,
        lifecycle: CollaborationBridgeLifecycleService,
        public_origin: str,
        secret: str,
    ) -> None:
        self._session_factory = session_factory
        self._store = store
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
