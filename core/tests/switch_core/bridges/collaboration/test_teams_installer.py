"""Approving the distributed Teams app for a Microsoft organisation, and the
webhooks that follow.

Microsoft's redirect proves nothing on its own, so the install records nothing
until the id token names the organisation, the person signing in holds an
approving role there, and a token issued there carries every permission the
app needs. Microsoft is faked at the HTTP layer; the checks are real.
"""

from __future__ import annotations

import datetime
import functools
import json
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import jwt
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from jwt.algorithms import RSAAlgorithm

from switch_core.bridges.collaboration.install import (
    MessagingInstallError,
    WebhookAuthenticityError,
    WebhookPayloadError,
)
from switch_core.bridges.collaboration.teams import install as teams_install
from switch_core.bridges.collaboration.teams.app_package import (
    build_distributed_app_package,
)
from switch_core.bridges.collaboration.teams.auth import ClientSecret
from switch_core.bridges.collaboration.teams.crypto import load_certificate_der_b64
from switch_core.bridges.collaboration.teams.identity import (
    REQUIRED_GRAPH_ROLES,
    NotificationKey,
    NotificationKeyring,
)
from switch_core.bridges.collaboration.teams.install import TeamsAppInstaller
from switch_core.bridges.collaboration.teams.shared_app import TeamsSharedApp

APP_ID = "aaaaaaaa-1111-1111-1111-111111111111"
ORG = "bbbbbbbb-2222-2222-2222-222222222222"
GLOBAL_ADMIN = "62e90394-69f5-4237-9190-012177145e10"
_IDENTITY_METADATA = (
    "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration"
)
_IDENTITY_KEYS = "https://login.microsoftonline.com/common/discovery/v2.0/keys"


@functools.lru_cache(maxsize=1)
def _signing_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@functools.lru_cache(maxsize=1)
def _notification_keypair() -> tuple[str, rsa.RSAPrivateKey]:
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


def _id_token(**overrides: Any) -> str:
    claims: dict[str, Any] = {
        "aud": APP_ID,
        "iss": f"https://login.microsoftonline.com/{ORG}/v2.0",
        "tid": ORG,
        "exp": datetime.datetime.now(datetime.UTC) + datetime.timedelta(hours=1),
        "name": "Ada Admin",
        "wids": [GLOBAL_ADMIN],
    }
    claims.update(overrides)
    for key in [k for k, v in claims.items() if v is None]:
        del claims[key]
    return jwt.encode(claims, _signing_key(), algorithm="RS256", headers={"kid": "id1"})


class _Microsoft:
    """Microsoft's sign-in, token and Graph endpoints, as far as an install
    touches them. Scripted per test; records what it was asked."""

    def __init__(self) -> None:
        self.id_token = _id_token()
        self.roles: list[str] = sorted(REQUIRED_GRAPH_ROLES)
        self.org_token_error: dict[str, Any] | None = None
        self.catalog: list[dict[str, Any]] = []
        self.publish_status = 201
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        url = str(request.url)
        if url == _IDENTITY_METADATA:
            return httpx.Response(200, json={"jwks_uri": _IDENTITY_KEYS})
        if url == _IDENTITY_KEYS:
            jwk = RSAAlgorithm.to_jwk(_signing_key().public_key(), as_dict=True)
            return httpx.Response(200, json={"keys": [{**jwk, "kid": "id1"}]})
        if url.endswith("/organizations/oauth2/v2.0/token"):
            return httpx.Response(
                200, json={"access_token": "delegated", "id_token": self.id_token}
            )
        if url.endswith(f"/{ORG}/oauth2/v2.0/token"):
            if self.org_token_error is not None:
                return httpx.Response(400, json=self.org_token_error)
            token = jwt.encode({"roles": self.roles}, "k" * 32)
            return httpx.Response(200, json={"access_token": token, "expires_in": 3600})
        if "/v1.0/organization" in url:
            return httpx.Response(200, json={"value": [{"displayName": "Contoso"}]})
        if "/appDefinitions" in url:
            return httpx.Response(201, json={"id": "definition"})
        if "/appCatalogs/teamsApps" in url and request.method == "GET":
            return httpx.Response(200, json={"value": self.catalog})
        if "/appCatalogs/teamsApps" in url and request.method == "POST":
            if self.publish_status >= 300:
                return httpx.Response(
                    self.publish_status,
                    json={"error": {"code": "Forbidden", "message": "not allowed"}},
                )
            return httpx.Response(201, json={"id": "catalog-app-1"})
        raise AssertionError(f"unexpected request to {request.method} {url}")

    def posted(self, fragment: str) -> list[httpx.Request]:
        return [
            r for r in self.requests if r.method == "POST" and fragment in str(r.url)
        ]


def _installer(microsoft: _Microsoft) -> TeamsAppInstaller:
    certificate, key = _notification_keypair()
    app = TeamsSharedApp(
        app_id=APP_ID,
        home_tenant_id="cccccccc-3333-3333-3333-333333333333",
        credential=ClientSecret("secret"),
        keyring=NotificationKeyring(
            current=NotificationKey(certificate_id="cert", private_key=key),
            certificate_der_b64=load_certificate_der_b64(certificate),
            retired=(),
        ),
        messaging_public_url="https://switch.example",
        client_state_secret="jwt-secret",
        http=httpx.AsyncClient(transport=httpx.MockTransport(microsoft.handler)),
    )
    package = build_distributed_app_package(
        app_id=APP_ID,
        messaging_public_url="https://switch.example",
        privacy_url="https://switch.example/privacy",
        terms_url="https://switch.example/terms",
    )
    return TeamsAppInstaller(app=app, package=package)


@pytest.fixture(autouse=True)
def _no_propagation_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(teams_install, "_APPROVAL_PROPAGATION_ATTEMPTS", 2)
    monkeypatch.setattr(teams_install, "_APPROVAL_PROPAGATION_DELAY_SECONDS", 0.0)


async def _redeem(microsoft: _Microsoft) -> Any:
    return await _installer(microsoft).redeem(
        code="the-code", redirect_uri="https://switch.example/messaging/teams/cb"
    )


# ── Starting ─────────────────────────────────────────────────────────────────


def test_the_sign_in_asks_for_everything_on_one_consent_screen() -> None:
    url = _installer(_Microsoft()).authorize_url(
        state="the-state", redirect_uri="https://switch.example/cb"
    )
    query = parse_qs(urlsplit(url).query)
    assert urlsplit(url).path == "/organizations/oauth2/v2.0/authorize"
    assert query["client_id"] == [APP_ID]
    assert query["state"] == ["the-state"]
    assert query["prompt"] == ["consent"]
    assert "https://graph.microsoft.com/.default" in query["scope"][0].split()
    assert "openid" in query["scope"][0].split()


# ── Finishing ────────────────────────────────────────────────────────────────


async def test_an_approved_organisation_is_installed_and_given_the_app() -> None:
    microsoft = _Microsoft()

    grant = await _redeem(microsoft)

    assert grant.external_workspace_id == ORG
    assert grant.workspace_name == "Contoso"
    assert grant.bot_token is None
    assert grant.scopes.split() == sorted(REQUIRED_GRAPH_ROLES)
    assert grant.platform_data == {
        "catalog_app_id": "catalog-app-1",
        "manifest_version": "1.0.0",
    }
    [published] = microsoft.posted("/appCatalogs/teamsApps")
    assert published.headers["Authorization"] == "Bearer delegated"
    assert published.headers["Content-Type"] == "application/zip"


async def test_a_person_who_cannot_approve_apps_is_refused() -> None:
    """The id token proves which organisation; only the role proves the
    person may give an app that organisation's data."""
    microsoft = _Microsoft()
    microsoft.id_token = _id_token(wids=["some-other-role"])

    with pytest.raises(MessagingInstallError, match="Global Administrator"):
        await _redeem(microsoft)

    assert microsoft.posted("/appCatalogs") == []


async def test_a_token_that_does_not_say_the_roles_is_the_operators_to_fix() -> None:
    microsoft = _Microsoft()
    microsoft.id_token = _id_token(wids=None)

    with pytest.raises(MessagingInstallError, match="groupMembershipClaims"):
        await _redeem(microsoft)


async def test_an_approval_for_one_person_rather_than_the_organisation_is_refused() -> (
    None
):
    """Approving only for themselves leaves the app's permissions out of the
    organisation's tokens."""
    microsoft = _Microsoft()
    microsoft.roles = ["User.ReadBasic.All"]

    with pytest.raises(MessagingInstallError, match="Consent on behalf"):
        await _redeem(microsoft)


async def test_an_organisation_that_never_approved_is_refused() -> None:
    microsoft = _Microsoft()
    microsoft.org_token_error = {
        "error": "unauthorized_client",
        "error_codes": [700016],
    }

    with pytest.raises(MessagingInstallError, match="not approved for the whole"):
        await _redeem(microsoft)


async def test_a_token_naming_one_organisation_and_issued_by_another_is_refused() -> (
    None
):
    microsoft = _Microsoft()
    microsoft.id_token = _id_token(
        iss="https://login.microsoftonline.com/someone-else/v2.0"
    )

    with pytest.raises(MessagingInstallError, match="could not be verified"):
        await _redeem(microsoft)


async def test_a_personal_account_is_refused() -> None:
    microsoft = _Microsoft()
    personal = "9188040d-6c67-4c5b-b112-36a304b66dad"
    microsoft.id_token = _id_token(
        tid=personal, iss=f"https://login.microsoftonline.com/{personal}/v2.0"
    )

    with pytest.raises(MessagingInstallError, match="personal Microsoft account"):
        await _redeem(microsoft)


async def test_a_government_cloud_organisation_is_refused() -> None:
    microsoft = _Microsoft()
    microsoft.id_token = _id_token(tenant_region_sub_scope="GCC")

    with pytest.raises(MessagingInstallError, match="government cloud"):
        await _redeem(microsoft)


async def test_an_approver_who_is_not_a_teams_admin_still_installs_and_is_told() -> (
    None
):
    """The approval is done; only putting the app in the catalogue failed,
    and the connection says so."""
    microsoft = _Microsoft()
    microsoft.publish_status = 403

    grant = await _redeem(microsoft)

    assert grant.external_workspace_id == ORG
    assert grant.platform_data["catalog_app_id"] is None
    assert "not a Teams administrator" in str(grant.platform_data["publish_problem"])


async def test_an_organisation_that_has_the_app_already_is_not_given_it_twice() -> None:
    microsoft = _Microsoft()
    microsoft.catalog = [{"id": "existing", "appDefinitions": [{"version": "1.0.0"}]}]

    grant = await _redeem(microsoft)

    assert grant.platform_data["catalog_app_id"] == "existing"
    assert microsoft.posted("/appCatalogs") == []


async def test_an_organisation_with_an_older_version_is_given_this_one() -> None:
    microsoft = _Microsoft()
    microsoft.catalog = [{"id": "existing", "appDefinitions": [{"version": "0.9.0"}]}]

    await _redeem(microsoft)

    assert len(microsoft.posted("/appCatalogs/teamsApps/existing/appDefinitions")) == 1


def test_an_install_becomes_a_shared_bridge_for_the_organisation() -> None:
    installer = _installer(_Microsoft())
    config = {"event_delivery": "shared", "tenant_id": ORG}
    assert installer.workspace_of_bridge(config) == ORG
    assert installer.workspace_of_bridge({"tenant_id": ORG}) is None


def test_a_refused_approval_is_explained_plainly() -> None:
    installer = _installer(_Microsoft())
    assert "not approved" in installer.describe_callback_error(
        error="access_denied", description="AADSTS65004: User declined"
    )
    assert "Global Administrator" in installer.describe_callback_error(
        error="consent_required", description="AADSTS90094: admin consent needed"
    )


# ── Webhooks ─────────────────────────────────────────────────────────────────


def test_graphs_url_check_is_echoed() -> None:
    installer = _installer(_Microsoft())
    assert (
        installer.unsigned_handshake(
            endpoint="notifications", query={"validationToken": "abc"}
        )
        == "abc"
    )
    assert installer.unsigned_handshake(endpoint="events", query={}) is None


class _Authenticator:
    def __init__(self, *, refuse: bool = False, vouched: frozenset[str] = frozenset()):
        self.refuse = refuse
        self.vouched = vouched
        self.seen: list[dict[str, Any]] = []

    async def verify(
        self, authorization: str | None, *, service_url: str, channel_id: str
    ) -> None:
        self.seen.append(
            {
                "authorization": authorization,
                "service_url": service_url,
                "channel": channel_id,
            }
        )
        if self.refuse:
            raise PermissionError("forged")

    async def vouched_tenants(self, tokens: list[object]) -> frozenset[str]:
        if self.refuse:
            raise PermissionError("forged")
        return self.vouched


def _activity(**overrides: Any) -> dict[str, Any]:
    return {
        "type": "message",
        "id": "m1",
        "channelId": "msteams",
        "serviceUrl": "https://smba.trafficmanager.net/amer/",
        "conversation": {"id": "19:c@thread.tacv2;messageid=m1", "tenantId": ORG},
        "channelData": {"tenant": {"id": ORG}},
        **overrides,
    }


async def test_an_activity_is_checked_against_its_own_service_url_and_channel() -> None:
    installer = _installer(_Microsoft())
    authenticator = _Authenticator()
    installer._app.bot_authenticator = authenticator  # type: ignore[assignment]

    await installer.verify_webhook(
        endpoint="events",
        headers={"Authorization": "Bearer t"},
        query={},
        body=json.dumps(_activity()).encode(),
    )

    assert authenticator.seen == [
        {
            "authorization": "Bearer t",
            "service_url": "https://smba.trafficmanager.net/amer/",
            "channel": "msteams",
        }
    ]


async def test_a_forged_activity_is_refused() -> None:
    installer = _installer(_Microsoft())
    installer._app.bot_authenticator = _Authenticator(refuse=True)  # type: ignore[assignment]

    with pytest.raises(WebhookAuthenticityError):
        await installer.verify_webhook(
            endpoint="events",
            headers={},
            query={},
            body=json.dumps(_activity()).encode(),
        )


async def test_a_body_that_is_not_json_is_not_genuine() -> None:
    installer = _installer(_Microsoft())
    with pytest.raises(WebhookAuthenticityError):
        await installer.verify_webhook(
            endpoint="events", headers={}, query={}, body=b"not json"
        )


def _notifications(*items: dict[str, Any], tokens: list[str] | None) -> bytes:
    body: dict[str, Any] = {"value": list(items)}
    if tokens is not None:
        body["validationTokens"] = tokens
    return json.dumps(body).encode()


_DATA = {
    "subscriptionId": "s1",
    "tenantId": ORG,
    "resource": "teams('t')/channels('c')/messages('m')",
    "changeType": "created",
    "encryptedContent": {},
    "clientState": "x",
}


async def test_notifications_carrying_data_need_graphs_tokens() -> None:
    installer = _installer(_Microsoft())
    installer._app.notification_authenticator = _Authenticator(vouched=frozenset({ORG}))  # type: ignore[assignment]

    with pytest.raises(WebhookAuthenticityError, match="assignment required"):
        await installer.verify_webhook(
            endpoint="notifications",
            headers={},
            query={},
            body=_notifications(_DATA, tokens=None),
        )


async def test_a_notification_for_an_organisation_the_tokens_do_not_vouch_for_is_refused() -> (
    None
):
    installer = _installer(_Microsoft())
    installer._app.notification_authenticator = _Authenticator(  # type: ignore[assignment]
        vouched=frozenset({"someone-else"})
    )

    with pytest.raises(WebhookAuthenticityError, match="vouch"):
        await installer.verify_webhook(
            endpoint="notifications",
            headers={},
            query={},
            body=_notifications(_DATA, tokens=["t"]),
        )


async def test_vouched_notifications_pass() -> None:
    installer = _installer(_Microsoft())
    installer._app.notification_authenticator = _Authenticator(vouched=frozenset({ORG}))  # type: ignore[assignment]

    await installer.verify_webhook(
        endpoint="notifications",
        headers={},
        query={},
        body=_notifications(_DATA, tokens=["t"]),
    )


async def test_lifecycle_notifications_need_no_tokens() -> None:
    """They carry no data, and the bridge they reach checks its organisation's
    own clientState and that the subscription is its own."""
    installer = _installer(_Microsoft())
    lifecycle = {
        "subscriptionId": "s1",
        "tenantId": ORG,
        "lifecycleEvent": "reauthorizationRequired",
        "clientState": "x",
    }

    await installer.verify_webhook(
        endpoint="notifications",
        headers={},
        query={},
        body=_notifications(lifecycle, tokens=None),
    )


def test_a_message_is_keyed_by_organisation_conversation_and_id() -> None:
    [event] = _installer(_Microsoft()).parse_webhook(
        endpoint="events", headers={}, query={}, body=json.dumps(_activity()).encode()
    )
    assert event.envelope_type == "activity"
    assert event.external_event_id == f"{ORG}|19:c@thread.tacv2;messageid=m1|m1"
    assert not event.answers_inline


def test_a_press_is_answered_inline_and_never_keyed() -> None:
    [event] = _installer(_Microsoft()).parse_webhook(
        endpoint="events",
        headers={},
        query={},
        body=json.dumps(_activity(type="invoke", name="adaptiveCard/action")).encode(),
    )
    assert event.answers_inline
    assert event.external_event_id is None


def test_a_batch_becomes_one_event_per_notification() -> None:
    other = {
        **_DATA,
        "tenantId": "org-2",
        "resource": "teams('t')/channels('c')/messages('n')",
    }
    events = _installer(_Microsoft()).parse_webhook(
        endpoint="notifications",
        headers={},
        query={},
        body=_notifications(_DATA, other, tokens=["t"]),
    )
    assert [e.envelope_type for e in events] == ["notification", "notification"]
    assert events[0].external_event_id == f"{ORG}|{_DATA['resource']}|created"


def test_each_event_names_its_organisation() -> None:
    installer = _installer(_Microsoft())
    assert installer.workspace_of_event(_activity()) == ORG
    assert installer.workspace_of_event(_DATA) == ORG
    with pytest.raises(WebhookPayloadError):
        installer.workspace_of_event(
            _activity(channelData={"tenant": {"id": "a-different-org"}})
        )


def test_microsoft_announces_no_organisation_wide_uninstall() -> None:
    assert _installer(_Microsoft()).revocation_of_event(_activity()) is None
