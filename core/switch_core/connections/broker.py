"""The credential broker: where a service token is decided, issued and recorded.

An agent may use a service when its owner has connected an account there and
granted it to the agent. The broker is the only code that decrypts a
connection's secret, and it keeps four seams narrow, so each can be tested on
its own and none assumes where tokens go next:

- **Connection credential** (`_access_token`): a usable vendor access token
  for a connection. Decrypt, refresh under the connection's lock when the
  cached token expires within five minutes, store the new pair, commit. One
  owner's agents share one token and one refresh.
- **Grant decision** (`decide`): the ordered checks every issuance runs,
  returning what the grant allows or raising a coded `ServiceError`.
- **Delivery** (`issue`): the only code, with the adapter's `issue` and
  `revoke_issued`, that knows a token goes to the agent.
- **Records**: every token issued is recorded here, under the connection's
  lock, so a disconnect or a removed grant always covers it.

What can be revoked is revoked by `revoke_pending`, once after each access
change the broker makes and on a five-minute tick (`connections/maintenance.py`)
for changes made elsewhere: an agent deleted, an owner removed from the
workspace.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.requests import Request

from switch_core.connections.adapters import (
    ConnectionSecret,
    IssuedToken,
    IssueRequest,
    ReauthorizationRequiredError,
    ServiceAdapter,
    ServiceAdapterError,
    ServiceUnavailableError,
)
from switch_core.connections.loader import AccessLevel, Connection
from switch_core.connections.shielded import finish_shielded
from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import (
    Agent,
    HostedLaunch,
    ServiceConnection,
    ServiceGrant,
    ServiceTokenIssuance,
    TenantMember,
    require_tenant_id,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.service_connection_store import (
    ServiceConnectionBusy,
    ServiceConnectionStore,
)
from switch_core.keys import Keyring
from switch_core.observability.catalogue import SERVICE_TOKEN_REQUESTS
from switch_core.observability.metrics import metrics

logger = logging.getLogger(__name__)

# The contract's reason codes (`docs/design/controller-contract-v1.md`, §9).
GRANT_MISSING = "grant_missing"
GRANT_ACCOUNT_CHANGED = "grant_account_changed"
CONNECTOR_NOT_CONNECTED = "connector_not_connected"
CONNECTOR_REVOKED = "connector_revoked"
FORBIDDEN = "forbidden"
NOT_FOUND = "not_found"
INTERNAL = "internal"
VALIDATION_ERROR = "validation_error"
REASON_CODES = frozenset(
    {
        GRANT_MISSING,
        GRANT_ACCOUNT_CHANGED,
        CONNECTOR_NOT_CONNECTED,
        CONNECTOR_REVOKED,
        FORBIDDEN,
        NOT_FOUND,
        INTERNAL,
        VALIDATION_ERROR,
    }
)

TOKEN_LIFETIME = timedelta(hours=1)
TOKEN_LEEWAY = timedelta(seconds=60)
REFRESH_BEFORE = timedelta(minutes=5)
REVOCATION_BATCH = 8
# How long one revocation call keeps taking batches before it leaves the rest
# to the next: a bulk change (a stop, a disconnect, a member removed) queues
# more than one batch, and a token left for the five-minute tick may outlive
# its own hour before it is reached.
REVOCATION_BUDGET_SECONDS = 20.0
REVOCATION_CLAIM = timedelta(seconds=90)
VENDOR_CALL_SECONDS = 8
ACCESS_WARNING = "Some access already given out may remain for up to 1 hour."


class ServiceError(Exception):
    """A refusal in the contract's envelope: `{"error": {code, message, retryable}}`."""

    def __init__(
        self, status_code: int, code: str, message: str, *, retryable: bool
    ) -> None:
        super().__init__(message)
        if code not in REASON_CODES:
            raise ValueError(f"Unknown reason code: {code!r}")
        self.status_code = status_code
        self.code = code
        self.message = message
        self.retryable = retryable

    def body(self) -> dict[str, Any]:
        return {
            "error": {
                "code": self.code,
                "message": self.message,
                "retryable": self.retryable,
            }
        }


@dataclass(frozen=True)
class Principal:
    """Who asks: a controller acting as the agent, or the agent's own key."""

    kind: Literal["controller", "agent_key"]
    controller_id: str | None
    controller_owner_id: str | None

    @classmethod
    def agent_key(cls) -> Principal:
        return cls("agent_key", None, None)

    @classmethod
    def controller(cls, controller_id: str, owner_id: str) -> Principal:
        return cls("controller", controller_id, owner_id)


@dataclass(frozen=True)
class GrantDecision:
    """What one grant allows, as every check before an issue found it."""

    grant_id: str
    grant_revision: int
    agent_id: str
    owner_id: str
    service: str
    access: AccessLevel
    reach: dict[str, Any]
    resources: dict[str, Any]
    tools: list[str]


@dataclass(frozen=True)
class ServiceToken:
    token: str = field(repr=False)
    expires_at: datetime
    resources: dict[str, Any]


def effective_tools(
    entry: Connection, access: AccessLevel, tool_mode: str, tools: list[str]
) -> list[str]:
    """The tools a grant gives: `allow` only those named, `deny` all but them."""
    level = entry.definition.level_tools(access)
    if tool_mode == "allow":
        return [tool for tool in level if tool in tools]
    return [tool for tool in level if tool not in tools]


def _narrows(
    before: tuple[str, dict[str, Any], str], after: tuple[str, dict[str, Any], str]
) -> bool:
    """Whether a replaced grant reaches less than it did, or another account.

    Tool lists do not count: they narrow what the agent is offered, not what
    an issued token can do.
    """
    old_access, old_resources, old_account = before
    new_access, new_resources, new_account = after
    if old_account != new_account or (old_access, new_access) == ("write", "read"):
        return True
    for key, old in old_resources.items():
        new = new_resources.get(key)
        if isinstance(old, list) and isinstance(new, list):
            if not set(old) <= set(new):
                return True
        elif old != new:
            return True
    return False


def _require_owners_controller(principal: Principal, owner_id: str | None) -> None:
    if principal.kind == "controller" and principal.controller_owner_id != owner_id:
        raise ServiceError(
            403,
            FORBIDDEN,
            "This controller belongs to someone other than the agent's owner.",
            retryable=False,
        )


def get_service_broker(request: Request) -> ServiceBroker:
    """The broker `main` installs on the agent bridge and the gateway."""
    broker = getattr(request.app.state, "service_broker", None)
    if not isinstance(broker, ServiceBroker):
        raise RuntimeError("No service broker is installed on this app.")
    return broker


class ServiceBroker:
    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        keyring: Keyring,
        catalog: dict[str, Connection],
        adapters: dict[str, ServiceAdapter],
        store: ServiceConnectionStore,
        token_retention: timedelta,
    ) -> None:
        unknown = sorted(set(adapters) - set(catalog))
        if unknown:
            raise ValueError(f"Adapters for services not in the catalog: {unknown}")
        self._session_factory = session_factory
        self._keyring = keyring
        self._catalog = catalog
        self._adapters = adapters
        self._store = store
        self._token_retention = token_retention
        # The access token being fetched for each connection, by (tenant,
        # owner, service), for callers that ask while it is.
        self._fetching: dict[tuple[str, str, str], asyncio.Task[str]] = {}

    def _entry(self, service: str) -> Connection:
        entry = self._catalog.get(service)
        if entry is None or not entry.definition.enabled:
            raise ServiceError(
                404, NOT_FOUND, f"No service named {service!r}.", retryable=False
            )
        return entry

    def _adapter(self, service: str) -> ServiceAdapter:
        """The adapter that issues for `service`, or the refusal saying why not."""
        adapter = self._refresher(service)
        if not adapter.can_issue:
            raise ServiceError(
                503,
                INTERNAL,
                self.availability(service) or "Not available on this server.",
                retryable=False,
            )
        return adapter

    def _refresher(self, service: str) -> ServiceAdapter:
        """The adapter that keeps `service`'s connections signed in."""
        adapter = self._adapters.get(service)
        if adapter is None:
            raise ServiceError(
                503,
                INTERNAL,
                f"{self._entry(service).definition.name} is not available on "
                "this server.",
                retryable=False,
            )
        return adapter

    # ── Grant decision ───────────────────────────────────────────────────────

    async def decide(
        self,
        session: AsyncSession,
        agent_id: str,
        principal: Principal,
        service: str,
    ) -> GrantDecision:
        """Run every issuance check, in order, in `session`."""
        return await self._decide(
            session, agent_id, principal, service, to_record=False
        )

    async def _decide(
        self,
        session: AsyncSession,
        agent_id: str,
        principal: Principal,
        service: str,
        *,
        to_record: bool,
    ) -> GrantDecision:
        entry = self._entry(service)
        name = entry.definition.name
        tenant_id = require_tenant_id()
        agent = await session.scalar(
            select(Agent)
            .where(Agent.tenant_id == tenant_id, Agent.id == agent_id)
            .execution_options(populate_existing=True)
        )
        if agent is None:
            raise ServiceError(
                403, FORBIDDEN, "This agent is not in this workspace.", retryable=False
            )
        if agent.owner_id is None:
            raise ServiceError(
                403, FORBIDDEN, "This agent has no owner to act for.", retryable=False
            )
        owner_id = agent.owner_id
        if (
            await session.get(
                TenantMember, (tenant_id, owner_id), populate_existing=True
            )
            is None
        ):
            raise ServiceError(
                403,
                FORBIDDEN,
                "This agent's owner is no longer a member of the workspace.",
                retryable=False,
            )
        launches = list(
            await session.execute(
                select(HostedLaunch.desired_state, HostedLaunch.state).where(
                    HostedLaunch.tenant_id == tenant_id,
                    HostedLaunch.agent_id == agent_id,
                    HostedLaunch.state != "deleted",
                )
            )
        )
        if launches and not any(
            desired == "running" and state not in ("error", "deleting")
            for desired, state in launches
        ):
            raise ServiceError(
                403,
                FORBIDDEN,
                f"Agent {agent.name} is a cloud agent whose launch is not running, "
                f"so it is issued no {name} token.",
                retryable=False,
            )

        grant = await (
            self._store.get_grant_to_record if to_record else self._store.get_grant
        )(session, agent_id, service)
        if grant is None:
            raise ServiceError(
                403,
                GRANT_MISSING,
                f"Agent {agent.name} has no {name} grant. Its owner can grant "
                f"{name} to it under the agent's Connections.",
                retryable=False,
            )
        if grant.owner_id != owner_id:
            raise ServiceError(
                403,
                FORBIDDEN,
                f"This agent's {name} grant was made by someone other than its owner.",
                retryable=False,
            )
        _require_owners_controller(principal, owner_id)

        connection = await self._store.get_connection(session, owner_id, service)
        if connection is None:
            raise ServiceError(
                404,
                CONNECTOR_NOT_CONNECTED,
                f"The agent's owner has not connected {name}. Connect it under "
                "Settings, Connections.",
                retryable=False,
            )
        if connection.status != "active":
            raise ServiceError(
                409,
                CONNECTOR_REVOKED,
                f"The agent's owner must reconnect {name}: its sign-in was "
                "revoked or has lapsed. Reconnect it under Settings, Connections.",
                retryable=False,
            )
        if grant.account_id != connection.account_id:
            raise ServiceError(
                409,
                GRANT_ACCOUNT_CHANGED,
                f"The {name} account connected now is not the one this grant was "
                f"made for. The owner must grant {name} to agent {agent.name} "
                "again.",
                retryable=False,
            )
        access: AccessLevel = "write" if grant.access == "write" else "read"
        if access == "write" and connection.consent != "write":
            raise ServiceError(
                403,
                FORBIDDEN,
                f"This grant asks for write access, but the {name} connection "
                "allows only reading. Reconnect with write access, or make the "
                "grant read-only.",
                retryable=False,
            )
        levels = entry.definition.access
        level = None if levels is None else getattr(levels, access)
        if level is None:
            raise ServiceError(
                403,
                FORBIDDEN,
                f"{name} has no {access} access level.",
                retryable=False,
            )
        return GrantDecision(
            grant_id=grant.id,
            grant_revision=grant.revision,
            agent_id=agent_id,
            owner_id=owner_id,
            service=service,
            access=access,
            reach=level.model_dump(exclude_none=True),
            resources=dict(grant.resources),
            tools=effective_tools(entry, access, grant.tool_mode, list(grant.tools)),
        )

    # ── Delivery ─────────────────────────────────────────────────────────────

    async def issue(
        self,
        session: AsyncSession,
        agent_id: str,
        principal: Principal,
        service: str,
    ) -> ServiceToken:
        """Issue the agent a token for `service`, valid for at most an hour.

        Ends `session`'s transaction before calling the vendor, and commits the
        issuance record in it.
        """
        outcome = INTERNAL
        try:
            token = await self._issue(session, agent_id, principal, service)
            outcome = "issued"
            return token
        except ServiceError as error:
            outcome = error.code
            raise
        finally:
            metrics().increment(
                SERVICE_TOKEN_REQUESTS,
                {
                    "connector": service if service in self._catalog else "unknown",
                    "outcome": outcome,
                },
            )

    async def _issue(
        self,
        session: AsyncSession,
        agent_id: str,
        principal: Principal,
        service: str,
    ) -> ServiceToken:
        decision = await self.decide(session, agent_id, principal, service)
        adapter = self._adapter(service)
        await session.commit()
        access_token = await self._access_token(decision.owner_id, service, adapter)
        request = IssueRequest(
            service=service,
            access=decision.access,
            reach=decision.reach,
            resources=decision.resources,
        )
        try:
            issued = await adapter.issue(access_token, request)
        except ReauthorizationRequiredError as error:
            raise await self._needs_reauthorization(
                decision.owner_id, service, error
            ) from None
        except ServiceUnavailableError as error:
            raise ServiceError(503, INTERNAL, str(error), retryable=True) from None
        except ServiceAdapterError as error:
            raise ServiceError(403, FORBIDDEN, str(error), retryable=False) from None
        try:
            now = datetime.now(UTC)
            if not (
                now + TOKEN_LEEWAY
                < issued.expires_at
                <= now + TOKEN_LIFETIME + TOKEN_LEEWAY
            ):
                raise ServiceError(
                    500,
                    INTERNAL,
                    f"{self._entry(service).definition.name} issued a token that "
                    "does not expire within an hour, so it was not handed out.",
                    retryable=False,
                )
            await self._record(session, decision, principal, issued)
        except BaseException as error:
            await self._discard(adapter, decision, principal, issued, session, error)
            raise
        return ServiceToken(issued.token, issued.expires_at, issued.resources)

    async def _record(
        self,
        session: AsyncSession,
        decision: GrantDecision,
        principal: Principal,
        issued: IssuedToken,
    ) -> None:
        """Record the token under the connection's lock, if nothing changed.

        A disconnect or a removed grant takes the same lock, so either it
        commits first, the checks below fail and the token is discarded, or
        this record commits first and its revocation covers the token. A cloud
        launch's stop or removal is ordered the same way by its launch lock.
        """
        try:
            await self._store.lock_cloud_launches(session, decision.agent_id)
            await self._store.lock_connection(
                session, decision.owner_id, decision.service
            )
        except ServiceConnectionBusy as error:
            raise ServiceError(503, INTERNAL, str(error), retryable=True) from None
        current = await self._decide(
            session, decision.agent_id, principal, decision.service, to_record=True
        )
        if current != decision:
            raise ServiceError(
                503,
                INTERNAL,
                "The grant changed while the token was issued. Please retry.",
                retryable=True,
            )
        self._store.add_issuance(
            session, self._issuance(decision, principal, issued, revoke_requested=False)
        )
        await session.commit()

    def _issuance(
        self,
        decision: GrantDecision,
        principal: Principal,
        issued: IssuedToken,
        *,
        revoke_requested: bool,
    ) -> ServiceTokenIssuance:
        return ServiceTokenIssuance(
            tenant_id=require_tenant_id(),
            grant_id=decision.grant_id,
            agent_id=decision.agent_id,
            owner_id=decision.owner_id,
            service=decision.service,
            principal=principal.kind,
            controller_id=principal.controller_id,
            permissions=decision.reach,
            resources=issued.resources,
            expires_at=issued.expires_at,
            token_sha256=hashlib.sha256(issued.token.encode()).hexdigest(),
            encrypted_token=(
                self._keyring.encrypt(issued.token) if issued.revocable else None
            ),
            revoke_requested=revoke_requested,
            attempts=0,
        )

    async def _discard(
        self,
        adapter: ServiceAdapter,
        decision: GrantDecision,
        principal: Principal,
        issued: IssuedToken,
        session: AsyncSession,
        original: BaseException,
    ) -> None:
        """Take back a token that was issued but must not be handed out.

        Revoked at once where the vendor allows it. Otherwise, or if that
        fails, it is recorded in a session of its own, queued for revocation
        where it can be revoked, so it is neither lost nor live unrecorded.
        """
        tenant_id = require_tenant_id()

        async def cleanup() -> None:
            try:
                await session.rollback()
            except Exception:
                logger.error(
                    "Rollback failed while discarding a %s token; original failure: %r",
                    decision.service,
                    original,
                    exc_info=True,
                )
            if issued.revocable:
                try:
                    async with asyncio.timeout(VENDOR_CALL_SECONDS):
                        await adapter.revoke_issued(issued.token)
                    return
                except Exception as error:
                    logger.error(
                        "A discarded %s token could not be revoked; queueing it: "
                        "error_type=%s",
                        decision.service,
                        type(error).__name__,
                    )
            else:
                logger.warning(
                    "A discarded %s token cannot be revoked and stays valid until "
                    "%s; recording it. Original failure: %r",
                    decision.service,
                    issued.expires_at.isoformat(),
                    original,
                )
            try:
                async with tenant_session(
                    self._session_factory, tenant_id
                ) as record_session:
                    self._store.add_issuance(
                        record_session,
                        self._issuance(
                            decision, principal, issued, revoke_requested=True
                        ),
                    )
                    await record_session.commit()
            except Exception as record_error:
                logger.error(
                    "A discarded %s token could not be recorded: error_type=%s",
                    decision.service,
                    type(record_error).__name__,
                )

        try:
            await finish_shielded(cleanup())
        except asyncio.CancelledError:
            logger.warning(
                "Discarding a %s token finished after the caller was cancelled; "
                "original failure: %r",
                decision.service,
                original,
            )
            raise

    # ── Connection credential ────────────────────────────────────────────────

    async def _access_token(
        self, owner_id: str, service: str, adapter: ServiceAdapter
    ) -> str:
        """A usable access token for the owner's connection.

        In a transaction of its own, which outlives the caller being
        cancelled: a rotating refresh spends the old refresh token, so the new
        one must be stored once the vendor has returned it.

        Callers asking for one connection at once share one fetch. The
        connection's lock still serialises refreshes, but every agent of an
        owner renewing together would otherwise each hold a database
        connection queued on that lock while one refresh takes its time, and
        give up at the lock's timeout.
        """
        key = (require_tenant_id(), owner_id, service)
        fetching = self._fetching.get(key)
        if fetching is None:
            fetching = asyncio.create_task(self._fresh_access_token(*key, adapter))
            self._fetching[key] = fetching
            fetching.add_done_callback(lambda done: self._fetched(key, done))
        return await asyncio.shield(fetching)

    def _fetched(self, key: tuple[str, str, str], done: asyncio.Task[str]) -> None:
        if self._fetching.get(key) is done:
            del self._fetching[key]
        # Its callers see a failure; one none of them stayed to see is logged.
        if not done.cancelled() and (error := done.exception()) is not None:
            if not isinstance(error, ServiceError):
                logger.error(
                    "Fetching a %s access token failed", key[2], exc_info=error
                )

    async def _fresh_access_token(
        self, tenant_id: str, owner_id: str, service: str, adapter: ServiceAdapter
    ) -> str:
        name = self._entry(service).definition.name
        refresh = self._entry(service).definition.auth.refresh
        async with tenant_session(self._session_factory, tenant_id) as session:
            try:
                await self._store.lock_connection(session, owner_id, service)
            except ServiceConnectionBusy as error:
                raise ServiceError(503, INTERNAL, str(error), retryable=True) from None
            connection = await self._store.get_connection(session, owner_id, service)
            if connection is None:
                raise ServiceError(
                    404,
                    CONNECTOR_NOT_CONNECTED,
                    f"The agent's owner has not connected {name}.",
                    retryable=False,
                )
            if connection.status != "active":
                raise ServiceError(
                    409,
                    CONNECTOR_REVOKED,
                    f"The agent's owner must reconnect {name} under Settings, "
                    "Connections.",
                    retryable=False,
                )
            secret = self._secret(connection)
            token = secret.access_token
            fresh = secret.expires_at > time.time() + REFRESH_BEFORE.total_seconds()
            if refresh == "none" or (token is not None and fresh):
                if token is None:
                    raise ServiceError(
                        500,
                        INTERNAL,
                        f"The {name} connection holds no token.",
                        retryable=False,
                    )
                await session.commit()
                return token
            try:
                renewed = await adapter.refresh(secret)
            except ReauthorizationRequiredError as error:
                await self._store.mark_needs_reauthorization(
                    session, owner_id, service, "refresh_refused"
                )
                await session.commit()
                raise self._revoked(service, error) from None
            except ServiceUnavailableError as error:
                raise ServiceError(503, INTERNAL, str(error), retryable=True) from None
            except ServiceAdapterError as error:
                raise ServiceError(503, INTERNAL, str(error), retryable=False) from None
            token = renewed.access_token
            if token is None:
                raise ServiceError(
                    500,
                    INTERNAL,
                    f"{name} returned no access token on refresh.",
                    retryable=False,
                )
            await self._store.replace_secret(
                session,
                owner_id,
                service,
                revision=connection.secret_revision,
                encrypted_secret=self._keyring.encrypt(json.dumps(renewed.values)),
            )
            await session.commit()
            return token

    def _revoked(self, service: str, error: Exception) -> ServiceError:
        name = self._entry(service).definition.name
        return ServiceError(
            409,
            CONNECTOR_REVOKED,
            f"{error} The agent's owner must reconnect {name} under Settings, "
            "Connections.",
            retryable=False,
        )

    async def _needs_reauthorization(
        self, owner_id: str, service: str, error: Exception
    ) -> ServiceError:
        """Record that the vendor refused the owner's sign-in; the refusal to raise.

        In a transaction of its own: the vendor's answer stands whatever the
        caller's transaction does next.
        """
        tenant_id = require_tenant_id()

        async def mark() -> None:
            async with tenant_session(self._session_factory, tenant_id) as session:
                await self._store.mark_needs_reauthorization(
                    session, owner_id, service, "sign_in_refused"
                )
                await session.commit()

        await finish_shielded(mark())
        return self._revoked(service, error)

    def _secret(self, connection: ServiceConnection) -> ConnectionSecret:
        return ConnectionSecret(
            json.loads(self._keyring.decrypt(connection.encrypted_secret))
        )

    # ── Access changes ───────────────────────────────────────────────────────

    async def grants_for(
        self, session: AsyncSession, agent: Agent, principal: Principal
    ) -> list[dict[str, Any]]:
        """The agent's grants as its host reads them when a session starts.

        A controller reads them only for its owner's agents, the same rule
        issuing holds it to.
        """
        _require_owners_controller(principal, agent.owner_id)
        grants = []
        for grant in await self._store.list_grants(session, agent.id):
            entry = self._catalog.get(grant.service)
            skill = None if entry is None else entry.skill_files.get("SKILL.md")
            grants.append(
                {
                    "service": grant.service,
                    "access": grant.access,
                    "tool_mode": grant.tool_mode,
                    "tools": list(grant.tools),
                    "resources": dict(grant.resources),
                    "skill": (
                        None
                        if skill is None
                        else {"name": grant.service, "content": skill}
                    ),
                }
            )
        return grants

    def connectable(self, service: str) -> bool:
        """Whether a person can connect `service` here: it has an adapter."""
        entry = self._catalog.get(service)
        return (
            entry is not None and entry.definition.enabled and service in self._adapters
        )

    def availability(self, service: str) -> str | None:
        """Why `service` cannot be granted on this server, or None if it can."""
        entry = self._catalog.get(service)
        if entry is None or not entry.definition.enabled:
            return "Not available yet."
        adapter = self._adapters.get(service)
        if adapter is None:
            return f"{entry.definition.name} is not set up on this server."
        if not adapter.can_issue:
            return (
                f"{entry.definition.name} can be connected on this server but "
                "not granted to agents: it is not fully set up."
            )
        return None

    def summary(self, agent_name: str, grant: ServiceGrant) -> str:
        """A grant's reach in a sentence, as the vendor's adapter words it."""
        access: AccessLevel = "write" if grant.access == "write" else "read"
        adapter = self._adapters.get(grant.service)
        if adapter is not None:
            return adapter.summary(agent_name, access, dict(grant.resources))
        verb = "read and write" if access == "write" else "read"
        return f"{agent_name} can {verb} {self._entry(grant.service).definition.name}."

    async def set_grant(
        self,
        session: AsyncSession,
        *,
        agent: Agent,
        actor_id: str,
        service: str,
        access: AccessLevel | None,
        tool_mode: Literal["allow", "deny"] | None,
        tools: list[str] | None,
        resources: dict[str, Any],
    ) -> tuple[ServiceGrant, str | None]:
        """Create or replace the agent's grant on its owner's own connection.

        A new grant with no `access` reads, with the level's tools. Commits
        `session`. Replacing a grant with one that reaches less, or on a
        different account, revokes what was issued under the old one, and the
        warning says when some of it could not be revoked yet.
        """
        if agent.owner_id != actor_id:
            raise ServiceError(404, NOT_FOUND, "Agent not found.", retryable=False)
        if service not in self._catalog:
            raise ServiceError(
                404, NOT_FOUND, f"No service named {service!r}.", retryable=False
            )
        unavailable = self.availability(service)
        if unavailable is not None:
            raise ServiceError(422, VALIDATION_ERROR, unavailable, retryable=False)
        entry = self._entry(service)
        name = entry.definition.name
        adapter = self._adapter(service)
        connection = await self._store.get_connection(session, actor_id, service)
        if connection is None:
            raise ServiceError(
                409,
                CONNECTOR_NOT_CONNECTED,
                f"Connect {name} under Settings, Connections first.",
                retryable=False,
            )
        if connection.status != "active":
            raise ServiceError(
                409,
                CONNECTOR_REVOKED,
                f"Reconnect {name} under Settings, Connections first.",
                retryable=False,
            )
        level_name: AccessLevel = access or "read"
        if level_name == "write" and connection.consent != "write":
            raise ServiceError(
                422,
                VALIDATION_ERROR,
                f"Your {name} connection allows only reading. Reconnect with "
                "write access to grant writing.",
                retryable=False,
            )
        levels = entry.definition.access
        level = None if levels is None else getattr(levels, level_name)
        if level is None:
            raise ServiceError(
                422,
                VALIDATION_ERROR,
                f"{name} has no {level_name} access level.",
                retryable=False,
            )
        mode: Literal["allow", "deny"] = tool_mode or (
            "allow" if level_name == "read" else "deny"
        )
        level_tools = entry.definition.level_tools(level_name)
        chosen = (
            tools if tools is not None else (level_tools if mode == "allow" else [])
        )
        unknown = sorted(set(chosen) - set(level_tools))
        if unknown:
            raise ServiceError(
                422,
                VALIDATION_ERROR,
                f"Not {level_name} tools of {name}: {', '.join(unknown)}.",
                retryable=False,
            )
        reach = level.model_dump(exclude_none=True)
        await session.commit()

        access_token = await self._access_token(actor_id, service, adapter)
        request = IssueRequest(
            service=service, access=level_name, reach=reach, resources=resources
        )
        try:
            checked = await adapter.check_grant(access_token, request)
        except ReauthorizationRequiredError as error:
            raise await self._needs_reauthorization(actor_id, service, error) from None
        except ServiceUnavailableError as error:
            raise ServiceError(503, INTERNAL, str(error), retryable=True) from None
        except ServiceAdapterError as error:
            raise ServiceError(
                422, VALIDATION_ERROR, str(error), retryable=False
            ) from None

        try:
            await self._store.lock_connection(session, actor_id, service)
        except ServiceConnectionBusy as error:
            raise ServiceError(503, INTERNAL, str(error), retryable=True) from None
        connection = await self._store.get_connection(session, actor_id, service)
        if connection is None or connection.status != "active":
            raise ServiceError(
                409,
                CONNECTOR_REVOKED,
                f"Your {name} connection changed. Please retry.",
                retryable=True,
            )
        previous = await self._store.get_grant(session, agent.id, service)
        before = (
            None
            if previous is None
            else (previous.access, dict(previous.resources), previous.account_id)
        )
        grant = await self._store.save_grant(
            session,
            agent_id=agent.id,
            owner_id=actor_id,
            service=service,
            access=level_name,
            tool_mode=mode,
            tools=chosen,
            resources=checked,
            account_id=connection.account_id,
            created_by=actor_id,
        )
        narrowed = before is not None and _narrows(
            before, (level_name, checked, connection.account_id)
        )
        if narrowed:
            await self._store.queue_revocation(
                session, ServiceTokenIssuance.grant_id == grant.id
            )
        await record_audit_event(
            session,
            tenant_id=require_tenant_id(),
            actor_user_id=actor_id,
            action=AuditAction.SERVICE_GRANT_SET,
            target_type="agent",
            target_id=agent.id,
            details={
                "service": service,
                "access": level_name,
                "tool_mode": mode,
                "tools": chosen,
                "resources": checked,
            },
        )
        grant_id = grant.id
        await session.commit()
        if not narrowed:
            return grant, None
        pending = await self.revoke_pending(
            session, (ServiceTokenIssuance.grant_id == grant_id,)
        )
        return grant, ACCESS_WARNING if pending else None

    async def connect(
        self,
        session: AsyncSession,
        *,
        user_id: str,
        service: str,
        consent: AccessLevel,
        granted_scopes: list[str],
        account_id: str,
        external_identity: str,
        secret: ConnectionSecret,
    ) -> str | None:
        """Link the person's account, or re-link it in place.

        Re-linking keeps the grants (a different account then fails them with
        `grant_account_changed`) and revokes what was issued on the old
        sign-in, and the old sign-in itself when it is not the new one.
        Commits `session`; returns a warning naming what could not be revoked.
        """
        name = self._entry(service).definition.name
        try:
            await self._store.lock_connection(session, user_id, service)
        except ServiceConnectionBusy as error:
            raise ServiceError(503, INTERNAL, str(error), retryable=True) from None
        previous = await self._store.get_connection(session, user_id, service)
        replaced = None if previous is None else self._secret(previous)
        issued_on_it = (
            ServiceTokenIssuance.owner_id == user_id,
            ServiceTokenIssuance.service == service,
        )
        await self._store.queue_revocation(session, *issued_on_it)
        await self._store.save_connection(
            session,
            user_id=user_id,
            service=service,
            consent=consent,
            granted_scopes=granted_scopes,
            account_id=account_id,
            external_identity=external_identity,
            encrypted_secret=self._keyring.encrypt(json.dumps(secret.values)),
        )
        await record_audit_event(
            session,
            tenant_id=require_tenant_id(),
            actor_user_id=user_id,
            action=AuditAction.SERVICE_CONNECTED,
            target_type="user",
            target_id=user_id,
            details={"service": service, "relinked": previous is not None},
        )
        await session.commit()

        warnings = []
        if replaced is not None and replaced.access_token != secret.access_token:
            adapter = self._adapters.get(service)
            try:
                if adapter is None:
                    raise ServiceUnavailableError(
                        f"{name} is not available on this server."
                    )
                async with asyncio.timeout(VENDOR_CALL_SECONDS):
                    await adapter.revoke_connection(replaced)
            except Exception as error:
                logger.error(
                    "%s old sign-in revocation failed: error_type=%s",
                    service,
                    type(error).__name__,
                )
                warnings.append(
                    f"{name} could not revoke the old sign-in. Revoke it in your "
                    f"{name} settings."
                )
        if await self.revoke_pending(session, issued_on_it):
            warnings.append(ACCESS_WARNING)
        return " ".join(warnings) or None

    async def connection_access_token(
        self, session: AsyncSession, user_id: str, service: str
    ) -> str | None:
        """The person's own access token for `service`, refreshed if due, or
        None when they have not connected it. Ends `session`'s transaction.

        For listing what the person can reach (GitHub's installations and
        repositories) while choosing what to grant; never handed to an agent.
        """
        if await self._store.get_connection(session, user_id, service) is None:
            return None
        await session.commit()
        return await self._access_token(user_id, service, self._refresher(service))

    async def queue_agent_revocation(
        self, session: AsyncSession, agent_id: str, service: str
    ) -> tuple[Any, ...]:
        """End what the agent was given for `service`, in the caller's
        transaction: queue every live token issued to it, and move its grant on
        so a token being issued right now is taken back rather than recorded.
        Returns the conditions to hand `revoke_pending` once the caller has
        committed.

        Takes no connection lock, so it never waits on a refresh at the
        vendor; at most on a token being recorded, which is quick.
        """
        await self._store.bump_grant(session, agent_id, service)
        conditions = (
            ServiceTokenIssuance.agent_id == agent_id,
            ServiceTokenIssuance.service == service,
        )
        await self.queue_revocation(session, *conditions)
        return conditions

    async def queue_revocation(self, session: AsyncSession, *conditions: Any) -> None:
        """Queue the live tokens matching `conditions`, in the caller's
        transaction, for an access change the broker does not make itself."""
        await self._store.queue_revocation(
            session, ServiceTokenIssuance.revoke_requested.is_(False), *conditions
        )

    async def revoke_grant(
        self, session: AsyncSession, grant: ServiceGrant, actor_id: str
    ) -> str | None:
        """Remove a grant and revoke the tokens issued under it.

        Commits `session`. Returns a warning when some of those tokens could
        not be revoked yet; the periodic tick keeps trying.
        """
        grant_id = grant.id
        agent_id = grant.agent_id
        service = grant.service
        try:
            await self._store.lock_connection(session, grant.owner_id, service)
        except ServiceConnectionBusy as error:
            raise ServiceError(503, INTERNAL, str(error), retryable=True) from None
        await self._store.queue_revocation(
            session, ServiceTokenIssuance.grant_id == grant_id
        )
        await self._store.delete_grant(session, grant_id)
        await record_audit_event(
            session,
            tenant_id=require_tenant_id(),
            actor_user_id=actor_id,
            action=AuditAction.SERVICE_GRANT_REMOVED,
            target_type="agent",
            target_id=agent_id,
            details={"service": service},
        )
        await session.commit()
        pending = await self.revoke_pending(
            session, (ServiceTokenIssuance.grant_id == grant_id,)
        )
        return ACCESS_WARNING if pending else None

    async def disconnect(
        self, session: AsyncSession, user_id: str, service: str
    ) -> str | None:
        """Delete a connection, its grants, and what was issued on it.

        Commits `session`, then revokes the sign-in at the vendor where the
        service allows it. Returns a warning naming whatever could not be
        revoked.
        """
        name = self._entry(service).definition.name
        removed = await self._remove_connection(session, user_id, service)
        if removed is None:
            raise ServiceError(
                404,
                CONNECTOR_NOT_CONNECTED,
                f"{name} is not connected.",
                retryable=False,
            )
        await record_audit_event(
            session,
            tenant_id=require_tenant_id(),
            actor_user_id=user_id,
            action=AuditAction.SERVICE_DISCONNECTED,
            target_type="user",
            target_id=user_id,
            details={"service": service},
        )
        await session.commit()
        return await self.finish_disconnect(session, user_id, [(service, removed)])

    async def remove_connections(
        self, session: AsyncSession, user_id: str
    ) -> list[tuple[str, ConnectionSecret]]:
        """Delete every connection `user_id` holds here, in the caller's
        transaction, and queue what was issued on them.

        For removing a member: the caller commits with the membership, then
        hands the result to `finish_disconnect`.
        """
        removed = []
        for connection in await self._store.list_connections(session, user_id):
            secret = await self._remove_connection(session, user_id, connection.service)
            if secret is not None:
                removed.append((connection.service, secret))
        return removed

    async def _remove_connection(
        self, session: AsyncSession, user_id: str, service: str
    ) -> ConnectionSecret | None:
        try:
            await self._store.lock_connection(session, user_id, service)
        except ServiceConnectionBusy as error:
            raise ServiceError(503, INTERNAL, str(error), retryable=True) from None
        connection = await self._store.get_connection(session, user_id, service)
        if connection is None:
            return None
        secret = self._secret(connection)
        await self._store.queue_revocation(
            session,
            ServiceTokenIssuance.owner_id == user_id,
            ServiceTokenIssuance.service == service,
        )
        await self._store.delete_connection(session, user_id, service)
        return secret

    async def finish_disconnect(
        self,
        session: AsyncSession,
        user_id: str,
        removed: list[tuple[str, ConnectionSecret]],
    ) -> str | None:
        """After the removal has committed: revoke each sign-in at its vendor,
        and the tokens issued on it. A warning names what could not be."""
        warnings = []
        for service, secret in removed:
            entry = self._catalog.get(service)
            name = service if entry is None else entry.definition.name
            adapter = self._adapters.get(service)
            try:
                if adapter is None:
                    raise ServiceUnavailableError(
                        f"{name} is not available on this server."
                    )
                async with asyncio.timeout(VENDOR_CALL_SECONDS):
                    await adapter.revoke_connection(secret)
            except Exception as error:
                logger.error(
                    "%s sign-in revocation failed: error_type=%s",
                    service,
                    type(error).__name__,
                )
                warnings.append(
                    f"{name} could not revoke the sign-in. Revoke it in your "
                    f"{name} settings."
                )
        if removed and await self.revoke_pending(
            session, (ServiceTokenIssuance.owner_id == user_id,)
        ):
            warnings.append(ACCESS_WARNING)
        return " ".join(warnings) or None

    # ── Revocation and retention ─────────────────────────────────────────────

    async def revoke_pending(
        self, session: AsyncSession, conditions: tuple[Any, ...]
    ) -> bool:
        """One bounded revocation pass over the bound tenant; whether any remain.

        Run after an access change has committed, so a failure here leaves the
        change in place and the tokens queued: it is logged, and the periodic
        tick tries again. The pass runs in a session of its own: a failure
        rolls that back, never `session`, whose rows the caller may still be
        reading for its response.
        """
        if session.in_transaction():
            raise RuntimeError("Commit the access change before revoking its tokens.")
        deadline = time.monotonic() + REVOCATION_BUDGET_SECONDS
        try:
            async with tenant_session(
                self._session_factory, require_tenant_id()
            ) as own:
                # Batch after batch, until none remain, a batch revokes nothing
                # (what is left keeps failing: the tick tries again), or the
                # time is up. A failed token sorts last, by its attempts.
                while True:
                    revoked, pending = await self._revoke_pending(own, conditions)
                    if not pending or not revoked or time.monotonic() >= deadline:
                        return pending
        except Exception as error:
            logger.error(
                "Service token revocation is pending after a failed pass: "
                "error_type=%s",
                type(error).__name__,
            )
            return True

    async def _revoke_pending(
        self, session: AsyncSession, conditions: tuple[Any, ...]
    ) -> tuple[int, bool]:
        """One batch: how many it revoked, and whether any remain."""
        # Most workspaces hold no token at any moment: one read, and done.
        if not await self._store.holds_tokens(session):
            await session.commit()
            return 0, False
        tenant_id = require_tenant_id()
        now = datetime.now(UTC)
        await session.execute(text("SET LOCAL lock_timeout = '2s'"))
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": f"service-revocation:{tenant_id}"},
        )
        await self._store.clear_expired(session, now)
        await self._store.queue_orphaned(session)
        until = now + REVOCATION_CLAIM
        rows = await self._store.claim_revocations(
            session, conditions, now=now, until=until, limit=REVOCATION_BATCH
        )
        claimed = [(row.id, row.service, row.encrypted_token) for row in rows]
        await session.commit()

        async def revoke(
            row_id: str, service: str, encrypted: str | None
        ) -> str | None:
            adapter = self._adapters.get(service)
            try:
                if adapter is None or encrypted is None:
                    raise ServiceUnavailableError(
                        f"{service} is not available on this server."
                    )
                async with asyncio.timeout(VENDOR_CALL_SECONDS):
                    await adapter.revoke_issued(self._keyring.decrypt(encrypted))
                return row_id
            except Exception as error:
                logger.error(
                    "Service token revocation failed: tenant=%s service=%s "
                    "issuance=%s error_type=%s",
                    tenant_id,
                    service,
                    row_id,
                    type(error).__name__,
                )
                return None

        revoked = [
            row_id
            for row_id in await asyncio.gather(*(revoke(*row) for row in claimed))
            if row_id
        ]
        await self._store.finish_revocations(
            session,
            claimed_ids=[row_id for row_id, _, _ in claimed],
            revoked_ids=revoked,
            until=until,
        )
        pending = await self._store.revocation_pending(session, conditions)
        await session.commit()
        return len(revoked), pending

    async def prune(self, session: AsyncSession) -> int:
        """Delete the bound tenant's issuance records past retention; commits."""
        pruned = await self._store.prune(
            session, datetime.now(UTC) - self._token_retention
        )
        await session.commit()
        return pruned
