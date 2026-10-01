"""A Teams bridge on the distributed app: one organisation, the deployment's app.

The deployment's credential reaches every organisation that approved the app,
so most of what is tested here is the bridge refusing what is not its own
organisation's — activities, notifications, channels — and never sending the
deployment's token anywhere but Microsoft.
"""

from __future__ import annotations

import datetime
import functools
from typing import Any

import httpx
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from pydantic import ValidationError

from switch_core.bridges.collaboration.adapter import ChannelNotBindable
from switch_core.bridges.collaboration.models import (
    BridgeOperationError,
    InboundMessage,
)
from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)
from switch_core.bridges.collaboration.teams.auth import (
    ClientSecret,
    TokenRequestRefused,
)
from switch_core.bridges.collaboration.teams.crypto import load_certificate_der_b64
from switch_core.bridges.collaboration.teams.graph import GraphError
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
    assert identity.notification_url == (
        "https://switch.example/messaging/teams/notifications"
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


async def test_creating_a_channel_needs_a_default_team() -> None:
    adapter = _shared_adapter()
    adapter._graph = _ChannelGraph(fail=False)  # type: ignore[assignment]

    with pytest.raises(BridgeOperationError, match="default team"):
        await adapter.create_channel("room", "topic")


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


# ── Removal ──────────────────────────────────────────────────────────────────


class _WithdrawGraph:
    def __init__(
        self, *, listed: list[dict[str, Any]], installations: list[str]
    ) -> None:
        self._listed = listed
        self._installations = installations
        self.deleted: list[str] = []
        self.uninstalled: list[tuple[str, str]] = []

    async def list_subscriptions(self) -> list[dict[str, Any]]:
        return self._listed

    async def delete_subscription(self, *, subscription_id: str) -> None:
        self.deleted.append(subscription_id)

    async def find_app_installations(
        self, *, team_id: str, external_id: str
    ) -> list[str]:
        return list(self._installations)

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
    )
    adapter._graph = graph  # type: ignore[assignment]

    await adapter.withdraw()

    assert sorted(graph.deleted) == ["SUB-KNOWN", "SUB-UNADOPTED"]
    assert sorted(graph.uninstalled) == [
        ("team-1", "INST-1"),
        ("team-default", "INST-1"),
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
        ]

    async def find_app_installations(
        self, *, team_id: str, external_id: str
    ) -> list[str]:
        assert external_id == "switch-app"
        return self.installed.get(team_id, [])

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

    assert [(p.name, p.has_switch) for p in placements] == [
        ("Alpha", False),
        ("beta", True),
    ]
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
