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
Making someone Org Admin makes them `org_admin` in WorkOS; making an
`org_admin` there a Member makes them `viewer`, the least a member of a shared
organization can be. A change WorkOS doesn't need is not sent. Adding someone stays refused: nobody from Switch can add a person to
the organization yet. Where no members service is configured, those that
grant are refused, and those that take away (a removal, a demotion) change
only Switch, so an Org Admin can end access WorkOS has already ended, until
WorkOS is read again. An organization nobody has linked is Switch's own, as
under the local directory, and that is what a new organization is until then.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

import httpx

from switch_core.authz import ORGANIZATION_ADMIN_ROLE
from switch_core.db.models import Organization, User
from switch_core.members_service import MembersService
from switch_core.organization_directory import (
    NO_DIRECTORY_CHANGE,
    DirectoryMembership,
    DirectoryOrganization,
    DirectoryRefusal,
    DirectorySignInRequired,
    DirectoryUnavailable,
    MemberChange,
)
from switch_core.outbound import OutboundHostUnresolved, OutboundURLRefused

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
NOT_IN_THE_ACCOUNT = (
    "They are not a member of your organization's account; add them there first."
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
    """WorkOS answered, with something other than 200. `detail` is what it
    said, as it said it, for the log and for telling one refusal from
    another."""

    def __init__(self, message: str, status_code: int, detail: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.detail = detail


class EventCursorRejected(DirectoryUnavailable):
    """WorkOS refused where the events were asked from: an event id or a
    start time it no longer keeps."""


# A refusal of where the events are read from names the parameter it refused;
# one of the request itself (an event type, how the list is sent) does not,
# and starting again from now would not cure it.
_NAMES_THE_CURSOR = re.compile(r"\b(after|range_start)\b")
# Enough of a refusal to say what it was, not a page of it in the log.
_DETAIL_LIMIT = 500


def _refusal_detail(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text[:_DETAIL_LIMIT]
    return json.dumps(body)[:_DETAIL_LIMIT]


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
        except OutboundHostUnresolved as error:
            logger.error("WorkOS's host does not resolve: %s", error)
            raise DirectoryUnavailable(
                "WorkOS could not be reached (its host does not resolve)."
            ) from error
        except OutboundURLRefused as error:
            logger.error("WorkOS is refused as a destination: %s", error)
            raise DirectoryUnavailable(
                "WorkOS could not be reached (its address is refused)."
            ) from error
        if response.status_code != 200:
            detail = _refusal_detail(response)
            raise WorkOSRefused(
                f"WorkOS answered {response.status_code} for {path}: {detail}",
                response.status_code,
                detail,
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
        membership = await self._active_membership(subject, workos_organization_id)
        return None if membership is None else switch_role(membership[1])

    async def _active_membership(
        self, subject: str, workos_organization_id: str
    ) -> tuple[str, str] | None:
        """The id and WorkOS role of WorkOS user `subject`'s active membership
        of `workos_organization_id`, or None if they hold none. One filtered
        read, however many members the organization has."""
        for item in await self._list(
            "/user_management/organization_memberships",
            {
                "user_id": subject,
                "organization_id": workos_organization_id,
                "statuses": "active",
            },
        ):
            if item.get("organization_id") != workos_organization_id:
                continue
            membership_id = item.get("id")
            role = item.get("role")
            slug = role.get("slug") if isinstance(role, dict) else None
            if not isinstance(membership_id, str) or not isinstance(slug, str):
                raise _unreadable("a membership")
            return membership_id, slug
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
        self, types: tuple[str, ...], *, after: str | None, range_start: datetime
    ) -> list[dict[str, Any]]:
        """One page of events of `types`, oldest first: those after event
        `after`, or from `range_start` when there is none yet.
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
            params["range_start"] = _workos_time(range_start)
        try:
            page = await self._get("/events", params)
        except WorkOSRefused as error:
            if error.status_code in (400, 404, 422) and _NAMES_THE_CURSOR.search(
                error.detail
            ):
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

    async def prepare_change(
        self,
        organization: Organization,
        subject: str | None,
        role: str | None,
        access_token: str | None,
    ) -> MemberChange:
        """Nothing for an organization nobody linked. Through the members
        service, WorkOS changes only where it has to: making someone Org Admin
        is refused for someone WorkOS doesn't list, and needs nothing for
        someone it already has as `org_admin`; making them a Member changes
        WorkOS only where it has them as `org_admin`, so a role they hold
        there for another product stays; a removal ends the membership WorkOS
        has. Someone with no WorkOS identity is in no WorkOS organization, and
        someone WorkOS no longer lists needs nothing: Switch is catching up.
        Without the service, granting is refused and taking away changes only
        Switch."""
        workos_organization_id = organization.workos_organization_id
        if workos_organization_id is None:
            return NO_DIRECTORY_CHANGE
        promoting = role == ORGANIZATION_ADMIN_ROLE
        if self._members is None:
            if promoting:
                raise DirectoryRefusal(NOT_FROM_SWITCH_YET)
            return NO_DIRECTORY_CHANGE
        membership = (
            None
            if subject is None
            else await self._active_membership(subject, workos_organization_id)
        )
        if membership is None:
            if promoting:
                raise DirectoryRefusal(NOT_IN_THE_ACCOUNT)
            return NO_DIRECTORY_CHANGE
        membership_id, workos_role = membership
        if role is not None and (workos_role == ORGANIZATION_ADMIN_ROLE) == promoting:
            return NO_DIRECTORY_CHANGE
        if access_token is None:
            raise DirectorySignInRequired(SIGN_IN_FIRST)
        return MemberChange(access_token=access_token, membership_id=membership_id)

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
        if change.membership_id is None:
            return None
        await self._members_service().set_role(
            _token_of(change),
            change.membership_id,
            ORGANIZATION_ADMIN_ROLE
            if role == ORGANIZATION_ADMIN_ROLE
            else MEMBER_ROLE_IN_WORKOS,
        )

    async def remove(
        self, organization: Organization, user_id: str, change: MemberChange
    ) -> None:
        if change.membership_id is None:
            return None
        await self._members_service().remove(_token_of(change), change.membership_id)

    def _members_service(self) -> MembersService:
        if self._members is None:
            raise RuntimeError(
                "A membership change for the members service, where there is none"
            )
        return self._members


def _token_of(change: MemberChange) -> str:
    """The admin's token; `prepare_change` has refused a change that needs
    one without it, so its absence here is a route's mistake."""
    if change.access_token is None:
        raise DirectorySignInRequired(SIGN_IN_FIRST)
    return change.access_token


def _workos_time(moment: datetime) -> str:
    """`moment` as WorkOS reads a time: UTC, to the millisecond, ending in
    `Z`. It refuses an offset such as `+00:00` as not ISO 8601."""
    if moment.tzinfo is None or moment.utcoffset() is None:
        raise ValueError(f"{moment!r} has no timezone, so it names no moment")
    return (
        moment.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    )
