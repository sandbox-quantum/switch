"""Telling Switch Trust which agents this deployment runs.

Switch Trust keeps an inventory of AI agents, and shows each one with what it
is made of: the coding agent behind it, its model, its tools, the services it
may reach, and the settings that decide how far it may act on its own. This
module sends it Switch's agents, one snapshot per tenant, to
`{endpoint}/integrations/switch-rooms/agents/sync` under the API key in the
`trust_settings` row. Nothing is sent while no key is stored.

**A snapshot is complete.** It lists every agent in the tenant, and Switch
Trust drops whatever an earlier snapshot listed that this one does not, so a
deleted agent leaves the inventory on the next pass. A tenant that is itself
gone is sent once more with no agents.

**Sent when something changed.** One process runs the sync for the whole
deployment (`own_inventory_sync`, owned work in `ownership.py`). Every
`SYNC_INTERVAL_SECONDS` it builds each tenant's snapshot and sends it only if
it differs from the last one sent, or `REFRESH_EVERY_SECONDS` have passed.
Reading the tables beats hooking every place an agent, its definition or its
grants can change, in whichever process changes them: none can be missed. A
settings change (`trust/signals.py`) sends everything again on the next pass.

**What is sent.** Names, description, the runtime, the model, the permission
settings, the addressing preset, the owner's name, tools and granted
services. A managed agent's instructions only when an operator has turned on
`share_agent_instructions`. Never a credential, a message or a file.

Inventory and checks are separate: the sync costs nothing in Switch Trust,
and each agent's guardrail checks carry the same identity
(`trust/identity.py`), so they land on the agent the inventory describes.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import policy_kind
from switch_core.db.models import (
    Agent,
    AgentDefinition,
    ServiceGrant,
    Tenant,
    Tool,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.trust_settings_store import TrustSettingsStore
from switch_core.db.tenant_lookup import all_tenant_ids
from switch_core.keys import Keyring
from switch_core.ownership import Fence, OwnedKind, Ownership
from switch_core.providers.registry import UnknownProvider, agent_provider
from switch_core.tenant_context import no_tenant
from switch_core.trust.identity import agent_fingerprint

logger = logging.getLogger(__name__)

SYNC_PATH = "/integrations/switch-rooms/agents/sync"

SYNC_INTERVAL_SECONDS = 60.0

# An unchanged snapshot is sent again this often, so an inventory Switch Trust
# lost, or one from before a change it missed, does not stay wrong for good.
REFRESH_EVERY_SECONDS = 6 * 3600.0

# A snapshot can be large and is not on any message's path.
SYNC_TIMEOUT_SECONDS = 30.0

# Switch Trust's limits on a snapshot. Over the agent, tool or service limit,
# the tenant is not sent at all and the reason is logged: a partial snapshot
# would drop the agents it left out from the inventory. A description is the
# one free-text field Switch does not bound itself, so it is cut to fit.
MAX_AGENTS = 1000
MAX_TOOLS_PER_AGENT = 200
MAX_SERVICES_PER_AGENT = 100
MAX_DESCRIPTION_BYTES = 4096


class InventorySyncError(Exception):
    """Switch Trust refused or failed a snapshot, or answered one wrongly."""


@dataclass(frozen=True)
class ServerIdentity:
    """This deployment, as every snapshot names it. `id` is part of every
    agent's fingerprint, so it must never change."""

    id: str
    name: str
    version: str | None


@dataclass(frozen=True)
class InventoryTarget:
    endpoint: str
    api_key: str
    share_instructions: bool


async def read_target(
    session_factory: async_sessionmaker[AsyncSession],
    store: TrustSettingsStore,
    keyring: Keyring,
) -> InventoryTarget | None:
    """Where to send the inventory, or None while no API key is stored."""
    async with session_factory() as session:
        settings = await store.get(session)
    if settings is None or not settings.api_key_encrypted:
        return None
    return InventoryTarget(
        endpoint=settings.endpoint,
        api_key=keyring.decrypt(settings.api_key_encrypted),
        share_instructions=settings.share_agent_instructions,
    )


def _cut_to_bytes(text: str, limit: int) -> str:
    encoded = text.encode()
    if len(encoded) <= limit:
        return text
    return encoded[:limit].decode(errors="ignore")


def _definition_tools(definition: dict[str, Any]) -> list[dict[str, str]]:
    try:
        provider = agent_provider(definition["provider"])
    except UnknownProvider:
        # A definition stored for a provider this release no longer runs.
        # Its agent is still listed; only the provider's tools are unknown.
        return []
    return [{"name": t.name, "description": t.description} for t in provider.tools]


def _agent_entry(
    agent: Agent,
    definition: AgentDefinition | None,
    tools: Sequence[Tool],
    grants: Sequence[ServiceGrant],
    owner_name: str | None,
    share_instructions: bool,
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": agent.id,
        "name": agent.name,
        "kind": "managed" if definition is not None else "registered",
        "addressing": policy_kind(agent.addressing_policy),
    }
    if agent.display_name:
        entry["display_name"] = agent.display_name
    if agent.description:
        entry["description"] = _cut_to_bytes(agent.description, MAX_DESCRIPTION_BYTES)
    metadata = agent.metadata_ or {}
    runtime = metadata.get("known_agent_type")
    if isinstance(runtime, str) and runtime:
        entry["runtime"] = runtime
    if owner_name:
        entry["owner"] = owner_name

    declared: list[dict[str, str]] = []
    if definition is not None:
        doc = definition.definition
        if doc.get("model"):
            entry["model"] = doc["model"]
        entry["auto_approve"] = bool(doc.get("auto_approve", False))
        # A definition stored before `auto_mode` existed lacks it, which
        # reads as off.
        entry["auto_mode"] = bool(doc.get("auto_mode", False))
        permission_mode = (doc.get("advanced_config") or {}).get("permissionMode")
        if isinstance(permission_mode, str) and permission_mode:
            entry["permission_mode"] = permission_mode
        if share_instructions and doc.get("instructions"):
            entry["instructions"] = doc["instructions"]
        declared.extend(_definition_tools(doc))
    declared.extend(
        {"name": t.name, "description": t.description} for t in tools if t.name
    )
    seen: set[str] = set()
    unique_tools: list[dict[str, str]] = []
    for tool in declared:
        if tool["name"] in seen:
            continue
        seen.add(tool["name"])
        unique_tools.append({k: v for k, v in tool.items() if v})
    if unique_tools:
        entry["tools"] = unique_tools
    if grants:
        entry["mcp_servers"] = [
            {"name": g.service, "access": g.access}
            for g in sorted(grants, key=lambda g: g.service)
        ]
    return entry


async def build_snapshot(
    session: AsyncSession,
    *,
    server: ServerIdentity,
    tenant_id: str,
    share_instructions: bool,
) -> dict[str, Any]:
    """Every agent of the tenant bound to `session`, as one snapshot.

    Each query names the tenant itself rather than leaning on row-level
    security, which does not narrow a connection as the tables' owner.
    """
    tenant = (
        await session.execute(select(Tenant).where(Tenant.id == tenant_id))
    ).scalar_one()
    agents = (
        (
            await session.execute(
                select(Agent).where(Agent.tenant_id == tenant_id).order_by(Agent.id)
            )
        )
        .scalars()
        .all()
    )
    definitions = {
        d.agent_id: d
        for d in (
            await session.execute(
                select(AgentDefinition).where(AgentDefinition.tenant_id == tenant_id)
            )
        )
        .scalars()
        .all()
    }
    tools_by_agent: dict[str, list[Tool]] = {}
    for tool in (
        (
            await session.execute(
                select(Tool).where(Tool.tenant_id == tenant_id).order_by(Tool.name)
            )
        )
        .scalars()
        .all()
    ):
        tools_by_agent.setdefault(tool.agent_id, []).append(tool)
    grants_by_agent: dict[str, list[ServiceGrant]] = {}
    for grant in (
        (
            await session.execute(
                select(ServiceGrant).where(ServiceGrant.tenant_id == tenant_id)
            )
        )
        .scalars()
        .all()
    ):
        grants_by_agent.setdefault(grant.agent_id, []).append(grant)
    owner_ids = {a.owner_id for a in agents if a.owner_id}
    owners: dict[str, str] = {}
    if owner_ids:
        owners = {
            row.id: row.name
            for row in (
                await session.execute(
                    select(User.id, User.name).where(User.id.in_(owner_ids))
                )
            ).all()
        }

    server_entry: dict[str, str] = {"id": server.id, "name": server.name}
    if server.version:
        server_entry["version"] = server.version
    return {
        "server": server_entry,
        "tenant": {"id": tenant.id, "name": tenant.name},
        "agents": [
            _agent_entry(
                agent,
                definitions.get(agent.id),
                tools_by_agent.get(agent.id, []),
                grants_by_agent.get(agent.id, []),
                owners.get(agent.owner_id) if agent.owner_id else None,
                share_instructions,
            )
            for agent in agents
        ],
    }


def empty_snapshot(server: ServerIdentity, tenant_id: str) -> dict[str, Any]:
    """The snapshot of a tenant that no longer exists: no agents."""
    server_entry: dict[str, str] = {"id": server.id, "name": server.name}
    if server.version:
        server_entry["version"] = server.version
    return {"server": server_entry, "tenant": {"id": tenant_id}, "agents": []}


def over_limits(snapshot: dict[str, Any]) -> str | None:
    """Why Switch Trust would refuse the snapshot on size, or None."""
    agents = snapshot["agents"]
    if len(agents) > MAX_AGENTS:
        return f"{len(agents)} agents, over the limit of {MAX_AGENTS}"
    for agent in agents:
        if len(agent.get("tools", [])) > MAX_TOOLS_PER_AGENT:
            return (
                f"agent {agent['id']} declares {len(agent['tools'])} tools, "
                f"over the limit of {MAX_TOOLS_PER_AGENT}"
            )
        if len(agent.get("mcp_servers", [])) > MAX_SERVICES_PER_AGENT:
            return (
                f"agent {agent['id']} has {len(agent['mcp_servers'])} services, "
                f"over the limit of {MAX_SERVICES_PER_AGENT}"
            )
    return None


async def post_snapshot(
    client: httpx.AsyncClient,
    *,
    target: InventoryTarget,
    snapshot: dict[str, Any],
) -> None:
    """Send one snapshot. Raises `InventorySyncError` unless Switch Trust took
    it and names every agent by the fingerprint checks will carry."""
    url = target.endpoint.rstrip("/") + SYNC_PATH
    try:
        response = await client.post(
            url,
            json=snapshot,
            headers={"Authorization": f"ApiKey {target.api_key}"},
            timeout=SYNC_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as error:
        raise InventorySyncError(f"POST {url} failed: {error}") from error
    if response.status_code >= 400:
        raise InventorySyncError(
            f"POST {url} answered {response.status_code}: {response.text[:200]}"
        )
    try:
        body = response.json()
        answered = {a["id"]: a["fingerprint"] for a in body["agents"]}
    except (ValueError, KeyError, TypeError) as error:
        raise InventorySyncError(
            f"POST {url} answered a body without the agents' fingerprints"
        ) from error
    server_id = snapshot["server"]["id"]
    tenant_id = snapshot["tenant"]["id"]
    for agent in snapshot["agents"]:
        expected = agent_fingerprint(server_id, tenant_id, agent["id"])
        if answered.get(agent["id"]) != expected:
            raise InventorySyncError(
                f"Switch Trust names agent {agent['id']} "
                f"{answered.get(agent['id'])!r}, not {expected!r}: guardrail "
                "checks from it would not reach the agent in the inventory"
            )


def _digest(target: InventoryTarget, snapshot: dict[str, Any]) -> str:
    body = json.dumps(
        {"endpoint": target.endpoint, "snapshot": snapshot}, sort_keys=True
    )
    return hashlib.sha256(body.encode()).hexdigest()


@dataclass
class _Sent:
    digest: str
    at: float


class InventorySync:
    """Sends each tenant's snapshot when it changed. One instance per process;
    it runs only in the process that owns the sync."""

    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        store: TrustSettingsStore,
        keyring: Keyring,
        client: httpx.AsyncClient,
        server: ServerIdentity,
    ) -> None:
        self._session_factory = session_factory
        self._store = store
        self._keyring = keyring
        self._client = client
        self._server = server
        self._sent: dict[str, _Sent] = {}

    def forget(self) -> None:
        """Send every tenant again on the next pass: the settings changed."""
        self._sent.clear()

    async def sync_once(self) -> None:
        """One pass over every tenant."""
        target = await read_target(self._session_factory, self._store, self._keyring)
        if target is None:
            self._sent.clear()
            return
        tenant_ids = await all_tenant_ids(self._session_factory)
        for tenant_id in tenant_ids:
            try:
                async with tenant_session(self._session_factory, tenant_id) as session:
                    snapshot = await build_snapshot(
                        session,
                        server=self._server,
                        tenant_id=tenant_id,
                        share_instructions=target.share_instructions,
                    )
                await self._send(target, tenant_id, snapshot)
            except Exception:
                # One tenant's failure must not keep the others' inventory stale.
                logger.exception(
                    "Switch Trust agent inventory sync failed for tenant %s",
                    tenant_id,
                )
        for tenant_id in set(self._sent) - set(tenant_ids):
            try:
                await self._send(
                    target, tenant_id, empty_snapshot(self._server, tenant_id)
                )
            except Exception:
                logger.exception(
                    "Clearing the Switch Trust agent inventory of deleted "
                    "tenant %s failed",
                    tenant_id,
                )
            else:
                del self._sent[tenant_id]

    async def _send(
        self, target: InventoryTarget, tenant_id: str, snapshot: dict[str, Any]
    ) -> None:
        digest = _digest(target, snapshot)
        last = self._sent.get(tenant_id)
        now = time.monotonic()
        if (
            last is not None
            and last.digest == digest
            and now - last.at < REFRESH_EVERY_SECONDS
        ):
            return
        reason = over_limits(snapshot)
        if reason is not None:
            raise InventorySyncError(
                f"Tenant {tenant_id}'s agent inventory was not sent: {reason}"
            )
        await post_snapshot(self._client, target=target, snapshot=snapshot)
        self._sent[tenant_id] = _Sent(digest=digest, at=now)
        logger.info(
            "Sent tenant %s's agent inventory (%d agents) to Switch Trust",
            tenant_id,
            len(snapshot["agents"]),
        )

    async def run_forever(self) -> None:
        with no_tenant():
            while True:
                try:
                    await self.sync_once()
                except Exception:
                    logger.exception("Switch Trust agent inventory sync failed")
                await asyncio.sleep(SYNC_INTERVAL_SECONDS)


# Owned work (`ownership.py`): one process sends the inventory for every
# tenant, and the next takes over when it stops or dies.
SYNC_KIND = "trust_inventory_sync"
SYNC_KEY = "all"


def own_inventory_sync(ownership: Ownership, sync: InventorySync) -> OwnedKind:
    """Register the inventory sync as owned work, wanted by this process; it
    runs here only while this process holds it."""
    running: dict[str, asyncio.Task[None]] = {}

    def launch(key: str) -> None:
        task = asyncio.create_task(sync.run_forever(), name="trust-inventory-sync")
        running[key] = task
        task.add_done_callback(lambda done: ended(key, done))

    def ended(key: str, task: asyncio.Task[None]) -> None:
        if task.cancelled() or running.get(key) is not task:
            return
        logger.error(
            "Switch Trust agent inventory sync stopped unexpectedly; restarting",
            exc_info=task.exception(),
        )
        launch(key)

    async def start(key: str, fence: Fence) -> None:
        launch(key)

    async def stop(key: str) -> None:
        task = running.pop(key, None)
        if task is None:
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    kind = ownership.kind(SYNC_KIND, start=start, stop=stop)
    kind.want(SYNC_KEY)
    return kind
