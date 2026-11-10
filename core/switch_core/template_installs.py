"""What a template sets on the agents it creates, and how to tell, later,
whether anyone has changed it since.

A template install (``db.models.TemplateInstall``) keeps, for each agent a
run created, a fingerprint of every value the template set on it. A value
whose fingerprint still matches is one nobody has changed, which a newer
revision of the template may replace; one that no longer matches was changed
by someone, and is theirs.

Only these fields are the template's to update. Who may address an agent,
whether it can manage agents, its provider, machine and directory are
settled when it is created and never touched by an update.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.agent_templates import plan_template
from switch_core.bridges.agent.protocol.agent_detail import addressing_policy_for
from switch_core.db.models import Agent, AgentDefinition, Template
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.template_install_store import (
    NewInstallResource,
    TemplateInstallStore,
)
from switch_core.official_templates import (
    OfficialTemplate,
    is_official,
    official_templates,
)
from switch_core.providers.registry import provider_ids
from switch_core.template_runs import TEMPLATE_ADDRESSING, NewAgentPlan
from switch_core.template_v2 import compile_v2, is_v2_text

logger = logging.getLogger(__name__)

AGENT_FIELDS: tuple[str, ...] = (
    "instructions",
    "description",
    "icon_url",
    "display_name",
)


def fingerprint(value: str | None) -> str:
    """A value's fingerprint: equal for equal values, and short."""
    return hashlib.sha256(json.dumps(value).encode()).hexdigest()[:32]


def agent_fields(plan: NewAgentPlan) -> dict[str, str | None]:
    """The values a template sets on an agent that an update may change."""
    return {
        "instructions": plan.instructions,
        "description": plan.description,
        "icon_url": plan.icon_url,
        "display_name": plan.display_name,
    }


def fingerprints(fields: dict[str, str | None]) -> dict[str, str]:
    return {name: fingerprint(value) for name, value in fields.items()}


def resource_keys(
    text: str, inputs: dict[str, Any], builtins: dict[str, str]
) -> dict[str, str]:
    """Each agent's name as a run creates it, with the key the template gives
    it: a version 2 resource's key, or for an older document the agent's own
    name."""
    if not is_v2_text(text):
        return {}
    compiled = compile_v2(text, inputs, builtins)
    return {name: key for key, name in compiled.names.items()}


def key_of(plan: NewAgentPlan, keys: dict[str, str]) -> str:
    return keys.get(plan.name, plan.name)


def render_plans(
    text: str, inputs: dict[str, Any], builtins: dict[str, str]
) -> dict[str, NewAgentPlan]:
    """Each agent `text` creates, by key, rendered with the inputs and
    builtins a run used.

    Where an agent runs does not change what it is told, so the run's machine
    stands in as the only one, ready for every provider: a machine since
    removed or offline must not stop a later revision from being read.
    """
    machine = str(inputs.get("machine") or "machine")
    machines = [
        {
            "id": machine,
            "name": machine,
            "state": "online",
            "providers": [
                {"provider": provider, "installed": True, "auth": "ok"}
                for provider in provider_ids()
            ],
        }
    ]
    plan = plan_template(text, {}, inputs, builtins=builtins, machines=machines)
    keys = resource_keys(text, inputs, builtins)
    return {key_of(agent, keys): agent for agent in plan.new_agents}


def render_agents(
    text: str, inputs: dict[str, Any], builtins: dict[str, str]
) -> dict[str, dict[str, str | None]]:
    """The values `text` sets on each agent it creates, by key (see
    `render_plans`)."""
    return {
        key: agent_fields(plan)
        for key, plan in render_plans(text, inputs, builtins).items()
    }


@dataclass(frozen=True)
class InstallSource:
    """Where a run's document came from, as the server knows it: never
    taken from what a caller says, only from a template it loaded itself."""

    source: Literal["official", "saved"]
    template_id: str
    template_name: str
    revision: int


def source_of(template: OfficialTemplate | Template) -> InstallSource:
    return InstallSource(
        source="official" if is_official(template.id) else "saved",
        template_id=template.id,
        template_name=template.name,
        revision=template.version,
    )


def vouched_source(
    document: str,
    loaded: OfficialTemplate | Template | None,
    *,
    agent_management: bool,
    switch_buddy: bool,
) -> InstallSource | None:
    """The source of a document a caller sent to run: the template it says
    the document is (`loaded`, read by the server with the caller's own
    access), when the document is exactly that template's; else an official
    template whose document it is word for word, which is how a run from a
    Switch Console too old to say is still recognised. None when it is
    neither: a document the caller wrote or changed has no source to update
    it from."""
    if loaded is not None:
        return source_of(loaded) if loaded.content == document else None
    for official in official_templates(agent_management, switch_buddy):
        if official.content == document:
            return source_of(official)
    return None


async def record_install(
    session_factory: async_sessionmaker[AsyncSession],
    tenant_id: str,
    *,
    owner_id: str,
    source: InstallSource,
    document: str,
    inputs: dict[str, Any],
    builtins: dict[str, str],
    plans: Sequence[NewAgentPlan],
    created: Sequence[dict[str, Any]],
) -> None:
    """Record that a run of `source` created these agents, with what it set
    on each. A run that created no agent records nothing.

    The agents exist whatever happens here, so a failure to record is not
    the run's failure: it is logged as an error, and those agents simply get
    no updates.
    """
    agent_ids = {str(agent["name"]): str(agent["agent_id"]) for agent in created}
    made = [plan for plan in plans if plan.name in agent_ids]
    if not made:
        return
    try:
        keys = resource_keys(document, inputs, builtins)
        async with tenant_session(session_factory, tenant_id) as session:
            await TemplateInstallStore().create(
                session,
                owner_id=owner_id,
                source=source.source,
                template_id=source.template_id,
                template_name=source.template_name,
                revision=source.revision,
                inputs=inputs,
                builtins=builtins,
                resources=[
                    NewInstallResource(
                        key=key_of(plan, keys),
                        agent_id=agent_ids[plan.name],
                        room_id=None,
                        fingerprints=fingerprints(agent_fields(plan)),
                    )
                    for plan in made
                ],
            )
            await session.commit()
    except Exception:
        logger.error(
            "Could not record that %s (revision %s) created agents %s: they "
            "will not be updated from it",
            source.template_id,
            source.revision,
            sorted(agent_ids.values()),
            exc_info=True,
        )


@dataclass(frozen=True)
class Held:
    """A permission the template's current revision sets differently from
    the agent's own, which no update changes."""

    setting: str
    yours: Any
    recommended: Any


@dataclass(frozen=True)
class Differs:
    """A value somebody changed from what the template set, with what the
    template's current revision would set instead."""

    field: str
    yours: str | None
    recommended: str | None


def agent_values(agent: Agent, row: AgentDefinition | None) -> dict[str, str | None]:
    """An agent's own values of the fields a template sets; no
    ``instructions`` for an agent with no managed definition."""
    values: dict[str, str | None] = {
        "description": agent.description,
        "icon_url": agent.icon_url,
        "display_name": agent.display_name,
    }
    if row is not None:
        values["instructions"] = str(row.definition.get("instructions") or "")
    return values


def held_permissions(plan: NewAgentPlan, agent: Agent) -> list[Held]:
    """The permissions `plan` sets that differ from the agent's own."""
    held: list[Held] = []
    if plan.can_manage_agents != agent.can_manage_agents:
        held.append(
            Held("can_manage_agents", agent.can_manage_agents, plan.can_manage_agents)
        )
    choice = TEMPLATE_ADDRESSING.get(plan.addressing)
    if choice is not None and addressing_policy_for(choice) != agent.addressing_policy:
        held.append(Held("addressing", _addressing_word(agent), choice))
    return held


def _addressing_word(agent: Agent) -> str:
    for choice in TEMPLATE_ADDRESSING.values():
        if addressing_policy_for(choice) == agent.addressing_policy:
            return choice
    return "custom"
