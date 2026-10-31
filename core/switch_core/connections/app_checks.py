"""Asking a connector's vendor whether an app's values belong together.

Nothing is signed in and nothing is stored: each check sends the vendor a
request it must refuse, and reads which refusal it chose.

- **GitHub App**: `GET /app` with a JWT the private key signs, issued by the
  client id, proves the key and the client id are one App's, and answers its
  slug; a code exchange with a made-up code then tells a wrong client secret
  (`incorrect_client_credentials`) from a right one (`bad_verification_code`).
- **OAuth client**: a code exchange at the token endpoint with a made-up
  code and PKCE verifier, the secret sent as a sign-in sends it, to a
  redirect URI the client registers: Core's own callback, or Switch
  Console's first loopback one for a client that has no other. `invalid_grant` means the client id and
  secret are right; `invalid_client` that they are not; and
  `redirect_uri_mismatch`, from a vendor that compares it first, that the
  redirect URI is not registered. What the vendor does not show this way
  (Google and Airtable compare the redirect URI only with a real code, and
  Airtable says nothing of whether the integration is published) is the
  entry's `unchecked`, said with the result.

What a check cannot prove (an App's permissions, a Google app's user type,
which APIs are switched on) is left to the vendor's own pages.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

import httpx

from switch_core.connections.adapters import ServiceAdapterError
from switch_core.connections.adapters.oauth import (
    OAuthAdapter,
    OAuthClientCredentials,
    StaticClient,
    client_fields,
)
from switch_core.connections.app_credentials import AppSpec, AppValues
from switch_core.connections.loader import ConnectionDefinition
from switch_core.providers.github_installation import GitHubInstallationCredentials

GITHUB_APP_URL = "https://api.github.com/app"
GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
# Never a real code: the vendor is asked to refuse it.
PLACEHOLDER_CODE = "switch-connector-app-check"
# Airtable asks for a verifier before it looks at the client.
PLACEHOLDER_VERIFIER = "switch-connector-app-check-" + "0" * 32

Field = Literal["client_id", "client_secret", "private_key"]


class VendorUnreachableError(Exception):
    """The vendor could not be asked; the message is for the operator."""


@dataclass(frozen=True)
class Check:
    name: str
    ok: bool
    message: str
    # The value the operator should look at again when the check fails.
    field: Field | None
    # What the check could not see, for the operator to confirm themselves.
    note: str | None


@dataclass(frozen=True)
class CheckResult:
    checks: list[Check]
    # What the vendor said about the app that Switch keeps: a GitHub App's slug.
    settings: dict[str, str]

    @property
    def ok(self) -> bool:
        return all(check.ok for check in self.checks)

    def first_failure(self) -> Check | None:
        return next((check for check in self.checks if not check.ok), None)


async def _send(
    http: httpx.AsyncClient, vendor: str, request: httpx.Request
) -> httpx.Response:
    try:
        response = await http.send(request, follow_redirects=False)
    except httpx.HTTPError:
        raise VendorUnreachableError(f"Couldn't reach {vendor}. Try again.") from None
    if response.status_code == 429 or response.status_code >= 500:
        raise VendorUnreachableError(
            f"{vendor} is unavailable (HTTP {response.status_code}). Try again."
        )
    return response


def _body(response: httpx.Response) -> dict[str, Any]:
    try:
        body = response.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


async def check_github_app(http: httpx.AsyncClient, values: AppValues) -> CheckResult:
    try:
        signer = GitHubInstallationCredentials(
            values.client_id, values.secrets["private_key"].encode()
        )
    except ValueError as unusable:
        return CheckResult(
            [Check("private_key", False, str(unusable), "private_key", None)],
            settings={},
        )
    assertion = signer.assertion()
    app = await _send(
        http,
        "GitHub",
        http.build_request(
            "GET",
            GITHUB_APP_URL,
            headers={
                "Authorization": f"Bearer {assertion}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        ),
    )
    answer = _body(app)
    slug = answer.get("slug")
    if app.status_code != 200 or not isinstance(slug, str) or not slug:
        return CheckResult(
            [
                Check(
                    "private_key",
                    False,
                    "GitHub doesn't accept this private key for this client ID. "
                    "Copy the Client ID again, or generate a private key in the "
                    "App's settings.",
                    "private_key",
                    None,
                )
            ],
            settings={},
        )
    if answer.get("client_id") != values.client_id:
        return CheckResult(
            [
                Check(
                    "private_key",
                    False,
                    "This private key belongs to a GitHub App with another client "
                    "ID. Copy the Client ID from that App's settings.",
                    "client_id",
                    None,
                )
            ],
            settings={},
        )
    checks = [
        Check(
            "private_key",
            True,
            f"GitHub accepts this private key for the App {slug}.",
            None,
            None,
        )
    ]
    exchanged = await _send(
        http,
        "GitHub",
        http.build_request(
            "POST",
            GITHUB_TOKEN_URL,
            data={
                "client_id": values.client_id,
                "client_secret": values.secrets["client_secret"],
                "code": PLACEHOLDER_CODE,
            },
            headers={"Accept": "application/json"},
        ),
    )
    error = _body(exchanged).get("error")
    if error == "bad_verification_code":
        checks.append(
            Check(
                "client_secret", True, "GitHub accepts this client secret.", None, None
            )
        )
    elif error == "incorrect_client_credentials":
        checks.append(
            Check(
                "client_secret",
                False,
                "GitHub doesn't accept this client secret for this client ID. "
                "Generate a new one in the App's settings.",
                "client_secret",
                None,
            )
        )
    else:
        checks.append(
            Check(
                "client_secret",
                False,
                "GitHub gave an answer Switch doesn't recognise when checking the "
                f"client secret ({error or f'HTTP {exchanged.status_code}'}).",
                "client_secret",
                None,
            )
        )
    return CheckResult(checks, settings={"slug": slug})


async def check_oauth_client(
    http: httpx.AsyncClient,
    definition: ConnectionDefinition,
    values: AppValues,
    redirect_uri: str,
) -> CheckResult:
    name = definition.name
    if definition.slug == "snowflake":
        oauth = definition.auth.oauth
        assert oauth is not None
        return CheckResult(
            [
                Check(
                    "client",
                    True,
                    "Snowflake's client will be verified when someone connects an "
                    "account-specific MCP endpoint.",
                    "client_id",
                    oauth.unchecked,
                )
            ],
            settings={},
        )
    client = OAuthClientCredentials(
        values.client_id, values.secrets["client_secret"], authentication=None
    )
    try:
        endpoints = await OAuthAdapter(
            definition, StaticClient(client), http
        ).endpoints()
    except ServiceAdapterError as refused:
        raise VendorUnreachableError(str(refused)) from None
    identifying, headers = client_fields(endpoints, client)
    response = await _send(
        http,
        name,
        http.build_request(
            "POST",
            endpoints.token,
            data={
                "grant_type": "authorization_code",
                "code": PLACEHOLDER_CODE,
                "code_verifier": PLACEHOLDER_VERIFIER,
                "redirect_uri": redirect_uri,
                **identifying,
            },
            headers={"Accept": "application/json", **headers},
        ),
    )
    error = _body(response).get("error")
    if error == "invalid_grant":
        oauth = definition.auth.oauth
        assert oauth is not None
        return CheckResult(
            [
                Check(
                    "client",
                    True,
                    f"{name} accepts this client ID and secret.",
                    None,
                    oauth.unchecked,
                )
            ],
            settings={},
        )
    if error == "redirect_uri_mismatch":
        return CheckResult(
            [
                Check(
                    "client",
                    False,
                    f"{name} doesn't have Switch's redirect URI for this client. "
                    f"Add {redirect_uri} to its authorized redirect URIs.",
                    None,
                    None,
                )
            ],
            settings={},
        )
    if error in ("invalid_client", "unauthorized_client"):
        return CheckResult(
            [
                Check(
                    "client",
                    False,
                    f"{name} doesn't recognise this client ID and secret together. "
                    "Copy both again from where you created the client.",
                    "client_secret",
                    None,
                )
            ],
            settings={},
        )
    return CheckResult(
        [
            Check(
                "client",
                False,
                f"{name} gave an answer Switch doesn't recognise "
                f"({error or f'HTTP {response.status_code}'}).",
                None,
                None,
            )
        ],
        settings={},
    )


async def check_app(
    http: httpx.AsyncClient,
    spec: AppSpec,
    definition: ConnectionDefinition,
    values: AppValues,
    redirect_uri: str,
) -> CheckResult:
    """Ask the vendor about `values`. Raises `VendorUnreachableError`."""
    if spec.kind == "github_app":
        return await check_github_app(http, values)
    return await check_oauth_client(http, definition, values, redirect_uri)
