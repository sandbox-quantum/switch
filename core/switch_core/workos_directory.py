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

Changes made from Switch to a linked organization go through the members
service (`members_service.py`), with the admin's own WorkOS token for it, not
through this module's API key, so each product's rules apply in one place.
Making someone Org Admin makes them `org_admin` in WorkOS; making them a
Member makes them `viewer` there, the least a member of a shared organization
can be. Adding someone stays refused: nobody from Switch can add a person to
the organization yet. Where no members service is configured, those that
grant are refused, and those that take away (a removal, a demotion) change
only Switch, so an Org Admin can end access WorkOS has already ended, until
WorkOS is read again. An organization nobody has linked is Switch's own, as
under the local directory, and that is what a new organization is until then.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

import httpx

from switch_core.authz import ORGANIZATION_ADMIN_ROLE
from switch_core.db.models import Organization, User
from switch_core.members_service import MembersService
from switch_core.organization_directory import (
    DirectoryMembership,
    DirectoryOrganization,
    DirectoryRefusal,
    DirectorySignInRequired,
    DirectoryUnavailable,
    MemberChange,
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
SIGN_IN_FIRST = (
    "Confirm your sign-in to your organization's account to change its members."
)
# The WorkOS role of a member Switch makes a Member: the least a member of a
# shared organization can be.
MEMBER_ROLE_IN_WORKOS = "viewer"


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


class WorkOSRefused(DirectoryUnavailable):
    """WorkOS answered, with something other than 200."""

    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


class EventCursorRejected(DirectoryUnavailable):
    """WorkOS refused where the events were asked from: an event id or a
    start time it no longer keeps."""


def _unreadable(what: str) -> DirectoryUnavailable:
    return DirectoryUnavailable(f"WorkOS answered with {what} Switch cannot read.")


class WorkOSDirectory:
    def __init__(
        self,
        http: httpx.AsyncClient,
        api_key: str,
        api_url: str,
        identity_issuer: str,
        members: MembersService | None,
    ) -> None:
        self._http = http
        self._api_key = api_key
        self._api_url = api_url.rstrip("/")
        self.identity_issuer: str | None = identity_issuer
        self._members = members

    async def _get(
        self, path: str, params: Mapping[str, str | list[str]]
    ) -> dict[str, Any]:
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
            raise WorkOSRefused(
                f"WorkOS answered {response.status_code} for {path}.",
                response.status_code,
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
        return self._read_memberships(
            await self._list(
                "/user_management/organization_memberships",
                {"user_id": subject, "statuses": "active"},
            )
        )

    @staticmethod
    def _read_memberships(items: list[dict[str, Any]]) -> list[DirectoryMembership]:
        memberships = []
        for membership in items:
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

    async def membership_role(
        self, subject: str, workos_organization_id: str
    ) -> str | None:
        """Switch's role for WorkOS user `subject`'s active membership of
        `workos_organization_id`, or None if they hold none."""
        memberships = await self._list(
            "/user_management/organization_memberships",
            {
                "user_id": subject,
                "organization_id": workos_organization_id,
                "statuses": "active",
            },
        )
        for membership in self._read_memberships(memberships):
            if membership.workos_organization_id == workos_organization_id:
                return membership.role
        return None

    async def organization_members(self, workos_organization_id: str) -> dict[str, str]:
        """Switch's role for each WorkOS user with an active membership of
        `workos_organization_id`, by their WorkOS user id."""
        members: dict[str, str] = {}
        for item in await self._list(
            "/user_management/organization_memberships",
            {"organization_id": workos_organization_id, "statuses": "active"},
        ):
            user_id = item.get("user_id")
            if not isinstance(user_id, str):
                raise _unreadable("a membership")
            [membership] = self._read_memberships([item])
            members[user_id] = membership.role
        return members

    async def events(
        self, types: tuple[str, ...], *, after: str | None, range_start: str
    ) -> list[dict[str, Any]]:
        """One page of events of `types`, oldest first: those after event
        `after`, or from `range_start` (ISO 8601) when there is none yet.
        Empty once there are no more. Each event is returned as WorkOS sent
        it, for the caller to skip one it can't read rather than lose the
        page. Raises `EventCursorRejected` when WorkOS refuses `after` or
        `range_start`."""
        params: dict[str, str | list[str]] = {
            "events": list(types),
            "limit": str(_PAGE),
            "order": "asc",
        }
        if after:
            params["after"] = after
        else:
            params["range_start"] = range_start
        try:
            page = await self._get("/events", params)
        except WorkOSRefused as error:
            if error.status_code in (400, 404, 422):
                raise EventCursorRejected(error.message) from error
            raise
        data = page.get("data")
        if not isinstance(data, list) or not all(
            isinstance(event, dict) for event in data
        ):
            raise _unreadable("a list of events")
        return data

    async def organization(self, workos_organization_id: str) -> dict[str, Any]:
        """The WorkOS organization `workos_organization_id`, for an operator
        linking a Switch organization to it."""
        return await self._get(f"/organizations/{workos_organization_id}", {})

    async def users_with_email(self, email: str) -> list[dict[str, Any]]:
        """The WorkOS users whose address is `email`, for an operator linking
        existing accounts."""
        return await self._list("/user_management/users", {"email": email})

    def check_can_change(
        self, organization: Organization, access_token: str | None
    ) -> None:
        if (
            organization.workos_organization_id is not None
            and self._members is not None
            and access_token is None
        ):
            raise DirectorySignInRequired(SIGN_IN_FIRST)

    def sends_changes_for(self, organization: Organization) -> bool:
        return (
            organization.workos_organization_id is not None
            and self._members is not None
        )

    def keeps_members_of(self, organization: Organization) -> bool:
        """Only an organization an operator linked follows WorkOS; any other
        is still Switch's own."""
        return organization.workos_organization_id is not None

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
        self,
        organization: Organization,
        user_id: str,
        role: str,
        change: MemberChange,
    ) -> None:
        """Through the members service where there is one. A demotion of
        someone WorkOS no longer lists needs nothing: it is Switch catching up.
        Without the service, taking Org Admin away needs nothing from WorkOS
        either, and a sign-in or the mirror makes them Org Admin again for as
        long as WorkOS still has them as one."""
        if organization.workos_organization_id is None:
            return None
        promoting = role == ORGANIZATION_ADMIN_ROLE
        if self._members is None:
            if promoting:
                raise DirectoryRefusal(NOT_FROM_SWITCH_YET)
            return None
        access_token = _token_of(change)
        membership = await self._membership(access_token, user_id, change)
        if membership is None:
            if promoting:
                raise DirectoryRefusal(
                    "They are not a member of your organization's account; "
                    "add them there first."
                )
            return None
        await self._members.set_role(
            access_token,
            membership,
            ORGANIZATION_ADMIN_ROLE if promoting else MEMBER_ROLE_IN_WORKOS,
        )

    async def remove(
        self, organization: Organization, user_id: str, change: MemberChange
    ) -> None:
        """Through the members service where there is one; someone WorkOS no
        longer lists needs nothing. Without it, as with a demotion: Switch
        catching up with a removal in WorkOS, undone for as long as WorkOS
        still lists them."""
        if organization.workos_organization_id is None or self._members is None:
            return None
        access_token = _token_of(change)
        membership = await self._membership(access_token, user_id, change)
        if membership is not None:
            await self._members.remove(access_token, membership)

    async def _membership(
        self, access_token: str, user_id: str, change: MemberChange
    ) -> str | None:
        assert self._members is not None
        if change.subject is None:
            raise DirectoryRefusal(
                f"User {user_id} has no WorkOS identity, so their membership "
                "there can't be changed from Switch."
            )
        return await self._members.membership_of(access_token, change.subject)


def _token_of(change: MemberChange) -> str:
    """The admin's token; `check_can_change` has refused a change without one
    before anything was changed, so its absence here is a route's mistake."""
    if change.access_token is None:
        raise DirectorySignInRequired(SIGN_IN_FIRST)
    return change.access_token
