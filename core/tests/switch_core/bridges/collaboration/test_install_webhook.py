"""An event from an installed workspace, from the wire to the right bridge.

This is the half of multi-tenancy that has no session to lean on. A Slack post
arrives at one public URL shared by every tenant on the deployment, carrying no
credential of ours, and something has to decide whose it is. Everything that
decides it is here: the signature, the workspace id in the payload, and the
lookup from that workspace to a tenant.

Two tenants exist in every fixture below, each with the app installed into its
own workspace, and the assertion that matters is the same one each time: an
event for one of them reaches that one's bridge and **no part of it reaches the
other's**. A test with a single tenant would pass against a router that ignored
the payload entirely.

Real Postgres, the restricted role, and the real Slack installer — including
the real signature check. What is faked is only what would otherwise open a
socket: the bridge lifecycle and the adapter at the end of it.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker

from switch_core.bridges.collaboration.adapter import CollaborationAdapter
from switch_core.bridges.collaboration.install import (
    MessagingInstallerRegistry,
    commands_path,
    events_path,
    interactive_path,
)
from switch_core.bridges.collaboration.install_routes import (
    create_messaging_install_router,
)
from switch_core.bridges.collaboration.install_service import MessagingInstallService
from switch_core.bridges.collaboration.slack.install import SlackAppInstaller
from switch_core.db.models import (
    Client,
    CollaborationBridge,
    MessagingInstall,
    Tenant,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.messaging_install_store import MessagingInstallStore
from switch_core.tenant_context import current_tenant_id
from tests.conftest import RLSHarness

pytestmark = pytest.mark.no_ambient_tenant

_SIGNING_SECRET = "test-signing-secret"
_SECRET = "test-secret"
_ORIGIN = "https://switch.example"


def _signed(body: bytes) -> dict[str, str]:
    timestamp = str(int(time.time()))
    digest = hmac.new(
        _SIGNING_SECRET.encode(),
        b"v0:" + timestamp.encode() + b":" + body,
        hashlib.sha256,
    ).hexdigest()
    return {
        "X-Slack-Request-Timestamp": timestamp,
        "X-Slack-Signature": f"v0={digest}",
        "Content-Type": "application/json",
    }


class _SocketOnlyAdapter(CollaborationAdapter):
    """A bridge that takes its events some other way.

    Concrete only so one can be built; every platform call is a stub, because
    nothing on the webhook path may reach one. It inherits `dispatch_event`
    from the base — the refusal — which is the behaviour one test below is
    about.
    """

    def __init__(self) -> None: ...

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


class _RecordingAdapter(_SocketOnlyAdapter):
    """An adapter that only remembers what it was handed.

    It also records the tenant bound at the moment of dispatch, which is the
    subject of one of the tests below: the answer has to be "none", the same as
    it is under Socket Mode.
    """

    def __init__(self) -> None:
        self.dispatched: list[tuple[str, dict[str, Any]]] = []
        self.tenants_bound: list[str | None] = []

    async def dispatch_event(
        self, *, envelope_type: str, payload: dict[str, Any]
    ) -> None:
        self.dispatched.append((envelope_type, payload))
        self.tenants_bound.append(current_tenant_id())


class _FakeLifecycle:
    def __init__(self) -> None:
        self.adapters: dict[str, CollaborationAdapter] = {}

    def get_adapter(self, bridge_id: str) -> CollaborationAdapter | None:
        return self.adapters.get(bridge_id)


@dataclass
class _Workspace:
    tenant_id: str
    workspace_id: str
    bridge_id: str
    adapter: _RecordingAdapter


class _Fixture:
    def __init__(self, harness: RLSHarness) -> None:
        self.harness = harness
        self.lifecycle = _FakeLifecycle()
        self.a: _Workspace
        self.b: _Workspace
        self.client: httpx.AsyncClient
        self.service: MessagingInstallService


async def _make_bridge(factory: async_sessionmaker, tenant_id: str, suffix: str) -> str:
    async with tenant_session(factory, tenant_id) as session:
        client = Client(
            matrix_user_id=f"@bridge-{tenant_id}:{suffix}",
            display_name="bridge",
            type="collaboration_bridge",
        )
        session.add(client)
        await session.flush()
        bridge = CollaborationBridge(
            type="slack",
            display_name="Acme",
            connection_config={},
            client_id=client.id,
            status="active",
        )
        session.add(bridge)
        await session.flush()
        bridge_id = bridge.id
        await session.commit()
    return bridge_id


async def _fixture(harness: RLSHarness) -> _Fixture:
    fixture = _Fixture(harness)
    suffix = uuid.uuid4().hex[:8]

    async with harness.owner() as session:
        for label in ("a", "b"):
            tenant_id = f"tenant-{label}-{suffix}"
            session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
        user = User(name="installer", email=f"{suffix}@example.test", role="user")
        session.add(user)
        await session.flush()
        user_id = user.id
        await session.commit()

    workspaces = []
    for label in ("a", "b"):
        tenant_id = f"tenant-{label}-{suffix}"
        workspace_id = f"T-{label}-{suffix}"
        bridge_id = await _make_bridge(harness.restricted, tenant_id, suffix)
        async with tenant_session(harness.restricted, tenant_id) as session:
            session.add(
                MessagingInstall(
                    tenant_id=tenant_id,
                    platform="slack",
                    external_workspace_id=workspace_id,
                    encrypted_bot_token="ciphertext",
                    scopes="chat:write",
                    status="active",
                    installed_by_user_id=user_id,
                    bridge_id=bridge_id,
                )
            )
            await session.commit()
        adapter = _RecordingAdapter()
        fixture.lifecycle.adapters[bridge_id] = adapter
        workspaces.append(
            _Workspace(
                tenant_id=tenant_id,
                workspace_id=workspace_id,
                bridge_id=bridge_id,
                adapter=adapter,
            )
        )
    fixture.a, fixture.b = workspaces

    installers = MessagingInstallerRegistry()
    installers.register(
        SlackAppInstaller(
            client_id="1234.5678",
            client_secret="test-client-secret",
            signing_secret=_SIGNING_SECRET,
        )
    )
    fixture.service = MessagingInstallService(
        session_factory=harness.restricted,
        store=MessagingInstallStore(),
        installers=installers,
        lifecycle=fixture.lifecycle,  # type: ignore[arg-type]
        public_origin=_ORIGIN,
        secret=_SECRET,
    )

    app = FastAPI()
    app.include_router(create_messaging_install_router(fixture.service))
    fixture.client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=_ORIGIN
    )
    return fixture


def _event(workspace_id: str, text: str) -> bytes:
    return json.dumps(
        {
            "type": "event_callback",
            "team_id": workspace_id,
            "event": {"type": "message", "text": text, "channel": "C1"},
        }
    ).encode()


def _texts(adapter: _RecordingAdapter) -> list[str]:
    return [payload["event"]["text"] for _, payload in adapter.dispatched]


async def _post(fixture: _Fixture, path: str, body: bytes) -> httpx.Response:
    return await fixture.client.post(path, content=body, headers=_signed(body))


class TestAnEventReachesOneTenant:
    async def test_it_reaches_the_tenant_that_installed_the_workspace(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        body = _event(fixture.a.workspace_id, "hello")

        response = await _post(fixture, events_path("slack"), body)

        assert response.status_code == 200
        assert len(fixture.a.adapter.dispatched) == 1
        envelope_type, payload = fixture.a.adapter.dispatched[0]
        assert envelope_type == "events_api"
        assert payload["event"]["text"] == "hello"

    async def test_it_reaches_no_other_tenant(self, rls_harness: RLSHarness) -> None:
        """The whole point. One URL, two customers, and the payload decides.

        Asserted from both directions in one test, because the failure this
        guards against is a router that resolves the tenant once and then
        fans out to every bridge it knows: that passes any test that only
        looks at the intended recipient.
        """
        fixture = await _fixture(rls_harness)

        await _post(fixture, events_path("slack"), _event(fixture.a.workspace_id, "a"))
        await _post(fixture, events_path("slack"), _event(fixture.b.workspace_id, "b"))

        assert _texts(fixture.a.adapter) == ["a"]
        assert _texts(fixture.b.adapter) == ["b"]

    async def test_nothing_is_bound_when_the_adapter_runs(
        self, rls_harness: RLSHarness
    ) -> None:
        """Same as Socket Mode, deliberately.

        A bridge that dials out dispatches from a task with no tenant bound,
        and every handler underneath binds the tenant of the room it is acting
        on. Binding one here would make the two delivery paths differ in the
        one respect that decides who a message reaches, and would hide a
        handler that had forgotten to bind for itself.
        """
        fixture = await _fixture(rls_harness)

        await _post(fixture, events_path("slack"), _event(fixture.a.workspace_id, "x"))

        assert fixture.a.adapter.tenants_bound == [None]

    async def test_a_slash_command_arrives_as_its_form_fields(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        body = urlencode(
            {
                "command": "/agents-status",
                "text": "",
                "team_id": fixture.a.workspace_id,
                "channel_id": "C1",
            }
        ).encode()

        response = await _post(fixture, commands_path("slack"), body)

        assert response.status_code == 200
        envelope_type, payload = fixture.a.adapter.dispatched[0]
        assert envelope_type == "slash_commands"
        assert payload["command"] == "/agents-status"

    async def test_an_interaction_is_routed_by_its_nested_team(
        self, rls_harness: RLSHarness
    ) -> None:
        """Slack names the workspace differently here, and it still routes."""
        fixture = await _fixture(rls_harness)
        body = urlencode(
            {
                "payload": json.dumps(
                    {"type": "block_actions", "team": {"id": fixture.b.workspace_id}}
                )
            }
        ).encode()

        response = await _post(fixture, interactive_path("slack"), body)

        assert response.status_code == 200
        assert fixture.b.adapter.dispatched[0][0] == "interactive"
        assert fixture.a.adapter.dispatched == []


class TestWhatTheEndpointRefuses:
    async def test_an_unsigned_post_is_refused_and_delivers_nothing(
        self, rls_harness: RLSHarness
    ) -> None:
        """The first line, and the only one that runs before anything is read.

        A workspace id in an unsigned body is just a string somebody typed;
        acting on it would let anyone who knows a customer's Slack team id post
        into their rooms.
        """
        fixture = await _fixture(rls_harness)
        body = _event(fixture.a.workspace_id, "forged")

        response = await fixture.client.post(
            events_path("slack"),
            content=body,
            headers={"Content-Type": "application/json"},
        )

        assert response.status_code == 401
        assert fixture.a.adapter.dispatched == []

    async def test_a_signature_over_a_different_body_is_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        """A captured signature re-used over a payload naming another tenant."""
        fixture = await _fixture(rls_harness)
        captured = _signed(_event(fixture.b.workspace_id, "theirs"))

        response = await fixture.client.post(
            events_path("slack"),
            content=_event(fixture.a.workspace_id, "mine"),
            headers=captured,
        )

        assert response.status_code == 401
        assert fixture.a.adapter.dispatched == []
        assert fixture.b.adapter.dispatched == []

    async def test_an_unknown_workspace_is_not_reported_as_handled(
        self, rls_harness: RLSHarness
    ) -> None:
        """404 rather than a polite 200.

        The app is still installed somewhere we no longer serve, and the
        honest answer is that this event reached nobody. A 200 would make it
        invisible on both sides — a platform's own delivery log is often the
        only place anyone would see it.
        """
        fixture = await _fixture(rls_harness)

        response = await _post(fixture, events_path("slack"), _event("T-nobody", "x"))

        assert response.status_code == 404
        assert fixture.a.adapter.dispatched == []
        assert fixture.b.adapter.dispatched == []

    async def test_an_event_naming_no_workspace_is_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)
        body = json.dumps({"type": "event_callback", "event": {}}).encode()

        response = await _post(fixture, events_path("slack"), body)

        assert response.status_code == 400

    async def test_a_body_that_cannot_be_read_is_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)

        response = await _post(fixture, events_path("slack"), b"not json")

        assert response.status_code == 400

    async def test_a_platform_with_no_app_registered_is_not_found(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)

        response = await _post(fixture, events_path("teams"), _event("T1", "x"))

        assert response.status_code == 404


class TestWhenTheBridgeIsNotThere:
    async def test_a_stopped_bridge_asks_the_platform_to_retry(
        self, rls_harness: RLSHarness
    ) -> None:
        """503, so Slack retries while a bridge restarts.

        The alternative is a 200 that discards a real message and reports it
        handled — the exact shape of failure that reads as "Slack lost a
        message" and is never found.
        """
        fixture = await _fixture(rls_harness)
        del fixture.lifecycle.adapters[fixture.a.bridge_id]

        response = await _post(
            fixture, events_path("slack"), _event(fixture.a.workspace_id, "x")
        )

        assert response.status_code == 503

    async def test_an_install_with_no_bridge_yet_says_the_same(
        self, rls_harness: RLSHarness
    ) -> None:
        """A recorded credential nothing has been built on. The schema allows
        it, so the router has to answer for it."""
        fixture = await _fixture(rls_harness)
        async with tenant_session(
            rls_harness.restricted, fixture.a.tenant_id
        ) as session:
            install = await MessagingInstallStore().get_for_workspace(
                session,
                platform="slack",
                external_workspace_id=fixture.a.workspace_id,
            )
            assert install is not None
            install.bridge_id = None
            await session.commit()

        response = await _post(
            fixture, events_path("slack"), _event(fixture.a.workspace_id, "x")
        )

        assert response.status_code == 503


class TestTheHandshake:
    async def test_it_is_answered_before_anyone_has_installed_anything(
        self, rls_harness: RLSHarness
    ) -> None:
        """Slack saves a Request URL only if this is echoed back.

        It carries no workspace, so a handshake that had to resolve a tenant
        could never be answered — and the app could never be configured at all.
        """
        fixture = await _fixture(rls_harness)
        body = json.dumps(
            {"type": "url_verification", "challenge": "let-me-in"}
        ).encode()

        response = await _post(fixture, events_path("slack"), body)

        assert response.status_code == 200
        assert response.text == "let-me-in"
        assert fixture.a.adapter.dispatched == []

    async def test_an_unsigned_handshake_is_still_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _fixture(rls_harness)

        response = await fixture.client.post(
            events_path("slack"),
            content=b'{"type":"url_verification","challenge":"let-me-in"}',
        )

        assert response.status_code == 401


class TestABridgeThatCannotTakeEvents:
    async def test_the_refusal_is_not_swallowed(self, rls_harness: RLSHarness) -> None:
        """A webhook install pointed at a socket-mode adapter is a fault.

        It cannot happen through the install flow — the rendered config says
        `event_delivery: webhook` — but it is exactly the state a hand-edited
        connection config could reach, and delivering nowhere while answering
        200 is how it would stay hidden.
        """
        fixture = await _fixture(rls_harness)
        adapter = _SocketOnlyAdapter()
        fixture.lifecycle.adapters[fixture.a.bridge_id] = adapter

        event = fixture.service.authenticate(
            platform="slack",
            endpoint="events",
            headers=_signed(_event(fixture.a.workspace_id, "x")),
            body=_event(fixture.a.workspace_id, "x"),
        )
        target = await fixture.service.resolve(platform="slack", event=event)
        with pytest.raises(Exception, match="does not receive events over HTTP"):
            await fixture.service.deliver(target, event)
