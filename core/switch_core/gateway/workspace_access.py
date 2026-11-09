"""Taking away what someone's own credentials let them do in one workspace.

A bearer credential resolves its workspace from its own row and never
consults membership, so whoever stops standing in a workspace (removed from
it, or no longer their organization's `org_admin` where that was their only
standing) has their personal API keys, service connections and sign-ins
under way there removed, or would keep working, invisible access. Agents they
own are refused rather than removed: see `gateway/tenants.py`'s
`remove_member` for why.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.connections.broker import ServiceBroker, SignIn
from switch_core.connections.sign_in_flows import SignInFlows
from switch_core.db.models import Agent
from switch_core.db.stores.api_key_store import ApiKeyStore


@dataclass(frozen=True)
class RevokedAccess:
    key_hashes: list[str]
    removed_services: list[tuple[str, SignIn]] = field(repr=False)


async def revoke_workspace_access(
    session: AsyncSession,
    user_id: str,
    *,
    api_key_store: ApiKeyStore,
    broker: ServiceBroker,
    sign_in_flows: SignInFlows,
    keep_agent_keys: bool,
) -> RevokedAccess:
    """Remove `user_id`'s keys, service connections and sign-ins under way in
    the bound workspace, in the caller's transaction. Raises `ServiceError`
    when a connection is busy, before anything is removed. The caller
    commits, then calls `finish_revocation`.

    `keep_agent_keys` keeps the keys agents' rows point at, for a caller that
    leaves those agents in place rather than refusing while they exist. Such a
    key authenticates as its agent, never as the person (`bridges/agent/auth.py`),
    or, retired, as nothing; keeping it leaves the agent in place and the
    person nothing of their own, and deleting it would fail on the agent's
    reference anyway. Every other key of theirs goes.
    """
    removed_services = await broker.remove_connections(session, user_id)
    keys = await api_key_store.get_by_user(session, user_id)
    if keep_agent_keys and keys:
        in_use = set(
            await session.scalars(
                select(Agent.api_key_id).where(
                    Agent.api_key_id.in_([key.id for key in keys])
                )
            )
        )
        keys = [key for key in keys if key.id not in in_use]
    for key in keys:
        await api_key_store.delete(session, key.id)
    await sign_in_flows.discard_for_user(session, user_id, None)
    return RevokedAccess([key.key_hash for key in keys], removed_services)


async def finish_revocation(
    session: AsyncSession,
    user_id: str,
    revoked: RevokedAccess,
    *,
    protocol: AgentCore,
    broker: ServiceBroker,
) -> str | None:
    """After the revocation has committed: forget the keys, and revoke each
    sign-in at its vendor. A warning names what could not be."""
    for key_hash in revoked.key_hashes:
        protocol.api_key_cache.invalidate(key_hash)
    return await broker.finish_disconnect(session, user_id, revoked.removed_services)
