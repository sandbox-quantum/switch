"""The service a shared WorkOS environment's members are changed through.

When several products share one WorkOS environment, one service owns each
customer's account there and every product changes its members through it,
so each product's rules (nobody grants above their own role, the last
`org_admin` stays) apply in one place. Switch calls it with the admin's own
WorkOS access token for the organization (`gateway/workos_sign_in.py`), never
a credential of its own: the service sees who acted and decides by their
live role there, as it does for its own product.

The calls, each acting on the organization the token was issued for:

- `GET {url}/v1/auth/tenants/members?limit=&offset=`: its members, a page at
  a time, `{"data": [{"id", "user_id", "role": {"slug"}}], "total"}`;
- `PATCH {url}/v1/auth/tenants/members/{id}` with `{"role": <slug>}`;
- `DELETE {url}/v1/auth/tenants/members/{id}`.

A refusal comes back as `{"error": <reason>}`.
"""

from __future__ import annotations

from typing import Any

import httpx

from switch_core.organization_directory import (
    DirectoryRefusal,
    DirectorySignInRequired,
    DirectoryUnavailable,
)

# Bounds every call: a route holds locks while it waits.
MEMBERS_SERVICE_TIMEOUT_SECONDS = 10.0
# The service's largest page.
_PAGE = 100

SIGN_IN_AGAIN = (
    "Your sign-in to your organization's account has ended. Confirm it again "
    "to change the organization's members."
)


class MembersService:
    def __init__(self, http: httpx.AsyncClient, url: str) -> None:
        self._http = http
        self._url = url.rstrip("/")

    async def membership_of(self, access_token: str, subject: str) -> str | None:
        """The id of WorkOS user `subject`'s membership of the token's
        organization, or None when they have none."""
        offset = 0
        while True:
            body = await self._call(
                "GET",
                "/v1/auth/tenants/members",
                access_token,
                params={"limit": str(_PAGE), "offset": str(offset)},
            )
            page = body.get("data")
            total = body.get("total")
            if not isinstance(page, list) or not isinstance(total, int):
                raise DirectoryUnavailable(
                    "The members service answered with something Switch can't read."
                )
            for membership in page:
                if not isinstance(membership, dict):
                    raise DirectoryUnavailable(
                        "The members service answered with something Switch can't read."
                    )
                if membership.get("user_id") == subject:
                    found = membership.get("id")
                    if not isinstance(found, str):
                        raise DirectoryUnavailable(
                            "The members service answered with a membership "
                            "that has no id."
                        )
                    return found
            offset += len(page)
            if not page or offset >= total:
                return None

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

    async def _call(
        self,
        method: str,
        path: str,
        access_token: str,
        *,
        params: dict[str, str] | None = None,
        json: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        try:
            response = await self._http.request(
                method,
                f"{self._url}{path}",
                params=params,
                json=json,
                headers={"Authorization": f"Bearer {access_token}"},
                timeout=MEMBERS_SERVICE_TIMEOUT_SECONDS,
            )
        except httpx.HTTPError as error:
            raise DirectoryUnavailable(
                f"The members service could not be reached ({type(error).__name__})."
            ) from error
        if response.status_code == 401:
            raise DirectorySignInRequired(SIGN_IN_AGAIN)
        if response.status_code in (400, 403, 404, 409, 422):
            raise DirectoryRefusal(_reason(response))
        if response.status_code >= 300:
            raise DirectoryUnavailable(
                f"The members service answered {response.status_code}."
            )
        if method == "DELETE" or not response.content:
            return {}
        try:
            body = response.json()
        except ValueError as error:
            raise DirectoryUnavailable(
                "The members service answered with no JSON."
            ) from error
        if not isinstance(body, dict):
            raise DirectoryUnavailable(
                "The members service answered with something Switch can't read."
            )
        return body


def _reason(response: httpx.Response) -> str:
    """The service's own words for a refusal, or its status when it gave none."""
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict) and isinstance(body.get("error"), str):
        return f"Your organization's account settings refused: {body['error']}."
    return f"Your organization's account settings refused ({response.status_code})."
