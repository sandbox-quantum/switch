"""Signing people in through WorkOS AuthKit, and their sessions there.

With `GATEWAY_SIGN_IN_PROVIDER=workos` the gateway signs people in through
AuthKit's own hosted sign-in, as an AuthKit application of the WorkOS
environment (`WORKOS_CLIENT_ID`), rather than through a generic OIDC client.
WorkOS then names the person's AuthKit session, which is shared with every
other application in the environment, so the gateway can follow it and end it
(`gateway/identity_sessions.py`).

The gateway keeps no WorkOS token. The code a sign-in brings back is
exchanged here, on the server, with the application's API key; the person,
their organization and the session id are read from the answer, and the
access and refresh tokens are dropped. The access token is decoded only for
its session id: it came from WorkOS over TLS in answer to a request
authenticated with the API key, as `workos_sign_in.py` already trusts.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import httpx
import jwt

from switch_core.outbound import OutboundHostUnresolved, OutboundURLRefused

logger = logging.getLogger(__name__)

AUTHKIT_TIMEOUT_SECONDS = 10.0
_PAGE = 100
# Enough of a refusal to say what it was, not a page of it in the log.
_DETAIL_LIMIT = 500


class AuthKitError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class AuthKitUnavailable(AuthKitError):
    """WorkOS could not be reached, was busy, failed, or answered with
    something unreadable. Worth trying again. `retry_after` is the seconds
    WorkOS asked for, when it asked."""

    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class AuthKitRefused(AuthKitError):
    """WorkOS refused the request (a 4xx). `code` is WorkOS's own error
    code, when it gave one, and `body` what it answered."""

    def __init__(
        self,
        message: str,
        status_code: int,
        code: str | None,
        body: Mapping[str, Any],
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.body = body


@dataclass(frozen=True)
class AuthKitOrganization:
    id: str
    name: str


@dataclass(frozen=True)
class AuthKitSignIn:
    """Who a sign-in signed in, and the AuthKit session it made or joined."""

    user_id: str
    email: str
    email_verified: bool
    name: str | None
    session_id: str
    organization_id: str | None
    # Who is really signing in, when this is a WorkOS dashboard user
    # impersonating the person: their email.
    impersonator: str | None


@dataclass(frozen=True)
class AuthKitUser:
    id: str
    email: str
    email_verified: bool


ChooseOrganization = Callable[[list[AuthKitOrganization]], Awaitable[str | None]]


def _retry_after(response: httpx.Response) -> float | None:
    value = response.headers.get("Retry-After")
    if value is None:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        return None


def _body(response: httpx.Response) -> dict[str, Any]:
    try:
        body = response.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


def _error_code(body: Mapping[str, Any]) -> str | None:
    """WorkOS's code for a refusal: `code` on most, `error` on the OAuth-shaped
    ones (`sso_required`)."""
    for key in ("code", "error"):
        value = body.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _detail(response: httpx.Response) -> str:
    return response.text[:_DETAIL_LIMIT]


class AuthKit:
    def __init__(
        self, http: httpx.AsyncClient, api_key: str, api_url: str, client_id: str
    ) -> None:
        self._http = http
        self._api_key = api_key
        self._api_url = api_url.rstrip("/")
        self.client_id = client_id

    # ── Where the browser goes ───────────────────────────────────────────────

    def authorize_url(
        self,
        *,
        redirect_uri: str,
        state: str,
        challenge: str,
        extra: Mapping[str, str],
    ) -> str:
        """AuthKit's hosted sign-in, coming back to `redirect_uri` with a code
        only the verifier behind `challenge` exchanges. `extra` carries what
        WorkOS sent to the Initiate login URI for the sign-in to continue
        (`invitation_token`, `organization_id`, `login_hint`)."""
        query = {
            **extra,
            "client_id": self.client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "provider": "authkit",
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
        return f"{self._api_url}/user_management/authorize?{urlencode(query)}"

    def logout_url(self, session_id: str, return_to: str) -> str:
        """Where the browser goes to end the AuthKit session, coming back to
        `return_to`, which must be one of the application's sign-out URIs."""
        query = urlencode({"session_id": session_id, "return_to": return_to})
        return f"{self._api_url}/user_management/sessions/logout?{query}"

    # ── Calls ────────────────────────────────────────────────────────────────

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: Mapping[str, Any] | None = None,
        params: Mapping[str, str] | None = None,
        authorized: bool,
    ) -> httpx.Response:
        try:
            return await self._http.request(
                method,
                f"{self._api_url}{path}",
                json=json_body,
                params=params,
                headers=(
                    {"Authorization": f"Bearer {self._api_key}"} if authorized else None
                ),
                timeout=AUTHKIT_TIMEOUT_SECONDS,
            )
        except httpx.HTTPError as error:
            raise AuthKitUnavailable(
                f"WorkOS could not be reached ({type(error).__name__})."
            ) from error
        except OutboundHostUnresolved as error:
            logger.error("WorkOS's host does not resolve: %s", error)
            raise AuthKitUnavailable(
                "WorkOS could not be reached (its host does not resolve)."
            ) from error
        except OutboundURLRefused as error:
            logger.error("WorkOS is refused as a destination: %s", error)
            raise AuthKitUnavailable(
                "WorkOS could not be reached (its address is refused)."
            ) from error

    def _refusal(self, response: httpx.Response, path: str) -> AuthKitError:
        if response.status_code == 429 or response.status_code >= 500:
            return AuthKitUnavailable(
                f"WorkOS answered {response.status_code} for {path}.",
                _retry_after(response),
            )
        body = _body(response)
        return AuthKitRefused(
            f"WorkOS answered {response.status_code} for {path}: {_detail(response)}",
            response.status_code,
            _error_code(body),
            body,
        )

    async def authenticate(
        self,
        *,
        code: str,
        verifier: str,
        ip_address: str | None,
        user_agent: str | None,
        choose_organization: ChooseOrganization,
    ) -> AuthKitSignIn:
        """Exchange a sign-in's code. A person in several organizations may be
        asked which one to sign in to: `choose_organization` picks one of
        those WorkOS lists, or None to refuse. Raises `AuthKitRefused` when
        WorkOS refuses the code (its `code` says why) and `AuthKitUnavailable`
        when it can't be reached or answers with something unreadable."""
        context: dict[str, str] = {}
        if ip_address is not None:
            context["ip_address"] = ip_address
        if user_agent is not None:
            context["user_agent"] = user_agent[:1024]
        body = await self._authenticate(
            {
                "grant_type": "authorization_code",
                "code": code,
                "code_verifier": verifier,
                **context,
            }
        )
        if (
            isinstance(body, AuthKitRefused)
            and body.code == "organization_selection_required"
        ):
            organizations, pending = self._organization_choice(body)
            chosen = await choose_organization(organizations)
            if chosen is None:
                raise AuthKitRefused(
                    "No organization this person is in may sign in here.",
                    body.status_code,
                    "organization_selection_required",
                    {},
                )
            body = await self._authenticate(
                {
                    "grant_type": "urn:workos:oauth:grant-type:organization-selection",
                    "pending_authentication_token": pending,
                    "organization_id": chosen,
                    **context,
                }
            )
        if isinstance(body, AuthKitRefused):
            raise body
        return _sign_in_from(body)

    async def _authenticate(
        self, grant: Mapping[str, str]
    ) -> dict[str, Any] | AuthKitRefused:
        path = "/user_management/authenticate"
        response = await self._request(
            "POST",
            path,
            json_body={
                "client_id": self.client_id,
                "client_secret": self._api_key,
                **grant,
            },
            authorized=False,
        )
        if response.status_code == 200:
            body = _body(response)
            if not body:
                raise AuthKitUnavailable("WorkOS answered the sign-in with no JSON.")
            return body
        refusal = self._refusal(response, path)
        if isinstance(refusal, AuthKitRefused):
            return refusal
        raise refusal

    @staticmethod
    def _organization_choice(
        refusal: AuthKitRefused,
    ) -> tuple[list[AuthKitOrganization], str]:
        body = refusal.body
        pending = body.get("pending_authentication_token")
        listed = body.get("organizations")
        if not isinstance(pending, str) or not pending or not isinstance(listed, list):
            raise AuthKitUnavailable(
                "WorkOS asked for an organization to sign in to without saying "
                "which, or how to continue."
            )
        organizations = [
            AuthKitOrganization(id=item["id"], name=str(item.get("name", "")))
            for item in listed
            if isinstance(item, dict) and isinstance(item.get("id"), str)
        ]
        return organizations, pending

    async def active_session_ids(self, user_id: str) -> set[str]:
        """The ids of the person's AuthKit sessions that are still active,
        across every application of the environment."""
        path = f"/user_management/users/{user_id}/sessions"
        found: set[str] = set()
        after: str | None = None
        while True:
            params = {"limit": str(_PAGE)}
            if after is not None:
                params["after"] = after
            response = await self._request("GET", path, params=params, authorized=True)
            if response.status_code != 200:
                raise self._refusal(response, path)
            body = _body(response)
            data = body.get("data")
            metadata = body.get("list_metadata") or {}
            if not isinstance(data, list) or not isinstance(metadata, dict):
                raise AuthKitUnavailable(f"WorkOS answered {path} with no list.")
            for item in data:
                if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                    raise AuthKitUnavailable(
                        f"WorkOS answered {path} with an unreadable session."
                    )
                if (
                    item.get("status", "active") == "active"
                    and item.get("ended_at") is None
                ):
                    found.add(item["id"])
            after = metadata.get("after")
            if not after:
                return found
            if not isinstance(after, str):
                raise AuthKitUnavailable(
                    f"WorkOS answered {path} with an unreadable cursor."
                )

    async def revoke_session(self, session_id: str) -> None:
        """End an AuthKit session. One WorkOS no longer has counts as ended."""
        path = "/user_management/sessions/revoke"
        response = await self._request(
            "POST", path, json_body={"session_id": session_id}, authorized=True
        )
        if response.status_code in (200, 201, 204, 404):
            return
        raise self._refusal(response, path)

    async def get_user(self, user_id: str) -> AuthKitUser | None:
        """The WorkOS user with this id, or None when this environment has no
        such user (or it is not a WorkOS user id at all)."""
        path = f"/user_management/users/{user_id}"
        response = await self._request("GET", path, authorized=True)
        if response.status_code in (400, 404, 422):
            return None
        if response.status_code != 200:
            raise self._refusal(response, path)
        body = _body(response)
        if not isinstance(body.get("id"), str) or not isinstance(
            body.get("email"), str
        ):
            raise AuthKitUnavailable(f"WorkOS answered {path} with an unreadable user.")
        return AuthKitUser(
            id=body["id"],
            email=body["email"],
            email_verified=body.get("email_verified") is True,
        )


def _sign_in_from(body: Mapping[str, Any]) -> AuthKitSignIn:
    unreadable = AuthKitUnavailable(
        "WorkOS answered the sign-in with something Switch can't read."
    )
    user = body.get("user")
    access_token = body.get("access_token")
    if (
        not isinstance(user, dict)
        or not isinstance(user.get("id"), str)
        or not isinstance(user.get("email"), str)
        or not isinstance(access_token, str)
    ):
        raise unreadable
    try:
        claims = jwt.decode(access_token, options={"verify_signature": False})
    except jwt.PyJWTError as error:
        raise unreadable from error
    session_id = claims.get("sid")
    if not isinstance(session_id, str) or not session_id:
        raise AuthKitUnavailable(
            "WorkOS signed the person in without naming a session. Is "
            "WORKOS_CLIENT_ID an AuthKit application, not a Connect one?"
        )
    names = [user.get("first_name"), user.get("last_name")]
    name = " ".join(part for part in names if isinstance(part, str) and part) or None
    impersonator = body.get("impersonator")
    organization_id = body.get("organization_id")
    return AuthKitSignIn(
        user_id=user["id"],
        email=user["email"],
        email_verified=user.get("email_verified") is True,
        name=name,
        session_id=session_id,
        organization_id=organization_id if isinstance(organization_id, str) else None,
        impersonator=(
            str(impersonator.get("email") or "a WorkOS dashboard user")
            if isinstance(impersonator, dict)
            else None
        ),
    )
