"""The service a shared WorkOS environment's members are changed through.

When several products share one WorkOS environment, one service owns each
customer's account there and every product changes its members through it,
so each product's rules (nobody grants above their own role, the last
`org_admin` stays) apply in one place. Switch calls it with the admin's own
WorkOS access token for the organization, renewed from their sign-in for the
change (`gateway/admin_tokens.py`), never a credential of its own: the
service sees who acted and decides by their live role there, as it does for
its own product.

The calls, each acting on the organization the token was issued for and on
a membership by its WorkOS id (`workos_directory.py` reads it with the API
key, before any lock is taken):

- `PATCH {url}/v1/auth/tenants/members/{id}` with `{"role": <slug>}`;
- `DELETE {url}/v1/auth/tenants/members/{id}`.

And one acting on no organization yet: `POST {url}/v1/auth/tenants` with
`{"name": <name>}` creates the customer's account, a WorkOS organization with
the caller its `org_admin` and one workspace recorded on it, and answers
`{"org_id": <id>}`. Each person creates one: asked again, it answers with the
one they made before, whatever its name.

A refusal comes back as `{"error": <reason>}`.
"""

from __future__ import annotations

import logging
import time

import httpx
import jwt

from switch_core.organization_directory import (
    DirectoryRefusal,
    DirectorySignInRequired,
    DirectoryUnavailable,
)
from switch_core.outbound import OutboundHostUnresolved, OutboundURLRefused

logger = logging.getLogger(__name__)

# Bounds every call: a route holds locks while it waits.
MEMBERS_SERVICE_TIMEOUT_SECONDS = 10.0
# Creating an account sets up the customer's cloud resources before it
# answers, which the service itself allows a minute for; the route holds no
# lock or connection meanwhile (`workspace_creation.create_organization_for`).
TENANT_CREATION_TIMEOUT_SECONDS = 90.0

SIGN_IN_AGAIN = (
    "Your access to your organization's account ran out. Sign in again to "
    "change the organization's members."
)

# The service checks a token without asking WorkOS, so a 401 for one that has
# not run out is the service not accepting Switch's AuthKit application at
# all: signing in again would get the same answer.
NOT_ACCEPTED = (
    "Your organization's account service doesn't accept member changes from "
    "Switch yet. Make the change in the organization's account settings."
)


class MembersService:
    def __init__(self, http: httpx.AsyncClient, url: str) -> None:
        self._http = http
        self._url = url.rstrip("/")

    async def set_role(self, access_token: str, membership_id: str, role: str) -> None:
        await self._call(
            "PATCH",
            f"/v1/auth/tenants/members/{membership_id}",
            access_token,
            json={"role": role},
        )

    async def remove(self, access_token: str, membership_id: str) -> None:
        await self._call(
            "DELETE", f"/v1/auth/tenants/members/{membership_id}", access_token
        )

    async def create_tenant(self, access_token: str, name: str) -> str:
        """Create the caller's account named `name`, or find the one they
        created before, and answer its WorkOS organization's id."""
        response = await self._call(
            "POST",
            "/v1/auth/tenants",
            access_token,
            json={"name": name},
            timeout=TENANT_CREATION_TIMEOUT_SECONDS,
        )
        try:
            body = response.json()
        except ValueError:
            body = None
        organization_id = body.get("org_id") if isinstance(body, dict) else None
        if not isinstance(organization_id, str) or not organization_id:
            raise DirectoryUnavailable(
                "The members service created the organization but didn't say "
                "which it is."
            )
        return organization_id

    async def _call(
        self,
        method: str,
        path: str,
        access_token: str,
        *,
        json: dict[str, str] | None = None,
        timeout: float = MEMBERS_SERVICE_TIMEOUT_SECONDS,
    ) -> httpx.Response:
        try:
            response = await self._http.request(
                method,
                f"{self._url}{path}",
                json=json,
                headers={"Authorization": f"Bearer {access_token}"},
                timeout=timeout,
            )
        except httpx.HTTPError as error:
            raise DirectoryUnavailable(
                f"The members service could not be reached ({type(error).__name__})."
            ) from error
        except OutboundHostUnresolved as error:
            logger.error("The members service's host does not resolve: %s", error)
            raise DirectoryUnavailable(
                "The members service could not be reached (its host does not resolve)."
            ) from error
        except OutboundURLRefused as error:
            logger.error("The members service is refused as a destination: %s", error)
            raise DirectoryUnavailable(
                "The members service could not be reached (its address is refused)."
            ) from error
        if response.status_code == 401:
            if _ran_out(access_token):
                raise DirectorySignInRequired(SIGN_IN_AGAIN)
            logger.error(
                "The members service refused Switch's WorkOS token (401) on %s %s; "
                "it is not set up to accept WORKOS_CLIENT_ID's tokens",
                method,
                path,
            )
            raise DirectoryUnavailable(NOT_ACCEPTED)
        if response.status_code in (400, 403, 404, 409, 422):
            raise DirectoryRefusal(_reason(response))
        if response.status_code >= 300:
            raise DirectoryUnavailable(
                f"The members service answered {response.status_code}."
            )
        return response


def _ran_out(access_token: str) -> bool:
    """Whether the token's own expiry has passed. Read unverified, for which
    answer to give only: the token is the one WorkOS gave the admin
    (`gateway/admin_tokens.py`), and the service is what verifies it."""
    try:
        expires_at = jwt.decode(access_token, options={"verify_signature": False})[
            "exp"
        ]
    except (jwt.PyJWTError, KeyError):
        return False
    return isinstance(expires_at, int) and expires_at <= time.time()


def _reason(response: httpx.Response) -> str:
    """The service's own words for a refusal, or its status when it gave none."""
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict) and isinstance(body.get("error"), str):
        return f"Your organization's account settings refused: {body['error']}."
    return f"Your organization's account settings refused ({response.status_code})."
