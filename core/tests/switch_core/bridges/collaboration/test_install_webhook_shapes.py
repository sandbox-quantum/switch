"""The shapes of webhook a platform other than Slack posts.

Slack posts one signed event per request and wants an empty acknowledgement.
Microsoft's platforms do not: Graph checks a notification URL with a request
nobody signed, batches notifications from several organisations into one
post, and the Bot Framework waits on a card press for its answer in the
response itself. A fake platform here posts each shape, against real Postgres
and the real routing, so the generic route is tested apart from any one
platform's installer.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Mapping
from typing import Any, ClassVar

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from switch_core.bridges.collaboration import install_routes
from switch_core.bridges.collaboration.adapter import CollaborationAdapter
from switch_core.bridges.collaboration.install import (
    InboundWebhook,
    InstallGrant,
    MessagingAppInstaller,
    MessagingInstallerRegistry,
    WebhookAuthenticityError,
    WebhookEndpoint,
)
from switch_core.bridges.collaboration.install_routes import (
    create_messaging_install_router,
)
from switch_core.bridges.collaboration.install_service import MessagingInstallService
from switch_core.db.models import (
    Client,
    CollaborationBridge,
    MessagingEventReceipt,
    MessagingInstall,
    Tenant,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.messaging_event_store import MessagingEventReceiptStore
from switch_core.db.stores.messaging_install_store import MessagingInstallStore
from tests.conftest import RLSHarness

pytestmark = pytest.mark.no_ambient_tenant

_PLATFORM = "relay"
_ORIGIN = "https://switch.example"
_SIGNED = {"X-Test-Signature": "ok"}


class _RelayInstaller(MessagingAppInstaller):
    """A platform that posts events and batched notifications, and checks its
    notification URL without signing the check."""

    platform: ClassVar[str] = _PLATFORM
    webhook_endpoints: ClassVar[frozenset[WebhookEndpoint]] = frozenset(
        {"events", "notifications"}
    )

    def __init__(self) -> None:
        self.verified = 0

    def authorize_url(self, *, state: str, redirect_uri: str) -> str:
        return "https://relay.example/authorize"

    async def redeem(self, *, code: str, redirect_uri: str) -> InstallGrant:
        raise NotImplementedError

    async def revoke(self, *, bot_token: str) -> None:
        raise NotImplementedError

    def unsigned_handshake(
        self, *, endpoint: WebhookEndpoint, query: Mapping[str, str]
    ) -> str | None:
        if endpoint == "notifications":
            return query.get("validationToken")
        return None

    async def verify_webhook(
        self,
        *,
        endpoint: WebhookEndpoint,
        headers: Mapping[str, str],
        query: Mapping[str, str],
        body: bytes,
    ) -> None:
        self.verified += 1
        if headers.get("x-test-signature") != "ok":
            raise WebhookAuthenticityError("unsigned")

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
                payload=item,
                handshake=None,
                external_event_id=item.get("id"),
                delivery_attempt=0,
                answers_inline=bool(item.get("inline")),
            )
            for item in json.loads(body)["items"]
        ]

    def workspace_of_event(self, payload: Mapping[str, object]) -> str:
        return str(payload["workspace"])

    def revocation_of_event(self, payload: Mapping[str, object]) -> str | None:
        return None

    def connection_config(self, grant: InstallGrant) -> dict[str, object]:
        return {}


class _Adapter(CollaborationAdapter):
    """Records what it is handed and answers with what it was asked to."""

    def __init__(self, *, delay: float = 0.0, fail: bool = False) -> None:
        self.dispatched: list[dict[str, Any]] = []
        self._delay = delay
        self._fail = fail

    async def dispatch_event(
        self, *, envelope_type: str, payload: dict[str, Any]
    ) -> dict[str, Any] | None:
        self.dispatched.append(payload)
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._fail:
            raise RuntimeError("the press could not be handled")
        return {"answer": payload["id"]} if payload.get("inline") else None

    async def start(self, *a: Any, **k: Any) -> Any: ...
    async def stop(self, *a: Any, **k: Any) -> Any: ...
    async def send_message(self, *a: Any, **k: Any) -> Any: ...
    async def send_typing(self, *a: Any, **k: Any) -> Any: ...
    async def update_message(self, *a: Any, **k: Any) -> Any: ...
    async def delete_message(self, *a: Any, **k: Any) -> Any: ...
    async def create_channel(self, *a: Any, **k: Any) -> Any: ...
    async def get_channel_type(self, *a: Any, **k: Any) -> Any: ...
    async def get_channel_agent_names(self, *a: Any, **k: Any) -> Any: ...
    async def add_agents_to_channel(self, *a: Any, **k: Any) -> Any: ...
    async def add_users_to_channel(self, *a: Any, **k: Any) -> Any: ...
    async def create_agent_identity(self, *a: Any, **k: Any) -> Any: ...
    async def remove_agent_identity(self, *a: Any, **k: Any) -> Any: ...
    def translate_inbound(self, *a: Any, **k: Any) -> Any: ...
    def translate_outbound(self, *a: Any, **k: Any) -> Any: ...


class _Lifecycle:
    def __init__(self) -> None:
        self.adapters: dict[str, CollaborationAdapter] = {}
        self.starting: set[str] = set()

    def get_adapter(self, bridge_id: str) -> CollaborationAdapter | None:
        return self.adapters.get(bridge_id)

    def is_connected(self, bridge_id: str) -> bool:
        return bridge_id in self.adapters and bridge_id not in self.starting


class _Fixture:
    installer: _RelayInstaller
    lifecycle: _Lifecycle
    client: httpx.AsyncClient
    tenants: dict[str, str]
    bridges: dict[str, str]


async def _fixture(harness: RLSHarness) -> _Fixture:
    fixture = _Fixture()
    suffix = uuid.uuid4().hex[:8]
    fixture.tenants = {label: f"tenant-{label}-{suffix}" for label in ("a", "b")}
    fixture.bridges = {}
    fixture.lifecycle = _Lifecycle()

    async with harness.owner() as session:
        for tenant_id in fixture.tenants.values():
            session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
        user = User(name="installer", email=f"{suffix}@example.test", role="user")
        session.add(user)
        await session.flush()
        user_id = user.id
        await session.commit()

    for label, tenant_id in fixture.tenants.items():
        async with tenant_session(harness.restricted, tenant_id) as session:
            client = Client(
                matrix_user_id=f"@bridge-{label}:{suffix}",
                display_name="bridge",
                type="collaboration_bridge",
            )
            session.add(client)
            await session.flush()
            bridge = CollaborationBridge(
                type=_PLATFORM,
                display_name=label,
                connection_config={},
                client_id=client.id,
                status="active",
            )
            session.add(bridge)
            await session.flush()
            session.add(
                MessagingInstall(
                    tenant_id=tenant_id,
                    platform=_PLATFORM,
                    external_workspace_id=f"org-{label}",
                    encrypted_bot_token=None,
                    scopes="",
                    status="active",
                    installed_by_user_id=user_id,
                    bridge_id=bridge.id,
                )
            )
            fixture.bridges[label] = bridge.id
            await session.commit()
        fixture.lifecycle.adapters[fixture.bridges[label]] = _Adapter()

    fixture.installer = _RelayInstaller()
    installers = MessagingInstallerRegistry()
    installers.register(fixture.installer)
    service = MessagingInstallService(
        session_factory=harness.restricted,
        store=MessagingInstallStore(),
        receipts=MessagingEventReceiptStore(),
        installers=installers,
        lifecycle=fixture.lifecycle,  # type: ignore[arg-type]
        public_origin=_ORIGIN,
        secret="secret",
    )
    app = FastAPI()
    app.include_router(create_messaging_install_router(service))
    fixture.client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=_ORIGIN
    )
    return fixture


def _adapter(fixture: _Fixture, label: str) -> _Adapter:
    adapter = fixture.lifecycle.adapters[fixture.bridges[label]]
    assert isinstance(adapter, _Adapter)
    return adapter


def _batch(*items: dict[str, Any]) -> bytes:
    return json.dumps({"items": list(items)}).encode()


async def _receipts(factory: async_sessionmaker, tenant_id: str) -> list[Any]:
    async with tenant_session(factory, tenant_id) as session:
        return list((await session.execute(select(MessagingEventReceipt))).scalars())


async def test_an_endpoint_the_app_does_not_post_to_does_not_exist(
    rls_harness: RLSHarness,
) -> None:
    fixture = await _fixture(rls_harness)

    response = await fixture.client.post(
        f"/messaging/{_PLATFORM}/commands", content=b"{}", headers=_SIGNED
    )

    assert response.status_code == 404
    assert fixture.installer.verified == 0


async def test_an_unsigned_url_check_is_answered_before_anything_is_verified(
    rls_harness: RLSHarness,
) -> None:
    fixture = await _fixture(rls_harness)

    response = await fixture.client.post(
        f"/messaging/{_PLATFORM}/notifications?validationToken=prove-it"
    )

    assert response.status_code == 200
    assert response.text == "prove-it"
    assert fixture.installer.verified == 0


async def test_anything_else_unsigned_is_refused(rls_harness: RLSHarness) -> None:
    fixture = await _fixture(rls_harness)

    response = await fixture.client.post(
        f"/messaging/{_PLATFORM}/notifications",
        content=_batch({"workspace": "org-a", "id": "n1"}),
    )

    assert response.status_code == 401
    assert _adapter(fixture, "a").dispatched == []


async def test_a_batch_reaches_each_organisations_own_bridge(
    rls_harness: RLSHarness,
) -> None:
    """One post, two organisations: each item goes to the bridge its own
    organisation resolves to, and none of it to the other's."""
    fixture = await _fixture(rls_harness)

    response = await fixture.client.post(
        f"/messaging/{_PLATFORM}/notifications",
        content=_batch(
            {"workspace": "org-a", "id": "n-a"}, {"workspace": "org-b", "id": "n-b"}
        ),
        headers=_SIGNED,
    )

    assert response.status_code == 200
    assert [p["id"] for p in _adapter(fixture, "a").dispatched] == ["n-a"]
    assert [p["id"] for p in _adapter(fixture, "b").dispatched] == ["n-b"]


async def test_an_unknown_organisation_does_not_hold_back_the_rest(
    rls_harness: RLSHarness,
) -> None:
    fixture = await _fixture(rls_harness)

    response = await fixture.client.post(
        f"/messaging/{_PLATFORM}/notifications",
        content=_batch(
            {"workspace": "org-nobody", "id": "n-x"},
            {"workspace": "org-a", "id": "n-a"},
        ),
        headers=_SIGNED,
    )

    assert response.status_code == 200
    assert [p["id"] for p in _adapter(fixture, "a").dispatched] == ["n-a"]


async def test_a_bridge_that_is_down_asks_for_its_events_again(
    rls_harness: RLSHarness,
) -> None:
    """A request whose every event was undeliverable is retried; receipts make
    the retry harmless once the bridge is back."""
    fixture = await _fixture(rls_harness)
    del fixture.lifecycle.adapters[fixture.bridges["b"]]
    body = _batch({"workspace": "org-b", "id": "n-b"})

    first = await fixture.client.post(
        f"/messaging/{_PLATFORM}/notifications", content=body, headers=_SIGNED
    )
    fixture.lifecycle.adapters[fixture.bridges["b"]] = _Adapter()
    retry = await fixture.client.post(
        f"/messaging/{_PLATFORM}/notifications", content=body, headers=_SIGNED
    )

    assert first.status_code == 503
    assert retry.status_code == 200
    assert [p["id"] for p in _adapter(fixture, "b").dispatched] == ["n-b"]


async def test_a_bridge_still_starting_is_not_handed_events(
    rls_harness: RLSHarness,
) -> None:
    """Running is not serving: an event handed over before the adapter has
    finished starting is acknowledged and lost, so it is asked for again."""
    fixture = await _fixture(rls_harness)
    fixture.lifecycle.starting.add(fixture.bridges["a"])

    response = await fixture.client.post(
        f"/messaging/{_PLATFORM}/notifications",
        content=_batch({"workspace": "org-a", "id": "n-a"}),
        headers=_SIGNED,
    )

    assert response.status_code == 503
    assert _adapter(fixture, "a").dispatched == []


async def test_one_workspace_down_does_not_fail_another_workspaces_delivery(
    rls_harness: RLSHarness,
) -> None:
    """On an endpoint every workspace shares, a 503 for a mixed batch would
    have the platform back off from everyone's delivery for one restart."""
    fixture = await _fixture(rls_harness)
    del fixture.lifecycle.adapters[fixture.bridges["b"]]

    response = await fixture.client.post(
        f"/messaging/{_PLATFORM}/notifications",
        content=_batch(
            {"workspace": "org-a", "id": "n-a"}, {"workspace": "org-b", "id": "n-b"}
        ),
        headers=_SIGNED,
    )

    assert response.status_code == 200
    assert [p["id"] for p in _adapter(fixture, "a").dispatched] == ["n-a"]


async def test_an_event_the_platform_waits_on_is_answered_in_the_response(
    rls_harness: RLSHarness,
) -> None:
    fixture = await _fixture(rls_harness)

    response = await fixture.client.post(
        f"/messaging/{_PLATFORM}/events",
        content=_batch({"workspace": "org-a", "id": "press-1", "inline": True}),
        headers=_SIGNED,
    )

    assert response.status_code == 200
    assert response.json() == {"answer": "press-1"}


async def test_a_retried_press_is_answered_again_rather_than_dropped(
    rls_harness: RLSHarness,
) -> None:
    """The platform retries because it never saw the answer; a receipt would
    give the retry nothing."""
    fixture = await _fixture(rls_harness)
    body = _batch({"workspace": "org-a", "id": "press-1", "inline": True})

    await fixture.client.post(
        f"/messaging/{_PLATFORM}/events", content=body, headers=_SIGNED
    )
    retry = await fixture.client.post(
        f"/messaging/{_PLATFORM}/events", content=body, headers=_SIGNED
    )

    assert retry.json() == {"answer": "press-1"}
    assert await _receipts(rls_harness.restricted, fixture.tenants["a"]) == []


async def test_a_press_that_takes_too_long_is_answered_as_failed(
    rls_harness: RLSHarness, monkeypatch: pytest.MonkeyPatch
) -> None:
    fixture = await _fixture(rls_harness)
    fixture.lifecycle.adapters[fixture.bridges["a"]] = _Adapter(delay=1.0)
    monkeypatch.setattr(install_routes, "_INLINE_ANSWER_SECONDS", 0.05)

    response = await fixture.client.post(
        f"/messaging/{_PLATFORM}/events",
        content=_batch({"workspace": "org-a", "id": "press-1", "inline": True}),
        headers=_SIGNED,
    )

    assert response.status_code == 504


async def test_a_press_whose_handling_fails_is_answered_as_failed(
    rls_harness: RLSHarness,
) -> None:
    fixture = await _fixture(rls_harness)
    fixture.lifecycle.adapters[fixture.bridges["a"]] = _Adapter(fail=True)

    response = await fixture.client.post(
        f"/messaging/{_PLATFORM}/events",
        content=_batch({"workspace": "org-a", "id": "press-1", "inline": True}),
        headers=_SIGNED,
    )

    assert response.status_code == 500


async def test_a_refused_install_is_explained_in_the_platforms_terms(
    rls_harness: RLSHarness,
) -> None:
    fixture = await _fixture(rls_harness)

    def explain(*, error: str, description: str | None) -> str:
        return f"You need to be an administrator ({error}: {description})."

    fixture.installer.describe_callback_error = explain  # type: ignore[method-assign]

    response = await fixture.client.get(
        f"/messaging/{_PLATFORM}/oauth/callback"
        "?error=access_denied&error_description=not+an+admin"
    )

    assert response.status_code == 200
    assert "You need to be an administrator (access_denied: not an admin)." in (
        response.text
    )
