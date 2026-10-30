"""Handing something a person owns to another member of the same workspace.

The current owner, or a workspace admin, may hand an agent, room, package,
reference, reference type, library document or template to anyone who is a
member of the workspace now. Everything else about the thing stays as it was.

An agent carries more than an owner id, so it is refused where the owner id is
not the whole of what ties it to its owner, and the refusal says what to undo
first:

- service access (`service_grants`) is made with the owner's own connections,
  so keeping it would let the new owner's agent act with the previous owner's
  accounts;
- a managed agent runs on its owner's machine, with their provider sign-ins;
- an agent that may manage agents acts on its owner's machines;
- an agent with sub-agents, or a sub-agent, is one of a family registered
  together from one session;
- an agent that signs in with an OAuth client of its own holds a credential
  this module does not rotate;
- an agent a server-side connector runs is registered again by that
  connector, under its own owner, whenever the server starts.

What is left is the agent's API key, which its owner can reveal. It is
re-issued to the new owner, so a copy the previous owner holds stops working.
The agent's open connections authenticated with the old key, so their rows go
in the same transaction, and the caller ends them in every process once it has
committed (`AgentConnectionRegistry.agent_key_reissued`): the agent has to be
reconnected with the new key.

The thing's row is locked before anything is checked and held until the caller
commits, so two transfers of the same thing take turns, and the second is
judged on the owner the first left. The new owner's membership row is locked
too, as removing a member locks it (`gateway/tenants.py`), so a member being
removed cannot be handed an agent between the removal's check and its commit.
"""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, cast, get_args

from sqlalchemy import select

from switch_core.authz import Principal, can_manage
from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import (
    Agent,
    AgentDefinition,
    ApiKey,
    Document,
    Package,
    Reference,
    ReferenceType,
    Room,
    ServiceGrant,
    Template,
    TenantMember,
)
from switch_core.db.stores.agent_connection_store import AgentConnectionStore

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from switch_core.keys import Keyring

TransferKind = Literal[
    "agent",
    "room",
    "package",
    "reference",
    "reference_type",
    "document",
    "template",
]
TRANSFER_KINDS: tuple[str, ...] = get_args(TransferKind)

_LABELS: dict[str, str] = {
    "agent": "agent",
    "room": "room",
    "package": "package",
    "reference": "reference",
    "reference_type": "reference type",
    "document": "document",
    "template": "template",
}

Owned = Agent | Room | Package | Reference | ReferenceType | Document | Template


class TransferRefused(Exception):
    """The transfer cannot happen; `status` is the HTTP status that says why,
    and the message is for the person who asked."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Transferred:
    kind: str
    resource_id: str
    previous_owner_id: str | None
    new_owner_id: str
    # The hash of the agent key that stopped working, for the caller to drop
    # from its cache once this has committed. None for anything but an agent.
    retired_key_hash: str | None


async def _load(
    session: AsyncSession, tenant_id: str, kind: str, resource_id: str
) -> Owned | None:
    if kind == "reference_type":
        return await session.get(
            ReferenceType,
            (tenant_id, resource_id),
            with_for_update=True,
            populate_existing=True,
        )
    models: dict[str, type[Agent | Room | Package | Reference | Document | Template]]
    models = {
        "agent": Agent,
        "room": Room,
        "package": Package,
        "reference": Reference,
        "document": Document,
        "template": Template,
    }
    row = cast(
        Owned | None,
        await session.get(
            models[kind], resource_id, with_for_update=True, populate_existing=True
        ),
    )
    # The policy already hides another tenant's row; this says so in Python
    # too, for a connection the policy does not apply to.
    if row is None or row.tenant_id != tenant_id:
        return None
    return row


async def _refuse_agent(session: AsyncSession, tenant_id: str, agent: Agent) -> None:
    services = sorted(
        await session.scalars(
            select(ServiceGrant.service).where(
                ServiceGrant.tenant_id == tenant_id, ServiceGrant.agent_id == agent.id
            )
        )
    )
    if services:
        raise TransferRefused(
            409,
            "This agent uses its owner's own connections to "
            f"{', '.join(services)}. Remove its service access first; the new "
            "owner can then grant their own.",
        )
    managed = await session.scalar(
        select(AgentDefinition.id).where(
            AgentDefinition.tenant_id == tenant_id, AgentDefinition.agent_id == agent.id
        )
    )
    if managed is not None:
        raise TransferRefused(
            409,
            "This agent is managed on its owner's machine, with their sign-ins, "
            "and can't be transferred.",
        )
    if agent.can_manage_agents:
        raise TransferRefused(
            409,
            "This agent can manage its owner's agents. Turn that off first.",
        )
    child = await session.scalar(
        select(Agent.id).where(
            Agent.tenant_id == tenant_id, Agent.parent_agent_id == agent.id
        )
    )
    if agent.parent_agent_id is not None or child is not None:
        raise TransferRefused(
            409,
            "This agent is part of a family of sub-agents, which can't be transferred.",
        )
    if agent.oauth_client_id is not None:
        raise TransferRefused(
            409,
            "This agent signs in with an OAuth client of its own and can't be "
            "transferred.",
        )
    if (agent.metadata_ or {}).get("server_connector_id"):
        raise TransferRefused(
            409,
            "This agent is run by a server connector, which registers it again "
            "under its own owner whenever the server starts, so it can't be "
            "transferred.",
        )


async def _refuse(
    session: AsyncSession,
    tenant_id: str,
    kind: str,
    resource: Owned,
    new_owner_id: str,
) -> None:
    if isinstance(resource, Agent):
        await _refuse_agent(session, tenant_id, resource)
    elif isinstance(resource, Room):
        if resource.metadata_ is not None and "chat_operation_id" in resource.metadata_:
            raise TransferRefused(409, "A chat can't be transferred.")
    elif isinstance(resource, Document):
        if resource.room_id is not None:
            raise TransferRefused(
                409,
                "This document belongs to a room. Only library documents can be "
                "transferred.",
            )
    elif isinstance(resource, Template):
        clash = await session.scalar(
            select(Template.id).where(
                Template.owner_id == new_owner_id, Template.name == resource.name
            )
        )
        if clash is not None:
            raise TransferRefused(
                409,
                f"The new owner already has a template named {resource.name}. "
                "Rename one of them first.",
            )


async def _reissue_agent_key(
    session: AsyncSession, agent: Agent, new_owner_id: str, keyring: Keyring
) -> str:
    """Give the agent's key to `new_owner_id` as a new secret; return the
    retired one's hash."""
    key = await session.get(ApiKey, agent.api_key_id)
    if key is None:
        raise RuntimeError(f"Agent {agent.id} has no API key row {agent.api_key_id}")
    retired = key.key_hash
    plaintext = secrets.token_urlsafe(32)
    key.key_hash = hashlib.sha256(plaintext.encode()).hexdigest()
    key.encrypted_key = keyring.encrypt(plaintext)
    key.user_id = new_owner_id
    return retired


async def transfer_ownership(
    session: AsyncSession,
    *,
    tenant_id: str,
    kind: str,
    resource_id: str,
    new_owner_id: str,
    caller: Principal,
    keyring: Keyring,
) -> Transferred:
    """Make `new_owner_id` the owner, on `session`, with its audit event; the
    caller commits, and for an agent then ends its connections
    (`AgentConnectionRegistry.agent_key_reissued`). Raises `TransferRefused`
    and changes nothing otherwise."""
    if kind not in TRANSFER_KINDS:
        raise TransferRefused(
            400,
            f"Unknown kind {kind!r}; expected one of {', '.join(TRANSFER_KINDS)}.",
        )
    label = _LABELS[kind]
    resource = await _load(session, tenant_id, kind, resource_id)
    if resource is None:
        raise TransferRefused(404, f"No such {label} in this workspace.")
    previous = resource.owner_id
    if not can_manage(caller, previous):
        raise TransferRefused(
            403,
            f"Only the {label}'s owner or a workspace admin can transfer it.",
        )
    membership = await session.get(
        TenantMember,
        (tenant_id, new_owner_id),
        with_for_update=True,
        populate_existing=True,
    )
    if membership is None:
        raise TransferRefused(
            400, "The new owner must be a current member of this workspace."
        )
    if previous == new_owner_id:
        raise TransferRefused(400, f"They already own this {label}.")
    if new_owner_id == caller.id:
        # An admin taking someone's agent would also take its key.
        raise TransferRefused(
            403,
            f"You can't transfer someone else's {label} to yourself. "
            "Ask its owner to transfer it to you.",
        )
    await _refuse(session, tenant_id, kind, resource, new_owner_id)

    retired: str | None = None
    if isinstance(resource, Agent):
        retired = await _reissue_agent_key(session, resource, new_owner_id, keyring)
        await AgentConnectionStore().delete_agent(
            session, tenant_id=tenant_id, agent_id=resource.id
        )
    resource.owner_id = new_owner_id
    await session.flush()
    await record_audit_event(
        session,
        tenant_id=tenant_id,
        actor_user_id=caller.id,
        action=AuditAction.OWNERSHIP_TRANSFERRED,
        target_type=kind,
        target_id=resource_id,
        details={
            "from": previous,
            "to": new_owner_id,
            "agent_key_reissued": retired is not None,
        },
    )
    return Transferred(
        kind=kind,
        resource_id=resource_id,
        previous_owner_id=previous,
        new_owner_id=new_owner_id,
        retired_key_hash=retired,
    )
