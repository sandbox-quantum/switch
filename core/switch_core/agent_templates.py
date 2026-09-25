"""Stored templates as the server reads them for an agent.

The registry keeps documents verbatim and never parses them. When an agent
asks what a template is, or asks to run one, something has to: this module
says which kind a document is, which agents it would create, and how to turn
an agent or team template into a room document the server can provision.

The server never creates agents; the Console does, on the machine the agent
runs on. So an agent or team template is runnable here only when every agent
it describes is swapped for an agent that already exists, the way the
Console's Use page does it for "Existing agent". The ``agent:``/``agents:``
block is then dropped and the room half runs like any room template.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

import yaml

from switch_core.agent_refusals import AgentRefused
from switch_core.rooms_yaml import CONSOLE_PARAM_TYPES, PLACEHOLDER_RE, interpolate

TemplateKind = Literal["room", "group", "agent"]


def _load(text: str) -> dict[str, Any]:
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as e:
        raise ValueError(f"Invalid YAML: {e}") from e
    if not isinstance(data, dict):
        raise ValueError("A template is a YAML mapping")
    return data


def _agents(data: dict[str, Any]) -> list[dict[str, Any]]:
    if isinstance(data.get("agent"), dict):
        return [data["agent"]]
    return [a for a in data.get("agents") or [] if isinstance(a, dict)]


def template_kind(text: str) -> TemplateKind:
    """The kind the registry files a document under, by the Console's rule:
    agents with one agent is an agent template, with several a group, a
    ``group:`` a group, anything else a room."""
    data = _load(text)
    agents = _agents(data)
    if agents:
        return "agent" if len(agents) == 1 else "group"
    return "group" if "group" in data else "room"


@dataclass(frozen=True)
class AgentSlot:
    """An agent a template would create, which a run fills with an agent
    that already exists. ``name`` is as the template writes it, placeholders
    and all."""

    name: str
    description: str | None


def agent_slots(text: str) -> list[AgentSlot]:
    return [
        AgentSlot(
            name=str(a.get("name", "")),
            description=str(a["description"]) if a.get("description") else None,
        )
        for a in _agents(_load(text))
    ]


def _param_defaults(data: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """The values a slot name can be read with before the server resolves
    the document: what was given, else a plain (non-list) default."""
    values: dict[str, Any] = {}
    for name, spec in (data.get("params") or {}).items():
        if isinstance(spec, dict) and not isinstance(spec.get("default"), list):
            if spec.get("default") is not None:
                values[name] = spec["default"]
    values.update({k: v for k, v in inputs.items() if v is not None})
    return values


def _name_pattern(names: list[str]) -> re.Pattern[str] | None:
    """A mention of any of ``names``, the longest first, counted only when
    neither neighbour could continue an agent name: `my-helper` is not
    `helper`, and "@helper." at the end of a sentence still is. A name inside
    a `{placeholder}` is left alone."""
    if not names:
        return None
    ordered = sorted(names, key=len, reverse=True)
    alternatives = "|".join(re.escape(n) for n in ordered)
    return re.compile(
        rf"(?<![A-Za-z0-9_.{{-])({alternatives})(?![A-Za-z0-9_}}-]|\.[A-Za-z0-9_-])"
    )


def _placeholders(node: Any, into: set[str]) -> set[str]:
    if isinstance(node, str):
        into.update(m.group(1) for m in PLACEHOLDER_RE.finditer(node))
    elif isinstance(node, dict):
        for k, v in node.items():
            _placeholders(k, into)
            _placeholders(v, into)
    elif isinstance(node, list):
        for item in node:
            _placeholders(item, into)
    return into


def room_document(
    text: str, filled: dict[str, str], inputs: dict[str, Any]
) -> tuple[str, dict[str, Any]]:
    """The room half of an agent or team template, each agent it would
    create replaced by the existing agent that fills its slot.

    ``filled`` maps a slot, by the name the template writes or the name it
    resolves to with ``inputs``, to an existing agent's name. Returns the
    document and the inputs to run it with. A document with no agents is
    returned as it is. A slot left empty is refused: creating an agent is the
    Console's to do.
    """
    data = _load(text)
    agents = _agents(data)
    if not agents:
        return text, inputs

    values = _param_defaults(data, inputs)
    replacements: dict[str, str] = {}
    unfilled: list[str] = []
    for agent in agents:
        written = str(agent.get("name", ""))
        resolved = str(interpolate(written, values))
        chosen = filled.get(written) or filled.get(resolved)
        if not chosen:
            unfilled.append(resolved)
            continue
        replacements[written] = chosen
        replacements[resolved] = chosen
    if unfilled:
        raise AgentRefused(
            "agent_creation_console_only",
            "Nothing was created: this template creates "
            f"{', '.join(unfilled)}, and creating agents happens in Switch "
            "Console. To run it here, fill each with an agent that already "
            "exists, in `agents`: {slot name: agent name}.",
        )

    room_part = {
        k: data[k] for k in ("room", "group", "rooms", "links", "kickoff") if k in data
    }
    if (
        not room_part.get("room")
        and "group" not in room_part
        and "rooms" not in room_part
    ):
        raise AgentRefused(
            "agent_creation_console_only",
            "Nothing was created: this template only creates an agent, with no "
            "room to run. Creating agents happens in Switch Console.",
        )
    if isinstance(data.get("agent"), dict):
        # A one-agent template names its agent `{agent}` in the room, a value
        # the Console supplies. Here it is the agent that fills the slot.
        values["agent"] = next(iter(replacements.values()))
    # Every value already known is filled in before names are swapped, so a
    # slot reached through a param (`agents: ["{member}"]` with `member`
    # defaulting to a slot) is swapped too. What is left, a chain or an input
    # nobody gave, stays for the server to resolve.
    room_part = interpolate(room_part, values)
    declared = {
        name: spec
        for name, spec in (data.get("params") or {}).items()
        if not (isinstance(spec, dict) and spec.get("type") in CONSOLE_PARAM_TYPES)
    }
    still_used = _placeholders(room_part, set())
    # Given inputs keep their params, so the server still checks them against
    # the param's pattern and bounds.
    params = {
        name: spec
        for name, spec in declared.items()
        if name in still_used or name in inputs
    }
    run_inputs = {k: v for k, v in inputs.items() if k in params}

    pattern = _name_pattern(list(replacements))

    def in_text(value: Any) -> Any:
        if not isinstance(value, str) or pattern is None:
            return value
        return pattern.sub(lambda m: replacements[m.group(1)], value)

    def rename(name: Any) -> Any:
        return replacements.get(name, name) if isinstance(name, str) else name

    rooms = [room_part.get("room")] + list(room_part.get("rooms") or [])
    for room in rooms:
        if not isinstance(room, dict):
            continue
        if isinstance(room.get("agents"), list):
            room["agents"] = [rename(a) for a in room["agents"]]
        if isinstance(room.get("aliases"), dict):
            room["aliases"] = {rename(k): v for k, v in room["aliases"].items()}
        if "kickoff" in room:
            room["kickoff"] = in_text(room["kickoff"])
    if "kickoff" in room_part:
        room_part["kickoff"] = in_text(room_part["kickoff"])

    out: dict[str, Any] = {}
    if isinstance(data.get("version"), int):
        out["version"] = data["version"]
    if params:
        out["params"] = params
    out.update(room_part)
    return yaml.safe_dump(out, sort_keys=False, allow_unicode=True), run_inputs
