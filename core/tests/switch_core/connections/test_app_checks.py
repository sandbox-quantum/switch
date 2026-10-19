"""Which refusal a vendor chose, read as whether an app's values belong together."""

from __future__ import annotations

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from switch_core.connections.app_checks import (
    VendorUnreachableError,
    check_github_app,
    check_oauth_client,
)
from switch_core.connections.app_credentials import AppValues
from switch_core.connections.loader import CATALOG

REDIRECT = "https://switch.example.test/gateway/service-connections/google-workspace/flows/callback"
GOOGLE = CATALOG["google-workspace"].definition


def _http(status: int, body: object) -> httpx.AsyncClient:
    def handle(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=body)

    return httpx.AsyncClient(transport=httpx.MockTransport(handle))


def _google(secret: str = "example-secret-0000") -> AppValues:
    return AppValues("example-client-id", {}, {"client_secret": secret})


class TestOAuthClient:
    @pytest.mark.parametrize(
        ("status", "error", "ok", "says", "field"),
        [
            (400, "invalid_grant", True, "accepts this client ID and secret", None),
            (401, "invalid_client", False, "doesn't recognise", "client_secret"),
            (400, "unauthorized_client", False, "doesn't recognise", "client_secret"),
            (400, "redirect_uri_mismatch", False, REDIRECT, None),
            (400, "something_new", False, "something_new", None),
        ],
    )
    async def test_reads_googles_refusal(
        self, status: int, error: str, ok: bool, says: str, field: str | None
    ) -> None:
        result = await check_oauth_client(
            _http(status, {"error": error}), GOOGLE, _google(), REDIRECT
        )
        [check] = result.checks
        assert (check.ok, check.field) == (ok, field)
        assert says in check.message

    async def test_unreachable_is_its_own_answer(self) -> None:
        def handle(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("unreachable", request=request)

        with pytest.raises(VendorUnreachableError, match="Couldn't reach"):
            await check_oauth_client(
                httpx.AsyncClient(transport=httpx.MockTransport(handle)),
                GOOGLE,
                _google(),
                REDIRECT,
            )

    async def test_the_secret_is_sent_only_to_the_token_endpoint(self) -> None:
        seen: list[httpx.Request] = []

        def handle(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(400, json={"error": "invalid_grant"})

        await check_oauth_client(
            httpx.AsyncClient(transport=httpx.MockTransport(handle)),
            GOOGLE,
            _google(),
            REDIRECT,
        )
        [request] = seen
        assert str(request.url) == "https://oauth2.googleapis.com/token"


def _github_values(key: rsa.RSAPrivateKey) -> AppValues:
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    return AppValues(
        "example-client-id",
        {},
        {"client_secret": "example-secret-0000", "private_key": pem},
    )


def _github(app: tuple[int, object], exchange: object) -> httpx.AsyncClient:
    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/app":
            return httpx.Response(app[0], json=app[1])
        return httpx.Response(200, json=exchange)

    return httpx.AsyncClient(transport=httpx.MockTransport(handle))


class TestGitHubApp:
    KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    APP = (200, {"slug": "example-app", "client_id": "example-client-id"})

    async def test_a_right_app_answers_its_slug(self) -> None:
        result = await check_github_app(
            _github(self.APP, {"error": "bad_verification_code"}),
            _github_values(self.KEY),
        )
        assert result.ok
        assert result.settings == {"slug": "example-app"}

    async def test_a_wrong_secret(self) -> None:
        result = await check_github_app(
            _github(self.APP, {"error": "incorrect_client_credentials"}),
            _github_values(self.KEY),
        )
        failure = result.first_failure()
        assert failure is not None and failure.field == "client_secret"

    async def test_a_key_github_refuses(self) -> None:
        result = await check_github_app(
            _github((401, {"message": "no"}), {}), _github_values(self.KEY)
        )
        failure = result.first_failure()
        assert failure is not None and failure.field == "private_key"

    async def test_a_key_of_another_app(self) -> None:
        result = await check_github_app(
            _github((200, {"slug": "other", "client_id": "other-client"}), {}),
            _github_values(self.KEY),
        )
        failure = result.first_failure()
        assert failure is not None and failure.field == "client_id"

    async def test_a_key_too_short_is_refused_before_asking(self) -> None:
        short = rsa.generate_private_key(public_exponent=65537, key_size=1024)
        result = await check_github_app(_github(self.APP, {}), _github_values(short))
        failure = result.first_failure()
        assert failure is not None and "2048" in failure.message
