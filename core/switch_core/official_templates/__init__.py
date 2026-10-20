"""Templates that come with Switch, served by the server on every workspace.

They are not rows: the server lists them beside the stored templates and
serves them by an ``official:`` id, so every workspace sees the version this
release ships and nobody can change or delete one. A template a deployment
can only use where agents are managed comes in two documents, and the
server's ``agent_management`` feature flag picks which it serves.
switch-buddy only makes sense as a managed agent, and is served only with both
``agent_management`` and ``switch_buddy`` on. The Switch expert is served only
where switch-buddy is not: buddy covers what it does, and offering both would
give a new user two built-in assistants to choose between.

Each lives in a directory here: ``template.yaml`` (for agent management),
optionally ``template.console.yaml`` (for a server without it, whose agents
Switch Console runs itself), and ``AGENT.md``, the agent's instructions,
written into the document's agent where it has none of its own. The Switch
expert's files are copies of ``switch-expert/`` at the repository root, kept
equal by a test.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any, Literal

import yaml

OFFICIAL_PREFIX = "official:"

_HERE = Path(__file__).parent


@dataclass(frozen=True)
class OfficialTemplate:
    """One template that comes with Switch, in the document this server
    serves. Read like a stored template: ``owner_id`` is None and no agent
    saved it."""

    id: str
    name: str
    description: str
    kind: str
    content: str
    owner_id: None = None
    created_by_agent_id: None = None
    read_visibility: str = "public"
    write_visibility: str = "private"
    version: int = 1


@dataclass(frozen=True)
class _Shipped:
    slug: str
    name: str
    description: str
    kind: str
    # Where the server serves it, relative to switch-buddy: "buddy" only with
    # agent management and the switch_buddy flag on (it has no Console-run
    # document, and Console asks for it only where offered); "without_buddy"
    # only where switch-buddy is not served.
    served: Literal["buddy", "without_buddy"]


_SHIPPED = (
    _Shipped(
        slug="switch-expert",
        name="Switch expert",
        description=(
            "An agent that knows Switch inside out. Ask it how to set things "
            "up or why something is off."
        ),
        kind="agent",
        served="without_buddy",
    ),
    _Shipped(
        slug="switch-buddy",
        name="switch-buddy",
        description=(
            "Your own assistant in Switch. It creates agents and rooms for you, "
            "answers anything about Switch and helps with any task."
        ),
        kind="agent",
        served="buddy",
    ),
)


def _strip_front_matter(text: str) -> str:
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end != -1:
            return text[end + 5 :].lstrip("\n")
    return text


def _with_instructions(document: str, instructions: str) -> str:
    """The document with ``instructions`` written into each agent that has
    none of its own."""
    data: dict[str, Any] = yaml.safe_load(document)
    agents: list[dict[str, Any]] = []
    resources = data.get("resources")
    if isinstance(resources, dict):
        agents = [
            spec
            for spec in resources.values()
            if isinstance(spec, dict) and spec.get("type") == "agent"
        ]
    elif isinstance(data.get("agent"), dict):
        agents = [data["agent"]]
    elif isinstance(data.get("agents"), list):
        agents = [a for a in data["agents"] if isinstance(a, dict)]
    for agent in agents:
        if not str(agent.get("instructions") or "").strip():
            agent["instructions"] = instructions
    return str(yaml.safe_dump(data, sort_keys=False, allow_unicode=True, width=1000))


@cache
def _document(slug: str, agent_management: bool) -> str:
    folder = _HERE / slug
    console = folder / "template.console.yaml"
    path = (
        folder / "template.yaml"
        if agent_management or not console.exists()
        else console
    )
    instructions = folder / "AGENT.md"
    text = path.read_text(encoding="utf-8")
    if not instructions.exists():
        return text
    return _with_instructions(
        text, _strip_front_matter(instructions.read_text(encoding="utf-8"))
    )


def official_templates(
    agent_management: bool, switch_buddy: bool
) -> list[OfficialTemplate]:
    """Every template that comes with Switch, as this server serves them."""
    return [
        OfficialTemplate(
            id=f"{OFFICIAL_PREFIX}{shipped.slug}",
            name=shipped.name,
            description=shipped.description,
            kind=shipped.kind,
            content=_document(shipped.slug, agent_management),
        )
        for shipped in _SHIPPED
        if (shipped.served == "buddy") == (agent_management and switch_buddy)
    ]


def is_official(template_id: str) -> bool:
    return template_id.startswith(OFFICIAL_PREFIX)


def official_template(
    template_id: str, agent_management: bool, switch_buddy: bool
) -> OfficialTemplate | None:
    return next(
        (
            t
            for t in official_templates(agent_management, switch_buddy)
            if t.id == template_id
        ),
        None,
    )


def matches(template: OfficialTemplate, query: str | None, kind: str | None) -> bool:
    """Whether a listing filtered by ``query`` (name or description) and
    ``kind`` shows it."""
    if kind and template.kind != kind:
        return False
    if query:
        needle = query.lower()
        return needle in template.name.lower() or needle in template.description.lower()
    return True
