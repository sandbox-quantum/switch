"""Organizations kept in WorkOS (`ORGANIZATION_DIRECTORY=workos`).

The hosted service shares one WorkOS environment with other products. A
customer is one organization there, and a product may give it organizations
of its own beneath that one. A Switch organization follows exactly one WorkOS
organization, the one its `workos_organization_id` names, and an operator
sets that link (`workos_linking.py`); nothing a WorkOS organization says about
itself, its metadata included, links it to Switch, because any product in the
environment may write that. So only memberships of that one organization count
here: an `org_admin` of some other organization of the same customer is
nothing in Switch until they are made one in the linked organization.

WorkOS holds who belongs to a linked organization and who is its `org_admin`;
Switch holds which workspaces, and the roles there. At sign-in the person's
memberships are read from WorkOS (`memberships_at_sign_in`), by their WorkOS
user id, which the sign-in's `sub` is.

Changes made from Switch to a linked organization go through the service that
owns the customer record, not through this module's API key, so each
product's rules apply in one place; until that is wired in, this directory
refuses those that grant (adding someone, making them Org Admin). Those that
take away (a removal, a demotion) change only Switch, so an Org Admin can end
access WorkOS has already ended. An organization nobody has linked is Switch's own, as under the
local directory, and that is what a new organization is until then.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from switch_core.authz import ORGANIZATION_ADMIN_ROLE
from switch_core.db.models import Organization, User
from switch_core.organization_directory import (
    DirectoryMembership,
    DirectoryOrganization,
    DirectoryRefusal,
    DirectoryUnavailable,
)

logger = logging.getLogger(__name__)

# Bounds every call: a sign-in waits on these.
WORKOS_TIMEOUT_SECONDS = 10.0
# WorkOS's largest page.
_PAGE = 100
# The metadata key a customer's organizations carry its id under. Recorded as
# `organizations.customer_id` when an organization is linked, never trusted
# to link one.
CUSTOMER_ID_KEY = "tenant_id"

NOT_FROM_SWITCH_YET = (
    "This organization's members are managed in your organization's account "
    "settings, not here yet."
)


def customer_id_of(organization: dict[str, Any]) -> str | None:
    """The customer a WorkOS organization says it belongs to, or None if it
    names none."""
    metadata = organization.get("metadata")
    value = metadata.get(CUSTOMER_ID_KEY) if isinstance(metadata, dict) else None
    return value if isinstance(value, str) and value else None


def switch_role(workos_role: str) -> str:
    """WorkOS's `org_admin` is Switch's; every other role there is a member
    here, since Switch adds no role of its own to a shared environment."""
    return (
        ORGANIZATION_ADMIN_ROLE if workos_role == ORGANIZATION_ADMIN_ROLE else "member"
    )


def _unreadable(what: str) -> DirectoryUnavailable:
    return DirectoryUnavailable(f"WorkOS answered with {what} Switch cannot read.")


class WorkOSDirectory:
    def __init__(self, http: httpx.AsyncClient, api_key: str, api_url: str) -> None:
        self._http = http
        self._api_key = api_key
        self._api_url = api_url.rstrip("/")

    async def _get(self, path: str, params: dict[str, str]) -> dict[str, Any]:
        try:
            response = await self._http.get(
                f"{self._api_url}{path}",
                params=params,
                headers={"Authorization": f"Bearer {self._api_key}"},
                timeout=WORKOS_TIMEOUT_SECONDS,
            )
        except httpx.HTTPError as error:
            raise DirectoryUnavailable(
                f"WorkOS could not be reached ({type(error).__name__})."
            ) from error
        if response.status_code != 200:
            raise DirectoryUnavailable(
                f"WorkOS answered {response.status_code} for {path}."
            )
        try:
            body = response.json()
        except ValueError as error:
            raise DirectoryUnavailable(
                f"WorkOS answered {path} with no JSON."
            ) from error
        if not isinstance(body, dict):
            raise DirectoryUnavailable(f"WorkOS answered {path} with no object.")
        return body

    async def _list(self, path: str, params: dict[str, str]) -> list[dict[str, Any]]:
        """Every item of a paginated list, page by page."""
        found: list[dict[str, Any]] = []
        after: str | None = None
        while True:
            page_params = {**params, "limit": str(_PAGE)}
            if after is not None:
                page_params["after"] = after
            page = await self._get(path, page_params)
            data = page.get("data")
            list_metadata = page.get("list_metadata") or {}
            if not isinstance(data, list) or not isinstance(list_metadata, dict):
                raise _unreadable(f"a list for {path}")
            if not all(isinstance(item, dict) for item in data):
                raise _unreadable(f"an item of {path}")
            found.extend(data)
            after = list_metadata.get("after")
            if not after:
                return found
            if not isinstance(after, str):
                raise _unreadable(f"a page cursor for {path}")

    async def memberships_at_sign_in(
        self, subject: str
    ) -> list[DirectoryMembership] | None:
        """The active memberships of WorkOS user `subject`, one per WorkOS
        organization. Which of those organizations Switch follows is for the
        caller to read from its own rows."""
        memberships: list[DirectoryMembership] = []
        for membership in await self._list(
            "/user_management/organization_memberships",
            {"user_id": subject, "statuses": "active"},
        ):
            organization_id = membership.get("organization_id")
            role = membership.get("role")
            slug = role.get("slug") if isinstance(role, dict) else None
            if not isinstance(organization_id, str) or not isinstance(slug, str):
                raise _unreadable("a membership")
            memberships.append(
                DirectoryMembership(
                    workos_organization_id=organization_id, role=switch_role(slug)
                )
            )
        return memberships

    async def organization(self, workos_organization_id: str) -> dict[str, Any]:
        """The WorkOS organization `workos_organization_id`, for an operator
        linking a Switch organization to it."""
        return await self._get(f"/organizations/{workos_organization_id}", {})

    async def users_with_email(self, email: str) -> list[dict[str, Any]]:
        """The WorkOS users whose address is `email`, for an operator linking
        existing accounts."""
        return await self._list("/user_management/users", {"email": email})

    async def create_organization(
        self, creator: User, name: str
    ) -> DirectoryOrganization:
        return DirectoryOrganization(workos_organization_id=None, customer_id=None)

    async def discard_organization(self, organization: DirectoryOrganization) -> None:
        return None

    async def join(self, organization: Organization, user_id: str, role: str) -> None:
        if organization.workos_organization_id is None:
            return None
        raise DirectoryRefusal(NOT_FROM_SWITCH_YET)

    async def set_role(
        self, organization: Organization, user_id: str, role: str
    ) -> None:
        """Taking Org Admin away in Switch needs nothing from WorkOS: it is how
        Switch catches up with a demotion there, and a sign-in makes them Org
        Admin again for as long as WorkOS still has them as one."""
        if organization.workos_organization_id is None:
            return None
        if role == ORGANIZATION_ADMIN_ROLE:
            raise DirectoryRefusal(NOT_FROM_SWITCH_YET)
        return None

    async def remove(self, organization: Organization, user_id: str) -> None:
        """As with a demotion: Switch catching up with a removal in WorkOS,
        undone at the next sign-in for as long as WorkOS still lists them."""
        return None
