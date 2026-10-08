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
    InstallGrant,
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
from switch_core.bridges.collaboration.teams.install import (
    TeamsAppInstaller,
    _graph_refusal,
)
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
        app_name="Agent Switch",
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
        "publish_problem": None,
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


async def test_an_organisation_token_refused_for_an_unrelated_reason_is_not_swallowed() -> (
    None
):
    """Only "not approved" is treated as something approving again might fix;
    anything else Microsoft's identity platform says about the request is a
    Switch-side problem worth its own message, not a silent retry."""
    microsoft = _Microsoft()
    microsoft.org_token_error = {"error": "invalid_client", "error_codes": [7000215]}

    with pytest.raises(MessagingInstallError, match="would not issue Switch a token"):
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
    assert "catalog_app_id" not in grant.platform_data
    assert "not a Teams administrator" in str(grant.platform_data["publish_problem"])


async def test_an_update_that_fails_keeps_the_catalogue_id_it_found() -> None:
    """An organisation that already has the app keeps an id that works, even
    when giving it the newer version is refused."""
    microsoft = _Microsoft()
    microsoft.catalog = [{"id": "existing", "appDefinitions": [{"version": "0.9.0"}]}]

    def refuse_update(request: httpx.Request) -> httpx.Response:
        if "/appDefinitions" in str(request.url):
            return httpx.Response(403, json={"error": {"message": "not allowed"}})
        return microsoft.handler(request)

    installer = _installer(microsoft)
    installer._app._http = httpx.AsyncClient(
        transport=httpx.MockTransport(refuse_update)
    )

    grant = await installer.redeem(code="c", redirect_uri="https://switch.example/cb")

    assert grant.platform_data["catalog_app_id"] == "existing"
    assert grant.platform_data["publish_problem"]


async def test_microsoft_unreachable_is_explained_not_a_server_error() -> None:
    def unreachable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    installer = _installer(_Microsoft())
    installer._app._http = httpx.AsyncClient(transport=httpx.MockTransport(unreachable))

    with pytest.raises(MessagingInstallError, match="could not reach Microsoft"):
        await installer.redeem(code="c", redirect_uri="https://switch.example/cb")


async def test_an_organisation_that_has_the_app_already_is_not_given_it_twice() -> None:
    microsoft = _Microsoft()
    microsoft.catalog = [{"id": "existing", "appDefinitions": [{"version": "1.0.0"}]}]

    grant = await _redeem(microsoft)

    assert grant.platform_data["catalog_app_id"] == "existing"
    assert microsoft.posted("/appCatalogs") == []


async def test_a_hand_uploaded_package_under_switchs_id_is_not_adopted() -> None:
    """Seen in a real organisation: a package uploaded by hand from the
    bring-your-own template, under the same id and version, which asks for
    per-team permissions. Graph refuses to let Switch add such an app to a
    team, so adopting it only moves the failure to the Teams panel."""
    microsoft = _Microsoft()
    microsoft.catalog = [
        {
            "id": "hand-uploaded",
            "appDefinitions": [
                {
                    "version": "1.0.0",
                    "authorization": {
                        "requiredPermissionSet": {
                            "resourceSpecificPermissions": [
                                {
                                    "permissionValue": "ChannelMessage.Read.Group",
                                    "permissionType": "application",
                                }
                            ]
                        }
                    },
                }
            ],
        }
    ]

    grant = await _redeem(microsoft)

    assert "catalog_app_id" not in grant.platform_data
    assert "per-team permissions" in str(grant.platform_data["publish_problem"])
    assert microsoft.posted("/appCatalogs") == []


async def test_an_older_hand_uploaded_package_is_replaced_by_this_one() -> None:
    microsoft = _Microsoft()
    microsoft.catalog = [
        {
            "id": "hand-uploaded",
            "appDefinitions": [
                {
                    "version": "0.9.0",
                    "authorization": {
                        "requiredPermissionSet": {
                            "resourceSpecificPermissions": [
                                {"permissionValue": "ChannelMessage.Read.Group"}
                            ]
                        }
                    },
                }
            ],
        }
    ]

    grant = await _redeem(microsoft)

    assert grant.platform_data["catalog_app_id"] == "hand-uploaded"
    assert (
        len(microsoft.posted("/appCatalogs/teamsApps/hand-uploaded/appDefinitions"))
        == 1
    )


async def test_the_catalogue_is_asked_for_each_versions_permissions() -> None:
    microsoft = _Microsoft()

    await _redeem(microsoft)

    [lookup] = [
        r
        for r in microsoft.requests
        if r.method == "GET" and "/appCatalogs/teamsApps" in str(r.url)
    ]
    assert "authorization" in lookup.url.params["$expand"]


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


async def _parsed(installer: TeamsAppInstaller, body: bytes) -> list[Any]:
    await installer.verify_webhook(
        endpoint="notifications", headers={}, query={}, body=body
    )
    return installer.parse_webhook(
        endpoint="notifications", headers={}, query={}, body=body
    )


async def test_a_notification_no_token_vouches_for_is_dropped() -> None:
    """Microsoft sends no token for an organisation that set "assignment
    required"; its notifications cannot be trusted and are not delivered."""
    installer = _installer(_Microsoft())
    installer._app.notification_authenticator = _Authenticator(vouched=frozenset())  # type: ignore[assignment]

    assert await _parsed(installer, _notifications(_DATA, tokens=None)) == []


async def test_one_organisations_missing_token_does_not_cost_another_its_messages() -> (
    None
):
    installer = _installer(_Microsoft())
    installer._app.notification_authenticator = _Authenticator(  # type: ignore[assignment]
        vouched=frozenset({ORG})
    )
    other = {**_DATA, "tenantId": "org-without-a-token"}

    events = await _parsed(installer, _notifications(_DATA, other, tokens=["t"]))

    assert [e.payload["tenantId"] for e in events] == [ORG]


async def test_a_resent_batch_checked_while_the_first_is_parsed_is_kept() -> None:
    """Graph resends a batch it thinks went unanswered; both copies are the
    same bytes, carrying the same tokens."""
    installer = _installer(_Microsoft())
    installer._app.notification_authenticator = _Authenticator(  # type: ignore[assignment]
        vouched=frozenset({ORG})
    )
    body = _notifications(_DATA, tokens=["t"])

    for _ in range(2):
        await installer.verify_webhook(
            endpoint="notifications", headers={}, query={}, body=body
        )
    first = installer.parse_webhook(
        endpoint="notifications", headers={}, query={}, body=body
    )
    second = installer.parse_webhook(
        endpoint="notifications", headers={}, query={}, body=body
    )

    assert [e.payload["tenantId"] for e in first] == [ORG]
    assert [e.payload["tenantId"] for e in second] == [ORG]


async def test_a_forged_token_refuses_the_whole_batch() -> None:
    installer = _installer(_Microsoft())
    installer._app.notification_authenticator = _Authenticator(refuse=True)  # type: ignore[assignment]

    with pytest.raises(WebhookAuthenticityError):
        await installer.verify_webhook(
            endpoint="notifications",
            headers={},
            query={},
            body=_notifications(_DATA, tokens=["forged"]),
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


async def test_a_batch_becomes_one_event_per_notification() -> None:
    other = {
        **_DATA,
        "tenantId": "org-2",
        "resource": "teams('t')/channels('c')/messages('n')",
    }
    installer = _installer(_Microsoft())
    installer._app.notification_authenticator = _Authenticator(  # type: ignore[assignment]
        vouched=frozenset({ORG, "org-2"})
    )
    events = await _parsed(installer, _notifications(_DATA, other, tokens=["t"]))
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


# ── Review gaps ──────────────────────────────────────────────────────────────


def test_the_package_is_offered_for_a_manual_upload() -> None:
    installer = _installer(_Microsoft())
    assert installer.package is installer._package


async def test_a_non_json_sign_in_response_is_explained() -> None:
    microsoft = _Microsoft()

    def not_json(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("/organizations/oauth2/v2.0/token"):
            return httpx.Response(200, content=b"not json")
        return microsoft.handler(request)

    installer = _installer(microsoft)
    installer._app._http = httpx.AsyncClient(transport=httpx.MockTransport(not_json))

    with pytest.raises(MessagingInstallError, match="is not JSON"):
        await installer.redeem(code="c", redirect_uri="https://switch.example/cb")


async def test_a_refused_sign_in_carries_microsofts_own_reason() -> None:
    microsoft = _Microsoft()

    def refused(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("/organizations/oauth2/v2.0/token"):
            return httpx.Response(
                400, json={"error": "invalid_grant", "error_description": "expired"}
            )
        return microsoft.handler(request)

    installer = _installer(microsoft)
    installer._app._http = httpx.AsyncClient(transport=httpx.MockTransport(refused))

    with pytest.raises(MessagingInstallError, match="Microsoft refused the sign-in"):
        await installer.redeem(code="c", redirect_uri="https://switch.example/cb")


async def test_a_sign_in_response_with_no_id_token_is_explained() -> None:
    microsoft = _Microsoft()

    def no_id_token(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("/organizations/oauth2/v2.0/token"):
            return httpx.Response(200, json={"access_token": "delegated"})
        return microsoft.handler(request)

    installer = _installer(microsoft)
    installer._app._http = httpx.AsyncClient(transport=httpx.MockTransport(no_id_token))

    with pytest.raises(MessagingInstallError, match="no id token"):
        await installer.redeem(code="c", redirect_uri="https://switch.example/cb")


async def test_an_organisation_name_that_cannot_be_read_falls_back_to_its_id() -> None:
    microsoft = _Microsoft()

    def organisation_unreadable(request: httpx.Request) -> httpx.Response:
        if "/v1.0/organization" in str(request.url):
            return httpx.Response(500, json={"error": {"message": "down"}})
        return microsoft.handler(request)

    installer = _installer(microsoft)
    installer._app._http = httpx.AsyncClient(
        transport=httpx.MockTransport(organisation_unreadable)
    )

    grant = await installer.redeem(code="c", redirect_uri="https://switch.example/cb")

    assert grant.workspace_name == ORG


def test_connection_config_is_a_shared_bridge_for_the_approved_organisation() -> None:
    installer = _installer(_Microsoft())
    grant = InstallGrant(
        external_workspace_id=ORG,
        workspace_name="Contoso",
        bot_token=None,
        scopes="",
        platform_data={},
    )

    assert installer.connection_config(grant) == {
        "event_delivery": "shared",
        "tenant_id": ORG,
    }


async def test_releasing_an_organisation_leaves_it_through_the_shared_app() -> None:
    installer = _installer(_Microsoft())
    left: list[str] = []

    async def _withdraw(organisation: str) -> None:
        left.append(organisation)

    installer._app.withdraw_from_org = _withdraw  # type: ignore[method-assign]

    await installer.release(external_workspace_id=ORG)

    assert left == [ORG]


async def test_revoke_is_not_supported_for_a_tokenless_install() -> None:
    installer = _installer(_Microsoft())
    with pytest.raises(NotImplementedError, match="no per-install token"):
        await installer.revoke(bot_token="irrelevant")


def test_an_unrecognised_refusal_is_reported_in_microsofts_own_words() -> None:
    installer = _installer(_Microsoft())
    assert (
        installer.describe_callback_error(
            error="server_error", description="something unexpected"
        )
        == "Microsoft reported: something unexpected."
    )


async def test_a_notification_batch_whose_value_is_not_a_list_is_not_genuine() -> None:
    installer = _installer(_Microsoft())
    with pytest.raises(WebhookAuthenticityError, match="not a Graph notification"):
        await installer.verify_webhook(
            endpoint="notifications",
            headers={},
            query={},
            body=json.dumps({"value": "not-a-list"}).encode(),
        )


def test_parsing_a_notification_batch_whose_value_is_not_a_list_is_refused() -> None:
    installer = _installer(_Microsoft())
    with pytest.raises(WebhookPayloadError, match="had no value"):
        installer.parse_webhook(
            endpoint="notifications",
            headers={},
            query={},
            body=json.dumps({"value": "not-a-list"}).encode(),
        )


def test_a_non_object_item_in_a_notification_batch_is_skipped_not_raised() -> None:
    installer = _installer(_Microsoft())
    installer._vouched[teams_install._digest({"value": ["not-a-dict", _DATA]})] = (
        frozenset({ORG})
    )

    events = installer.parse_webhook(
        endpoint="notifications",
        headers={},
        query={},
        body=json.dumps({"value": ["not-a-dict", _DATA]}).encode(),
    )

    assert [e.payload for e in events] == [_DATA]


def test_only_the_most_recently_vouched_batches_are_remembered() -> None:
    installer = _installer(_Microsoft())
    for i in range(300):
        installer._remember_vouched(f"digest-{i}".encode(), frozenset({ORG}))

    assert len(installer._vouched) == 256
    assert b"digest-0" not in installer._vouched
    assert b"digest-299" in installer._vouched


async def test_a_webhook_body_that_is_valid_json_but_not_an_object_is_not_genuine() -> (
    None
):
    installer = _installer(_Microsoft())
    with pytest.raises(WebhookAuthenticityError, match="not a JSON object"):
        await installer.verify_webhook(
            endpoint="events", headers={}, query={}, body=b"[1, 2, 3]"
        )


def test_a_graph_refusal_with_an_unreadable_body_falls_back_to_the_raw_text() -> None:
    request = httpx.Request("POST", "https://graph.microsoft.com/v1.0/x")
    response = httpx.Response(403, content=b"not json", request=request)
    error = httpx.HTTPStatusError("refused", request=request, response=response)

    assert "not a Teams administrator" in _graph_refusal(error)
    assert "not json" in _graph_refusal(error)


def test_a_graph_refusal_that_is_not_a_permission_problem_names_the_status() -> None:
    request = httpx.Request("POST", "https://graph.microsoft.com/v1.0/x")
    response = httpx.Response(
        500, json={"error": {"message": "internal error"}}, request=request
    )
    error = httpx.HTTPStatusError("refused", request=request, response=response)

    assert _graph_refusal(error) == "Microsoft refused (500): internal error"


def test_a_graph_refusal_that_is_not_an_http_status_error_is_reported_as_is() -> None:
    assert _graph_refusal(ValueError("boom")) == "boom"
