"""A stand-in for a service's vendor, for broker and route tests.

Plays GitHub, the one enabled catalog entry, as the broker sees it through
`ServiceAdapter`: refresh, check a grant, issue, revoke, all counted.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from switch_core.connections.adapters import (
    ConnectionSecret,
    IssuedToken,
    IssueRequest,
)
from switch_core.connections.loader import AccessLevel


class FakeVendor:
    """GitHub as the broker sees it: refresh, issue, revoke, counted."""

    def __init__(self) -> None:
        self.can_issue = True
        self.refreshes = 0
        self.refresh_error: Exception | None = None
        self.issue_error: Exception | None = None
        self.lifetime = timedelta(hours=1)
        self.revocable = True
        self.during_issue: Callable[[], Awaitable[None]] | None = None
        self.issued: list[tuple[str, str]] = []
        self.revoked: list[str] = []
        self.connections_revoked: list[ConnectionSecret] = []
        self.grant_error: Exception | None = None
        self.checked: list[tuple[str, dict[str, Any]]] = []

    async def refresh(self, secret: ConnectionSecret) -> ConnectionSecret:
        self.refreshes += 1
        # Wide enough that a second, unserialised refresh would start here.
        await asyncio.sleep(0.2)
        if self.refresh_error is not None:
            raise self.refresh_error
        return ConnectionSecret(
            {
                **secret.values,
                "access_token": f"gho_access_{self.refreshes}",
                "expires_at": time.time() + 8 * 3600,
                "refresh_token": f"ghr_refresh_{self.refreshes}",
            }
        )

    async def issue(self, access_token: str, request: IssueRequest) -> IssuedToken:
        if self.during_issue is not None:
            await self.during_issue()
        if self.issue_error is not None:
            raise self.issue_error
        token = f"ghs_{uuid.uuid4().hex}"
        self.issued.append((access_token, token))
        return IssuedToken(
            token=token,
            expires_at=datetime.now(UTC) + self.lifetime,
            resources=dict(request.resources),
            revocable=self.revocable,
        )

    async def revoke_issued(self, token: str) -> None:
        self.revoked.append(token)

    async def revoke_connection(self, secret: ConnectionSecret) -> None:
        self.connections_revoked.append(secret)

    async def check_grant(
        self, access_token: str, request: IssueRequest
    ) -> dict[str, Any]:
        if self.grant_error is not None:
            raise self.grant_error
        self.checked.append((access_token, dict(request.resources)))
        return dict(request.resources)

    def summary(
        self, agent_name: str, access: AccessLevel, resources: dict[str, Any]
    ) -> str:
        verb = "push to" if access == "write" else "read"
        count = len(resources.get("repository_ids", []))
        return f"{agent_name} can {verb} {count} repositories, as the GitHub App."
