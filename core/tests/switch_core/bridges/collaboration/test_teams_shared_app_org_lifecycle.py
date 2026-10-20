"""Leaving an organisation that is no longer installed, and shutting the app down.

`TeamsSharedApp.withdraw_from_org` is called for an organisation whose bridge
is not running to undo it itself: delete every subscription this app's
notification URL owns there, and leave every team Switch was added to.
Neither half blocks the other — each is best effort — and the organisation's
token provider is forgotten whatever either found.
"""

from __future__ import annotations

import datetime
import functools
import logging

import httpx
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from switch_core.bridges.collaboration.teams.auth import ClientSecret
from switch_core.bridges.collaboration.teams.crypto import load_certificate_der_b64
from switch_core.bridges.collaboration.teams.identity import (
    NotificationKey,
    NotificationKeyring,
)
from switch_core.bridges.collaboration.teams.shared_app import TeamsSharedApp

ORG = "aaaaaaaa-0000-0000-0000-000000000001"


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


def _app(handler: httpx.MockTransport | None = None) -> TeamsSharedApp:
    certificate, key = _keypair()
    http = (
        httpx.AsyncClient(transport=handler)
        if handler is not None
        else httpx.AsyncClient()
    )
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
        http=http,
    )


def _token_response(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})


async def test_withdrawing_forgets_the_org_even_when_listing_subscriptions_fails(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth2/v2.0/token" in str(request.url):
            return _token_response(request)
        if request.url.path == "/v1.0/subscriptions":
            return httpx.Response(500, json={"error": {"message": "down"}})
        if request.url.path == "/v1.0/teams":
            return httpx.Response(200, json={"value": []})
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    app = _app(httpx.MockTransport(handler))
    app.org_tokens(ORG)  # the provider that should be forgotten

    with caplog.at_level(logging.ERROR):
        await app.withdraw_from_org(ORG)

    assert ORG not in app._org_tokens
    messages = [r.message for r in caplog.records if r.levelno >= logging.ERROR]
    assert any("subscriptions" in m and ORG in m for m in messages)


async def test_withdrawing_forgets_the_org_even_when_uninstalling_fails(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth2/v2.0/token" in str(request.url):
            return _token_response(request)
        if request.url.path == "/v1.0/subscriptions":
            return httpx.Response(200, json={"value": []})
        if request.url.path == "/v1.0/teams":
            return httpx.Response(200, json={"value": [{"id": "team-1"}]})
        if request.url.path == "/v1.0/teams/team-1/installedApps":
            return httpx.Response(
                200,
                json={
                    "value": [
                        {"id": "install-1", "teamsApp": {"id": "catalog-1"}},
                    ]
                },
            )
        if request.url.path == "/v1.0/teams/team-1/installedApps/install-1":
            return httpx.Response(500, json={"error": {"message": "refused"}})
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    app = _app(httpx.MockTransport(handler))
    app.org_tokens(ORG)

    with caplog.at_level(logging.ERROR):
        await app.withdraw_from_org(ORG)

    assert ORG not in app._org_tokens
    messages = [r.message for r in caplog.records if r.levelno >= logging.ERROR]
    assert any("the app in team team-1" in m and ORG in m for m in messages)


async def test_withdrawing_cleanly_leaves_nothing_behind_to_log(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth2/v2.0/token" in str(request.url):
            return _token_response(request)
        if request.url.path == "/v1.0/subscriptions":
            return httpx.Response(200, json={"value": []})
        if request.url.path == "/v1.0/teams":
            return httpx.Response(200, json={"value": []})
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    app = _app(httpx.MockTransport(handler))
    app.org_tokens(ORG)

    with caplog.at_level(logging.ERROR):
        await app.withdraw_from_org(ORG)

    assert ORG not in app._org_tokens
    assert not [r for r in caplog.records if r.levelno >= logging.ERROR]


async def test_aclose_closes_the_one_shared_client() -> None:
    app = _app()

    await app.aclose()

    with pytest.raises(RuntimeError):
        await app.http.get("https://graph.microsoft.com/v1.0/subscriptions")


async def test_one_team_that_cannot_be_read_does_not_keep_the_app_in_the_rest(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An archived or restricted team early in the listing used to end the
    loop, leaving the app in every team listed after it."""
    removed: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth2/v2.0/token" in str(request.url):
            return _token_response(request)
        if request.url.path == "/v1.0/subscriptions":
            return httpx.Response(200, json={"value": []})
        if request.url.path == "/v1.0/teams":
            return httpx.Response(
                200, json={"value": [{"id": "archived"}, {"id": "team-2"}]}
            )
        if request.url.path == "/v1.0/teams/archived/installedApps":
            return httpx.Response(403, json={"error": {"message": "archived"}})
        if request.url.path == "/v1.0/teams/team-2/installedApps":
            return httpx.Response(
                200, json={"value": [{"id": "install-2", "teamsApp": {"id": "c"}}]}
            )
        if request.url.path == "/v1.0/teams/team-2/installedApps/install-2":
            removed.append("team-2")
            return httpx.Response(204)
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    app = _app(httpx.MockTransport(handler))

    with caplog.at_level(logging.ERROR):
        await app.withdraw_from_org(ORG)

    assert removed == ["team-2"]
    messages = [r.message for r in caplog.records if r.levelno >= logging.ERROR]
    assert any("the app in team archived" in m for m in messages)


async def test_an_organisation_whose_teams_cannot_be_listed_is_still_forgotten(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth2/v2.0/token" in str(request.url):
            return _token_response(request)
        if request.url.path == "/v1.0/subscriptions":
            return httpx.Response(200, json={"value": []})
        if request.url.path == "/v1.0/teams":
            return httpx.Response(403, json={"error": {"message": "no"}})
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    app = _app(httpx.MockTransport(handler))
    app.org_tokens(ORG)

    with caplog.at_level(logging.ERROR):
        await app.withdraw_from_org(ORG)

    assert ORG not in app._org_tokens
    assert "listing the organisation's teams failed" in caplog.text


async def test_a_team_listed_without_an_id_is_skipped() -> None:
    asked: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth2/v2.0/token" in str(request.url):
            return _token_response(request)
        if request.url.path == "/v1.0/subscriptions":
            return httpx.Response(200, json={"value": []})
        if request.url.path == "/v1.0/teams":
            return httpx.Response(200, json={"value": [{"displayName": "?"}]})
        asked.append(request.url.path)
        return httpx.Response(200, json={"value": []})

    await _app(httpx.MockTransport(handler)).withdraw_from_org(ORG)

    assert asked == []
