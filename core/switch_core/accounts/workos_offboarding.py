"""Taking a purged organization out of WorkOS, with the server's own API key
(`WORKOS_API_KEY`).

The WorkOS environment may be shared with other products, so what goes is
only what Switch alone had there:

- **Memberships** of the purged people in the organization's WorkOS
  organization are removed, whatever their status.
- **A WorkOS user** is deleted only when Switch no longer uses it (the
  caller decides that) and, once those memberships are gone, it is a member
  of no organization at all in the environment. Anyone still in another
  organization is used by another product and is kept.
- **The WorkOS organization** is deleted only when, after that, nobody is a
  member of it in any status and it has no SSO connection and no directory:
  another product may have people, or a sign-in, there.

Every step reads WorkOS again before it changes anything, and a 404 on a
deletion counts as done, so a run that stops part-way is finished by running
it again. `plan` reads what a run would do now and changes nothing.

Changes made to members from the dashboard go through the members service
with the admin's own token (`workos_directory.py`); the purge has no admin
token to send, and deletes what that service cannot (users, the
organization), so it uses the API key.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

import httpx

from switch_core.workos_directory import WORKOS_TIMEOUT_SECONDS

logger = logging.getLogger(__name__)

# WorkOS's largest page.
_PAGE = 100
# Every status a membership can have: one that is pending or inactive still
# ties the person to that organization.
_ALL_STATUSES = "active,inactive,pending"
_DETAIL_LIMIT = 300


class WorkOSError(Exception):
    """A WorkOS call failed: it could not be made, or WorkOS answered with
    something other than success (or a 404 on a deletion)."""


@dataclass(frozen=True)
class Membership:
    id: str
    user_id: str
    organization_id: str


@dataclass
class WorkOSSteps:
    """What taking the organization out of WorkOS does, or did."""

    # The memberships of the purged people in the organization.
    memberships: list[Membership] = field(default_factory=list)
    users_deleted: list[str] = field(default_factory=list)
    # Users kept, with why.
    users_kept: dict[str, str] = field(default_factory=dict)
    organization_deleted: bool = False
    # Why the organization is kept; None when it is deleted, or there is none.
    organization_kept: str | None = None
    # What failed, to retry by running again.
    failures: list[str] = field(default_factory=list)


class WorkOSOffboarding:
    def __init__(self, http: httpx.AsyncClient, api_key: str, api_url: str) -> None:
        self._http = http
        self._api_key = api_key
        self._api_url = api_url.rstrip("/")

    async def plan(
        self,
        workos_organization_id: str | None,
        users: list[str],
        deletable: set[str],
    ) -> WorkOSSteps:
        """What `carry_out` would do now, for the WorkOS users `users`, of
        whom Switch no longer uses those in `deletable`. Changes nothing;
        raises `WorkOSError` when WorkOS can't be read."""
        steps = WorkOSSteps()
        if workos_organization_id is not None:
            steps.memberships = await self._memberships_in(
                workos_organization_id, users
            )
        leaving = {membership.id for membership in steps.memberships}
        for user_id in users:
            if user_id not in deletable:
                steps.users_kept[user_id] = "Switch still uses this user"
                continue
            elsewhere = [
                membership
                for membership in await self._memberships_of(user_id)
                if membership.id not in leaving
            ]
            if elsewhere:
                steps.users_kept[user_id] = _member_elsewhere(elsewhere)
            else:
                steps.users_deleted.append(user_id)
        if workos_organization_id is not None:
            steps.organization_kept = await self._why_organization_stays(
                workos_organization_id, leaving
            )
            steps.organization_deleted = steps.organization_kept is None
        return steps

    async def carry_out(
        self,
        workos_organization_id: str | None,
        users: list[str],
        deletable: set[str],
    ) -> WorkOSSteps:
        """Remove the memberships, then delete each user in `deletable` that
        is left in no organization, then the organization if it is left
        empty. A failure is recorded in `failures` and holds back only what
        depends on it; run again to retry."""
        steps = WorkOSSteps()
        failed_users: set[str] = set()
        if workos_organization_id is not None:
            try:
                steps.memberships = await self._memberships_in(
                    workos_organization_id, users
                )
            except WorkOSError as error:
                steps.failures.append(
                    f"listing memberships of {workos_organization_id}: {error}"
                )
                failed_users.update(users)
            for membership in steps.memberships:
                try:
                    await self._delete(
                        f"/user_management/organization_memberships/{quote(membership.id)}"
                    )
                except WorkOSError as error:
                    steps.failures.append(
                        f"removing membership {membership.id} of user "
                        f"{membership.user_id}: {error}"
                    )
                    failed_users.add(membership.user_id)
        for user_id in users:
            if user_id not in deletable:
                steps.users_kept[user_id] = "Switch still uses this user"
                continue
            if user_id in failed_users:
                continue
            try:
                elsewhere = await self._memberships_of(user_id)
                if elsewhere:
                    steps.users_kept[user_id] = _member_elsewhere(elsewhere)
                    continue
                await self._delete(f"/user_management/users/{quote(user_id)}")
            except WorkOSError as error:
                steps.failures.append(f"deleting user {user_id}: {error}")
                continue
            steps.users_deleted.append(user_id)
        if workos_organization_id is None:
            return steps
        if failed_users:
            steps.organization_kept = (
                "not all of the purged people's memberships could be removed"
            )
            return steps
        try:
            steps.organization_kept = await self._why_organization_stays(
                workos_organization_id, set()
            )
            if steps.organization_kept is None:
                await self._delete(f"/organizations/{quote(workos_organization_id)}")
                steps.organization_deleted = True
        except WorkOSError as error:
            steps.failures.append(
                f"deleting organization {workos_organization_id}: {error}"
            )
        return steps

    async def _why_organization_stays(
        self, workos_organization_id: str, leaving: set[str]
    ) -> str | None:
        """Why the organization must stay, once the memberships `leaving`
        are gone, or None when nothing else is in it."""
        remaining = [
            item
            for item in await self._list_or_none(
                "/user_management/organization_memberships",
                {
                    "organization_id": workos_organization_id,
                    "statuses": _ALL_STATUSES,
                },
            )
            if item.get("id") not in leaving
        ]
        if remaining:
            return (
                f"{len(remaining)} other membership(s) remain in it, of people "
                "the purge did not delete or of another product's"
            )
        connections = await self._list_or_none(
            "/connections", {"organization_id": workos_organization_id}
        )
        if connections:
            return f"it has {len(connections)} SSO connection(s)"
        directories = await self._list_or_none(
            "/directories", {"organization_id": workos_organization_id}
        )
        if directories:
            return f"it has {len(directories)} directory sync connection(s)"
        return None

    async def _memberships_in(
        self, workos_organization_id: str, users: list[str]
    ) -> list[Membership]:
        found = []
        for user_id in users:
            for membership in await self._memberships_of(user_id):
                if membership.organization_id == workos_organization_id:
                    found.append(membership)
        return found

    async def _memberships_of(self, user_id: str) -> list[Membership]:
        """Every membership of the user, in any organization and status;
        none for a user WorkOS no longer has."""
        memberships = []
        for item in await self._list_or_none(
            "/user_management/organization_memberships",
            {"user_id": user_id, "statuses": _ALL_STATUSES},
        ):
            membership_id = item.get("id")
            organization_id = item.get("organization_id")
            if not isinstance(membership_id, str) or not isinstance(
                organization_id, str
            ):
                raise WorkOSError(
                    "WorkOS answered with a membership Switch can't read."
                )
            memberships.append(
                Membership(
                    id=membership_id, user_id=user_id, organization_id=organization_id
                )
            )
        return memberships

    async def _list_or_none(
        self, path: str, params: dict[str, str]
    ) -> list[dict[str, Any]]:
        """Every item of a paginated list; none when WorkOS answers 404,
        for a user or organization it no longer has."""
        found: list[dict[str, Any]] = []
        after: str | None = None
        while True:
            page_params = {**params, "limit": str(_PAGE)}
            if after is not None:
                page_params["after"] = after
            response = await self._request("GET", path, page_params)
            if response.status_code == 404:
                return found
            _require_success(response, "GET", path)
            try:
                page = response.json()
            except ValueError as error:
                raise WorkOSError(
                    f"WorkOS answered GET {path} with no JSON."
                ) from error
            data = page.get("data") if isinstance(page, dict) else None
            metadata = (
                (page.get("list_metadata") or {}) if isinstance(page, dict) else None
            )
            if not isinstance(data, list) or not isinstance(metadata, dict):
                raise WorkOSError(f"WorkOS answered GET {path} with no list.")
            found.extend(item for item in data if isinstance(item, dict))
            after = metadata.get("after")
            if not after:
                return found

    async def _delete(self, path: str) -> None:
        """Delete what `path` names; one WorkOS no longer has is gone
        already."""
        response = await self._request("DELETE", path, {})
        if response.status_code == 404:
            logger.info("WorkOS has no %s; already deleted", path)
            return
        _require_success(response, "DELETE", path)
        logger.info("Deleted %s at WorkOS", path)

    async def _request(
        self, method: str, path: str, params: dict[str, str]
    ) -> httpx.Response:
        try:
            return await self._http.request(
                method,
                f"{self._api_url}{path}",
                params=params,
                headers={"Authorization": f"Bearer {self._api_key}"},
                timeout=WORKOS_TIMEOUT_SECONDS,
            )
        except httpx.HTTPError as error:
            raise WorkOSError(
                f"WorkOS could not be reached for {method} {path} "
                f"({type(error).__name__})."
            ) from error


def _require_success(response: httpx.Response, method: str, path: str) -> None:
    if 200 <= response.status_code < 300:
        return
    try:
        detail = json.dumps(response.json())[:_DETAIL_LIMIT]
    except ValueError:
        detail = response.text[:_DETAIL_LIMIT]
    raise WorkOSError(
        f"WorkOS answered {response.status_code} for {method} {path}: {detail}"
    )


def _member_elsewhere(memberships: list[Membership]) -> str:
    organizations = sorted({membership.organization_id for membership in memberships})
    return (
        f"a member of {len(organizations)} other WorkOS organization(s) "
        f"({', '.join(organizations)}), so another product uses this user"
    )
