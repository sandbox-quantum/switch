"""Bringing the agents an official template created up to its current
revision, when the server starts.

A new release can ship a new revision of an official template (see
``official_templates/revisions.py``). Every agent an older revision created
(its install, ``db.models.TemplateInstall``) is then brought up to it:

- A value the template set that nobody has changed since (its fingerprint
  still matches) takes the new revision's value.
- A value somebody changed is theirs, and is left as it is.
- Who may address the agent and whether it can manage agents are never
  changed, whichever way the new revision would move them.

When anything was left as it is, the agent is left a notice (see
``template_status``): it is told, before the next message it receives, to
read how it differs from its template and tell its owner, who decides.

One server at a time works through a tenant, under a lock the others skip
it for. Every write is also conditional on what was read, so even without
the lock an agent is updated once at most and an install moves once.

The agents switch-buddy created before installs were recorded are recorded
first (``record_existing_buddies``), matched against the fingerprints of
every revision of it released.
"""

from __future__ import annotations

import logging
import re
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from switch_core.db.models import (
    Agent,
    AgentDefinition,
    TemplateInstall,
    TemplateInstallResource,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_definition_store import DefinitionChanged
from switch_core.db.stores.template_install_store import (
    NewInstallResource,
    TemplateInstallStore,
)
from switch_core.management.schemas import DefinitionV1, stored_definition
from switch_core.official_templates import (
    OFFICIAL_PREFIX,
    OfficialTemplate,
    official_template,
    official_templates,
    released_agent_fingerprints,
    slug_of,
)
from switch_core.template_installs import (
    AGENT_FIELDS,
    Held,
    agent_fields,
    agent_values,
    fingerprint,
    held_permissions,
    render_plans,
)
from switch_core.template_runs import NewAgentPlan

if TYPE_CHECKING:
    from switch_core.bridges.agent.protocol.agent_core import AgentCore
    from switch_core.management.service import ManagementService

logger = logging.getLogger(__name__)

BUDDY_ID = f"{OFFICIAL_PREFIX}switch-buddy"
BUDDY_KEY = "buddy"
_BUDDY_NAME = re.compile(r"^switch-buddy(-[a-z0-9._-]+)?$")


class LostRace(Exception):
    """Something changed the agent between it being read and written."""


def notice_text(
    template: OfficialTemplate,
    updated: Sequence[str],
    differs: Sequence[str],
    held: Sequence[Held],
) -> str:
    """What the agent is told when it was not brought fully up to a new
    revision of its template."""
    parts = [
        f"Your template, {template.name}, has a new revision ({template.version})."
    ]
    if updated:
        parts.append(f"Switch updated your {', '.join(updated)} to it.")
    if differs:
        parts.append(
            f"Your {', '.join(differs)} had been changed from the template, so "
            "they were left as they are."
        )
    if held:
        parts.append(
            "It also sets "
            + ", ".join(h.setting for h in held)
            + " differently, which Switch never changes for you."
        )
    parts.append(
        "Call get_template_status to see what differs, then tell your owner "
        "what they would gain and what they would lose by taking the new "
        "version. They decide, and make any change themselves."
    )
    return " ".join(parts)


class TemplateUpdates:
    def __init__(
        self,
        *,
        engine: AsyncEngine,
        session_factory: async_sessionmaker[AsyncSession],
        management: ManagementService,
        protocol: AgentCore,
        agent_management: bool,
        switch_buddy: bool,
    ) -> None:
        self._engine = engine
        self._session_factory = session_factory
        self._management = management
        self._protocol = protocol
        self._agent_management = agent_management
        self._switch_buddy = switch_buddy
        self._store = TemplateInstallStore()

    async def run(self, tenant_ids: Sequence[str]) -> None:
        """Record old buddies and update every install, tenant by tenant. One
        tenant's failure is logged and the next is still updated.

        One server at a time works through a tenant: each takes the tenant's
        lock first, and one that finds it held skips the tenant, which the
        server holding it is already updating. The conditional writes would
        keep two servers from updating anything twice anyway; the lock saves
        them doing the same reads and renders, and keeps two servers from
        each updating part of one install and neither moving it on."""
        for tenant_id in tenant_ids:
            try:
                async with self._tenant_lock(tenant_id) as held:
                    if not held:
                        logger.info(
                            "Another server is updating the agents of official "
                            "templates in tenant %s",
                            tenant_id,
                        )
                        continue
                    await self.record_existing_buddies(tenant_id)
                    for template in official_templates(
                        self._agent_management, self._switch_buddy
                    ):
                        await self.update_installs(tenant_id, template)
            except Exception:
                logger.error(
                    "Could not update the agents of official templates in tenant %s",
                    tenant_id,
                    exc_info=True,
                )

    @asynccontextmanager
    async def _tenant_lock(self, tenant_id: str) -> AsyncIterator[bool]:
        """A session-level advisory lock on the tenant's template updates,
        held on one connection of its own for the pass and released after it
        (or with the connection, if the process dies). Yields whether it was
        taken.

        The connection is in autocommit, so holding the lock does not hold a
        transaction open for the length of the pass; and it is one connection
        throughout, since a session-level lock is released only on the
        connection that took it."""
        key = func.hashtext(f"template-updates:{tenant_id}")
        async with self._engine.connect() as connection:
            locking = await connection.execution_options(isolation_level="AUTOCOMMIT")
            held = bool(
                (await locking.execute(select(func.pg_try_advisory_lock(key)))).scalar()
            )
            try:
                yield held
            finally:
                if held:
                    await locking.execute(select(func.pg_advisory_unlock(key)))

    # ── Buddies created before installs were recorded ───────────────────────

    async def record_existing_buddies(self, tenant_id: str) -> int:
        """Record each managed agent that is relatively surely someone's
        switch-buddy, with no install yet, as an install of the revision it
        matches best. Returns how many it recorded.

        Relatively surely: named as buddies are (``switch-buddy`` or
        ``switch-buddy-…``), and still carrying the buddy's icon or
        description from some revision. A name alone is anyone's to take.
        """
        buddy = official_template(BUDDY_ID, self._agent_management, self._switch_buddy)
        if buddy is None:
            return 0
        released = [
            (revision, agents[BUDDY_KEY])
            for revision, agents in released_agent_fingerprints(slug_of(BUDDY_ID))
            if BUDDY_KEY in agents
        ]
        icons = {fps["icon_url"] for _, fps in released}
        descriptions = {fps["description"] for _, fps in released}
        async with tenant_session(self._session_factory, tenant_id) as session:
            candidates = await self._unrecorded_buddies(session, tenant_id)
        recorded = 0
        for agent, row in candidates:
            mine = {
                name: fingerprint(value)
                for name, value in agent_values(agent, row).items()
            }
            if (
                mine["icon_url"] not in icons
                and mine["description"] not in descriptions
            ):
                continue
            # The newest revision it matches most fields of; a buddy whose
            # instructions match none is recorded too, as one somebody changed.
            revision, fps = max(
                released,
                key=lambda entry: (
                    sum(mine.get(k) == v for k, v in entry[1].items()),
                    entry[0],
                ),
            )
            try:
                async with tenant_session(self._session_factory, tenant_id) as session:
                    await self._store.create(
                        session,
                        owner_id=str(agent.owner_id),
                        source="official",
                        template_id=BUDDY_ID,
                        template_name=buddy.name,
                        revision=revision,
                        inputs={"agent_name": agent.name},
                        builtins={},
                        resources=[
                            NewInstallResource(
                                key=BUDDY_KEY,
                                agent_id=agent.id,
                                room_id=None,
                                fingerprints=dict(fps),
                            )
                        ],
                    )
                    await session.commit()
            except IntegrityError:
                # Another server recorded it first.
                continue
            recorded += 1
            logger.info(
                "Recorded agent %s as switch-buddy revision %s", agent.name, revision
            )
        return recorded

    async def _unrecorded_buddies(
        self, session: AsyncSession, tenant_id: str
    ) -> list[tuple[Agent, AgentDefinition]]:
        rows = await session.execute(
            select(Agent, AgentDefinition)
            .join(
                AgentDefinition,
                (AgentDefinition.agent_id == Agent.id)
                & (AgentDefinition.tenant_id == Agent.tenant_id),
            )
            .outerjoin(
                TemplateInstallResource,
                (TemplateInstallResource.agent_id == Agent.id)
                & (TemplateInstallResource.tenant_id == Agent.tenant_id),
            )
            .where(
                Agent.tenant_id == tenant_id,
                Agent.name.like("switch-buddy%"),
                Agent.owner_id.is_not(None),
                TemplateInstallResource.id.is_(None),
            )
        )
        return [
            (agent, row)
            for agent, row in rows.tuples()
            if _BUDDY_NAME.match(agent.name)
        ]

    # ── Updating installs ───────────────────────────────────────────────────

    async def update_installs(self, tenant_id: str, template: OfficialTemplate) -> None:
        async with tenant_session(self._session_factory, tenant_id) as session:
            installs = await self._store.behind(session, template.id, template.version)
        for install in installs:
            try:
                await self.update_install(tenant_id, template, install)
            except Exception:
                logger.error(
                    "Could not update install %s of %s to revision %s",
                    install.id,
                    template.id,
                    template.version,
                    exc_info=True,
                )

    async def update_install(
        self, tenant_id: str, template: OfficialTemplate, install: TemplateInstall
    ) -> None:
        """Bring one install's agents up to `template`'s revision, then move
        the install to it, unless another server is doing the same."""
        try:
            plans = render_plans(template.content, install.inputs, install.builtins)
        except Exception as error:
            logger.warning(
                "Revision %s of %s cannot be rendered with what install %s was "
                "run with (%s): its agents stay as they are",
                template.version,
                template.id,
                install.id,
                error,
            )
            return
        async with tenant_session(self._session_factory, tenant_id) as session:
            resources = await self._store.resources(session, install.id)
        complete = True
        for resource in resources:
            plan = plans.get(resource.key)
            if resource.agent_id is None or plan is None:
                continue
            try:
                await self._update_agent(tenant_id, template, resource, plan)
            except LostRace:
                complete = False
        if not complete:
            return
        async with tenant_session(self._session_factory, tenant_id) as session:
            if await self._store.move_to_revision(
                session, install.id, from_revision=install.revision, to=template.version
            ):
                logger.info(
                    "Updated install %s of %s from revision %s to %s",
                    install.id,
                    template.id,
                    install.revision,
                    template.version,
                )
            await session.commit()

    async def _update_agent(
        self,
        tenant_id: str,
        template: OfficialTemplate,
        resource: TemplateInstallResource,
        plan: NewAgentPlan,
    ) -> None:
        assert resource.agent_id is not None
        async with tenant_session(self._session_factory, tenant_id) as session:
            agent = await session.get(Agent, resource.agent_id)
            row = (
                await session.execute(
                    select(AgentDefinition).where(
                        AgentDefinition.tenant_id == tenant_id,
                        AgentDefinition.agent_id == resource.agent_id,
                    )
                )
            ).scalar_one_or_none()
        if agent is None:
            return
        current = agent_values(agent, row)
        new = agent_fields(plan)
        changes: dict[str, str | None] = {}
        differs: list[str] = []
        fingerprints = dict(resource.fingerprints)
        for name in AGENT_FIELDS:
            if name not in current:
                continue
            if current[name] == new[name]:
                fingerprints[name] = fingerprint(new[name])
            elif fingerprints.get(name) == fingerprint(current[name]):
                changes[name] = new[name]
                fingerprints[name] = fingerprint(new[name])
            else:
                differs.append(name)
        await self._apply(tenant_id, agent, row, current, changes)
        held = held_permissions(plan, agent)
        notice = (
            notice_text(template, sorted(changes), differs, held)
            if differs or held
            else None
        )
        async with tenant_session(self._session_factory, tenant_id) as session:
            await self._store.set_fingerprints(session, resource.id, fingerprints)
            await self._store.set_notice(session, resource.id, notice)
            await session.commit()

    async def _apply(
        self,
        tenant_id: str,
        agent: Agent,
        row: AgentDefinition | None,
        current: dict[str, str | None],
        changes: dict[str, str | None],
    ) -> None:
        """Write `changes`, each only while the agent still has the value it
        was read with; `LostRace` when it no longer does."""
        profile = {k: v for k, v in changes.items() if k != "instructions"}
        if profile:
            async with tenant_session(self._session_factory, tenant_id) as session:
                written = await session.execute(
                    update(Agent)
                    .where(
                        Agent.tenant_id == tenant_id,
                        Agent.id == agent.id,
                        *(
                            getattr(Agent, k).is_(None)
                            if current[k] is None
                            else getattr(Agent, k) == current[k]
                            for k in profile
                        ),
                    )
                    .values(**profile)
                )
                if not written.rowcount:  # type: ignore[attr-defined]
                    raise LostRace(agent.id)
                await session.commit()
            async with tenant_session(self._session_factory, tenant_id):
                if {"description", "display_name"} & profile.keys():
                    await self._protocol.update_bridge_identities(agent.id)
                if {"icon_url", "display_name"} & profile.keys():
                    await self._protocol.agent_profile_changed(agent.id)
        if "instructions" in changes and row is not None:
            definition = DefinitionV1.model_validate(
                {
                    **stored_definition(row.definition),
                    "instructions": changes["instructions"],
                }
            )
            try:
                async with tenant_session(self._session_factory, tenant_id) as session:
                    await self._management.patch_managed_agent(
                        session,
                        tenant_id,
                        str(agent.owner_id),
                        agent.id,
                        definition=definition,
                        desired_state=None,
                        controller_id=None,
                        controller_id_given=False,
                        protocol=self._protocol,
                        expected_revision=row.revision,
                    )
            except DefinitionChanged as error:
                raise LostRace(agent.id) from error
