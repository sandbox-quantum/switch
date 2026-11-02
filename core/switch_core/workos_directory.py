"""Organizations kept in WorkOS (`ORGANIZATION_DIRECTORY=workos`).

The hosted service shares one WorkOS environment with other products. A
customer is one organization there, and a product may give it organizations
of its own beneath that one; every one of them carries the customer's id in
its metadata (`tenant_id`, the name the first product gave the customer), and
that id, not any one organization's WorkOS id, is what tells customers apart.
A Switch organization is one customer (`organizations.customer_id`).

WorkOS holds who belongs to a customer and who is its `org_admin`; Switch
holds which workspaces, and the roles there. At sign-in the person's
memberships are read from WorkOS (`memberships_at_sign_in`), by their WorkOS
user id, which the sign-in's `sub` is.

Changes made from Switch go through the service that owns the customer
record, not through this module's API key, so each product's rules apply in
one place; until that is wired in, this directory refuses them.
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
# The metadata key every organization of a customer carries its id under.
CUSTOMER_ID_KEY = "tenant_id"

NOT_FROM_SWITCH_YET = (
    "This organization's members are managed in your organization's account "
    "settings, not here yet."
)


def customer_id_of(organization: dict[str, Any]) -> str | None:
    """The customer a WorkOS organization belongs to, or None if it names
    none. Root and child organizations of one customer answer alike."""
    metadata = organization.get("metadata") or {}
    value = metadata.get(CUSTOMER_ID_KEY)
    return value if isinstance(value, str) and value else None


def switch_role(workos_role: str) -> str:
    """WorkOS's `org_admin` is Switch's; every other role there is a member
    here, since Switch adds no role of its own to a shared environment."""
    return (
        ORGANIZATION_ADMIN_ROLE if workos_role == ORGANIZATION_ADMIN_ROLE else "member"
    )


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
        body = response.json()
        if not isinstance(body, dict):
            raise DirectoryUnavailable(f"WorkOS answered {path} with no object.")
        return body

    async def memberships_at_sign_in(
        self, subject: str
    ) -> list[DirectoryMembership] | None:
        """The active memberships of WorkOS user `subject`, one per customer.

        Someone in several organizations of one customer holds the highest of
        their roles there. An organization that names no customer is skipped,
        and logged: Switch cannot tell which customer it is part of.
        """
        roles: dict[str, str] = {}
        for membership in await self._memberships(subject):
            organization_id = membership.get("organization_id")
            role = (membership.get("role") or {}).get("slug")
            if not isinstance(organization_id, str) or not isinstance(role, str):
                raise DirectoryUnavailable(
                    "WorkOS answered with a membership Switch cannot read."
                )
            organization = await self._get(f"/organizations/{organization_id}", {})
            customer_id = customer_id_of(organization)
            if customer_id is None:
                logger.warning(
                    "WorkOS organization %s names no customer (metadata.%s); "
                    "user %s's membership of it is not brought into Switch",
                    organization_id,
                    CUSTOMER_ID_KEY,
                    subject,
                )
                continue
            if roles.get(customer_id) != ORGANIZATION_ADMIN_ROLE:
                roles[customer_id] = switch_role(role)
        return [
            DirectoryMembership(customer_id=customer_id, role=role)
            for customer_id, role in sorted(roles.items())
        ]

    async def _memberships(self, user_id: str) -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = []
        after: str | None = None
        while True:
            params = {"user_id": user_id, "statuses": "active", "limit": str(_PAGE)}
            if after is not None:
                params["after"] = after
            page = await self._get("/user_management/organization_memberships", params)
            data = page.get("data")
            if not isinstance(data, list):
                raise DirectoryUnavailable(
                    "WorkOS answered the memberships with no list."
                )
            found.extend(item for item in data if isinstance(item, dict))
            after = (page.get("list_metadata") or {}).get("after")
            if not after:
                return found

    async def create_organization(
        self, creator: User, name: str
    ) -> DirectoryOrganization:
        raise DirectoryRefusal(NOT_FROM_SWITCH_YET)

    async def discard_organization(self, organization: DirectoryOrganization) -> None:
        raise DirectoryRefusal(NOT_FROM_SWITCH_YET)

    async def join(self, organization: Organization, user_id: str, role: str) -> None:
        if organization.customer_id is None:
            return None
        raise DirectoryRefusal(NOT_FROM_SWITCH_YET)

    async def set_role(
        self, organization: Organization, user_id: str, role: str
    ) -> None:
        if organization.customer_id is None:
            return None
        raise DirectoryRefusal(NOT_FROM_SWITCH_YET)

    async def remove(self, organization: Organization, user_id: str) -> None:
        if organization.customer_id is None:
            return None
        raise DirectoryRefusal(NOT_FROM_SWITCH_YET)
