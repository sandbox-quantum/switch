"""An admin's own WorkOS access token for a linked organization.

The members service takes changes to a linked organization's members only
from the admin as WorkOS knows them, with an AuthKit access token issued for
that organization (`members_service.py`). Switch's own sign-in proves who the
admin is but holds no such token, and Switch keeps no long-lived WorkOS
credential of anyone's. So when an admin changes the members, Switch sends
them through the AuthKit application's sign-in for the organization (silent
while their AuthKit session lasts), exchanges the code for an access token,
and keeps only that token, encrypted, in the short-lived sign-in cookie, for
as long as it lasts (`gateway/workos_sign_in_routes.py`). The refresh token
that comes with it is dropped.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import httpx
import jwt

from switch_core.organization_directory import DirectoryUnavailable

WORKOS_SIGN_IN_TIMEOUT_SECONDS = 10.0


class SignInRefused(Exception):
    """WorkOS refused the code: the sign-in has to start again."""


@dataclass(frozen=True)
class OrganizationToken:
    """An access token WorkOS issued `subject` for `workos_organization_id`,
    good until `expires_at` (Unix seconds)."""

    subject: str
    workos_organization_id: str
    access_token: str
    expires_at: int

    def lasts_beyond(self, seconds: int) -> bool:
        return self.expires_at > time.time() + seconds


class WorkOSOrganizationSignIn:
    def __init__(
        self,
        http: httpx.AsyncClient,
        api_key: str,
        api_url: str,
        client_id: str,
        redirect_url: str,
    ) -> None:
        self._http = http
        self._api_key = api_key
        self._api_url = api_url.rstrip("/")
        self._client_id = client_id
        self._redirect_url = redirect_url

    def authorize_url(
        self, workos_organization_id: str, state: str, challenge: str
    ) -> str:
        """Where the browser goes to sign in to `workos_organization_id`."""
        query = urlencode(
            {
                "client_id": self._client_id,
                "redirect_uri": self._redirect_url,
                "response_type": "code",
                "provider": "authkit",
                "organization_id": workos_organization_id,
                "state": state,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
            }
        )
        return f"{self._api_url}/user_management/authorize?{query}"

    async def authenticate(self, code: str, verifier: str) -> OrganizationToken:
        """The token the sign-in's `code` is good for. Raises `SignInRefused`
        when WorkOS refuses the code, `DirectoryUnavailable` when it can't be
        reached or answers with something else."""
        try:
            response = await self._http.post(
                f"{self._api_url}/user_management/authenticate",
                json={
                    "client_id": self._client_id,
                    "client_secret": self._api_key,
                    "grant_type": "authorization_code",
                    "code": code,
                    "code_verifier": verifier,
                },
                timeout=WORKOS_SIGN_IN_TIMEOUT_SECONDS,
            )
        except httpx.HTTPError as error:
            raise DirectoryUnavailable(
                f"WorkOS could not be reached ({type(error).__name__})."
            ) from error
        if response.status_code in (400, 401, 403):
            raise SignInRefused(f"WorkOS refused the sign-in ({response.status_code}).")
        if response.status_code != 200:
            raise DirectoryUnavailable(
                f"WorkOS answered the sign-in with {response.status_code}."
            )
        try:
            body: Any = response.json()
        except ValueError as error:
            raise DirectoryUnavailable(
                "WorkOS answered the sign-in with no JSON."
            ) from error
        return _token_from(body)


def _token_from(body: Any) -> OrganizationToken:
    unreadable = DirectoryUnavailable(
        "WorkOS answered the sign-in with something Switch can't read."
    )
    if not isinstance(body, dict):
        raise unreadable
    user = body.get("user")
    organization_id = body.get("organization_id")
    access_token = body.get("access_token")
    if (
        not isinstance(user, dict)
        or not isinstance(user.get("id"), str)
        or not isinstance(organization_id, str)
        or not isinstance(access_token, str)
    ):
        raise unreadable
    # Read for its expiry only: it came from WorkOS over TLS, in answer to a
    # request authenticated with the API key, and the members service
    # verifies it.
    try:
        claims = jwt.decode(access_token, options={"verify_signature": False})
    except jwt.PyJWTError as error:
        raise unreadable from error
    expires_at = claims.get("exp")
    if not isinstance(expires_at, int):
        raise unreadable
    return OrganizationToken(
        subject=user["id"],
        workos_organization_id=organization_id,
        access_token=access_token,
        expires_at=expires_at,
    )
