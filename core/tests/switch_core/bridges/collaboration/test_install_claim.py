"""Installing a workspace from an event, for a platform with no OAuth leg.

Telegram cannot redirect a browser, so its install arrives as a webhook event
carrying a compact signed state. What is only visible here is what differs from
the OAuth install: every claim of one tenant lands on one shared bridge, the
first claim is an admin's and later ones a member's, and two first claims at
once still make one bridge.

Postgres is real because row-level security, the unique index and the advisory
lock are all part of the argument, and a mock has none of them.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Mapping
from typing import Any, ClassVar
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from switch_core.bridges.collaboration.adapter import PlatformAdapter
from switch_core.bridges.collaboration.install import (
    InboundWebhook,
    InstallClaim,
    InstallGrant,
    MessagingAppInstaller,
    MessagingInstallerRegistry,
    MessagingInstallError,
    WebhookEndpoint,
)
from switch_core.bridges.collaboration.install_routes import (
    create_messaging_install_router,
)
from switch_core.bridges.collaboration.install_service import (
    InstallClaimNotPermitted,
    MessagingInstallService,
)
from switch_core.bridges.collaboration.install_state import (
    InstallState,
    InstallStateError,
    mint_compact,
)
from switch_core.db.models import (
    Client,
    CollaborationBridge,
    MessagingInstall,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.messaging_event_store import MessagingEventReceiptStore
from switch_core.db.stores.messaging_install_store import (
    INSTALL_ACTIVE,
    MessagingInstallClaimedError,
    MessagingInstallStateError,
    MessagingInstallStore,
)
from switch_core.db.stores.user_store import UserStore
from switch_core.keys import Keyring
from tests.conftest import RLSHarness
from tests.switch_core.bridges.collaboration.test_install_webhook import (
    _RecordingAdapter,
)

pytestmark = pytest.mark.no_ambient_tenant

_KEYRING = Keyring.parse("test:" + "t" * 40, legacy_secret=None)
_ORIGIN = "https://switch.example"
_PLATFORM = "telegram"


class _ClaimInstaller(MessagingAppInstaller):
    """A platform whose installs arrive as events, the way Telegram's do.

    The payload is a stand-in rather than Telegram's shape: `chat` names the
    workspace and `claim`, when present, carries the token.
    """

    platform: ClassVar[str] = _PLATFORM
    state_format = "compact"

    def __init__(self) -> None:
        self.connection: object | None = None
        self.not_ready = False

    def shared_connection(self) -> object | None:
        if self.not_ready:
            raise MessagingInstallError("the shared bot has not connected yet")
        return self.connection

    def authorize_url(self, *, state: str, redirect_uri: str) -> str:
        return f"https://t.me/switch_bot?startgroup={state}"

    async def redeem(self, *, code: str, redirect_uri: str) -> InstallGrant:
        raise AssertionError("a claim-based platform has no code to redeem")

    async def revoke(self, *, bot_token: str) -> None:
        raise AssertionError("a claim-based install holds no token to revoke")

    def verify_webhook(self, *, headers: Mapping[str, str], body: bytes) -> None:
        return None

    def parse_webhook(
        self, *, endpoint: WebhookEndpoint, headers: Mapping[str, str], body: bytes
    ) -> InboundWebhook:
        return InboundWebhook(
            envelope_type=endpoint,
            payload=json.loads(body),
            handshake=None,
            external_event_id=None,
            delivery_attempt=0,
        )

    def workspace_of_event(self, payload: Mapping[str, object]) -> str:
        return str(payload["chat"])

    def revocation_of_event(self, payload: Mapping[str, object]) -> str | None:
        return None

    def claim_of_event(self, payload: Mapping[str, object]) -> InstallClaim | None:
        token = payload.get("claim")
        if not isinstance(token, str):
            return None
        return InstallClaim(token=token, grant=_grant(str(payload["chat"])))

    def connection_config(self, grant: InstallGrant) -> dict[str, object]:
        return {"event_delivery": "shared"}


def _grant(chat_id: str) -> InstallGrant:
    return InstallGrant(
        external_workspace_id=chat_id,
        workspace_name="Telegram",
        bot_token=None,
        scopes="",
    )


class _AttachableAdapter(_RecordingAdapter):
    """A bridge that runs on its platform's shared connection."""

    def __init__(self) -> None:
        super().__init__()
        self.attached: list[object] = []

    def attach_shared_connection(self, connection: object) -> None:
        self.attached.append(connection)

    def set_on_attached(self, callback: Any) -> None:
        return None


class _FakeLifecycle:
    """Registers real rows, on a plain session like the real lifecycle.

    The real `register` opens its own session and lets the tenant bound around
    the call decide where the row lands, and it does so while `claim` is still
    holding its transaction open — so a fake that wrote nothing, or wrote
    through the caller's session, would not exercise the part that matters.
    """

    def __init__(self, factory: async_sessionmaker, suffix: str) -> None:
        self._factory = factory
        self._suffix = suffix
        self.registered: list[dict[str, object]] = []
        self.adapters: dict[str, PlatformAdapter] = {}
        self.fail_next: Exception | None = None

    async def register(self, **kwargs: object) -> CollaborationBridge:
        if self.fail_next is not None:
            failure, self.fail_next = self.fail_next, None
            raise failure
        self.registered.append(kwargs)
        async with self._factory() as session:
            client = Client(
                transport_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:{self._suffix}",
                display_name=str(kwargs["display_name"]),
                type="collaboration_bridge",
            )
            session.add(client)
            await session.flush()
            bridge = CollaborationBridge(
                type=str(kwargs["bridge_type"]),
                display_name=str(kwargs["display_name"]),
                connection_config=dict(kwargs["connection_config"]),  # type: ignore[call-overload]
                client_id=client.id,
                status="active",
            )
            session.add(bridge)
            await session.flush()
            bridge_id = bridge.id
            await session.commit()
        self.adapters[bridge_id] = _AttachableAdapter()
        return CollaborationBridge(id=bridge_id)

    def get_adapter(self, bridge_id: str) -> PlatformAdapter | None:
        return self.adapters.get(bridge_id)


class _Fixture:
    def __init__(self) -> None:
        self.tenant_a: str = ""
        self.tenant_b: str = ""
        self.admin_a: str = ""
        self.member_a: str = ""
        self.admin_b: str = ""
        self.suffix: str = ""
        self.lifecycle: _FakeLifecycle
        self.installer: _ClaimInstaller
        self.service: MessagingInstallService


async def _fixture(harness: RLSHarness) -> _Fixture:
    fixture = _Fixture()
    fixture.suffix = uuid.uuid4().hex[:8]
    # UUIDs, as every tenant is in production: the compact token carries them
    # as raw bytes.
    fixture.tenant_a = str(uuid.uuid4())
    fixture.tenant_b = str(uuid.uuid4())

    async with harness.owner() as session:
        for tenant_id in (fixture.tenant_a, fixture.tenant_b):
            session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
        users = {}
        for label in ("admin-a", "member-a", "admin-b"):
            user = User(
                name=label, email=f"{label}-{fixture.suffix}@example.test", role="user"
            )
            session.add(user)
            users[label] = user
        await session.flush()
        for label, tenant_id, role in (
            ("admin-a", fixture.tenant_a, "admin"),
            ("member-a", fixture.tenant_a, "member"),
            ("admin-b", fixture.tenant_b, "admin"),
        ):
            session.add(
                TenantMember(tenant_id=tenant_id, user_id=users[label].id, role=role)
            )
        fixture.admin_a = users["admin-a"].id
        fixture.member_a = users["member-a"].id
        fixture.admin_b = users["admin-b"].id
        await session.commit()

    fixture.lifecycle = _FakeLifecycle(harness.restricted, fixture.suffix)
    installers = MessagingInstallerRegistry()
    fixture.installer = _ClaimInstaller()
    installers.register(fixture.installer)
    fixture.service = MessagingInstallService(
        session_factory=harness.restricted,
        store=MessagingInstallStore(),
        receipts=MessagingEventReceiptStore(),
        installers=installers,
        lifecycle=fixture.lifecycle,  # type: ignore[arg-type]
        users=UserStore(),
        public_origin=_ORIGIN,
        keyring=_KEYRING,
    )
    return fixture


async def _link(
    factory: async_sessionmaker, fixture: _Fixture, tenant_id: str, user_id: str
) -> str:
    """Start a claim as `user_id` in `tenant_id` and return the token it minted."""
    async with tenant_session(factory, tenant_id) as session:
        url = await fixture.service.begin(session, platform=_PLATFORM, user_id=user_id)
        await session.commit()
    return parse_qs(urlparse(url).query)["startgroup"][0]


async def _claim(fixture: _Fixture, token: str, chat_id: str) -> MessagingInstall:
    return await fixture.service.claim(
        platform=_PLATFORM, claim=InstallClaim(token=token, grant=_grant(chat_id))
    )


async def _active_installs(harness: RLSHarness) -> list[MessagingInstall]:
    async with harness.owner() as session:
        rows = await session.execute(
            select(MessagingInstall).where(
                MessagingInstall.platform == _PLATFORM,
                MessagingInstall.status == INSTALL_ACTIVE,
            )
        )
        return list(rows.scalars())


class TestTheLink:
    async def test_the_token_fits_a_telegram_deep_link(
        self, rls_harness: RLSHarness
    ) -> None:
        """At most 64 characters of `[A-Za-z0-9_-]`, or Telegram drops it."""
        fixture = await _fixture(rls_harness)

        token = await _link(
            rls_harness.restricted, fixture, fixture.tenant_a, fixture.admin_a
        )

        assert len(token) <= 64
        assert all(c.isalnum() or c in "-_" for c in token)


class TestOneBridgePerTenant:
    async def test_the_first_claim_creates_the_bridge(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        token = await _link(
            rls_harness.restricted, fixture, fixture.tenant_a, fixture.admin_a
        )

        install = await _claim(fixture, token, "-1001")

        assert install.tenant_id == fixture.tenant_a
        assert install.external_workspace_id == "-1001"
        assert install.encrypted_bot_token is None
        assert install.installed_by_user_id == fixture.admin_a
        assert len(fixture.lifecycle.registered) == 1
        assert fixture.lifecycle.registered[0]["channel_creation_enabled"] is False
        assert install.bridge_id is not None

    async def test_later_claims_share_it(self, rls_harness: RLSHarness) -> None:
        """The reason for the design: identities are per bridge, so a bridge
        per chat would have everyone link themselves again in every chat."""
        fixture = await _fixture(rls_harness)
        first = await _claim(
            fixture,
            await _link(
                rls_harness.restricted, fixture, fixture.tenant_a, fixture.admin_a
            ),
            "-1001",
        )

        second = await _claim(
            fixture,
            await _link(
                rls_harness.restricted, fixture, fixture.tenant_a, fixture.admin_a
            ),
            "-1002",
        )

        assert len(fixture.lifecycle.registered) == 1
        assert second.bridge_id == first.bridge_id

    async def test_another_tenant_gets_its_own(self, rls_harness: RLSHarness) -> None:
        fixture = await _fixture(rls_harness)
        a = await _claim(
            fixture,
            await _link(
                rls_harness.restricted, fixture, fixture.tenant_a, fixture.admin_a
            ),
            "-1001",
        )

        b = await _claim(
            fixture,
            await _link(
                rls_harness.restricted, fixture, fixture.tenant_b, fixture.admin_b
            ),
            "-2001",
        )

        assert b.tenant_id == fixture.tenant_b
        assert b.bridge_id != a.bridge_id

    async def test_two_first_claims_at_once_make_one_bridge(
        self, rls_harness: RLSHarness
    ) -> None:
        """The race the advisory lock exists for. Without it both claims find
        no bridge, both register one, and the tenant's chats are split across
        two bridges nobody chose."""
        fixture = await _fixture(rls_harness)
        tokens = [
            await _link(
                rls_harness.restricted, fixture, fixture.tenant_a, fixture.admin_a
            )
            for _ in range(2)
        ]

        first, second = await asyncio.gather(
            _claim(fixture, tokens[0], "-1001"), _claim(fixture, tokens[1], "-1002")
        )

        assert len(fixture.lifecycle.registered) == 1
        assert first.bridge_id == second.bridge_id

    async def test_a_failed_registration_leaves_the_chat_unclaimed(
        self, rls_harness: RLSHarness
    ) -> None:
        """Rather than claimed by a tenant with no bridge, which would refuse
        every later claim and answer every event with a retryable failure."""
        fixture = await _fixture(rls_harness)
        fixture.lifecycle.fail_next = RuntimeError("the platform said no")

        with pytest.raises(RuntimeError, match="the platform said no"):
            await _claim(
                fixture,
                await _link(
                    rls_harness.restricted, fixture, fixture.tenant_a, fixture.admin_a
                ),
                "-1001",
            )

        assert await _active_installs(rls_harness) == []
        retried = await _claim(
            fixture,
            await _link(
                rls_harness.restricted, fixture, fixture.tenant_a, fixture.admin_a
            ),
            "-1001",
        )
        assert retried.bridge_id is not None


class TestWhoMayClaim:
    async def test_a_member_cannot_turn_the_platform_on(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        token = await _link(
            rls_harness.restricted, fixture, fixture.tenant_a, fixture.member_a
        )

        with pytest.raises(InstallClaimNotPermitted):
            await _claim(fixture, token, "-1001")

        assert fixture.lifecycle.registered == []
        assert await _active_installs(rls_harness) == []

    async def test_a_member_can_add_a_chat_once_it_is_on(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        first = await _claim(
            fixture,
            await _link(
                rls_harness.restricted, fixture, fixture.tenant_a, fixture.admin_a
            ),
            "-1001",
        )

        added = await _claim(
            fixture,
            await _link(
                rls_harness.restricted, fixture, fixture.tenant_a, fixture.member_a
            ),
            "-1002",
        )

        assert added.bridge_id == first.bridge_id
        assert added.installed_by_user_id == fixture.member_a


class TestWhatAClaimWillNotDo:
    async def test_a_replayed_claim_is_refused(self, rls_harness: RLSHarness) -> None:
        fixture = await _fixture(rls_harness)
        token = await _link(
            rls_harness.restricted, fixture, fixture.tenant_a, fixture.admin_a
        )
        await _claim(fixture, token, "-1001")

        with pytest.raises(MessagingInstallStateError):
            await _claim(fixture, token, "-1002")

    async def test_a_chat_another_tenant_holds_is_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        await _claim(
            fixture,
            await _link(
                rls_harness.restricted, fixture, fixture.tenant_a, fixture.admin_a
            ),
            "-1001",
        )

        with pytest.raises(MessagingInstallClaimedError):
            await _claim(
                fixture,
                await _link(
                    rls_harness.restricted, fixture, fixture.tenant_b, fixture.admin_b
                ),
                "-1001",
            )

        installs = await _active_installs(rls_harness)
        assert [install.tenant_id for install in installs] == [fixture.tenant_a]

    async def test_a_token_minted_for_another_platform_is_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        token = mint_compact(
            InstallState(
                tenant_id=fixture.tenant_a,
                state_id=str(uuid.uuid4()),
                platform="discord",
            ),
            keyring=_KEYRING,
        )

        with pytest.raises(InstallStateError):
            await _claim(fixture, token, "-1001")


class TestTheRoute:
    """A claim arrives as an ordinary event, and is then delivered as one."""

    async def _client(self, fixture: _Fixture) -> httpx.AsyncClient:
        app = FastAPI()
        app.include_router(create_messaging_install_router(fixture.service))
        return httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url=_ORIGIN
        )

    async def _post(self, client: httpx.AsyncClient, body: dict[str, Any]) -> int:
        response = await client.post(
            f"/messaging/{_PLATFORM}/events", content=json.dumps(body).encode()
        )
        return response.status_code

    async def test_a_claim_installs_the_chat_and_is_delivered_to_it(
        self, rls_harness: RLSHarness
    ) -> None:
        """Delivered because the claim is also the event that creates the
        room: the add that preceded it was dropped, the chat being unowned."""
        fixture = await _fixture(rls_harness)
        token = await _link(
            rls_harness.restricted, fixture, fixture.tenant_a, fixture.admin_a
        )
        body = {"chat": "-1001", "claim": token}

        async with await self._client(fixture) as client:
            assert await self._post(client, body) == 200

        (install,) = await _active_installs(rls_harness)
        assert install.tenant_id == fixture.tenant_a
        adapter = fixture.lifecycle.adapters[install.bridge_id]  # type: ignore[index]
        assert isinstance(adapter, _RecordingAdapter)
        assert adapter.dispatched == [("events", body)]

    async def test_a_refused_claim_in_an_unowned_chat_is_dropped(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)

        async with await self._client(fixture) as client:
            status = await self._post(client, {"chat": "-1001", "claim": "c1forged"})

        assert status == 200
        assert await _active_installs(rls_harness) == []
        assert fixture.lifecycle.registered == []

    async def test_a_refused_claim_in_an_owned_chat_still_reaches_its_owner(
        self, rls_harness: RLSHarness
    ) -> None:
        """Tenant B's token posted in tenant A's chat changes nothing about
        where that chat's events go."""
        fixture = await _fixture(rls_harness)
        owned = await _claim(
            fixture,
            await _link(
                rls_harness.restricted, fixture, fixture.tenant_a, fixture.admin_a
            ),
            "-1001",
        )
        intruding = await _link(
            rls_harness.restricted, fixture, fixture.tenant_b, fixture.admin_b
        )
        body = {"chat": "-1001", "claim": intruding}

        async with await self._client(fixture) as client:
            assert await self._post(client, body) == 200

        installs = await _active_installs(rls_harness)
        assert [install.tenant_id for install in installs] == [fixture.tenant_a]
        adapter = fixture.lifecycle.adapters[owned.bridge_id]  # type: ignore[index]
        assert isinstance(adapter, _RecordingAdapter)
        assert adapter.dispatched == [("events", body)]


class TestTheSharedConnection:
    """A bridge registered by a claim at runtime missed boot's attach, so its
    first delivered event is what hands it the platform's shared bot."""

    async def _client(self, fixture: _Fixture) -> httpx.AsyncClient:
        app = FastAPI()
        app.include_router(create_messaging_install_router(fixture.service))
        return httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url=_ORIGIN
        )

    async def test_the_first_delivery_attaches_it(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        shared = object()
        fixture.installer.connection = shared
        token = await _link(
            rls_harness.restricted, fixture, fixture.tenant_a, fixture.admin_a
        )

        async with await self._client(fixture) as client:
            response = await client.post(
                f"/messaging/{_PLATFORM}/events",
                content=json.dumps({"chat": "-1001", "claim": token}).encode(),
            )

        assert response.status_code == 200
        (install,) = await _active_installs(rls_harness)
        adapter = fixture.lifecycle.adapters[install.bridge_id]  # type: ignore[index]
        assert isinstance(adapter, _AttachableAdapter)
        assert adapter.attached == [shared]
        assert len(adapter.dispatched) == 1

    async def test_a_connection_not_ready_yet_is_retried_not_dropped(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        owned = await _claim(
            fixture,
            await _link(
                rls_harness.restricted, fixture, fixture.tenant_a, fixture.admin_a
            ),
            "-1001",
        )
        fixture.installer.not_ready = True

        async with await self._client(fixture) as client:
            response = await client.post(
                f"/messaging/{_PLATFORM}/events",
                content=json.dumps({"chat": "-1001"}).encode(),
            )

        assert response.status_code == 503
        adapter = fixture.lifecycle.adapters[owned.bridge_id]  # type: ignore[index]
        assert isinstance(adapter, _AttachableAdapter)
        assert adapter.dispatched == []
