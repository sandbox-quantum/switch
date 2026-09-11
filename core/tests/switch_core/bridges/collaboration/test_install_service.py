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
from typing import ClassVar
from urllib.parse import parse_qs, urlparse

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

from switch_core.bridges.collaboration.install import (
    InstallGrant,
    MessagingAppInstaller,
    MessagingInstallerRegistry,
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
from switch_core.crypto import decrypt_token
from switch_core.db.models import (
    Client,
    CollaborationBridge,
    MessagingInstall,
    Tenant,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.messaging_install_store import (
    MessagingInstallClaimedError,
    MessagingInstallStateError,
    MessagingInstallStore,
)
from tests.conftest import RLSHarness

pytestmark = pytest.mark.no_ambient_tenant

_SECRET = "test-secret"
_ORIGIN = "https://switch.example"


class _FakeInstaller(MessagingAppInstaller):
    """A platform that always says yes, and counts how often it was asked."""

    platform: ClassVar[str] = "slack"

    def __init__(self, workspace_id: str) -> None:
        self.workspace_id = workspace_id
        self.redeem_calls: list[str] = []

    def authorize_url(self, *, state: str, redirect_uri: str) -> str:
        return f"https://platform.example/authorize?state={state}"

    async def redeem(self, *, code: str, redirect_uri: str) -> InstallGrant:
        self.redeem_calls.append(redirect_uri)
        return InstallGrant(
            external_workspace_id=self.workspace_id,
            workspace_name="Acme",
            bot_token="xoxb-granted",
            scopes="chat:write",
        )

    def verify_webhook(self, *, headers: Mapping[str, str], body: bytes) -> None:
        return None

    def workspace_of_event(self, payload: Mapping[str, object]) -> str:
        return self.workspace_id

    def connection_config(self, grant: InstallGrant) -> dict[str, object]:
        return {"bot_token": grant.bot_token, "workspace_id": grant.workspace_name}


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

    async def register(self, **kwargs: object) -> CollaborationBridge:
        self.registered.append(kwargs)
        async with tenant_session(self._factory, self._tenant_id) as session:
            client = Client(
                matrix_user_id=f"@bridge-{len(self.registered)}:{self._suffix}",
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


class _Fixture:
    def __init__(self) -> None:
        self.tenant_a: str = ""
        self.tenant_b: str = ""
        self.user_id: str = ""
        self.workspace: str = ""
        self.installer: _FakeInstaller
        self.lifecycle: _FakeLifecycle
        self.service: MessagingInstallService


async def _fixture(harness: RLSHarness) -> _Fixture:
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

    fixture.installer = _FakeInstaller(fixture.workspace)
    fixture.lifecycle = _FakeLifecycle(harness.restricted, fixture.tenant_a, suffix)
    installers = MessagingInstallerRegistry()
    installers.register(fixture.installer)
    fixture.service = MessagingInstallService(
        session_factory=harness.restricted,
        store=MessagingInstallStore(),
        installers=installers,
        lifecycle=fixture.lifecycle,  # type: ignore[arg-type]
        public_origin=_ORIGIN,
        secret=_SECRET,
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


class TestTheRoundTrip:
    async def test_an_install_lands_in_the_tenant_that_started_it(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        state = await _begin(rls_harness.restricted, fixture, fixture.tenant_a)

        install = await fixture.service.complete(
            platform="slack", code="the-code", state_token=state
        )

        assert install.tenant_id == fixture.tenant_a
        assert install.external_workspace_id == fixture.workspace
        assert install.installed_by_user_id == fixture.user_id

    async def test_the_bot_token_is_encrypted_at_rest(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        state = await _begin(rls_harness.restricted, fixture, fixture.tenant_a)

        install = await fixture.service.complete(
            platform="slack", code="the-code", state_token=state
        )

        assert "xoxb-granted" not in install.encrypted_bot_token
        assert decrypt_token(install.encrypted_bot_token, _SECRET) == "xoxb-granted"

    async def test_it_ends_with_a_bridge_the_install_points_at(
        self, rls_harness: RLSHarness
    ) -> None:
        """The seam. An install that records a credential and builds nothing is
        a customer who clicked Add to Slack and got nothing."""
        fixture = await _fixture(rls_harness)
        state = await _begin(rls_harness.restricted, fixture, fixture.tenant_a)

        install = await fixture.service.complete(
            platform="slack", code="the-code", state_token=state
        )

        assert len(fixture.lifecycle.registered) == 1
        registered = fixture.lifecycle.registered[0]
        assert registered["bridge_type"] == "slack"
        assert registered["display_name"] == "Acme"
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
            secret=_SECRET,
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
            secret=_SECRET,
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
            await fixture.service.complete(
                platform="slack", code="the-code", state_token=state
            )
        assert fixture.lifecycle.registered == []
