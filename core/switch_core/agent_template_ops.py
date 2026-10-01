"""The template registry as an agent sees it.

An agent reads what its owner can read: every shared template and the
owner's private ones. An owner's admin standing does not come along, so an
admin's agent does not see other people's private templates. Writing is
narrower than the owner's rights: an agent changes or deletes only what it
saved itself, never its owner's templates or another agent's, because an
agent takes instructions from whoever can address it and should not be a way
to rewrite templates other people or agents depend on.

Every "no" here is an ``AgentRefused`` with a reason code, which the
operation layer reports (see ``agent_refusals``).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

import yaml

from switch_core.agent_refusals import AgentRefused
from switch_core.agent_templates import agent_slots, template_kind
from switch_core.authz import Principal, can
from switch_core.db.models import Agent, Template, User
from switch_core.db.stores.template_store import TemplateNameTaken, TemplateStore
from switch_core.template_lint import lint_template

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

Visibility = Literal["private", "shared"]

# How an agent's word for who may see a template maps onto the registry's
# pair. "Shared" is read by everyone and changed only by the saver; a
# template anyone may change is not something an agent may make.
_VISIBILITY: dict[str, tuple[str, str]] = {
    "private": ("private", "private"),
    "shared": ("public", "private"),
}


@dataclass(frozen=True)
class ActingFor:
    """The agent making the request and the owner it acts for."""

    agent: Agent
    owner: User

    @property
    def reader(self) -> Principal:
        return Principal(self.owner.id, False)


def _visibility(template: Template | Any) -> str:
    return "shared" if template.read_visibility == "public" else "private"


async def _saved_by(session: AsyncSession, template: Template | Any) -> str:
    if template.created_by_agent_id:
        agent = await session.get(Agent, template.created_by_agent_id)
        return f"agent {agent.name}" if agent else "an agent that no longer exists"
    owner = await session.get(User, template.owner_id)
    return owner.name if owner else "someone"


def _params(content: str) -> list[dict[str, Any]]:
    """The inputs a document declares, as far as it declares them properly.
    A stored document may be malformed (saving checks only what would block
    it), and an agent still needs to read it to repair it."""
    try:
        doc = yaml.safe_load(content)
    except yaml.YAMLError:
        return []
    raw = doc.get("params") if isinstance(doc, dict) else None
    if not isinstance(raw, dict):
        return []
    return [
        {
            "name": name,
            "type": spec.get("type", "string"),
            "description": spec.get("description"),
            "default": spec.get("default"),
            "required": spec.get("required"),
        }
        for name, spec in raw.items()
        if isinstance(spec, dict)
    ]


class AgentTemplates:
    def __init__(self, store: TemplateStore, *, max_bytes: int) -> None:
        self._store = store
        self._max_bytes = max_bytes

    # ── Reading ───────────────────────────────────────────────────────────

    async def listing(
        self,
        session: AsyncSession,
        acting: ActingFor,
        *,
        query: str | None,
        kind: str | None,
    ) -> list[dict[str, Any]]:
        rows = await self._store.list_all(
            session, viewer_id=acting.owner.id, is_admin=False, query=query, kind=kind
        )
        return [
            {
                "id": row.id,
                "name": row.name,
                "description": row.description,
                "kind": row.kind,
                "visibility": _visibility(row),
                "saved_by": await _saved_by(session, row),
                "can_edit": row.created_by_agent_id == acting.agent.id,
            }
            for row in rows
        ]

    async def load(
        self, session: AsyncSession, acting: ActingFor, template_id: str
    ) -> Template:
        """A template the agent may read, or ``not_found``: one it may not
        read does not exist for it, as for a person."""
        template = await self._store.get(session, template_id)
        if template is None or not can(acting.reader, "read", template):
            raise AgentRefused(
                "not_found",
                f"No template with id {template_id} that you can see. "
                "list_templates shows the ones you can use.",
            )
        return template

    async def describe(
        self, session: AsyncSession, acting: ActingFor, template_id: str
    ) -> dict[str, Any]:
        template = await self.load(session, acting, template_id)
        try:
            slots = [
                {"name": s.name, "description": s.description}
                for s in agent_slots(template.content)
            ]
        except ValueError:
            slots = []
        return {
            "id": template.id,
            "name": template.name,
            "description": template.description,
            "kind": template.kind,
            "visibility": _visibility(template),
            "saved_by": await _saved_by(session, template),
            "can_edit": template.created_by_agent_id == acting.agent.id,
            "params": _params(template.content),
            "agent_slots": slots,
            "content": template.content,
        }

    # ── Writing ───────────────────────────────────────────────────────────

    def _check_content(
        self, content: str, *, bypass_warnings: bool
    ) -> tuple[str, list[str]]:
        """The document's kind and its lint warnings, refusing a document no
        consumer could provision, and one with warnings unless the agent has
        seen them and chosen to save anyway."""
        size = len(content.encode("utf-8"))
        if size > self._max_bytes:
            raise AgentRefused(
                "too_large",
                f"The template is {size} bytes, over this server's limit of "
                f"{self._max_bytes}.",
            )
        lint = lint_template(content)
        if lint.blocked:
            raise AgentRefused(
                "invalid",
                "The template cannot be saved: "
                + "; ".join(f.message for f in lint.errors if f.blocking),
            )
        try:
            kind = template_kind(content)
        except ValueError as e:
            raise AgentRefused("invalid", str(e)) from e
        warnings = [f.message for f in lint.warnings]
        if warnings and not bypass_warnings:
            raise AgentRefused(
                "has_warnings",
                "The template was not saved, because of these warnings: "
                + " ".join(f"({i}) {w}" for i, w in enumerate(warnings, 1))
                + " Fix them, or tell whoever asked for the template what they "
                "mean and save again with bypass_warnings=true.",
            )
        return kind, warnings

    @staticmethod
    def _pair(visibility: str) -> tuple[str, str]:
        pair = _VISIBILITY.get(visibility)
        if pair is None:
            raise AgentRefused(
                "visibility_not_allowed",
                f"Visibility '{visibility}' is not one an agent can set. Use "
                "'private' (only your owner sees it) or 'shared' (everyone "
                "sees it, only you change it). A template anyone may change "
                "can be made in Switch Console.",
            )
        return pair

    @staticmethod
    def _name_taken(name: str) -> AgentRefused:
        return AgentRefused(
            "name_taken",
            f"Your owner already has a template named '{name}', saved by them "
            "or one of their agents. Pick another name.",
        )

    async def save(
        self,
        session: AsyncSession,
        acting: ActingFor,
        *,
        name: str,
        description: str,
        content: str,
        visibility: str,
        bypass_warnings: bool,
    ) -> tuple[Template, list[str]]:
        read, write = self._pair(visibility)
        kind, warnings = self._check_content(content, bypass_warnings=bypass_warnings)
        try:
            template = await self._store.create(
                session,
                Template(
                    owner_id=acting.owner.id,
                    created_by_agent_id=acting.agent.id,
                    name=name,
                    description=description,
                    kind=kind,
                    content=content,
                    read_visibility=read,
                    write_visibility=write,
                ),
            )
        except TemplateNameTaken as e:
            raise self._name_taken(name) from e
        return template, warnings

    async def _own(
        self, session: AsyncSession, acting: ActingFor, template_id: str
    ) -> Template:
        template = await self.load(session, acting, template_id)
        if template.created_by_agent_id != acting.agent.id:
            raise AgentRefused(
                "not_yours",
                f"'{template.name}' was saved by {await _saved_by(session, template)}. "
                "An agent can change or delete only the templates it saved "
                "itself. Ask whoever saved it, or save your own version under "
                "another name.",
            )
        return template

    async def update(
        self,
        session: AsyncSession,
        acting: ActingFor,
        template_id: str,
        *,
        name: str | None,
        description: str | None,
        content: str | None,
        visibility: str | None,
        bypass_warnings: bool,
    ) -> tuple[Template, list[str]]:
        template = await self._own(session, acting, template_id)
        label = name or template.name
        read, write = self._pair(visibility) if visibility is not None else (None, None)
        kind, warnings = (
            self._check_content(content, bypass_warnings=bypass_warnings)
            if content is not None
            else (None, [])
        )
        try:
            updated = await self._store.update_fields(
                session,
                template.id,
                name=name,
                description=description,
                kind=kind,
                content=content,
                read_visibility=read,
                write_visibility=write,
                guard=lambda locked: self._still_own(acting, locked),
            )
        except TemplateNameTaken as e:
            raise self._name_taken(label) from e
        return updated, warnings

    @staticmethod
    def _still_own(acting: ActingFor, locked: Template) -> None:
        """The saver check again, on the row once it is locked: the agent
        could have been deleted, clearing the mark, since it was read."""
        if locked.created_by_agent_id != acting.agent.id:
            raise AgentRefused(
                "not_yours",
                f"'{locked.name}' is no longer yours to change: an agent can "
                "change or delete only the templates it saved itself.",
            )

    async def delete(
        self, session: AsyncSession, acting: ActingFor, template_id: str
    ) -> str:
        template = await self._own(session, acting, template_id)
        locked = await session.get(
            Template, template.id, with_for_update=True, populate_existing=True
        )
        if locked is None:
            raise AgentRefused("not_found", f"No template with id {template_id}.")
        self._still_own(acting, locked)
        name = locked.name
        await self._store.delete(session, locked.id)
        return name
