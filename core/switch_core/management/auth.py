"""Authenticating agent controllers.

Two shapes, matching the two kinds of route:

- **Access token** (`swct_…`), on every controller route but two, and on the
  agent routes a controller acts as its agents on. The bearer
  middleware hands it here (`ManagementAuthenticator.authenticate`). The
  token is signed, so its tenant claim is trusted and bound directly; the
  controller row is then read under that tenant, and a revoked controller is
  refused even while its token is unexpired. A controller that authenticated
  is remembered for a few seconds (`ControllerAuthCache`), and forgotten the
  moment it is revoked. A controller whose owner is suspended
  (`accounts/suspension.py`) is refused with 403 `account_suspended` on every
  route but its assignment, which it may still read: with all its owner's
  agents suspended, that says to stop every one. Its credential is kept, so
  it is let back in once the suspension is lifted.
- **Secret in the body**, on enrollment (an `swce_…` code) and token exchange
  (an `swcc_…` credential). Both are `api_keys` rows, so their tenant comes
  from the same `SECURITY DEFINER` hash lookup a bearer API key uses
  (`tenant_of_secret`). This module is the only place in the package that
  reaches that exemption.
"""

from __future__ import annotations

import re
from collections.abc import Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.accounts.suspension import owner_is_suspended
from switch_core.archived_workspace import is_archived
from switch_core.bridges.agent.auth import ControllerAuthError, ControllerPrincipal
from switch_core.bridges.agent.controller_auth_cache import ControllerAuthCache
from switch_core.bridges.agent.operations.agent_management import (
    WORKSPACE_NOT_ENABLED_MESSAGE,
)
from switch_core.bridges.agent.protocol.controller_presence import (
    Binding,
    ControllerPresence,
)
from switch_core.db.models import Agent
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.tenant_lookup import tenant_of_api_key
from switch_core.management import reason_codes, tokens
from switch_core.management.errors import ManagementError

MANAGEMENT_PREFIX = "/v1/management"
CONTROLLERS_PREFIX = "/v1/controllers"
ENROLL_PATH = "/v1/management/controllers/enroll"
_TOKEN_PATH = re.compile(r"/v1/management/controllers/[^/]+/token")
_ASSIGNMENT_PATH = re.compile(r"/v1/management/controllers/[^/]+/assignment")


class ControllerOwnerSuspendedError(ControllerAuthError):
    """The controller's owner is suspended: refused while that lasts, never
    told its credential is no good."""

    status_code = 403

    def __init__(self) -> None:
        super().__init__(
            reason_codes.ACCOUNT_SUSPENDED,
            "The account this controller belongs to is suspended.",
            # Given here too: the base class sets the status from its argument.
            status_code=403,
        )


def _under(path: str, prefix: str) -> bool:
    return path == prefix or path.startswith(prefix + "/")


class ManagementAuthenticator:
    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        controllers: AgentControllerStore,
        token_secret: str,
        presence: ControllerPresence,
        auth_cache: ControllerAuthCache,
        workspace_allowed: Callable[[str], bool] = lambda _tenant_id: True,
        workspace_restricted: bool = False,
    ) -> None:
        # Whether a workspace may use agent management at all (the hosted
        # config's `management_tenant_ids`, through `tenant_allowed`). Applied
        # where a caller's workspace becomes known, so it covers every route
        # under /v1/management and /v1/controllers without a copy per route;
        # the Console-side routes ask `workspace_allowed` too.
        self._workspace_allowed = workspace_allowed
        self._workspace_restricted = workspace_restricted
        self._session_factory = session_factory
        self._controllers = controllers
        self._verified = tokens.VerifiedTokens(secret=token_secret)
        self._presence = presence
        self._auth_cache = auth_cache

    def workspace_allowed(self, tenant_id: str) -> bool:
        return self._workspace_allowed(tenant_id)

    @property
    def workspace_restricted(self) -> bool:
        """A workspace list is set (so an unbound call fails closed)."""
        return self._workspace_restricted

    @property
    def presence(self) -> ControllerPresence:
        return self._presence

    @property
    def auth_cache(self) -> ControllerAuthCache:
        return self._auth_cache

    def is_controller_token(self, token: str) -> bool:
        return token.startswith(tokens.ACCESS_TOKEN_PREFIX)

    def handles(self, path: str) -> bool:
        return _under(path, MANAGEMENT_PREFIX) or _under(path, CONTROLLERS_PREFIX)

    def is_public(self, path: str) -> bool:
        return path == ENROLL_PATH or _TOKEN_PATH.fullmatch(path) is not None

    def signature_valid(self, token: str) -> bool:
        """The token's signature and expiry check out, with no database read
        (a locked-out address is served only for such a token)."""
        try:
            self._verified.verify(token)
        except (tokens.AccessTokenExpired, tokens.AccessTokenInvalid):
            return False
        return True

    async def authenticate(self, token: str, path: str) -> ControllerPrincipal:
        try:
            claims = self._verified.verify(token)
        except tokens.AccessTokenExpired as exc:
            raise ControllerAuthError(
                reason_codes.TOKEN_EXPIRED,
                "The access token has expired; exchange the credential again.",
            ) from exc
        except tokens.AccessTokenInvalid as exc:
            raise ControllerAuthError(
                reason_codes.INVALID_CREDENTIAL,
                "The access token is not a valid controller token.",
            ) from exc
        principal = ControllerPrincipal(
            controller_id=claims.controller_id,
            owner_id=claims.owner_id,
            tenant_id=claims.tenant_id,
            key_id=claims.key_id,
        )
        if _ASSIGNMENT_PATH.fullmatch(path):
            # A suspended owner's controller still reads its assignment, but a
            # workspace off the allow-list is refused here as everywhere.
            self._require_workspace(principal)
            current, _ = await self._standing(principal)
            return current
        return await self.current(principal)

    async def current(self, principal: ControllerPrincipal) -> ControllerPrincipal:
        """The controller `principal` names, while it keeps the authority its
        token gave it: not revoked, owned by the same person, that person not
        suspended, and, for a token naming the credential it was exchanged
        for, still holding that credential. Every request made with a
        controller access token is checked here, and every call on a
        controller's socket, which authenticated once when it opened.

        A token for a credential the controller no longer has (rotated away,
        or replaced when another controller on the same device took it over)
        is refused as expired: its holder exchanges its credential again,
        which only the controller's current process can do."""
        self._require_workspace(principal)
        current, owner_suspended = await self._standing(principal)
        if owner_suspended:
            raise ControllerOwnerSuspendedError()
        return current

    def _require_workspace(self, principal: ControllerPrincipal) -> None:
        if not self._workspace_allowed(principal.tenant_id):
            # Ahead of the cache, so a controller remembered from before the
            # list changed is refused too.
            raise ControllerAuthError(
                reason_codes.WORKSPACE_NOT_ENABLED, WORKSPACE_NOT_ENABLED_MESSAGE, 403
            )

    async def _standing(
        self, principal: ControllerPrincipal
    ) -> tuple[ControllerPrincipal, bool]:
        """The controller, not revoked, owned by the same person and holding
        the credential the token names, and whether that person is suspended.
        Only a controller whose owner is not suspended is cached."""
        cached = self._auth_cache.controller(
            principal.tenant_id, principal.controller_id
        )
        if cached is not None and cached.owner_id == principal.owner_id:
            return _holding(principal, cached.key_id), False

        ticket = self._auth_cache.ticket()
        async with tenant_session(
            self._session_factory, principal.tenant_id
        ) as session:
            controller = await self._controllers.get(
                session, principal.tenant_id, principal.controller_id
            )
            owner_suspended = await owner_is_suspended(session, principal.owner_id)
        if controller is None or controller.owner_id != principal.owner_id:
            raise ControllerAuthError(
                reason_codes.INVALID_CREDENTIAL,
                "The access token names no controller.",
            )
        if controller.revoked_at is not None or controller.api_key_id is None:
            raise ControllerAuthError(
                reason_codes.CONTROLLER_REVOKED, "The controller has been revoked."
            )
        current = ControllerPrincipal(
            controller_id=controller.id,
            owner_id=controller.owner_id,
            tenant_id=principal.tenant_id,
            key_id=controller.api_key_id,
        )
        if not owner_suspended:
            self._auth_cache.put_controller(current, ticket)
        return _holding(principal, controller.api_key_id), owner_suspended

    async def stopped_by_archive(self, binding: Binding) -> bool:
        """Whether `binding` is stopped because its workspace is archived: its
        controller may then not act for the agent, on an agent route or its
        socket, as the agent's own key may not (`bridges/agent/auth.py`).
        Read only for a binding not running, so acting for a running agent
        costs nothing more."""
        if binding.running:
            return False
        async with tenant_session(self._session_factory, binding.tenant_id) as session:
            return await is_archived(session, binding.tenant_id)

    async def agent_suspended(self, tenant_id: str, agent_id: str) -> bool:
        """Whether the agent a controller acts for is suspended
        (`accounts/suspension.py`), when its controller may not act for it,
        as its own key may not. From the controller-token cache when it holds
        the agent's row, which a change to the row drops."""
        agent = self._auth_cache.agent(tenant_id, agent_id)
        if agent is None:
            ticket = self._auth_cache.ticket()
            async with tenant_session(self._session_factory, tenant_id) as session:
                agent = await session.scalar(
                    select(Agent).where(
                        Agent.tenant_id == tenant_id, Agent.id == agent_id
                    )
                )
                if agent is not None:
                    session.expunge(agent)
            if agent is None:
                return False
            self._auth_cache.put_agents(tenant_id, [agent], ticket)
        return agent.suspended_at is not None

    async def tenant_of_secret(self, secret: str) -> str | None:
        """The tenant an enrollment code or controller credential belongs to,
        or None for a secret no tenant holds. Raises `ManagementError` (403)
        for a workspace not allowed to use the controller routes."""
        tenant_id = await tenant_of_api_key(
            self._session_factory, tokens.hash_secret(secret)
        )
        if tenant_id is not None and not self._workspace_allowed(tenant_id):
            raise workspace_not_enabled()
        return tenant_id


def workspace_not_enabled() -> ManagementError:
    return ManagementError(
        403, reason_codes.WORKSPACE_NOT_ENABLED, WORKSPACE_NOT_ENABLED_MESSAGE
    )


def _holding(principal: ControllerPrincipal, key_id: str | None) -> ControllerPrincipal:
    """`principal`, while the controller holds the credential its token names."""
    if principal.key_id is not None and principal.key_id != key_id:
        raise ControllerAuthError(
            reason_codes.TOKEN_EXPIRED,
            "The access token was issued for a credential this controller no "
            "longer has; exchange the credential again.",
        )
    return principal
