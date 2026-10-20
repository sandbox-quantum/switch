"""The install as one operation, across the two requests it is actually made of.

The individual pieces are covered elsewhere — the signature in
`test_install_state.py`, single use in the store's own tests, Slack's responses
in `test_slack_installer.py`. What is only visible here is the join: that the
tenant the first leg was authenticated for is the tenant the second leg writes
to, that a replay gets no further than the burn, and that a bridge appears at
the end configured the way an operator's own would be.

Postgres is real because row-level security is the second half of the argument
and a mock has no policies.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import ClassVar
from urllib.parse import parse_qs, urlparse

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import async_sessionmaker

from switch_core.bridges.collaboration.install import (
    InboundWebhook,
    InstallGrant,
    MessagingAppInstaller,
    MessagingInstallerRegistry,
    MessagingInstallError,
    WebhookEndpoint,
)
from switch_core.bridges.collaboration.install_confirmation import (
    InstallTicketError,
)
from switch_core.bridges.collaboration.install_service import (
    InstallPlatformMismatch,
    MessagingInstallService,
)
from switch_core.bridges.collaboration.install_state import (
    InstallState,
    InstallStateError,
    mint,
)
from switch_core.bridges.collaboration.lifecycle_service import BridgeClaimConflict
from switch_core.bridges.collaboration.models import BridgeCredentialError
from switch_core.db.models import (
    Client,
    CollaborationBridge,
    MessagingInstall,
    MessagingInstallState,
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
    MessagingInstallNotFound,
    MessagingInstallStateError,
    MessagingInstallStore,
)
from switch_core.db.stores.user_store import UserStore
from switch_core.keys import Keyring
from tests.conftest import RLSHarness

pytestmark = pytest.mark.no_ambient_tenant

_KEYRING = Keyring.parse("test:" + "s" * 40, legacy_secret=None)
_ORIGIN = "https://switch.example"


class _FakeInstaller(MessagingAppInstaller):
    """A platform that always says yes, and counts how often it was asked."""

    platform: ClassVar[str] = "slack"
    webhook_endpoints: ClassVar[frozenset[WebhookEndpoint]] = frozenset(
        {"events", "interactive", "commands"}
    )

    def __init__(self, workspace_id: str, *, tokenless: bool = False) -> None:
        self.workspace_id = workspace_id
        self.tokenless = tokenless
        self.redeem_calls: list[str] = []
        self.platform_data: dict[str, object] = {"kept": "for later"}
        self.revoked_tokens: list[str] = []
        self.revoke_error: Exception | None = None
        self.released: list[str] = []

    def authorize_url(self, *, state: str, redirect_uri: str) -> str:
        return f"https://platform.example/authorize?state={state}"

    async def redeem(self, *, code: str, redirect_uri: str) -> InstallGrant:
        self.redeem_calls.append(redirect_uri)
        return InstallGrant(
            external_workspace_id=self.workspace_id,
            workspace_name="Acme",
            # `None` stands in for a platform whose credential is
            # deployment-level, not per-install (Discord). The service must
            # store no token for it and revoke nothing on disconnect.
            bot_token=None if self.tokenless else "xoxb-granted",
            scopes="chat:write",
            platform_data=self.platform_data,
        )

    async def revoke(self, *, bot_token: str) -> None:
        if self.revoke_error is not None:
            raise self.revoke_error
        self.revoked_tokens.append(bot_token)

    async def release(self, *, external_workspace_id: str) -> None:
        self.released.append(external_workspace_id)

    def revocation_of_event(self, payload: Mapping[str, object]) -> str | None:
        event = payload.get("event")
        if not isinstance(event, dict):
            return None
        if event.get("type") == "app_uninstalled":
            return "the app was removed"
        return None

    async def verify_webhook(
        self,
        *,
        endpoint: WebhookEndpoint,
        headers: Mapping[str, str],
        query: Mapping[str, str],
        body: bytes,
    ) -> None:
        return None

    def parse_webhook(
        self,
        *,
        endpoint: WebhookEndpoint,
        headers: Mapping[str, str],
        query: Mapping[str, str],
        body: bytes,
    ) -> list[InboundWebhook]:
        return [
            InboundWebhook(
                envelope_type=endpoint,
                payload={},
                handshake=None,
                external_event_id=None,
                delivery_attempt=0,
                answers_inline=False,
            )
        ]

    def workspace_of_event(self, payload: Mapping[str, object]) -> str:
        return self.workspace_id

    def connection_config(self, grant: InstallGrant) -> dict[str, object]:
        return {"bot_token": grant.bot_token, "workspace_id": grant.workspace_name}


class _NoRooms:
    """A Slack bridge has one install, so an ending never detaches one room."""

    async def unlink_bridge_channel(
        self, bridge_id: str, external_channel_id: str
    ) -> None:
        raise AssertionError("a one-install bridge is removed, not detached")


class _FakeLifecycle:
    """Stands in for the bridge lifecycle, which starts real network clients.

    It still writes the rows, because the install points at the bridge through
    a composite foreign key and a stub returning an id that is not in the table
    would prove the last step works when it does not.
    """

    def __init__(
        self, factory: async_sessionmaker, tenant_id: str, suffix: str
    ) -> None:
        self._factory = factory
        self._tenant_id = tenant_id
        self._suffix = suffix
        self.registered: list[dict[str, object]] = []
        self.removed: list[str] = []
        # Set to make the claim check refuse, as the real one does when another
        # bridge already connects the workspace.
        self.claim_conflict: str | None = None
        # Set to make the next registration fail before writing anything, as
        # the real one does when the platform rejects or cannot check the
        # credential. Cleared once raised, so a retry succeeds.
        self.register_failure: Exception | None = None
        self.restarted: list[str] = []
        self.running: dict[str, object] = {}
        # Registered but still starting: running, and not yet connected.
        self.starting: set[str] = set()
        self.restart_failure: Exception | None = None

    async def reject_claim_conflict(
        self,
        bridge_type: str,
        connection_config: dict[str, object],
        *,
        exclude_bridge_id: str | None = None,
    ) -> None:
        if self.claim_conflict is not None:
            raise BridgeClaimConflict(self.claim_conflict)

    async def restart(self, bridge_id: str) -> None:
        self.restarted.append(bridge_id)
        if self.restart_failure is not None:
            raise self.restart_failure

    def get_adapter(self, bridge_id: str) -> object | None:
        return self.running.get(bridge_id)

    def is_connected(self, bridge_id: str) -> bool:
        return bridge_id in self.running and bridge_id not in self.starting

    async def register(self, **kwargs: object) -> CollaborationBridge:
        if self.register_failure is not None:
            failure, self.register_failure = self.register_failure, None
            raise failure
        self.registered.append(kwargs)
        async with tenant_session(self._factory, self._tenant_id) as session:
            client = Client(
                transport_user_id=f"@bridge-{len(self.registered)}:{self._suffix}",
                display_name=str(kwargs["display_name"]),
                type="collaboration_bridge",
            )
            session.add(client)
            await session.flush()
            bridge = CollaborationBridge(
                type=str(kwargs["bridge_type"]),
                display_name=str(kwargs["display_name"]),
                connection_config={},
                client_id=client.id,
                status="active",
            )
            session.add(bridge)
            await session.flush()
            bridge_id = bridge.id
            await session.commit()
        return CollaborationBridge(id=bridge_id)

    async def remove(self, bridge_id: str) -> None:
        """Delete the row, not just record the call.

        The install points at the bridge through a foreign key with no
        `ON DELETE`, so a stub that only counted removals would let a caller
        that forgot to release the pointer pass here and fail in production.
        """
        self.removed.append(bridge_id)
        async with tenant_session(self._factory, self._tenant_id) as session:
            bridge = await session.get(CollaborationBridge, bridge_id)
            if bridge is not None:
                await session.delete(bridge)
            await session.commit()


class _Fixture:
    def __init__(self) -> None:
        self.tenant_a: str = ""
        self.tenant_b: str = ""
        self.user_id: str = ""
        self.workspace: str = ""
        self.installer: _FakeInstaller
        self.lifecycle: _FakeLifecycle
        self.service: MessagingInstallService


async def _fixture(harness: RLSHarness, *, tokenless: bool = False) -> _Fixture:
    fixture = _Fixture()
    suffix = uuid.uuid4().hex[:8]
    fixture.tenant_a = f"tenant-a-{suffix}"
    fixture.tenant_b = f"tenant-b-{suffix}"
    fixture.workspace = f"T-{suffix}"

    async with harness.owner() as session:
        for tenant_id in (fixture.tenant_a, fixture.tenant_b):
            session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
        user = User(name="installer", email=f"{suffix}@example.test", role="user")
        session.add(user)
        await session.flush()
        fixture.user_id = user.id
        await session.commit()

    fixture.installer = _FakeInstaller(fixture.workspace, tokenless=tokenless)
    fixture.lifecycle = _FakeLifecycle(harness.restricted, fixture.tenant_a, suffix)
    installers = MessagingInstallerRegistry()
    installers.register(fixture.installer)
    fixture.service = MessagingInstallService(
        session_factory=harness.restricted,
        store=MessagingInstallStore(),
        receipts=MessagingEventReceiptStore(),
        installers=installers,
        lifecycle=fixture.lifecycle,  # type: ignore[arg-type]
        users=UserStore(),
        rooms=_NoRooms(),
        public_origin=_ORIGIN,
        keyring=_KEYRING,
    )
    return fixture


async def _begin(factory: async_sessionmaker, fixture: _Fixture, tenant_id: str) -> str:
    """Start an install as `tenant_id` and return the state it minted."""
    async with tenant_session(factory, tenant_id) as session:
        url = await fixture.service.begin(
            session, platform="slack", user_id=fixture.user_id
        )
        await session.commit()
    return parse_qs(urlparse(url).query)["state"][0]


async def _installed(
    factory: async_sessionmaker, fixture: _Fixture, tenant_id: str
) -> MessagingInstall:
    """Run both legs, confirm, and return the install they produced."""
    state = await _begin(factory, fixture, tenant_id)
    return await _land(fixture, state)


async def _land(fixture: _Fixture, state: str) -> MessagingInstall:
    """Finish the callback and choose Connect on the page it renders."""
    pending = await fixture.service.complete(
        platform="slack", code="the-code", state_token=state
    )
    return await fixture.service.confirm(platform="slack", ticket=pending.ticket)


async def _reread(
    factory: async_sessionmaker, tenant_id: str, install_id: str
) -> MessagingInstall:
    async with tenant_session(factory, tenant_id) as session:
        return await MessagingInstallStore().get(session, install_id=install_id)


class TestTheRoundTrip:
    async def test_an_install_lands_in_the_tenant_that_started_it(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        state = await _begin(rls_harness.restricted, fixture, fixture.tenant_a)

        install = await _land(fixture, state)

        assert install.tenant_id == fixture.tenant_a
        assert install.external_workspace_id == fixture.workspace
        assert install.installed_by_user_id == fixture.user_id

    async def test_the_bot_token_is_encrypted_at_rest(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        state = await _begin(rls_harness.restricted, fixture, fixture.tenant_a)

        install = await _land(fixture, state)

        assert "xoxb-granted" not in install.encrypted_bot_token
        assert _KEYRING.decrypt(install.encrypted_bot_token) == "xoxb-granted"

    async def test_it_ends_with_a_bridge_the_install_points_at(
        self, rls_harness: RLSHarness
    ) -> None:
        """The seam. An install that records a credential and builds nothing is
        a customer who clicked Add to Slack and got nothing."""
        fixture = await _fixture(rls_harness)
        state = await _begin(rls_harness.restricted, fixture, fixture.tenant_a)

        install = await _land(fixture, state)

        assert len(fixture.lifecycle.registered) == 1
        registered = fixture.lifecycle.registered[0]
        assert registered["bridge_type"] == "slack"
        assert registered["display_name"] == "Acme"
        # A person clicked Add to Slack: onboarding telemetry must count it.
        assert registered["preconfigured"] is False
        assert install.bridge_id is not None

    async def test_the_redirect_is_the_public_one_on_both_legs(
        self, rls_harness: RLSHarness
    ) -> None:
        """The platform compares them, so a mismatch is a refused install.

        Built from the configured origin rather than from either request,
        which is the only way the two legs — on different hostnames — agree.
        """
        fixture = await _fixture(rls_harness)
        state = await _begin(rls_harness.restricted, fixture, fixture.tenant_a)
        await fixture.service.complete(
            platform="slack", code="the-code", state_token=state
        )

        assert fixture.installer.redeem_calls == [
            f"{_ORIGIN}/messaging/slack/oauth/callback"
        ]


class TestWhatTheCallbackWillNotDo:
    async def test_a_replayed_state_never_reaches_the_platform(
        self, rls_harness: RLSHarness
    ) -> None:
        """Burnt before the code is exchanged, not after.

        The count is the assertion: a replay that got as far as redeeming would
        have obtained a second credential before anything refused it.
        """
        fixture = await _fixture(rls_harness)
        state = await _begin(rls_harness.restricted, fixture, fixture.tenant_a)
        await fixture.service.complete(
            platform="slack", code="the-code", state_token=state
        )

        with pytest.raises(MessagingInstallStateError):
            await fixture.service.complete(
                platform="slack", code="the-code", state_token=state
            )
        assert len(fixture.installer.redeem_calls) == 1

    async def test_a_state_naming_a_tenant_it_does_not_own_is_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        """What is left if the signing key ever leaks.

        Forging a state for tenant B against tenant A's row gets past the
        signature by construction, and row-level security still finds no row
        to burn.
        """
        fixture = await _fixture(rls_harness)
        state = await _begin(rls_harness.restricted, fixture, fixture.tenant_a)

        async with tenant_session(rls_harness.restricted, fixture.tenant_a) as session:
            state_id = (
                await MessagingInstallStore().start_install(
                    session, platform="slack", user_id=fixture.user_id
                )
            ).id
            await session.commit()

        forged = mint(
            InstallState(
                tenant_id=fixture.tenant_b, state_id=state_id, platform="slack"
            ),
            keyring=_KEYRING,
        )
        with pytest.raises(MessagingInstallStateError):
            await fixture.service.complete(
                platform="slack", code="the-code", state_token=forged
            )
        assert fixture.installer.redeem_calls == []
        assert state  # the untouched state is still redeemable; nothing was burnt

    async def test_an_unsigned_state_never_touches_the_database(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        with pytest.raises(InstallStateError):
            await fixture.service.complete(
                platform="slack", code="the-code", state_token="v1.aaa.bbb"
            )

    async def test_a_state_for_another_platform_is_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        forged = mint(
            InstallState(
                tenant_id=fixture.tenant_a, state_id="whatever", platform="teams"
            ),
            keyring=_KEYRING,
        )
        with pytest.raises(InstallPlatformMismatch):
            await fixture.service.complete(
                platform="slack", code="the-code", state_token=forged
            )

    async def test_a_workspace_another_tenant_holds_is_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        """And no bridge is built for it.

        The whole point of the deployment-wide unique constraint: one
        workspace's events have exactly one destination.
        """
        fixture = await _fixture(rls_harness)
        async with tenant_session(rls_harness.restricted, fixture.tenant_b) as session:
            session.add(
                MessagingInstall(
                    tenant_id=fixture.tenant_b,
                    platform="slack",
                    external_workspace_id=fixture.workspace,
                    encrypted_bot_token="ciphertext",
                    scopes="chat:write",
                    status="active",
                    installed_by_user_id=fixture.user_id,
                )
            )
            await session.commit()

        state = await _begin(rls_harness.restricted, fixture, fixture.tenant_a)
        with pytest.raises(MessagingInstallClaimedError):
            await _land(fixture, state)
        assert fixture.lifecycle.registered == []

    async def test_a_workspace_a_manual_bridge_connects_is_refused_before_recording(
        self, rls_harness: RLSHarness
    ) -> None:
        """Refused before the install is written, not when its bridge is
        registered: an install left with no bridge would hold the workspace
        for nothing, and the next attempt would be refused by it."""
        fixture = await _fixture(rls_harness)
        fixture.lifecycle.claim_conflict = (
            f"Slack workspace {fixture.workspace} is already claimed"
        )

        state = await _begin(rls_harness.restricted, fixture, fixture.tenant_a)
        with pytest.raises(MessagingInstallClaimedError, match="already claimed"):
            await fixture.service.complete(
                platform="slack", code="the-code", state_token=state
            )
        assert fixture.lifecycle.registered == []
        async with tenant_session(rls_harness.restricted, fixture.tenant_a) as session:
            assert await fixture.service.list_installs(session) == []

    async def test_a_workspace_claimed_while_the_page_was_open_is_refused_on_connect(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        state = await _begin(rls_harness.restricted, fixture, fixture.tenant_a)
        pending = await fixture.service.complete(
            platform="slack", code="the-code", state_token=state
        )
        fixture.lifecycle.claim_conflict = (
            f"Slack workspace {fixture.workspace} is already claimed"
        )

        with pytest.raises(MessagingInstallClaimedError, match="already claimed"):
            await fixture.service.confirm(platform="slack", ticket=pending.ticket)
        assert fixture.lifecycle.registered == []
        async with tenant_session(rls_harness.restricted, fixture.tenant_a) as session:
            assert await fixture.service.list_installs(session) == []


class TestAFailedRegistrationReleasesTheWorkspace:
    """The bridge is registered after the install is recorded, and a platform
    blip during its credential check must not leave an active install with no
    bridge holding the workspace against every retry."""

    async def _statuses(self, factory: async_sessionmaker, tenant_id: str) -> list[str]:
        async with tenant_session(factory, tenant_id) as session:
            installs = await MessagingInstallStore().list_for_tenant(session)
        return sorted(install.status for install in installs)

    async def test_a_credential_failure_ends_the_install_and_says_so(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        fixture.lifecycle.register_failure = BridgeCredentialError(
            "Could not reach Slack to check the bot token: timeout. Try again."
        )

        with pytest.raises(MessagingInstallError, match="Start the install again"):
            await _installed(rls_harness.restricted, fixture, fixture.tenant_a)

        assert await self._statuses(rls_harness.restricted, fixture.tenant_a) == [
            INSTALL_DISCONNECTED
        ]
        retry = await _installed(rls_harness.restricted, fixture, fixture.tenant_a)
        assert retry.status == INSTALL_ACTIVE
        assert retry.bridge_id is not None

    async def test_any_other_failure_ends_it_too_and_is_not_disguised(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        fixture.lifecycle.register_failure = RuntimeError("database went away")

        with pytest.raises(RuntimeError, match="database went away"):
            await _installed(rls_harness.restricted, fixture, fixture.tenant_a)

        assert await self._statuses(rls_harness.restricted, fixture.tenant_a) == [
            INSTALL_DISCONNECTED
        ]


class TestTheConfirmation:
    """The callback asks before it claims, and only the page's answer counts."""

    async def test_the_callback_claims_nothing_and_names_the_organisation(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        state = await _begin(rls_harness.restricted, fixture, fixture.tenant_a)

        pending = await fixture.service.complete(
            platform="slack", code="the-code", state_token=state
        )

        assert pending.organisation == fixture.tenant_a
        assert pending.requested_by.endswith("@example.test")
        assert pending.workspace_name == "Acme"
        assert pending.external_workspace_id == fixture.workspace
        assert "xoxb-granted" not in pending.ticket
        assert fixture.lifecycle.registered == []
        async with tenant_session(rls_harness.restricted, fixture.tenant_a) as session:
            assert await MessagingInstallStore().list_for_tenant(session) == []

    async def test_the_state_token_alone_cannot_connect(
        self, rls_harness: RLSHarness
    ) -> None:
        """Whoever started the install holds the state; only the page holds
        the ticket. Otherwise they could confirm on the approver's behalf."""
        fixture = await _fixture(rls_harness)
        state = await _begin(rls_harness.restricted, fixture, fixture.tenant_a)
        await fixture.service.complete(
            platform="slack", code="the-code", state_token=state
        )

        with pytest.raises(InstallTicketError):
            await fixture.service.confirm(platform="slack", ticket=state)
        assert fixture.lifecycle.registered == []

    async def test_a_tampered_ticket_is_refused(self, rls_harness: RLSHarness) -> None:
        fixture = await _fixture(rls_harness)
        state = await _begin(rls_harness.restricted, fixture, fixture.tenant_a)
        pending = await fixture.service.complete(
            platform="slack", code="the-code", state_token=state
        )
        flipped = pending.ticket[:-5] + ("A" if pending.ticket[-5] != "A" else "B")
        tampered = flipped + pending.ticket[-4:]

        with pytest.raises(InstallTicketError):
            await fixture.service.confirm(platform="slack", ticket=tampered)

    async def test_a_ticket_for_another_platform_is_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        state = await _begin(rls_harness.restricted, fixture, fixture.tenant_a)
        pending = await fixture.service.complete(
            platform="slack", code="the-code", state_token=state
        )

        with pytest.raises(InstallPlatformMismatch):
            await fixture.service.confirm(platform="teams", ticket=pending.ticket)

    async def test_a_confirmation_connects_once(self, rls_harness: RLSHarness) -> None:
        fixture = await _fixture(rls_harness)
        state = await _begin(rls_harness.restricted, fixture, fixture.tenant_a)
        pending = await fixture.service.complete(
            platform="slack", code="the-code", state_token=state
        )
        await fixture.service.confirm(platform="slack", ticket=pending.ticket)

        with pytest.raises(MessagingInstallStateError):
            await fixture.service.confirm(platform="slack", ticket=pending.ticket)
        with pytest.raises(MessagingInstallStateError):
            await fixture.service.cancel(platform="slack", ticket=pending.ticket)
        assert len(fixture.lifecycle.registered) == 1
        assert fixture.installer.revoked_tokens == []

    async def test_a_stale_confirmation_is_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        state = await _begin(rls_harness.restricted, fixture, fixture.tenant_a)
        pending = await fixture.service.complete(
            platform="slack", code="the-code", state_token=state
        )
        async with rls_harness.owner() as session:
            await session.execute(
                update(MessagingInstallState)
                .where(MessagingInstallState.tenant_id == fixture.tenant_a)
                .values(consumed_at=datetime.now(UTC) - timedelta(hours=1))
            )
            await session.commit()

        with pytest.raises(MessagingInstallStateError):
            await fixture.service.confirm(platform="slack", ticket=pending.ticket)
        assert fixture.lifecycle.registered == []

    async def test_cancel_records_nothing_and_revokes_the_token(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        state = await _begin(rls_harness.restricted, fixture, fixture.tenant_a)
        pending = await fixture.service.complete(
            platform="slack", code="the-code", state_token=state
        )

        await fixture.service.cancel(platform="slack", ticket=pending.ticket)

        assert fixture.installer.revoked_tokens == ["xoxb-granted"]
        assert fixture.lifecycle.registered == []
        with pytest.raises(MessagingInstallStateError):
            await fixture.service.confirm(platform="slack", ticket=pending.ticket)
        async with tenant_session(rls_harness.restricted, fixture.tenant_a) as session:
            assert await MessagingInstallStore().list_for_tenant(session) == []

    async def test_cancel_leaves_a_token_another_install_is_using(
        self, rls_harness: RLSHarness
    ) -> None:
        """The platform issues one bot token per app and workspace, so revoking
        it here would disconnect the tenant that already holds the workspace."""
        fixture = await _fixture(rls_harness)
        async with tenant_session(rls_harness.restricted, fixture.tenant_b) as session:
            session.add(
                MessagingInstall(
                    tenant_id=fixture.tenant_b,
                    platform="slack",
                    external_workspace_id=fixture.workspace,
                    encrypted_bot_token="ciphertext",
                    scopes="chat:write",
                    status="active",
                    installed_by_user_id=fixture.user_id,
                )
            )
            await session.commit()
        state = await _begin(rls_harness.restricted, fixture, fixture.tenant_a)
        pending = await fixture.service.complete(
            platform="slack", code="the-code", state_token=state
        )

        await fixture.service.cancel(platform="slack", ticket=pending.ticket)

        assert fixture.installer.revoked_tokens == []

    async def test_a_cancel_whose_revocation_fails_can_be_retried(
        self, rls_harness: RLSHarness
    ) -> None:
        """The ticket is the only copy of the token, so a cancel recorded
        ahead of a failed revocation would strand a live credential."""
        fixture = await _fixture(rls_harness)
        state = await _begin(rls_harness.restricted, fixture, fixture.tenant_a)
        pending = await fixture.service.complete(
            platform="slack", code="the-code", state_token=state
        )
        fixture.installer.revoke_error = MessagingInstallError("Slack is down")

        with pytest.raises(MessagingInstallError):
            await fixture.service.cancel(platform="slack", ticket=pending.ticket)

        fixture.installer.revoke_error = None
        await fixture.service.cancel(platform="slack", ticket=pending.ticket)

        assert fixture.installer.revoked_tokens == ["xoxb-granted"]
        assert fixture.lifecycle.registered == []
        with pytest.raises(MessagingInstallStateError):
            await fixture.service.cancel(platform="slack", ticket=pending.ticket)


class TestDisconnecting:
    """An install an operator ended, and what has to be true afterwards."""

    async def test_the_platform_is_told_before_anything_is_destroyed(
        self, rls_harness: RLSHarness
    ) -> None:
        """Deleting our copy of a token does not stop it working.

        Revoking is the half only the platform can do, so a disconnect that
        skipped it would leave a live key into a customer's workspace in every
        backup taken before it.
        """
        fixture = await _fixture(rls_harness)
        install = await _installed(rls_harness.restricted, fixture, fixture.tenant_a)

        await fixture.service.disconnect(
            tenant_id=fixture.tenant_a, install_id=install.id
        )

        assert fixture.installer.revoked_tokens == ["xoxb-granted"]

    async def test_it_leaves_no_credential_and_no_bridge(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        install = await _installed(rls_harness.restricted, fixture, fixture.tenant_a)
        bridge_id = install.bridge_id

        ended = await fixture.service.disconnect(
            tenant_id=fixture.tenant_a, install_id=install.id
        )

        assert ended.status == INSTALL_DISCONNECTED
        assert ended.ended_at is not None
        assert ended.encrypted_bot_token is None
        assert ended.bridge_id is None
        assert fixture.lifecycle.removed == [bridge_id]

    async def test_the_workspace_can_be_installed_again(
        self, rls_harness: RLSHarness
    ) -> None:
        """The reason the uniqueness index is partial.

        A customer who disconnects and changes their mind must be able to
        click Add to Slack again, and a row that went on occupying the
        workspace would mean nobody ever could.
        """
        fixture = await _fixture(rls_harness)
        first = await _installed(rls_harness.restricted, fixture, fixture.tenant_a)
        await fixture.service.disconnect(
            tenant_id=fixture.tenant_a, install_id=first.id
        )

        second = await _installed(rls_harness.restricted, fixture, fixture.tenant_a)

        assert second.id != first.id
        assert second.status == INSTALL_ACTIVE
        assert second.bridge_id is not None

    async def test_disconnecting_twice_is_success(
        self, rls_harness: RLSHarness
    ) -> None:
        """An operator can click it on a row the platform ended a second ago."""
        fixture = await _fixture(rls_harness)
        install = await _installed(rls_harness.restricted, fixture, fixture.tenant_a)
        await fixture.service.disconnect(
            tenant_id=fixture.tenant_a, install_id=install.id
        )

        again = await fixture.service.disconnect(
            tenant_id=fixture.tenant_a, install_id=install.id
        )

        assert again.status == INSTALL_DISCONNECTED
        assert fixture.installer.revoked_tokens == ["xoxb-granted"]
        assert len(fixture.lifecycle.removed) == 1

    async def test_a_refusal_nobody_understands_leaves_the_install_intact(
        self, rls_harness: RLSHarness
    ) -> None:
        """Which is the whole reason the platform is told first.

        The operator sees the failure and can try again; the alternative is a
        bridge already gone and a token still valid.
        """
        fixture = await _fixture(rls_harness)
        install = await _installed(rls_harness.restricted, fixture, fixture.tenant_a)
        fixture.installer.revoke_error = MessagingInstallError("Slack said no")

        with pytest.raises(MessagingInstallError):
            await fixture.service.disconnect(
                tenant_id=fixture.tenant_a, install_id=install.id
            )

        still = await _reread(rls_harness.restricted, fixture.tenant_a, install.id)
        assert still.status == INSTALL_ACTIVE
        assert still.encrypted_bot_token is not None
        assert still.bridge_id is not None
        assert fixture.lifecycle.removed == []

    async def test_another_tenants_install_is_not_disconnectable(
        self, rls_harness: RLSHarness
    ) -> None:
        """And misses the way an invented id would, telling the caller nothing."""
        fixture = await _fixture(rls_harness)
        install = await _installed(rls_harness.restricted, fixture, fixture.tenant_a)

        with pytest.raises(MessagingInstallNotFound):
            await fixture.service.disconnect(
                tenant_id=fixture.tenant_b, install_id=install.id
            )

        assert fixture.installer.revoked_tokens == []


class TestThePlatformEndingIt:
    async def test_an_uninstall_event_ends_the_install(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        install = await _installed(rls_harness.restricted, fixture, fixture.tenant_a)

        await fixture.service.revoked(
            platform="slack",
            workspace_id=fixture.workspace,
            reason="the app was removed",
        )

        ended = await _reread(rls_harness.restricted, fixture.tenant_a, install.id)
        assert ended.status == INSTALL_REVOKED
        assert ended.encrypted_bot_token is None
        assert ended.bridge_id is None
        assert fixture.lifecycle.removed == [install.bridge_id]

    async def test_nothing_is_revoked_at_a_platform_that_already_did_it(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        await _installed(rls_harness.restricted, fixture, fixture.tenant_a)

        await fixture.service.revoked(
            platform="slack",
            workspace_id=fixture.workspace,
            reason="the app was removed",
        )

        assert fixture.installer.revoked_tokens == []

    async def test_a_retried_event_is_not_an_error(
        self, rls_harness: RLSHarness
    ) -> None:
        """Slack redelivers, so the second one arrives after the workspace is free."""
        fixture = await _fixture(rls_harness)
        await _installed(rls_harness.restricted, fixture, fixture.tenant_a)
        await fixture.service.revoked(
            platform="slack", workspace_id=fixture.workspace, reason="removed"
        )

        await fixture.service.revoked(
            platform="slack", workspace_id=fixture.workspace, reason="removed"
        )

        assert len(fixture.lifecycle.removed) == 1

    async def test_a_workspace_nobody_installed_is_ignored(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)

        await fixture.service.revoked(
            platform="slack", workspace_id="T-nobody", reason="removed"
        )

        assert fixture.lifecycle.removed == []


class TestWhatTheOperatorSees:
    async def test_the_list_keeps_installs_that_ended(
        self, rls_harness: RLSHarness
    ) -> None:
        """A list of only the live ones answers "nothing here" to "what happened
        to the one that was here yesterday"."""
        fixture = await _fixture(rls_harness)
        first = await _installed(rls_harness.restricted, fixture, fixture.tenant_a)
        await fixture.service.disconnect(
            tenant_id=fixture.tenant_a, install_id=first.id
        )
        second = await _installed(rls_harness.restricted, fixture, fixture.tenant_a)

        async with tenant_session(rls_harness.restricted, fixture.tenant_a) as session:
            listed = await MessagingInstallStore().list_for_tenant(session)

        assert {install.id for install in listed} == {first.id, second.id}
        assert {install.status for install in listed} == {
            INSTALL_ACTIVE,
            INSTALL_DISCONNECTED,
        }

    async def test_the_list_is_the_bound_tenants_own(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        await _installed(rls_harness.restricted, fixture, fixture.tenant_a)

        async with tenant_session(rls_harness.restricted, fixture.tenant_b) as session:
            listed = await MessagingInstallStore().list_for_tenant(session)

        assert listed == []


class TestATokenlessGrant:
    """A platform whose credential is deployment-level, not per-install (Discord).

    The grant carries no token, so there is nothing to encrypt at record time
    and nothing to revoke at the platform on disconnect — the app-level bot
    token is not this install's to end. The rest of the flow is unchanged.
    """

    async def test_complete_stores_no_token_and_still_builds_a_bridge(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness, tokenless=True)
        state = await _begin(rls_harness.restricted, fixture, fixture.tenant_a)

        install = await _land(fixture, state)

        assert install.encrypted_bot_token is None
        assert install.bridge_id is not None
        assert len(fixture.lifecycle.registered) == 1

    async def test_disconnect_revokes_nothing_and_ends_cleanly(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness, tokenless=True)
        install = await _installed(rls_harness.restricted, fixture, fixture.tenant_a)
        bridge_id = install.bridge_id

        ended = await fixture.service.disconnect(
            tenant_id=fixture.tenant_a, install_id=install.id
        )

        assert fixture.installer.revoked_tokens == []
        assert ended.status == INSTALL_DISCONNECTED
        assert ended.ended_at is not None
        assert ended.bridge_id is None
        assert fixture.lifecycle.removed == [bridge_id]


class TestWhatAnInstallRemembers:
    async def test_what_the_platform_keeps_is_recorded_with_the_install(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)

        install = await _installed(rls_harness.restricted, fixture, fixture.tenant_a)

        reread = await _reread(rls_harness.restricted, fixture.tenant_a, install.id)
        assert reread.platform_data == {"kept": "for later"}


class TestApprovingAgain:
    async def test_the_same_organisation_approving_again_refreshes_its_install(
        self, rls_harness: RLSHarness
    ) -> None:
        """For a platform with no token, approving again is how new permissions
        or a newer app are granted — not a second claim on the workspace."""
        fixture = await _fixture(rls_harness, tokenless=True)
        first = await _installed(rls_harness.restricted, fixture, fixture.tenant_a)
        fixture.installer.platform_data = {"kept": "something newer"}

        again = await _installed(rls_harness.restricted, fixture, fixture.tenant_a)

        assert again.id == first.id
        assert again.platform_data == {"kept": "something newer"}
        assert fixture.lifecycle.restarted == [first.bridge_id]
        assert len(fixture.lifecycle.registered) == 1

    async def test_a_connection_that_cannot_restart_says_so_on_the_page(
        self, rls_harness: RLSHarness
    ) -> None:
        """The approval is recorded either way; the admin is told the
        connection is stopped, not shown a raw server error."""
        fixture = await _fixture(rls_harness, tokenless=True)
        first = await _installed(rls_harness.restricted, fixture, fixture.tenant_a)
        fixture.lifecycle.restart_failure = RuntimeError("database went away")

        with pytest.raises(MessagingInstallError, match="could not restart"):
            await _installed(rls_harness.restricted, fixture, fixture.tenant_a)

        assert fixture.lifecycle.restarted == [first.bridge_id]

    async def test_another_tenant_approving_the_same_workspace_is_still_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness, tokenless=True)
        await _installed(rls_harness.restricted, fixture, fixture.tenant_a)

        with pytest.raises(MessagingInstallClaimedError):
            await _installed(rls_harness.restricted, fixture, fixture.tenant_b)

    async def test_a_platform_with_a_token_is_not_refreshed_this_way(
        self, rls_harness: RLSHarness
    ) -> None:
        """Its bridge holds the old token; swapping it is not what this does."""
        fixture = await _fixture(rls_harness)
        await _installed(rls_harness.restricted, fixture, fixture.tenant_a)

        with pytest.raises(MessagingInstallClaimedError):
            await _installed(rls_harness.restricted, fixture, fixture.tenant_a)


class TestLettingGoOfATokenlessWorkspace:
    async def test_a_bridge_that_is_not_running_is_released_by_the_installer(
        self, rls_harness: RLSHarness
    ) -> None:
        """A running bridge lets go of the platform as it is removed; one that
        is not running cannot, so the installer does it instead."""
        fixture = await _fixture(rls_harness, tokenless=True)
        install = await _installed(rls_harness.restricted, fixture, fixture.tenant_a)

        await fixture.service.disconnect(
            tenant_id=fixture.tenant_a, install_id=install.id
        )

        assert fixture.installer.released == [fixture.workspace]

    async def test_a_running_bridge_is_left_to_let_go_itself(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness, tokenless=True)
        install = await _installed(rls_harness.restricted, fixture, fixture.tenant_a)
        assert install.bridge_id is not None
        fixture.lifecycle.running[install.bridge_id] = object()

        await fixture.service.disconnect(
            tenant_id=fixture.tenant_a, install_id=install.id
        )

        assert fixture.installer.released == []

    async def test_a_bridge_still_starting_is_released_by_the_installer(
        self, rls_harness: RLSHarness
    ) -> None:
        """Registered is not connected: a bridge just restarted has no Graph
        client yet, and letting go itself would quietly do nothing."""
        fixture = await _fixture(rls_harness, tokenless=True)
        install = await _installed(rls_harness.restricted, fixture, fixture.tenant_a)
        assert install.bridge_id is not None
        fixture.lifecycle.running[install.bridge_id] = object()
        fixture.lifecycle.starting.add(install.bridge_id)

        await fixture.service.disconnect(
            tenant_id=fixture.tenant_a, install_id=install.id
        )

        assert fixture.installer.released == [fixture.workspace]


class TestApprovingAgainKeepsWhatItLearned:
    async def test_a_repeated_approval_that_learned_less_erases_nothing(
        self, rls_harness: RLSHarness
    ) -> None:
        """An id an earlier approval learned is still good when this one could
        not read it again."""
        fixture = await _fixture(rls_harness, tokenless=True)
        fixture.installer.platform_data = {"catalog_app_id": "c-1"}
        await _installed(rls_harness.restricted, fixture, fixture.tenant_a)
        fixture.installer.platform_data = {"publish_problem": "update refused"}

        again = await _installed(rls_harness.restricted, fixture, fixture.tenant_a)

        assert again.platform_data == {
            "catalog_app_id": "c-1",
            "publish_problem": "update refused",
        }
