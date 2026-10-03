"""Authenticating agent controllers.

Two shapes, matching the two kinds of route:

- **Access token** (`swct_…`), on every controller route but two, and on the
  agent routes a controller acts as its agents on. The bearer
  middleware hands it here (`ManagementAuthenticator.authenticate`). The
  token is signed, so its tenant claim is trusted and bound directly; the
  controller row is then read under that tenant, and a revoked controller is
  refused even while its token is unexpired. A controller that authenticated
  is remembered for a few seconds (`ControllerAuthCache`), and forgotten the
  moment it is revoked.
- **Secret in the body**, on enrollment (an `swce_…` code) and token exchange
  (an `swcc_…` credential). Both are `api_keys` rows, so their tenant comes
  from the same `SECURITY DEFINER` hash lookup a bearer API key uses
  (`tenant_of_secret`). This module is the only place in the package that
  reaches that exemption.
"""

from __future__ import annotations

import re

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.auth import ControllerAuthError, ControllerPrincipal
from switch_core.bridges.agent.controller_auth_cache import ControllerAuthCache
from switch_core.bridges.agent.protocol.controller_presence import ControllerPresence
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.tenant_lookup import tenant_of_api_key
from switch_core.management import reason_codes, tokens

MANAGEMENT_PREFIX = "/v1/management"
CONTROLLERS_PREFIX = "/v1/controllers"
ENROLL_PATH = "/v1/management/controllers/enroll"
_TOKEN_PATH = re.compile(r"/v1/management/controllers/[^/]+/token")


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
    ) -> None:
        self._session_factory = session_factory
        self._controllers = controllers
        self._token_secret = token_secret
        self._presence = presence
        self._auth_cache = auth_cache

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

    async def authenticate(self, token: str) -> ControllerPrincipal:
        try:
            claims = tokens.verify_access_token(token, secret=self._token_secret)
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

        cached = self._auth_cache.controller(claims.tenant_id, claims.controller_id)
        if cached is not None and cached.owner_id == claims.owner_id:
            return cached

        generation = self._auth_cache.generation
        async with tenant_session(self._session_factory, claims.tenant_id) as session:
            controller = await self._controllers.get(
                session, claims.tenant_id, claims.controller_id
            )
        if controller is None or controller.owner_id != claims.owner_id:
            raise ControllerAuthError(
                reason_codes.INVALID_CREDENTIAL,
                "The access token names no controller.",
            )
        if controller.revoked_at is not None or controller.api_key_id is None:
            raise ControllerAuthError(
                reason_codes.CONTROLLER_REVOKED, "The controller has been revoked."
            )
        principal = ControllerPrincipal(
            controller_id=controller.id,
            owner_id=controller.owner_id,
            tenant_id=claims.tenant_id,
        )
        self._auth_cache.put_controller(principal, generation)
        return principal

    async def tenant_of_secret(self, secret: str) -> str | None:
        """The tenant an enrollment code or controller credential belongs to,
        or None for a secret no tenant holds."""
        return await tenant_of_api_key(
            self._session_factory, tokens.hash_secret(secret)
        )
