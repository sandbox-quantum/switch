"""A Teams bridge on the distributed app: one organisation, the deployment's app.

The deployment's credential reaches every organisation that approved the app,
so most of what is tested here is the bridge refusing what is not its own
organisation's — activities, notifications, channels — and never sending the
deployment's token anywhere but Microsoft.
"""

from __future__ import annotations

import asyncio
import datetime
import functools
from typing import Any

import httpx
import jwt
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.x509.oid import NameOID
from pydantic import ValidationError

from switch_core.bridges.collaboration.adapter import (
    ChannelNotBindable,
    ConfigEditRefused,
)
from switch_core.bridges.collaboration.models import (
    BridgeOperationError,
    InboundMessage,
)
from switch_core.bridges.collaboration.teams import shared_app as shared_app_module
from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)
from switch_core.bridges.collaboration.teams.auth import (
    ClientSecret,
    TokenRequestRefused,
)
from switch_core.bridges.collaboration.teams.crypto import load_certificate_der_b64
from switch_core.bridges.collaboration.teams.graph import AppInstallation, GraphError
from switch_core.bridges.collaboration.teams.identity import (
    REQUIRED_GRAPH_ROLES,
    NotificationKey,
    NotificationKeyring,
)
from switch_core.bridges.collaboration.teams.shared_app import (
    TeamsSharedApp,
    client_state_for,
)

ORG = "aaaaaaaa-0000-0000-0000-000000000001"
OTHER_ORG = "bbbbbbbb-0000-0000-0000-000000000002"
CHANNEL = "19:abc@thread.tacv2"
SERVICE_URL = "https://smba.trafficmanager.net/amer/"


@functools.lru_cache(maxsize=1)
def _keypair() -> tuple[str, rsa.RSAPrivateKey]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "switch-test")])
    now = datetime.datetime(2026, 1, 1, tzinfo=datetime.UTC)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=365))
        .sign(key, hashes.SHA256())
    )
    return certificate.public_bytes(serialization.Encoding.PEM).decode(), key


def _app() -> TeamsSharedApp:
    certificate, key = _keypair()
    return TeamsSharedApp(
        app_id="switch-app",
        home_tenant_id="11111111-0000-0000-0000-000000000000",
        credential=ClientSecret("secret"),
        keyring=NotificationKeyring(
            current=NotificationKey(certificate_id="switch-cert", private_key=key),
            certificate_der_b64=load_certificate_der_b64(certificate),
            retired=(),
        ),
        messaging_public_url="https://switch.example",
        client_state_secret="jwt-secret",
        http=httpx.AsyncClient(),
    )


def _shared_config(**overrides: Any) -> TeamsConnectionConfig:
    return TeamsConnectionConfig.model_validate(
        {"event_delivery": "shared", "tenant_id": ORG, **overrides}
    )


def _shared_adapter(**overrides: Any) -> TeamsAdapter:
    adapter = TeamsAdapter(config=_shared_config(**overrides))
    _app().attach_if_teams(adapter)
    return adapter


# ── Config ───────────────────────────────────────────────────────────────────


def test_a_shared_bridge_needs_only_its_organisation() -> None:
    config = _shared_config()
    assert config.tenant_id == ORG
    assert config.app_id is None and config.team_id is None


@pytest.mark.parametrize(
    "foreign",
    [
        {"app_id": "x"},
        {"app_password": "x"},
        {"public_base_url": "https://x.example"},
        {"client_state": "x"},
        {"listen_port": 4000},
    ],
)
def test_a_shared_bridge_carrying_its_own_app_is_refused(
    foreign: dict[str, Any],
) -> None:
    with pytest.raises(ValidationError, match="distributed Teams app"):
        _shared_config(**foreign)


def test_a_bring_your_own_bridge_still_needs_every_setting() -> None:
    with pytest.raises(ValidationError, match="app_password"):
        TeamsConnectionConfig.model_validate(
            {
                "app_id": "a",
                "tenant_id": "t",
                "team_id": "team",
                "public_base_url": "https://x.example",
                "client_state": "s",
            }
        )


def test_the_registration_form_asks_for_the_same_fields_as_before() -> None:
    """The form is built from the schema's required list. The model now also
    describes a shared bridge, which holds none of those fields, so the list is
    declared rather than left to the field types."""
    schema = TeamsConnectionConfig.model_json_schema()
    assert schema["required"] == [
        "app_id",
        "app_password",
        "tenant_id",
        "team_id",
        "public_base_url",
    ]
    assert "event_delivery" not in schema["properties"]


def test_a_shared_bridge_claims_no_port() -> None:
    """Every bring-your-own bridge claims port 3978; a second customer's
    install would otherwise be refused."""
    assert TeamsAdapter.exclusive_resource(_shared_config().model_dump()) is None


async def test_registration_mints_nothing_for_a_shared_bridge() -> None:
    config = {"event_delivery": "shared", "tenant_id": ORG}
    assert await TeamsAdapter.prepare_config(config) == config


async def test_a_shared_bridge_has_no_credentials_of_its_own_to_verify() -> None:
    """Whether the organisation approved the app is proved by the install, not
    by a secret this bridge never carries."""
    await TeamsAdapter.verify_credentials(
        {"event_delivery": "shared", "tenant_id": ORG}
    )


def test_only_the_default_team_is_editable_on_a_shared_bridge() -> None:
    assert TeamsAdapter.editable_config_keys({"event_delivery": "shared"}) == (
        frozenset({"team_id"})
    )
    assert TeamsAdapter.editable_config_keys({"event_delivery": "own_listener"}) is None


# ── The deployment's app ─────────────────────────────────────────────────────


def test_each_organisation_gets_its_own_client_state() -> None:
    assert client_state_for("s", ORG) == client_state_for("s", ORG)
    assert client_state_for("s", ORG) != client_state_for("s", OTHER_ORG)
    assert client_state_for("s", ORG) != client_state_for("other-secret", ORG)
    assert len(client_state_for("s", ORG)) <= 128


def test_the_identity_points_the_deployments_app_at_one_organisation() -> None:
    identity = _app().identity_for(ORG)
    assert identity.shared
    assert identity.org_tenant_id == ORG
    assert identity.app_id == "switch-app"
    assert identity.notification_url.startswith(
        "https://switch.example/messaging/teams/notifications?v="
    )
    assert identity.client_state == client_state_for("jwt-secret", ORG)
    assert identity.allowed_service_hosts == frozenset({"smba.trafficmanager.net"})
    assert identity.required_graph_roles == REQUIRED_GRAPH_ROLES


def test_a_bring_your_own_bridge_is_never_attached() -> None:
    adapter = TeamsAdapter(
        config=TeamsConnectionConfig(
            app_id="a",
            app_password="p",
            tenant_id="t",
            team_id="team",
            public_base_url="https://x.example",
            client_state="s",
        )
    )
    _app().attach_if_teams(adapter)
    assert adapter._shared_app is None
    with pytest.raises(ValueError):
        adapter.attach_shared_app(_app())


async def test_a_shared_bridge_will_not_start_without_the_deployments_app() -> None:
    adapter = TeamsAdapter(config=_shared_config())

    async def _noop(*args: Any) -> None:
        return None

    with pytest.raises(RuntimeError, match="TEAMS_APP_"):
        await adapter.start(_noop, _noop, _noop, _noop, _noop)


def _app_over(handler: httpx.MockTransport) -> TeamsSharedApp:
    certificate, key = _keypair()
    return TeamsSharedApp(
        app_id="switch-app",
        home_tenant_id="11111111-0000-0000-0000-000000000000",
        credential=ClientSecret("secret"),
        keyring=NotificationKeyring(
            current=NotificationKey(certificate_id="switch-cert", private_key=key),
            certificate_der_b64=load_certificate_der_b64(certificate),
            retired=(),
        ),
        messaging_public_url="https://switch.example",
        client_state_secret="jwt-secret",
        http=httpx.AsyncClient(transport=handler),
    )


async def test_starting_a_shared_bridge_checks_approval_and_schedules_renewal() -> None:
    """The shared path of `start`: no listener of its own, tokens and a Graph
    client built from the deployment's app, and the renewal and repair loops
    running against it — proved by `stop` tearing down exactly those two tasks
    and leaving the app's own client open behind it."""

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth2/v2.0/token" in str(request.url):
            token = jwt.encode({"roles": sorted(REQUIRED_GRAPH_ROLES)}, "k" * 32)
            return httpx.Response(200, json={"access_token": token, "expires_in": 3600})
        if request.url.path == "/v1.0/subscriptions":
            return httpx.Response(200, json={"value": []})
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    app = _app_over(httpx.MockTransport(handler))
    adapter = TeamsAdapter(config=_shared_config())
    app.attach_if_teams(adapter)

    async def _noop(*args: Any) -> None:
        return None

    await adapter.start(_noop, _noop, _noop, _noop, _noop)

    assert adapter._owns_http is False
    assert adapter._http is app.http
    renewal_task, repair_task = adapter._renewal_task, adapter._repair_task
    assert renewal_task is not None and not renewal_task.done()
    assert repair_task is not None and not repair_task.done()

    await adapter.stop()

    assert renewal_task.cancelled()
    assert repair_task.cancelled()
    assert adapter._renewal_task is None
    assert adapter._repair_task is None
    assert adapter._http is None
    # The deployment's own client belongs to the app, not the bridge: stop()
    # must not have closed it.
    assert app.http.is_closed is False
    await app.aclose()


async def test_start_does_not_wait_for_the_first_renewal_round() -> None:
    """Renewing many adopted subscriptions one by one, waiting out Graph's
    throttling, must not keep the bridge from connecting; the renewal loop's
    first round does it straight after."""

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth2/v2.0/token" in str(request.url):
            token = jwt.encode({"roles": sorted(REQUIRED_GRAPH_ROLES)}, "k" * 32)
            return httpx.Response(200, json={"access_token": token, "expires_in": 3600})
        if request.url.path == "/v1.0/subscriptions":
            return httpx.Response(200, json={"value": []})
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    app = _app_over(httpx.MockTransport(handler))
    adapter = TeamsAdapter(config=_shared_config())
    app.attach_if_teams(adapter)
    renewing = asyncio.Event()
    throttled = asyncio.Event()

    async def slow_renewal() -> None:
        renewing.set()
        await throttled.wait()

    adapter._renew_due_subscriptions = slow_renewal  # type: ignore[method-assign]

    async def _noop(*args: Any) -> None:
        return None

    await asyncio.wait_for(adapter.start(_noop, _noop, _noop, _noop, _noop), 1)
    await asyncio.wait_for(renewing.wait(), 1)

    await adapter.stop()
    await app.aclose()


# ── Inbound: only this organisation's ────────────────────────────────────────


def _activity(tenant: str = ORG, **overrides: Any) -> dict[str, Any]:
    return {
        "type": "message",
        "id": "m1",
        "serviceUrl": SERVICE_URL,
        "text": "hello",
        "from": {"aadObjectId": "aad-1", "name": "Alice"},
        "conversation": {
            "id": f"{CHANNEL};messageid=m1",
            "conversationType": "channel",
            "tenantId": tenant,
        },
        "channelData": {"channel": {"id": CHANNEL}, "tenant": {"id": tenant}},
        **overrides,
    }


def _capture(adapter: TeamsAdapter) -> list[InboundMessage]:
    seen: list[InboundMessage] = []

    async def on_message(message: InboundMessage) -> None:
        seen.append(message)

    adapter._on_message = on_message
    adapter._sender_handles["aad-1"] = "alice"
    adapter._channel_names[CHANNEL] = "general"
    return seen


async def test_this_organisations_activity_is_delivered() -> None:
    adapter = _shared_adapter()
    seen = _capture(adapter)

    assert await adapter.receive_activity(_activity()) is None

    assert [m.content for m in seen] == ["hello"]


async def test_another_organisations_activity_is_refused() -> None:
    adapter = _shared_adapter()
    seen = _capture(adapter)

    await adapter.receive_activity(_activity(tenant=OTHER_ORG))

    assert seen == []


async def test_an_activity_naming_two_organisations_is_refused() -> None:
    adapter = _shared_adapter()
    seen = _capture(adapter)
    activity = _activity()
    activity["channelData"]["tenant"]["id"] = OTHER_ORG

    await adapter.receive_activity(activity)

    assert seen == []


async def test_a_press_from_another_organisation_is_answered_with_a_refusal() -> None:
    """Left unanswered, the button spins and then reports a failure of its own."""
    adapter = _shared_adapter()

    answer = await adapter.receive_activity(
        _activity(tenant=OTHER_ORG, type="invoke", name="adaptiveCard/action")
    )

    assert answer is not None and answer["statusCode"] == 403


async def test_a_service_url_that_is_not_microsofts_is_never_learned() -> None:
    """The bridge sends the deployment's token to whatever service URL it
    learns, so one that is not Microsoft's is refused before it is kept."""
    adapter = _shared_adapter()
    seen = _capture(adapter)

    await adapter.receive_activity(_activity(serviceUrl="https://evil.example/amer/"))

    assert seen == []
    assert adapter._default_service_url is None


async def test_a_bring_your_own_bridge_takes_any_tenant_it_is_sent() -> None:
    """Its credential reaches only its own organisation, so there is nothing
    for it to refuse — and nothing changes for existing bridges."""
    adapter = TeamsAdapter(
        config=TeamsConnectionConfig(
            app_id="a",
            app_password="p",
            tenant_id="t",
            team_id="team",
            public_base_url="https://x.example",
            client_state="s",
        )
    )
    seen = _capture(adapter)

    await adapter.receive_activity(_activity(tenant="whatever"))

    assert len(seen) == 1


async def test_a_notification_for_a_subscription_the_bridge_did_not_make_is_refused() -> (
    None
):
    adapter = _shared_adapter()
    adapter._subscriptions[CHANNEL] = "SUB-MINE"

    class _Graph:
        renewed: list[str] = []

        async def renew_subscription(self, *, subscription_id: str, **_: Any) -> None:
            self.renewed.append(subscription_id)

    graph = _Graph()
    adapter._graph = graph  # type: ignore[assignment]
    client_state = adapter._me.client_state

    await adapter.receive_notification(
        {
            "lifecycleEvent": "reauthorizationRequired",
            "subscriptionId": "SUB-SOMEONE-ELSES",
            "clientState": client_state,
        }
    )
    await adapter.receive_notification(
        {
            "lifecycleEvent": "reauthorizationRequired",
            "subscriptionId": "SUB-MINE",
            "clientState": client_state,
        }
    )

    assert graph.renewed == ["SUB-MINE"]


async def test_another_organisations_client_state_is_refused() -> None:
    adapter = _shared_adapter()
    adapter._subscriptions[CHANNEL] = "SUB-MINE"

    class _Graph:
        renewed: list[str] = []

        async def renew_subscription(self, *, subscription_id: str, **_: Any) -> None:
            self.renewed.append(subscription_id)

    graph = _Graph()
    adapter._graph = graph  # type: ignore[assignment]

    await adapter.receive_notification(
        {
            "lifecycleEvent": "reauthorizationRequired",
            "subscriptionId": "SUB-MINE",
            "clientState": client_state_for("jwt-secret", OTHER_ORG),
        }
    )

    assert graph.renewed == []


# ── Binding a room to a channel by id ────────────────────────────────────────


class _ChannelGraph:
    def __init__(self, *, fail: bool) -> None:
        self._fail = fail
        self.reads: list[tuple[str, str]] = []

    async def get_channel(self, *, team_id: str, channel_id: str) -> dict[str, Any]:
        self.reads.append((team_id, channel_id))
        if self._fail:
            raise GraphError("get channel failed (404): NotFound", status=404)
        return {"id": channel_id}


async def test_a_channel_in_this_organisation_can_be_bound() -> None:
    adapter = _shared_adapter(team_id="team-1")
    graph = _ChannelGraph(fail=False)
    adapter._graph = graph  # type: ignore[assignment]

    await adapter.require_bindable_channel(CHANNEL)

    assert graph.reads == [("team-1", CHANNEL)]


async def test_a_channel_graph_will_not_show_this_organisation_is_refused() -> None:
    adapter = _shared_adapter(team_id="team-1")
    adapter._graph = _ChannelGraph(fail=True)  # type: ignore[assignment]

    with pytest.raises(ChannelNotBindable):
        await adapter.require_bindable_channel(CHANNEL)


async def test_a_chat_cannot_be_bound_by_id() -> None:
    adapter = _shared_adapter(team_id="team-1")
    adapter._graph = _ChannelGraph(fail=False)  # type: ignore[assignment]

    with pytest.raises(ChannelNotBindable, match="not a Teams channel"):
        await adapter.require_bindable_channel("19:chat@thread.v2")


async def test_a_channel_in_an_unknown_team_is_refused() -> None:
    adapter = _shared_adapter()
    adapter._graph = _ChannelGraph(fail=False)  # type: ignore[assignment]

    with pytest.raises(ChannelNotBindable, match="which team"):
        await adapter.require_bindable_channel(CHANNEL)


async def test_a_bring_your_own_bridge_has_nothing_to_refuse_when_binding() -> None:
    """Its own credential reaches only its own organisation, so there is no
    other organisation's channel it could bind by mistake."""
    adapter = TeamsAdapter(
        config=TeamsConnectionConfig(
            app_id="a",
            app_password="p",
            tenant_id="t",
            team_id="team",
            public_base_url="https://x.example",
            client_state="s",
        )
    )

    await adapter.require_bindable_channel(CHANNEL)  # must not raise


async def test_an_unstarted_shared_bridge_cannot_check_a_channel_binding() -> None:
    adapter = _shared_adapter(team_id="team-1")
    assert adapter._graph is None

    with pytest.raises(RuntimeError, match="not started"):
        await adapter.require_bindable_channel(CHANNEL)


async def test_a_deeplink_for_a_channel_with_no_known_team_is_none() -> None:
    """Nothing to link to without a team id — a stopped bridge's dashboard
    shows no deeplink rather than a broken one."""
    adapter = _shared_adapter()

    assert await adapter.channel_deeplink(CHANNEL) is None


async def test_adding_people_to_a_channel_with_no_known_team_fails_them_all() -> None:
    adapter = _shared_adapter()
    adapter._graph = _ChannelGraph(fail=False)  # type: ignore[assignment]

    failed = await adapter.add_users_to_channel(CHANNEL, ["someone"], ["aad-1"])

    assert failed == ["aad-1"]


async def test_creating_a_channel_needs_a_default_team() -> None:
    adapter = _shared_adapter()
    adapter._graph = _ChannelGraph(fail=False)  # type: ignore[assignment]

    with pytest.raises(BridgeOperationError, match="default team"):
        await adapter.create_channel("room", "topic")


async def test_the_type_of_a_channel_whose_team_is_not_yet_known_cannot_be_read() -> (
    None
):
    """Reading a channel needs its team, and nothing has learned this one's
    yet — no activity from it, and no default team to fall back to."""
    adapter = _shared_adapter()
    adapter._graph = _ChannelGraph(fail=False)  # type: ignore[assignment]

    with pytest.raises(BridgeOperationError, match="which team"):
        await adapter.get_channel_type(CHANNEL)


# ── Approval health ──────────────────────────────────────────────────────────


class _Tokens:
    def __init__(
        self, *, roles: frozenset[str] | None = None, error: Exception | None = None
    ) -> None:
        self._roles = roles
        self._error = error

    async def graph_roles(self) -> frozenset[str]:
        if self._error is not None:
            raise self._error
        assert self._roles is not None
        return self._roles


async def test_a_withdrawn_approval_is_something_to_act_on() -> None:
    adapter = _shared_adapter()
    adapter._tokens = _Tokens(  # type: ignore[assignment]
        error=TokenRequestRefused("no app", error_codes=frozenset({700016}))
    )

    await adapter._check_approval()

    note = await adapter.attention()
    assert note is not None and "no longer approved" in note


async def test_a_narrowed_approval_names_what_is_missing() -> None:
    adapter = _shared_adapter()
    adapter._tokens = _Tokens(  # type: ignore[assignment]
        roles=REQUIRED_GRAPH_ROLES - {"Channel.Create"}
    )

    await adapter._check_approval()

    note = await adapter.attention()
    assert note is not None and "Channel.Create" in note


async def test_an_intact_approval_clears_the_note() -> None:
    adapter = _shared_adapter()
    adapter._approval_problem = "stale"
    adapter._tokens = _Tokens(roles=REQUIRED_GRAPH_ROLES)  # type: ignore[assignment]

    await adapter._check_approval()

    assert await adapter.attention() is None


async def test_a_transient_failure_changes_nothing() -> None:
    """A blip in Microsoft's directory is not a withdrawn approval."""
    adapter = _shared_adapter()
    adapter._tokens = _Tokens(  # type: ignore[assignment]
        error=TokenRequestRefused("busy", error_codes=frozenset({50196}))
    )

    await adapter._check_approval()

    assert await adapter.attention() is None


async def test_microsoft_being_unreachable_is_not_an_approval_problem() -> None:
    """A connectivity failure says nothing about whether the organisation still
    approves the app, so it must not be mistaken for one."""
    adapter = _shared_adapter()
    adapter._tokens = _Tokens(error=httpx.ConnectError("no route to host"))  # type: ignore[assignment]

    await adapter._check_approval()

    assert await adapter.attention() is None


async def test_a_bring_your_own_bridge_has_no_approval_to_check() -> None:
    """Only a bridge on the distributed app can lose an organisation's
    approval; a bring-your-own bridge's identity asks for no Graph roles, so
    this returns before touching tokens it was never given."""
    adapter = TeamsAdapter(
        config=TeamsConnectionConfig(
            app_id="a",
            app_password="p",
            tenant_id="t",
            team_id="team",
            public_base_url="https://x.example",
            client_state="s",
        )
    )

    await adapter._check_approval()

    assert await adapter.attention() is None


async def test_a_blocked_app_is_something_to_act_on() -> None:
    adapter = _shared_adapter()

    adapter._note_bot_disabled()

    note = await adapter.attention()
    assert note is not None and "blocked" in note


# ── Subscriptions ────────────────────────────────────────────────────────────


class _RenewGraph:
    def __init__(self, *, status: int | None = None) -> None:
        self._status = status
        self.renewed: list[str] = []

    async def renew_subscription(
        self, *, subscription_id: str, expiration_iso: str
    ) -> None:
        self.renewed.append(subscription_id)
        if self._status is not None:
            raise GraphError("renew failed", status=self._status)


async def test_only_subscriptions_close_to_running_out_are_renewed() -> None:
    adapter = _shared_adapter()
    now = datetime.datetime.now(datetime.UTC)
    adapter._subscriptions = {
        "19:soon@thread.tacv2": "SOON",
        "19:later@thread.tacv2": "LATER",
    }
    adapter._subscription_expiry = {
        "19:soon@thread.tacv2": now + datetime.timedelta(minutes=5),
        "19:later@thread.tacv2": now + datetime.timedelta(minutes=50),
    }
    graph = _RenewGraph()
    adapter._graph = graph  # type: ignore[assignment]

    await adapter._renew_due_subscriptions()

    assert graph.renewed == ["SOON"]
    assert adapter._subscription_expiry[
        "19:soon@thread.tacv2"
    ] > now + datetime.timedelta(minutes=40)


async def test_a_subscription_graph_no_longer_has_is_handed_to_the_repair_loop() -> (
    None
):
    adapter = _shared_adapter()
    adapter._subscriptions = {CHANNEL: "GONE"}
    adapter._graph = _RenewGraph(status=404)  # type: ignore[assignment]

    await adapter._renew_due_subscriptions()

    assert CHANNEL not in adapter._subscriptions
    assert CHANNEL in adapter._capture_wanted


async def test_a_failed_renewal_keeps_the_subscription_for_the_next_attempt() -> None:
    adapter = _shared_adapter()
    adapter._subscriptions = {CHANNEL: "SUB"}
    adapter._graph = _RenewGraph(status=503)  # type: ignore[assignment]

    await adapter._renew_due_subscriptions()

    assert adapter._subscriptions == {CHANNEL: "SUB"}


class _UnreachableRenewGraph:
    """Graph is not reachable at all — not even a Graph-shaped refusal."""

    async def renew_subscription(
        self, *, subscription_id: str, expiration_iso: str
    ) -> None:
        raise RuntimeError("connection reset")


async def test_a_renewal_that_fails_outright_also_keeps_the_subscription() -> None:
    """Not every failure to renew comes back as a `GraphError` — anything else
    Graph's own client can raise is kept for the next attempt exactly the same
    way a refusal is."""
    adapter = _shared_adapter()
    adapter._subscriptions = {CHANNEL: "SUB"}
    adapter._graph = _UnreachableRenewGraph()  # type: ignore[assignment]

    await adapter._renew_due_subscriptions()

    assert adapter._subscriptions == {CHANNEL: "SUB"}


async def test_removing_the_app_from_a_team_stops_capture_there() -> None:
    adapter = _shared_adapter()
    adapter._team_of_channel = {CHANNEL: "team-1", "19:other@thread.tacv2": "team-2"}
    adapter._subscriptions = {CHANNEL: "SUB-1", "19:other@thread.tacv2": "SUB-2"}
    adapter._capture_wanted = {CHANNEL, "19:other@thread.tacv2"}

    class _Graph:
        deleted: list[str] = []

        async def delete_subscription(self, *, subscription_id: str) -> None:
            self.deleted.append(subscription_id)

    graph = _Graph()
    adapter._graph = graph  # type: ignore[assignment]

    await adapter.receive_activity(
        {
            "type": "installationUpdate",
            "action": "remove",
            "serviceUrl": SERVICE_URL,
            "conversation": {
                "id": CHANNEL,
                "conversationType": "channel",
                "tenantId": ORG,
            },
            "channelData": {
                "team": {"aadGroupId": "team-1"},
                "channel": {"id": CHANNEL},
                "tenant": {"id": ORG},
            },
        }
    )

    assert graph.deleted == ["SUB-1"]
    assert adapter._capture_wanted == {"19:other@thread.tacv2"}


async def test_an_upgrade_is_not_a_removal() -> None:
    adapter = _shared_adapter()
    adapter._team_of_channel = {CHANNEL: "team-1"}
    adapter._subscriptions = {CHANNEL: "SUB-1"}

    await adapter.receive_activity(
        {
            "type": "installationUpdate",
            "action": "remove-upgrade",
            "serviceUrl": SERVICE_URL,
            "conversation": {
                "id": CHANNEL,
                "conversationType": "channel",
                "tenantId": ORG,
            },
            "channelData": {"team": {"aadGroupId": "team-1"}, "tenant": {"id": ORG}},
        }
    )

    assert adapter._subscriptions == {CHANNEL: "SUB-1"}


async def test_a_removal_naming_no_team_stops_capture_nowhere() -> None:
    """Graph always names the team on a real removal; this is the defensive
    branch for one that somehow does not, and it must not guess by falling
    back to whatever team this bridge defaults to."""
    adapter = _shared_adapter(team_id="team-1")
    adapter._team_of_channel = {CHANNEL: "team-1"}
    adapter._subscriptions = {CHANNEL: "SUB-1"}

    await adapter.receive_activity(
        {
            "type": "installationUpdate",
            "action": "remove",
            "serviceUrl": SERVICE_URL,
            "conversation": {
                "id": CHANNEL,
                "conversationType": "channel",
                "tenantId": ORG,
            },
            "channelData": {"tenant": {"id": ORG}},
        }
    )

    assert adapter._subscriptions == {CHANNEL: "SUB-1"}


async def test_stopping_capture_with_no_live_subscription_is_a_no_op() -> None:
    adapter = _shared_adapter()
    adapter._capture_wanted = {CHANNEL}
    adapter._capture_failures = {CHANNEL: "some failure"}

    await adapter._stop_capture(CHANNEL)

    assert CHANNEL not in adapter._capture_wanted
    assert CHANNEL not in adapter._capture_failures
    assert CHANNEL not in adapter._subscriptions


async def test_a_subscription_delete_that_fails_while_stopping_capture_is_only_logged() -> (
    None
):
    """The subscription runs out on its own within the hour; capture is
    already stopped either way, so a Graph failure here is not raised."""
    adapter = _shared_adapter()
    adapter._subscriptions = {CHANNEL: "SUB-1"}

    class _FailingDelete:
        async def delete_subscription(self, *, subscription_id: str) -> None:
            raise RuntimeError("Graph is down")

    adapter._graph = _FailingDelete()  # type: ignore[assignment]

    await adapter._stop_capture(CHANNEL)  # must not raise

    assert CHANNEL not in adapter._subscriptions


# ── Removal ──────────────────────────────────────────────────────────────────


class _WithdrawGraph:
    def __init__(
        self,
        *,
        listed: list[dict[str, Any]],
        installations: list[str],
        teams: tuple[str, ...] = ("team-1",),
    ) -> None:
        self._listed = listed
        self._installations = installations
        self._teams = teams
        self.deleted: list[str] = []
        self.uninstalled: list[tuple[str, str]] = []

    async def list_subscriptions(self) -> list[dict[str, Any]]:
        return self._listed

    async def list_teams(self) -> list[dict[str, Any]]:
        return [{"id": team_id} for team_id in self._teams]

    async def delete_subscription(self, *, subscription_id: str) -> None:
        self.deleted.append(subscription_id)

    async def find_app_installations(
        self, *, team_id: str, external_id: str
    ) -> list[AppInstallation]:
        return [
            AppInstallation(installation_id=i, catalog_app_id="catalog-1")
            for i in self._installations
        ]

    async def uninstall_app(self, *, team_id: str, installation_id: str) -> None:
        self.uninstalled.append((team_id, installation_id))


async def test_removing_a_shared_bridge_stops_listening_and_leaves_its_teams() -> None:
    adapter = _shared_adapter(team_id="team-default")
    url = adapter._me.notification_url
    adapter._subscriptions = {CHANNEL: "SUB-KNOWN"}
    adapter._team_of_channel = {CHANNEL: "team-1"}
    graph = _WithdrawGraph(
        listed=[
            {"id": "SUB-KNOWN", "notificationUrl": url},
            {"id": "SUB-UNADOPTED", "notificationUrl": url},
            {"id": "SUB-ELSEWHERE", "notificationUrl": "https://other.example/x"},
        ],
        installations=["INST-1"],
        teams=("team-1", "team-default", "team-never-seen"),
    )
    adapter._graph = graph  # type: ignore[assignment]

    await adapter.withdraw()

    assert sorted(graph.deleted) == ["SUB-KNOWN", "SUB-UNADOPTED"]
    # Every team the app is in, including one whose join the bridge never saw.
    assert sorted(graph.uninstalled) == [
        ("team-1", "INST-1"),
        ("team-default", "INST-1"),
        ("team-never-seen", "INST-1"),
    ]
    assert adapter._capture_wanted == set()


async def test_removing_a_bring_your_own_bridge_leaves_the_operators_app_in_place() -> (
    None
):
    adapter = TeamsAdapter(
        config=TeamsConnectionConfig(
            app_id="a",
            app_password="p",
            tenant_id="t",
            team_id="team",
            public_base_url="https://x.example",
            client_state="s",
        )
    )
    adapter._subscriptions = {CHANNEL: "SUB-1"}
    graph = _WithdrawGraph(listed=[], installations=["INST-1"])
    adapter._graph = graph  # type: ignore[assignment]

    await adapter.withdraw()

    assert graph.deleted == ["SUB-1"]
    assert graph.uninstalled == []


async def test_what_could_not_be_withdrawn_is_said() -> None:
    adapter = _shared_adapter()
    adapter._subscriptions = {CHANNEL: "SUB-1"}

    class _Failing(_WithdrawGraph):
        async def delete_subscription(self, *, subscription_id: str) -> None:
            raise GraphError("delete failed (503)", status=503)

    adapter._graph = _Failing(listed=[], installations=[])  # type: ignore[assignment]

    with pytest.raises(BridgeOperationError, match="SUB-1"):
        await adapter.withdraw()


async def test_withdrawing_before_a_graph_client_ever_existed_is_a_no_op() -> None:
    """A bridge that never got past `start`'s early checks has nothing on the
    platform to let go of."""
    adapter = _shared_adapter()
    assert adapter._graph is None

    await adapter.withdraw()  # must not raise


async def test_a_withdrawal_that_cannot_even_list_subscriptions_still_says_so() -> None:
    adapter = _shared_adapter()

    class _Unreachable(_WithdrawGraph):
        async def list_subscriptions(self) -> list[dict[str, Any]]:
            raise GraphError("list failed (503)", status=503)

    adapter._graph = _Unreachable(listed=[], installations=[])  # type: ignore[assignment]

    with pytest.raises(BridgeOperationError, match="listing subscriptions failed"):
        await adapter.withdraw()


async def test_a_team_the_app_cannot_be_removed_from_is_named_in_what_is_left_behind() -> (
    None
):
    adapter = _shared_adapter(team_id="team-1")

    class _CannotUninstall(_WithdrawGraph):
        async def uninstall_app(self, *, team_id: str, installation_id: str) -> None:
            raise GraphError("uninstall failed (403)", status=403)

    adapter._graph = _CannotUninstall(  # type: ignore[assignment]
        listed=[], installations=["INST-1"]
    )

    with pytest.raises(BridgeOperationError, match="the app in team team-1"):
        await adapter.withdraw()


# ── From the deployment's public route ───────────────────────────────────────


async def test_an_activity_from_the_public_route_is_delivered() -> None:
    adapter = _shared_adapter()
    seen = _capture(adapter)

    answer = await adapter.dispatch_event(envelope_type="activity", payload=_activity())

    assert answer is None
    assert [m.content for m in seen] == ["hello"]


async def test_a_press_from_the_public_route_is_answered() -> None:
    adapter = _shared_adapter()

    answer = await adapter.dispatch_event(
        envelope_type="activity",
        payload=_activity(tenant=OTHER_ORG, type="invoke", name="adaptiveCard/action"),
    )

    assert answer is not None and answer["statusCode"] == 403


async def test_an_envelope_it_does_not_know_is_refused() -> None:
    adapter = _shared_adapter()
    with pytest.raises(ValueError):
        await adapter.dispatch_event(envelope_type="mystery", payload={})


async def test_a_notification_from_the_public_route_answers_nothing() -> None:
    """Unlike an activity, which may carry an invoke's answer, a notification
    never does — Graph does not wait on a reply."""
    adapter = _shared_adapter()

    answer = await adapter.dispatch_event(
        envelope_type="notification",
        payload={"clientState": "not this organisation's", "subscriptionId": "x"},
    )

    assert answer is None


# ── Which teams Switch is in ─────────────────────────────────────────────────


class _PlacementGraph:
    def __init__(self) -> None:
        self.installed: dict[str, list[str]] = {"team-b": ["INST-B"]}
        self.added: list[tuple[str, str]] = []
        self.uninstalled: list[tuple[str, str]] = []
        self.deleted: list[str] = []

    async def list_teams(self) -> list[dict[str, Any]]:
        return [
            {"id": "team-b", "displayName": "beta"},
            {"id": "team-a", "displayName": "Alpha"},
            {"id": "team-unreadable", "displayName": "gamma (archived)"},
        ]

    async def find_app_installations(
        self, *, team_id: str, external_id: str
    ) -> list[AppInstallation]:
        assert external_id == "switch-app"
        if team_id == "team-unreadable":
            raise GraphError("forbidden", status=403)
        return [
            AppInstallation(installation_id=i, catalog_app_id="catalog-b")
            for i in self.installed.get(team_id, [])
        ]

    async def install_app(self, *, team_id: str, catalog_app_id: str) -> None:
        self.added.append((team_id, catalog_app_id))

    async def uninstall_app(self, *, team_id: str, installation_id: str) -> None:
        self.uninstalled.append((team_id, installation_id))

    async def delete_subscription(self, *, subscription_id: str) -> None:
        self.deleted.append(subscription_id)


async def test_the_organisations_teams_are_listed_with_where_switch_is() -> None:
    adapter = _shared_adapter()
    adapter._graph = _PlacementGraph()  # type: ignore[assignment]

    placements = await adapter.list_team_placements()

    assert [(p.name, p.has_switch) for p in placements.teams] == [
        ("Alpha", False),
        ("beta", True),
        ("gamma (archived)", None),
    ]
    # An installation reports the app's id in the catalogue, which is how it
    # is learned after a Teams admin uploaded the app by hand.
    assert placements.catalog_app_id == "catalog-b"
    assert adapter.places_app_in_teams


async def test_switch_is_added_to_a_team_by_its_id_in_the_catalogue() -> None:
    adapter = _shared_adapter()
    graph = _PlacementGraph()
    adapter._graph = graph  # type: ignore[assignment]

    await adapter.add_to_team("team-a", catalog_app_id="catalog-1")

    assert graph.added == [("team-a", "catalog-1")]


async def test_leaving_a_team_stops_capture_in_its_channels() -> None:
    adapter = _shared_adapter()
    graph = _PlacementGraph()
    adapter._graph = graph  # type: ignore[assignment]
    adapter._team_of_channel = {CHANNEL: "team-b"}
    adapter._subscriptions = {CHANNEL: "SUB-B"}

    await adapter.remove_from_team("team-b")

    assert graph.uninstalled == [("team-b", "INST-B")]
    assert graph.deleted == ["SUB-B"]


async def test_a_bring_your_own_bridge_does_not_place_itself() -> None:
    adapter = TeamsAdapter(
        config=TeamsConnectionConfig(
            app_id="a",
            app_password="p",
            tenant_id="t",
            team_id="team",
            public_base_url="https://x.example",
            client_state="s",
        )
    )
    adapter._graph = _PlacementGraph()  # type: ignore[assignment]

    assert not adapter.places_app_in_teams
    with pytest.raises(BridgeOperationError):
        await adapter.list_team_placements()


async def test_an_unstarted_shared_bridge_cannot_be_asked_which_teams_it_is_in() -> (
    None
):
    """It is a bridge on the distributed app, so the request is the right one —
    just asked of a bridge that has no Graph client yet."""
    adapter = _shared_adapter()
    assert adapter._graph is None

    with pytest.raises(RuntimeError, match="not started"):
        await adapter.list_team_placements()


def test_before_any_activity_a_shared_bridge_posts_through_microsofts_global_endpoint() -> (
    None
):
    adapter = _shared_adapter()
    assert adapter._service_url_for(CHANNEL) == "https://smba.trafficmanager.net/teams/"


def test_a_bring_your_own_bridge_still_waits_to_learn_its_endpoint() -> None:
    adapter = TeamsAdapter(
        config=TeamsConnectionConfig(
            app_id="a",
            app_password="p",
            tenant_id="t",
            team_id="team",
            public_base_url="https://x.example",
            client_state="s",
        )
    )
    with pytest.raises(RuntimeError, match="serviceUrl"):
        adapter._service_url_for(CHANNEL)


async def test_a_chat_is_never_mapped_to_a_team() -> None:
    adapter = _shared_adapter(team_id="team-default")
    _capture(adapter)
    chat = "19:chat@thread.v2"

    await adapter.receive_activity(
        _activity(
            conversation={"id": chat, "conversationType": "groupChat", "tenantId": ORG},
            channelData={"tenant": {"id": ORG}},
        )
    )

    assert chat not in adapter._team_of_channel


async def test_removing_a_shared_bridge_lets_go_of_its_organisations_tokens() -> None:
    app = _app()
    adapter = TeamsAdapter(config=_shared_config())
    app.attach_if_teams(adapter)
    app.org_tokens(ORG)
    adapter._graph = _WithdrawGraph(listed=[], installations=[])  # type: ignore[assignment]

    await adapter.withdraw()

    assert ORG not in app._org_tokens


# ── Review fixes ─────────────────────────────────────────────────────────────


async def test_a_renewal_round_that_fails_does_not_end_renewal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The loop is what keeps every subscription alive; an error escaping it
    would end renewal silently and for good."""
    adapter = _shared_adapter()
    rounds: list[int] = []

    async def failing_check() -> None:
        rounds.append(1)
        raise OSError("the projected token file is being rotated")

    async def fast_sleep(seconds: float) -> None:
        if len(rounds) >= 3:
            raise asyncio.CancelledError

    adapter._check_approval = failing_check  # type: ignore[method-assign]
    monkeypatch.setattr(
        "switch_core.bridges.collaboration.teams.adapter.asyncio.sleep", fast_sleep
    )

    with pytest.raises(asyncio.CancelledError):
        await adapter._renewal_loop()

    assert len(rounds) == 3


async def test_a_successful_round_goes_on_to_renew_due_subscriptions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter = _shared_adapter()
    rounds: list[int] = []

    async def ok_check() -> None:
        return None

    async def renew() -> None:
        rounds.append(1)

    async def fast_sleep(seconds: float) -> None:
        if len(rounds) >= 2:
            raise asyncio.CancelledError

    adapter._check_approval = ok_check  # type: ignore[method-assign]
    adapter._renew_due_subscriptions = renew  # type: ignore[method-assign]
    monkeypatch.setattr(
        "switch_core.bridges.collaboration.teams.adapter.asyncio.sleep", fast_sleep
    )

    with pytest.raises(asyncio.CancelledError):
        await adapter._renewal_loop()

    assert len(rounds) == 2


def test_an_unusable_encryption_key_only_turns_capture_off() -> None:
    """A bring-your-own bridge with a key Graph cannot use still posts and
    hears mentions; it just does not capture channel messages."""
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    certificate, _ = _keypair()
    adapter = TeamsAdapter(
        config=TeamsConnectionConfig(
            app_id="a",
            app_password="p",
            tenant_id="t",
            team_id="team",
            public_base_url="https://x.example",
            client_state="s",
            encryption_certificate_id="c",
            encryption_public_certificate=certificate,
            encryption_private_key=pem,
        )
    )
    assert adapter._me.keyring is None


async def test_rotating_the_secret_remakes_subscriptions_made_under_the_old_one() -> (
    None
):
    """The clientState key rides on the notification URL, so a subscription
    made under an earlier key points somewhere else and is replaced at start
    rather than kept and failing every origin check."""
    adapter = _shared_adapter()
    current = adapter._me.notification_url
    stale = current.split("?")[0] + "?v=0123456789ab"

    class _Graph:
        deleted: list[str] = []

        async def list_subscriptions(self) -> list[dict[str, Any]]:
            return [
                {
                    "id": "OLD-KEY",
                    "resource": f"teams/t/channels/{CHANNEL}/messages",
                    "notificationUrl": stale,
                },
                {
                    "id": "CURRENT",
                    "resource": "teams/t/channels/19:other@thread.tacv2/messages",
                    "notificationUrl": current,
                },
            ]

        async def delete_subscription(self, *, subscription_id: str) -> None:
            self.deleted.append(subscription_id)

    graph = _Graph()
    adapter._graph = graph  # type: ignore[assignment]

    await adapter._adopt_existing_subscriptions()

    assert graph.deleted == ["OLD-KEY"]
    assert adapter._subscriptions == {"19:other@thread.tacv2": "CURRENT"}


def test_a_subscription_made_under_an_earlier_key_still_delivers_here() -> None:
    """For cleaning up: it is this deployment's, whichever key made it."""
    identity = _app().identity_for(ORG)
    base = identity.notification_url.split("?")[0]
    assert identity.delivers_here(base + "?v=0123456789ab")
    assert not identity.delivers_here(
        "https://elsewhere.example/messaging/teams/notifications"
    )


async def test_an_organisation_whose_bridge_is_not_running_is_still_left() -> None:
    app = _app()
    url = app.identity_for(ORG).notification_url.split("?")[0] + "?v=old"
    deleted: list[str] = []
    uninstalled: list[tuple[str, str]] = []

    class _Graph:
        async def list_subscriptions(self) -> list[dict[str, Any]]:
            return [
                {"id": "S1", "notificationUrl": url},
                {"id": "S2", "notificationUrl": "https://elsewhere.example/x"},
            ]

        async def delete_subscription(self, *, subscription_id: str) -> None:
            deleted.append(subscription_id)

        async def list_teams(self) -> list[dict[str, Any]]:
            return [{"id": "team-1"}, {"id": "team-2"}]

        async def find_app_installations(
            self, *, team_id: str, external_id: str
        ) -> list[AppInstallation]:
            if team_id == "team-1":
                return [AppInstallation(installation_id="I1", catalog_app_id="c")]
            return []

        async def uninstall_app(self, *, team_id: str, installation_id: str) -> None:
            uninstalled.append((team_id, installation_id))

    original = shared_app_module.GraphClient
    shared_app_module.GraphClient = lambda **_: _Graph()  # type: ignore[assignment,misc]
    try:
        app.org_tokens(ORG)
        await app.withdraw_from_org(ORG)
    finally:
        shared_app_module.GraphClient = original  # type: ignore[misc]

    assert deleted == ["S1"]
    assert uninstalled == [("team-1", "I1")]
    assert ORG not in app._org_tokens


# ── Channel ids offered for binding ──────────────────────────────────────────


@pytest.mark.parametrize(
    "channel_id",
    [
        "19:x/../../../teams/team-1?@thread.tacv2",
        "19:x?@thread.tacv2",
        "19:x#@thread.tacv2",
        "19:x%2F@thread.tacv2",
        "19:x y@thread.tacv2",
        "19:x@y@thread.tacv2",
        "19:@thread.tacv2",
    ],
)
async def test_a_channel_id_that_could_reshape_the_check_is_refused(
    channel_id: str,
) -> None:
    """The id goes into the Graph call that proves the channel is this
    organisation's; one that moved that call elsewhere could pass it."""
    adapter = _shared_adapter(team_id="team-1")
    graph = _ChannelGraph(fail=False)
    adapter._graph = graph  # type: ignore[assignment]

    with pytest.raises(ChannelNotBindable, match="not a Teams channel"):
        await adapter.require_bindable_channel(channel_id)

    assert graph.reads == []


async def test_an_older_teams_channel_id_can_be_bound() -> None:
    adapter = _shared_adapter(team_id="team-1")
    graph = _ChannelGraph(fail=False)
    adapter._graph = graph  # type: ignore[assignment]

    await adapter.require_bindable_channel("19:a1b2-c3_d4@thread.skype")

    assert graph.reads == [("team-1", "19:a1b2-c3_d4@thread.skype")]


# ── Never a second subscription ──────────────────────────────────────────────


class _SubscribingGraph:
    """Lists what it holds (or fails to), and makes subscriptions on request."""

    def __init__(self, *, list_failures: int, held: list[dict[str, Any]]) -> None:
        self.list_failures = list_failures
        self.held = held
        self.created: list[str] = []
        self.deleted: list[str] = []
        self.create_started = asyncio.Event()
        self.let_create_finish: asyncio.Event | None = None

    async def list_subscriptions(self) -> list[dict[str, Any]]:
        if self.list_failures:
            self.list_failures -= 1
            raise GraphError("list subscriptions failed (503)", status=503)
        return list(self.held)

    async def create_subscription(self, **kwargs: Any) -> dict[str, Any]:
        self.create_started.set()
        if self.let_create_finish is not None:
            await self.let_create_finish.wait()
        sub_id = f"NEW-{len(self.created) + 1}"
        self.created.append(sub_id)
        self.held.append(
            {
                "id": sub_id,
                "resource": kwargs["resource"],
                "notificationUrl": kwargs["notification_url"],
            }
        )
        return {"id": sub_id}

    async def delete_subscription(self, *, subscription_id: str) -> None:
        self.deleted.append(subscription_id)
        self.held = [s for s in self.held if s["id"] != subscription_id]

    async def find_app_installations(
        self, *, team_id: str, external_id: str
    ) -> list[AppInstallation]:
        return []

    async def list_teams(self) -> list[dict[str, Any]]:
        return []


async def test_capture_waits_until_the_existing_subscriptions_can_be_read() -> None:
    """A channel whose live subscription could not be seen at start would be
    given a second, and every message delivered twice."""
    adapter = _shared_adapter(team_id="team-1")
    graph = _SubscribingGraph(list_failures=2, held=[])
    adapter._graph = graph  # type: ignore[assignment]

    await adapter._adopt_existing_subscriptions()
    await adapter._ensure_channel_subscription(CHANNEL)

    assert graph.created == []
    assert CHANNEL in adapter._capture_wanted
    assert CHANNEL in adapter._capture_failures


async def test_a_subscription_seen_once_listing_works_is_adopted_not_remade() -> None:
    adapter = _shared_adapter(team_id="team-1")
    graph = _SubscribingGraph(
        list_failures=1,
        held=[
            {
                "id": "LIVE",
                "resource": f"teams/team-1/channels/{CHANNEL}/messages",
                "notificationUrl": adapter._me.notification_url,
            }
        ],
    )
    adapter._graph = graph  # type: ignore[assignment]

    await adapter._adopt_existing_subscriptions()
    await adapter._ensure_channel_subscription(CHANNEL)

    assert graph.created == []
    assert adapter._subscriptions == {CHANNEL: "LIVE"}


async def test_a_channel_with_none_is_subscribed_once_listing_works() -> None:
    adapter = _shared_adapter(team_id="team-1")
    graph = _SubscribingGraph(list_failures=1, held=[])
    adapter._graph = graph  # type: ignore[assignment]

    await adapter._adopt_existing_subscriptions()
    await adapter._ensure_channel_subscription(CHANNEL)

    assert graph.created == ["NEW-1"]
    assert adapter._subscriptions == {CHANNEL: "NEW-1"}


async def test_nothing_is_subscribed_once_the_bridge_is_withdrawing() -> None:
    """A `subscriptionRemoved` arriving while the bridge is being removed must
    not make a subscription nothing will renew or delete."""
    adapter = _shared_adapter(team_id="team-1")
    graph = _SubscribingGraph(list_failures=0, held=[])
    adapter._graph = graph  # type: ignore[assignment]
    adapter._adopted = True
    adapter._subscriptions = {CHANNEL: "SUB-1"}

    await adapter.withdraw()
    await adapter._recreate_removed_subscription("SUB-1")
    adapter._subscriptions = {}
    await adapter._ensure_channel_subscription(CHANNEL)

    assert graph.created == []


async def test_a_subscription_being_made_as_withdrawal_starts_is_deleted() -> None:
    adapter = _shared_adapter(team_id="team-1")
    graph = _SubscribingGraph(list_failures=0, held=[])
    graph.let_create_finish = asyncio.Event()
    adapter._graph = graph  # type: ignore[assignment]
    adapter._adopted = True

    making = asyncio.create_task(adapter._ensure_channel_subscription(CHANNEL))
    await graph.create_started.wait()
    withdrawing = asyncio.create_task(adapter.withdraw())
    await asyncio.sleep(0)
    graph.let_create_finish.set()
    await making
    await withdrawing

    assert graph.created == ["NEW-1"]
    assert graph.deleted == ["NEW-1"]


# ── The default team ─────────────────────────────────────────────────────────


class _DefaultTeamGraph:
    def __init__(self, *, installed_in: set[str], failure: Exception | None) -> None:
        self.installed_in = installed_in
        self.failure = failure
        self.asked: list[str] = []

    async def find_app_installations(
        self, *, team_id: str, external_id: str
    ) -> list[AppInstallation]:
        self.asked.append(team_id)
        if self.failure is not None:
            raise self.failure
        if team_id in self.installed_in:
            return [AppInstallation(installation_id="I", catalog_app_id="c")]
        return []


async def test_a_team_switch_is_in_can_be_the_default() -> None:
    adapter = _shared_adapter(team_id="team-1")
    graph = _DefaultTeamGraph(installed_in={"team-2"}, failure=None)
    adapter._graph = graph  # type: ignore[assignment]

    await adapter.check_config_edit({"tenant_id": ORG, "team_id": "team-2"})

    assert graph.asked == ["team-2"]


async def test_a_team_switch_is_not_in_cannot_be_the_default() -> None:
    adapter = _shared_adapter(team_id="team-1")
    adapter._graph = _DefaultTeamGraph(installed_in=set(), failure=None)  # type: ignore[assignment]

    with pytest.raises(ConfigEditRefused, match="Add it to the team first"):
        await adapter.check_config_edit({"tenant_id": ORG, "team_id": "team-2"})


async def test_a_team_that_does_not_exist_cannot_be_the_default() -> None:
    adapter = _shared_adapter(team_id="team-1")
    adapter._graph = _DefaultTeamGraph(  # type: ignore[assignment]
        installed_in=set(), failure=GraphError("not found (404)", status=404)
    )

    with pytest.raises(ConfigEditRefused, match="no team"):
        await adapter.check_config_edit({"tenant_id": ORG, "team_id": "nope"})


@pytest.mark.parametrize(
    "failure",
    [
        GraphError("busy (503)", status=503),
        TokenRequestRefused("AADSTS700016", error_codes=frozenset({700016})),
        httpx.ConnectError("unreachable"),
    ],
)
async def test_a_default_team_microsoft_cannot_be_asked_about_is_not_accepted(
    failure: Exception,
) -> None:
    adapter = _shared_adapter(team_id="team-1")
    adapter._graph = _DefaultTeamGraph(installed_in=set(), failure=failure)  # type: ignore[assignment]

    with pytest.raises(BridgeOperationError):
        await adapter.check_config_edit({"tenant_id": ORG, "team_id": "team-2"})


@pytest.mark.parametrize("team_id", [None, "team-1"])
async def test_an_unchanged_or_cleared_default_is_not_checked(
    team_id: str | None,
) -> None:
    adapter = _shared_adapter(team_id="team-1")
    graph = _DefaultTeamGraph(installed_in=set(), failure=None)
    adapter._graph = graph  # type: ignore[assignment]

    await adapter.check_config_edit({"tenant_id": ORG, "team_id": team_id})

    assert graph.asked == []


async def test_a_bring_your_own_bridges_default_team_is_its_operators() -> None:
    adapter = TeamsAdapter(
        config=TeamsConnectionConfig(
            app_id="a",
            app_password="p",
            tenant_id="t",
            team_id="team",
            public_base_url="https://x.example",
            client_state="s",
        )
    )
    graph = _DefaultTeamGraph(installed_in=set(), failure=None)
    adapter._graph = graph  # type: ignore[assignment]

    await adapter.check_config_edit({"team_id": "anything"})

    assert graph.asked == []


async def test_two_catalogue_ids_for_the_app_are_logged(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter = _shared_adapter()

    class _TwoCopies(_PlacementGraph):
        async def find_app_installations(
            self, *, team_id: str, external_id: str
        ) -> list[AppInstallation]:
            return [
                AppInstallation(installation_id="I", catalog_app_id=f"cat-{team_id}")
            ]

    adapter._graph = _TwoCopies()  # type: ignore[assignment]

    with caplog.at_level("WARNING"):
        placements = await adapter.list_team_placements()

    assert placements.catalog_app_id is not None
    assert "more than one catalogue id" in caplog.text


# ── Final review fixes ───────────────────────────────────────────────────────


async def test_a_channel_activity_without_its_team_does_not_move_the_channel() -> None:
    """Teams names a channel's team group on some activities only. A bridge on
    the distributed app is in many teams, so guessing the default would file
    another team's channel under it, and its capture would ask the wrong team."""
    adapter = _shared_adapter(team_id="team-default")
    _capture(adapter)
    adapter._team_of_channel = {CHANNEL: "team-x"}

    await adapter.receive_activity(
        _activity(channelData={"channel": {"id": CHANNEL}, "tenant": {"id": ORG}})
    )

    assert adapter._team_of_channel == {CHANNEL: "team-x"}


async def test_a_channel_activity_naming_its_team_places_the_channel() -> None:
    adapter = _shared_adapter(team_id="team-default")
    _capture(adapter)

    await adapter.receive_activity(
        _activity(
            channelData={
                "channel": {"id": CHANNEL},
                "tenant": {"id": ORG},
                "team": {"id": "19:team-thread", "aadGroupId": "team-x"},
            }
        )
    )

    assert adapter._team_of_channel == {CHANNEL: "team-x"}


def _own_bridge() -> TeamsAdapter:
    return TeamsAdapter(
        config=TeamsConnectionConfig(
            app_id="a",
            app_password="p",
            tenant_id=ORG,
            team_id="team-own",
            public_base_url="https://x.example",
            client_state="s",
        )
    )


async def test_a_bring_your_own_bridge_places_an_unplaced_channel_in_its_team() -> None:
    adapter = _own_bridge()
    _capture(adapter)

    await adapter.receive_activity(
        _activity(channelData={"channel": {"id": CHANNEL}, "tenant": {"id": ORG}})
    )

    assert adapter._team_of_channel == {CHANNEL: "team-own"}


async def test_a_bring_your_own_bridge_keeps_a_channel_it_already_placed() -> None:
    adapter = _own_bridge()
    _capture(adapter)
    adapter._team_of_channel = {CHANNEL: "team-elsewhere"}

    await adapter.receive_activity(
        _activity(channelData={"channel": {"id": CHANNEL}, "tenant": {"id": ORG}})
    )

    assert adapter._team_of_channel == {CHANNEL: "team-elsewhere"}


async def test_an_unreadable_credential_file_is_not_an_approval_problem() -> None:
    """The federated token file can be unreadable for a moment while it is
    rotated; the check says it could not ask, and the bridge carries on."""
    adapter = _shared_adapter()
    adapter._tokens = _Tokens(  # type: ignore[assignment]
        error=FileNotFoundError("/var/run/secrets/microsoft/teams-app/token")
    )

    await adapter._check_approval()

    assert await adapter.attention() is None


async def test_a_team_whose_read_times_out_is_listed_as_unknown() -> None:
    adapter = _shared_adapter()

    class _Slow(_PlacementGraph):
        async def find_app_installations(
            self, *, team_id: str, external_id: str
        ) -> list[AppInstallation]:
            if team_id == "team-a":
                raise httpx.ReadTimeout("timed out")
            return await super().find_app_installations(
                team_id=team_id, external_id=external_id
            )

    adapter._graph = _Slow()  # type: ignore[assignment]

    placements = await adapter.list_team_placements()

    by_id = {p.team_id: p.has_switch for p in placements.teams}
    assert by_id["team-a"] is None
    assert by_id["team-b"] is True


async def test_a_refused_organisation_token_fails_the_listing_and_stops_the_reads() -> (
    None
):
    adapter = _shared_adapter()
    started: list[str] = []
    finished: list[str] = []

    class _Refused(_PlacementGraph):
        async def list_teams(self) -> list[dict[str, Any]]:
            return [{"id": f"team-{n}", "displayName": str(n)} for n in range(20)]

        async def find_app_installations(
            self, *, team_id: str, external_id: str
        ) -> list[AppInstallation]:
            started.append(team_id)
            if team_id == "team-0":
                raise TokenRequestRefused(
                    "AADSTS7000112: disabled", error_codes=frozenset({7000112})
                )
            await asyncio.sleep(0.5)
            finished.append(team_id)
            return []

    adapter._graph = _Refused()  # type: ignore[assignment]

    with pytest.raises(TokenRequestRefused):
        await adapter.list_team_placements()

    await asyncio.sleep(0.6)
    assert finished == []


async def test_one_subscription_that_cannot_be_deleted_does_not_keep_the_rest() -> None:
    adapter = _shared_adapter()
    url = adapter._me.notification_url

    class _OneStuck(_WithdrawGraph):
        async def delete_subscription(self, *, subscription_id: str) -> None:
            if subscription_id == "SUB-A":
                raise GraphError("delete failed (503)", status=503)
            await super().delete_subscription(subscription_id=subscription_id)

    graph = _OneStuck(
        listed=[
            {"id": "SUB-A", "notificationUrl": url},
            {"id": "SUB-B", "notificationUrl": url},
        ],
        installations=[],
    )
    adapter._graph = graph  # type: ignore[assignment]

    with pytest.raises(BridgeOperationError, match="SUB-A"):
        await adapter.withdraw()

    assert graph.deleted == ["SUB-B"]
