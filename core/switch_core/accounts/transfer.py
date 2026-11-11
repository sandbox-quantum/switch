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
  this module does not rotate.

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
from collections.abc import Collection
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, cast, get_args

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from switch_core.authz import Principal, can_manage, owns
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


@dataclass(frozen=True)
class AgentTransferFacts:
    """What decides whether an agent can change owner, read for many agents
    at once by `agent_transfer_facts`. Every one of these ties the agent to its
    owner by more than its owner id; see this module's docstring."""

    granted_services: tuple[str, ...]
    managed: bool
    may_manage_agents: bool
    # It is a sub-agent, or has sub-agents.
    in_family: bool
    has_oauth_client: bool


async def agent_transfer_facts(
    session: AsyncSession, tenant_id: str, agent_ids: Collection[str]
) -> dict[str, AgentTransferFacts]:
    """`AgentTransferFacts` for each of `agent_ids` found in the tenant, in one
    query per kind of fact rather than per agent."""
    if not agent_ids:
        return {}
    ids = list(agent_ids)
    rows = (
        await session.execute(
            select(
                Agent.id,
                Agent.can_manage_agents,
                Agent.parent_agent_id,
                Agent.oauth_client_id,
            ).where(Agent.tenant_id == tenant_id, Agent.id.in_(ids))
        )
    ).all()
    services: dict[str, list[str]] = {}
    for agent_id, service in await session.execute(
        select(ServiceGrant.agent_id, ServiceGrant.service).where(
            ServiceGrant.tenant_id == tenant_id, ServiceGrant.agent_id.in_(ids)
        )
    ):
        services.setdefault(agent_id, []).append(service)
    managed = set(
        await session.scalars(
            select(AgentDefinition.agent_id).where(
                AgentDefinition.tenant_id == tenant_id,
                AgentDefinition.agent_id.in_(ids),
            )
        )
    )
    parents = set(
        await session.scalars(
            select(Agent.parent_agent_id).where(
                Agent.tenant_id == tenant_id, Agent.parent_agent_id.in_(ids)
            )
        )
    )
    return {
        agent_id: AgentTransferFacts(
            granted_services=tuple(sorted(services.get(agent_id, ()))),
            managed=agent_id in managed,
            may_manage_agents=may_manage_agents,
            in_family=parent_agent_id is not None or agent_id in parents,
            has_oauth_client=oauth_client_id is not None,
        )
        for agent_id, may_manage_agents, parent_agent_id, oauth_client_id in rows
    }


def agent_transfer_refusal(facts: AgentTransferFacts, *, to_owner: bool) -> str | None:
    """Why the agent can't change owner, for the person asking; None when it
    can. Only its owner is told which services it is granted: the grants are
    made on the owner's own connections, which nobody else is shown."""
    if facts.granted_services:
        if to_owner:
            return (
                "This agent uses your own connectors for "
                f"{', '.join(facts.granted_services)}. Remove its service access "
                "first; the new owner can then grant their own."
            )
        return (
            "This agent uses its owner's own connectors. Its owner has to "
            "remove its service access first; the new owner can then grant "
            "their own."
        )
    if facts.managed:
        return (
            "This agent is managed on its owner's device, with their sign-ins, "
            "and can't be transferred."
        )
    if facts.may_manage_agents:
        return "This agent can manage its owner's agents. Turn that off first."
    if facts.in_family:
        return (
            "This agent is part of a family of sub-agents, which can't be transferred."
        )
    if facts.has_oauth_client:
        return (
            "This agent signs in with an OAuth client of its own and can't be "
            "transferred."
        )
    return None


async def _refuse_agent(
    session: AsyncSession, tenant_id: str, agent: Agent, *, to_owner: bool
) -> None:
    facts = (await agent_transfer_facts(session, tenant_id, [agent.id]))[agent.id]
    refusal = agent_transfer_refusal(facts, to_owner=to_owner)
    if refusal is not None:
        raise TransferRefused(409, refusal)


def kind_refusal(resource: Room | Document) -> str | None:
    """Why a room or a document can't change owner, whoever would receive it;
    None when it can. A chat stays with the people in it, and a room's own
    document with its room."""
    if isinstance(resource, Room) and "chat_operation_id" in (resource.metadata_ or {}):
        return "A chat can't be transferred."
    if isinstance(resource, Document) and resource.room_id is not None:
        return (
            "This document belongs to a room. Only library documents can be "
            "transferred."
        )
    return None


async def _refuse(
    session: AsyncSession,
    tenant_id: str,
    kind: str,
    resource: Owned,
    new_owner_id: str,
    caller: Principal,
) -> None:
    if isinstance(resource, Agent):
        await _refuse_agent(
            session, tenant_id, resource, to_owner=owns(caller, resource.owner_id)
        )
    elif isinstance(resource, Room | Document):
        refusal = kind_refusal(resource)
        if refusal is not None:
            raise TransferRefused(409, refusal)
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
    await _refuse(session, tenant_id, kind, resource, new_owner_id, caller)

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


# What passes to an heir when its owner leaves the workspace, in the order
# handed over. Agents are not here: removing a member who owns one is refused
# until it is transferred or deleted with it in front of an admin.
_HANDED_OVER: tuple[tuple[str, type[Owned]], ...] = (
    ("room", Room),
    ("package", Package),
    ("reference", Reference),
    ("reference_type", ReferenceType),
    ("document", Document),
    ("template", Template),
)


async def hand_over_everything(
    session: AsyncSession,
    *,
    tenant_id: str,
    previous_owner_id: str,
    heir_id: str,
    actor_id: str | None,
    reason: str,
) -> dict[str, int]:
    """Make `heir_id` the owner of what `previous_owner_id` owns in the
    workspace bound on `session`, each with its audit event, so nothing there
    is left owned by someone who can no longer reach it. Returns how many of
    each kind passed.

    What a transfer refuses stays with them: a chat, which is one person's
    conversation; a room's own document, which goes with its room; and a
    template whose name the heir already uses. The caller commits."""
    handed: dict[str, int] = {}
    for kind, model in _HANDED_OVER:
        rows: list[Owned] = list(
            await session.scalars(
                select(model)
                .where(
                    model.tenant_id == tenant_id,
                    model.owner_id == previous_owner_id,
                )
                .with_for_update()
            )
        )
        for row in rows:
            if isinstance(row, (Room, Document)) and kind_refusal(row) is not None:
                continue
            if isinstance(row, Template):
                if not await _template_passes(session, row, heir_id):
                    continue
            else:
                row.owner_id = heir_id
            await record_audit_event(
                session,
                tenant_id=tenant_id,
                actor_user_id=actor_id,
                action=AuditAction.OWNERSHIP_TRANSFERRED,
                target_type=kind,
                target_id=row.type if isinstance(row, ReferenceType) else row.id,
                details={
                    "from": previous_owner_id,
                    "to": heir_id,
                    "reason": reason,
                    "agent_key_reissued": False,
                },
            )
            handed[kind] = handed.get(kind, 0) + 1
    await session.flush()
    return handed


async def _template_passes(
    session: AsyncSession, template: Template, heir_id: str
) -> bool:
    """Make `heir_id` the owner of `template` unless they already have a
    template by its name. Template names are unique per owner across every
    workspace, and this session sees only its own, so the clash is found by
    trying: in a savepoint, which a clash rolls back alone."""
    try:
        async with session.begin_nested():
            template.owner_id = heir_id
            await session.flush()
    except IntegrityError:
        return False
    return True
