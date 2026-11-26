"""Where an agent came from, for telemetry: switch-buddy, another template
that comes with Switch, or anything else.

Read from the agent's template install (`TemplateInstallResource` and
`TemplateInstall`), which the server writes itself when it runs a template it
vouches for, so the answer never rests on a name someone typed. An agent no
install created, or one a saved template created, is `other`.

Lets retention charts tell people talking to switch-buddy from people using
the agents it, or they, set up.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal

from sqlalchemy import select

from switch_core.db.models import TemplateInstall, TemplateInstallResource
from switch_core.official_templates import OFFICIAL_PREFIX

if TYPE_CHECKING:
    from collections.abc import Collection

    from sqlalchemy.ext.asyncio import AsyncSession

AgentOrigin = Literal["buddy", "official_template", "other"]

BUDDY_TEMPLATE_ID = f"{OFFICIAL_PREFIX}switch-buddy"


def origin_of(source: str | None, template_id: str | None) -> AgentOrigin:
    """The origin an install's `source` and `template_id` give an agent;
    `other` for an agent no install created."""
    if source != "official" or template_id is None:
        return "other"
    if template_id == BUDDY_TEMPLATE_ID:
        return "buddy"
    return "official_template"


async def agent_origins(
    session: AsyncSession, agent_ids: Collection[str]
) -> dict[str, AgentOrigin]:
    """Each of `agent_ids`' origin; an id with no install is `other`."""
    ids = set(agent_ids)
    if not ids:
        return {}
    rows = (
        await session.execute(
            select(
                TemplateInstallResource.agent_id,
                TemplateInstall.source,
                TemplateInstall.template_id,
            )
            .join(
                TemplateInstall,
                (TemplateInstall.id == TemplateInstallResource.install_id)
                & (TemplateInstall.tenant_id == TemplateInstallResource.tenant_id),
            )
            .where(TemplateInstallResource.agent_id.in_(ids))
        )
    ).all()
    found: dict[str, AgentOrigin] = {}
    for agent_id, source, template_id in rows:
        origin = origin_of(source, template_id)
        # An agent in more than one install keeps its most specific origin.
        found[agent_id] = most_specific(found.get(agent_id, "other"), origin)
    return {agent_id: found.get(agent_id, "other") for agent_id in ids}


_RANK: dict[AgentOrigin, int] = {"other": 0, "official_template": 1, "buddy": 2}


def most_specific(a: AgentOrigin, b: AgentOrigin) -> AgentOrigin:
    """Of two origins one agent has (it is in more than one install), the one
    that says more: switch-buddy over another official template over other."""
    return a if _RANK[a] >= _RANK[b] else b


async def is_buddy(session: AsyncSession, agent_id: str | None) -> bool:
    """Whether `agent_id` is a switch-buddy; False for None."""
    if agent_id is None:
        return False
    return (await agent_origins(session, [agent_id]))[agent_id] == "buddy"
