"""`get_template_status`: how an agent differs from the template it was
created from.

When a new revision of an official template reaches the server, the values
nobody changed on the agents it created follow it (see
``management/template_updates.py``). What somebody changed, and the
permissions the template would set differently, stay as they are; the agent
is left a notice to ask here, and to tell its owner what they would gain and
lose by taking the template's version. Reading clears the notice.
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Any

from sqlalchemy import select

from switch_core.bridges.agent.operations.context import get_agent_id, get_protocol
from switch_core.bridges.agent.operations.registry import operation
from switch_core.db.models import Agent, AgentDefinition, require_tenant_id
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.template_install_store import TemplateInstallStore
from switch_core.feature_flags import AGENT_MANAGEMENT, SWITCH_BUDDY
from switch_core.official_templates import official_template
from switch_core.template_installs import (
    AGENT_FIELDS,
    Differs,
    agent_fields,
    agent_values,
    held_permissions,
    render_plans,
)

_STORE = TemplateInstallStore()


@operation
async def get_template_status() -> dict[str, Any]:
    """How you differ from the template you were created from, such as
    switch-buddy's.

    Call it when Switch tells you your template has a new revision. Switch
    already brought up to it everything nobody had changed; what is listed
    here is what it left alone. Tell your owner, in a few lines, what they
    would gain and what they would lose by taking the template's version of
    each, and let them decide: they make any change themselves, on your page
    in Switch Console (you cannot change your own settings). Offer the full
    text when it is long rather than pasting it into the chat.

    Returns:
        {template, installed_revision, current_revision, differs,
        permissions}. `template` is {id, name, source}, or null when you were
        not created from a template Switch can update you from (the other
        fields are then absent).
        `differs` lists each of your values that differs from what the
        template's current revision sets, {field, yours, recommended}:
        `field` is "instructions", "description", "icon_url" or
        "display_name". `permissions` lists each permission the template
        sets differently, {setting, yours, recommended}: `setting` is
        "can_manage_agents" or "addressing"; Switch never changes these for
        you. Both are empty when you match the template.
    """
    protocol = get_protocol()
    agent_id = get_agent_id()
    async with tenant_session(protocol.session_factory, require_tenant_id()) as session:
        found = await _STORE.for_agent(session, agent_id)
        if found is None:
            return {"template": None}
        install, resource = found
        template = {
            "id": install.template_id,
            "name": install.template_name,
            "source": install.source,
        }
        official = official_template(
            install.template_id,
            protocol.config.feature_flags[AGENT_MANAGEMENT],
            protocol.config.feature_flags[SWITCH_BUDDY],
        )
        agent = await session.get(Agent, agent_id)
        row = (
            await session.execute(
                select(AgentDefinition).where(
                    AgentDefinition.tenant_id == require_tenant_id(),
                    AgentDefinition.agent_id == agent_id,
                )
            )
        ).scalar_one_or_none()
        await _STORE.set_notice(session, resource.id, None)
        await session.commit()
    if official is None or agent is None:
        # A saved template, or one this server no longer serves: nothing to
        # compare against.
        return {
            "template": template,
            "installed_revision": install.revision,
            "current_revision": None,
            "differs": [],
            "permissions": [],
        }
    plan = render_plans(official.content, install.inputs, install.builtins).get(
        resource.key
    )
    if plan is None:
        return {
            "template": template,
            "installed_revision": install.revision,
            "current_revision": official.version,
            "differs": [],
            "permissions": [],
        }
    yours = agent_values(agent, row)
    recommended = agent_fields(plan)
    return {
        "template": template,
        "installed_revision": install.revision,
        "current_revision": official.version,
        "differs": [
            asdict(Differs(name, yours[name], recommended[name]))
            for name in AGENT_FIELDS
            if name in yours and yours[name] != recommended[name]
        ],
        "permissions": [asdict(held) for held in held_permissions(plan, agent)],
    }
