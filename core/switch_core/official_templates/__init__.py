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

Each also has ``revisions.json``: every revision of it released, numbered
from 1, with a fingerprint of what each one served and set on its agents.
The last is the revision this release serves (its ``version``), and agents
created from an older one are brought up to it when the server starts
(``management/template_updates.py``). Revisions are recorded at release time,
with the other versions (see ``revisions.py``); between releases a changed
template is served under its last revision.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any, Literal

import yaml

OFFICIAL_PREFIX = "official:"

# Each template's revisions, next to its files: see ``revisions.py``.
REVISIONS_FILE = "revisions.json"

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
    return document_in(_HERE / slug, agent_management)


def document_in(folder: Path, agent_management: bool) -> str:
    """The document a template's folder serves: its ``template.yaml`` (or,
    without agent management, its ``template.console.yaml`` where it has
    one), with ``AGENT.md`` written in as its agents' instructions."""
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
            version=current_revision(shipped.slug),
        )
        for shipped in _SHIPPED
        if (shipped.served == "buddy") == (agent_management and switch_buddy)
    ]


@cache
def _revisions(slug: str) -> tuple[dict[str, Any], ...]:
    path = _HERE / slug / REVISIONS_FILE
    data = json.loads(path.read_text(encoding="utf-8"))
    revisions = tuple(data["revisions"])
    numbers = [entry["revision"] for entry in revisions]
    if numbers != list(range(1, len(numbers) + 1)):
        raise RuntimeError(
            f"{path} must list revisions 1, 2, 3… in order; it lists {numbers}"
        )
    return revisions


def current_revision(slug: str) -> int:
    """The revision of an official template this release serves."""
    return int(_revisions(slug)[-1]["revision"])


def slug_of(template_id: str) -> str:
    return template_id.removeprefix(OFFICIAL_PREFIX)


def released_agent_fingerprints(
    slug: str,
) -> list[tuple[int, dict[str, dict[str, str]]]]:
    """Every revision of an official template ever released, newest first,
    with the fingerprints of what it set on each agent it creates, by key:
    how an agent created before installs were recorded is told apart from
    one somebody has changed."""
    return [
        (int(entry["revision"]), dict(entry["agents"]))
        for entry in reversed(_revisions(slug))
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
