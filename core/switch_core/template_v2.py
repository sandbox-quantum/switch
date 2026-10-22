"""Version 2 of the template language: resources with a key and a type.

A version 1 document says what a block is by where it sits (``agent:``,
``agents:``, ``room:``, ``group:`` with ``rooms:``) and links them by
matching text: a room lists ``"{team}-lead"`` and the agent whose name reads
the same is the one meant. Version 2 says it outright::

    version: 2
    params:
      start_in: { type: enum, enum: [nowhere, new_room], default: nowhere }
    resources:
      expert:
        type: agent
        display_name: Switch expert
        machine: "{machine}"
      expert_room:
        type: room
        if: "{start_in} == new_room"
        name: "Ask {expert.name}"
        agents: [expert]
        kickoff: "@{expert.name} hi"

Every resource has a key and a ``type`` (``agent``, ``room``, ``group``).
Resources refer to each other by key: ``agents: [expert]`` on a room, and
``{expert.name}`` anywhere for the name a resource is created under. One
construct is conditional, ``if:``: on a resource (it is created only when the
condition holds), on a param (asked only when it holds), and in a field's
value written as a list of ``{if, value}``, the first that holds being taken.
A condition is ``"{param}"`` (true when the value is) or ``"{param} == x"`` /
``"{param} != x"``.

A version 2 document is compiled, once the inputs are known, into the
version 1 document it amounts to, which the rest of the template engine runs
as it always has. What version 1 cannot say comes back beside it: an agent
whose addressing admits anyone in one of the rooms the run creates.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

import yaml

from switch_core.rooms_yaml import PLACEHOLDER_RE, ParamSpec, coerce_param, interpolate

RESOURCE_TYPES = ("agent", "room", "group")

# A reference to the name a resource is created under.
_NAME_REF = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\.name\}")
_CONDITION = re.compile(
    r"\A\s*\{([A-Za-z_][A-Za-z0-9_]*)\}\s*(?:(==|!=)\s*(.*?))?\s*\Z"
)
# Past this a display name is not slugged, as in the Console's agent-slug.
_MAX_SLUG_INPUT = 128

_AGENT_ONLY = ("type", "if")
_ROOM_ONLY = ("type", "if", "kickoff", "group")
_GROUP_ONLY = ("type", "if", "links")


class TemplateError(ValueError):
    """A version 2 document that cannot be compiled, saying where."""


def is_v2(data: dict[str, Any]) -> bool:
    return data.get("version") == 2 or "resources" in data


def is_v2_text(text: str) -> bool:
    """Whether a document's text is version 2; false for one that does not
    parse, which the version 1 path reports."""
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError:
        return False
    return isinstance(data, dict) and is_v2(data)


def _slug(value: str) -> str:
    if len(value) > _MAX_SLUG_INPUT:
        return ""
    slug = re.sub(r"[^a-z0-9._]+", "-", value.lower())
    return re.sub(r"^[._-]+|[._-]+$", "", slug)


def condition_params(expression: str) -> str:
    """The param a condition reads; raises for one that is not a condition."""
    match = _CONDITION.match(str(expression))
    if match is None:
        raise TemplateError(
            f"'{expression}' is not a condition: write \"{{param}}\", "
            '"{param} == value" or "{param} != value".'
        )
    return match.group(1)


def holds(expression: Any, values: dict[str, Any]) -> bool:
    """Whether a condition holds with these values. A param with no value
    is false, and equal to nothing."""
    match = _CONDITION.match(str(expression))
    if match is None:
        raise TemplateError(
            f"'{expression}' is not a condition: write \"{{param}}\", "
            '"{param} == value" or "{param} != value".'
        )
    name, op, literal = match.groups()
    value = values.get(name)
    if op is None:
        return value not in (None, "", False, 0)
    equal = value is not None and str(value) == str(literal).strip().strip("'\"")
    return equal if op == "==" else not equal


def _choose(node: Any, values: dict[str, Any]) -> Any:
    """A field written as ``[{if, value}, ...]`` becomes the first value whose
    condition holds (an entry with no ``if`` always does); every other node
    is walked as it is."""
    if (
        isinstance(node, list)
        and node
        and all(isinstance(item, dict) and "value" in item for item in node)
    ):
        for item in node:
            if "if" not in item or holds(item["if"], values):
                return _choose(item["value"], values)
        return None
    if isinstance(node, dict):
        return {k: _choose(v, values) for k, v in node.items()}
    if isinstance(node, list):
        return [_choose(item, values) for item in node]
    return node


def _drop_empty(node: Any) -> Any:
    if isinstance(node, dict):
        return {k: _drop_empty(v) for k, v in node.items()}
    if isinstance(node, list):
        return [_drop_empty(item) for item in node if item != ""]
    return node


def _known_values(
    params: dict[str, dict[str, Any]],
    inputs: dict[str, Any],
    builtins: dict[str, str],
) -> dict[str, Any]:
    """Each given input, else each plain default, checked as the server
    checks them; a chain or a value nobody gave is left unknown."""
    values: dict[str, Any] = dict(builtins)
    for name, raw in params.items():
        spec = ParamSpec.model_validate({k: v for k, v in raw.items() if k != "if"})
        if inputs.get(name) not in (None, ""):
            values[name] = coerce_param(inputs[name], spec, name)
        elif spec.default is not None and not isinstance(spec.default, list):
            values[name] = coerce_param(spec.default, spec, name)
    return values


@dataclass(frozen=True)
class Compiled:
    """A version 2 document as the version 1 document it amounts to, the
    inputs to run it with, and, per agent created, the rooms (by name) whose
    members may address it beyond its owner."""

    document: str
    inputs: dict[str, Any]
    room_addressing: dict[str, list[str]] = field(default_factory=dict)
    # Each resource's key, with the name it is created under.
    names: dict[str, str] = field(default_factory=dict)


def _resources(data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    raw = data.get("resources")
    if not isinstance(raw, dict) or not raw:
        raise TemplateError("'resources' must map each resource's key to it.")
    out: dict[str, dict[str, Any]] = {}
    for key, spec in raw.items():
        if not isinstance(spec, dict):
            raise TemplateError(f"resource '{key}' must be a mapping.")
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", str(key)):
            raise TemplateError(
                f"resource key '{key}' must be letters, digits and _, so "
                "{key.name} can name it."
            )
        if spec.get("type") not in RESOURCE_TYPES:
            raise TemplateError(
                f"resource '{key}' needs a type: one of {', '.join(RESOURCE_TYPES)}."
            )
        out[str(key)] = spec
    return out


def compile_v2(text: str, inputs: dict[str, Any], builtins: dict[str, str]) -> Compiled:
    data = yaml.safe_load(text)
    if not isinstance(data, dict):
        raise TemplateError("A template is a YAML mapping.")
    raw_params = data.get("params") or {}
    if not isinstance(raw_params, dict):
        raise TemplateError("'params' must map each param's name to its spec.")
    params = {k: dict(v) for k, v in raw_params.items() if isinstance(v, dict)}
    undeclared = set(inputs) - set(params)
    if undeclared:
        raise TemplateError(f"Undeclared input(s): {', '.join(sorted(undeclared))}")
    values = _known_values(params, inputs, builtins)

    # A param whose condition does not hold is not asked, and not used.
    off: dict[str, Any] = {}
    for name, spec in list(params.items()):
        if "if" in spec and not holds(spec["if"], values):
            del params[name]
            values.pop(name, None)
            off[name] = ""
    resources = {
        key: spec
        for key, spec in _resources(data).items()
        if "if" not in spec or holds(spec["if"], values)
    }
    dropped = set(_resources(data)) - set(resources)
    # A param that is not asked reads as empty, and drops out of the lists it
    # was written in (a `join` with no room picked joins nothing).
    resources = {
        key: _drop_empty(interpolate(_choose(spec, values), off))
        for key, spec in resources.items()
    }

    names: dict[str, str] = {}

    def name_of(key: str, spec: dict[str, Any]) -> str:
        if spec["type"] == "agent":
            written = spec.get("name") or ""
            name = (
                str(interpolate(str(written), values))
                if written
                else _slug(
                    str(interpolate(str(spec.get("display_name") or ""), values))
                )
            )
        else:
            name = str(interpolate(str(spec.get("name") or ""), values))
        if not name or PLACEHOLDER_RE.search(name) or _NAME_REF.search(name):
            raise TemplateError(
                f"resource '{key}' has no name yet: give it a 'name' (or, for an "
                "agent, a 'display_name') whose inputs have values."
            )
        return name

    def resolve(node: Any, where: str) -> Any:
        if isinstance(node, str):

            def by_key(match: re.Match[str]) -> str:
                key = match.group(1)
                if key in names:
                    return names[key]
                if key in dropped:
                    raise TemplateError(
                        f"{where} refers to {key}, which this run does not "
                        "create (its 'if' does not hold)."
                    )
                return match.group(0)

            return _NAME_REF.sub(by_key, node)
        if isinstance(node, dict):
            return {resolve(k, where): resolve(v, where) for k, v in node.items()}
        if isinstance(node, list):
            return [resolve(item, where) for item in node]
        return node

    # Agents first: a room's name may read an agent's, never the reverse.
    for key, spec in resources.items():
        if spec["type"] == "agent":
            names[key] = name_of(key, spec)
    resources = {key: resolve(spec, key) for key, spec in resources.items()}
    for key, spec in resources.items():
        if spec["type"] != "agent":
            names[key] = name_of(key, spec)
    resources = {key: resolve(spec, key) for key, spec in resources.items()}
    agent_keys = {k for k, s in resources.items() if s["type"] == "agent"}
    room_keys = [k for k, s in resources.items() if s["type"] == "room"]
    group_keys = [k for k, s in resources.items() if s["type"] == "group"]

    def agent_name(item: Any, where: str) -> Any:
        if isinstance(item, str) and item in agent_keys:
            return names[item]
        if isinstance(item, str) and item in dropped:
            raise TemplateError(
                f"{where} lists {item}, which this run does not create (its "
                "'if' does not hold)."
            )
        return item

    room_addressing: dict[str, list[str]] = {}
    agents: list[dict[str, Any]] = []
    for key in agent_keys:
        spec = resources[key]
        entry = {k: v for k, v in spec.items() if k not in _AGENT_ONLY}
        entry["name"] = names[key]
        addressing = entry.get("addressing")
        if isinstance(addressing, dict):
            rooms = addressing.get("anyone_in")
            if set(addressing) != {"anyone_in"} or not isinstance(rooms, list):
                raise TemplateError(
                    f"{key}: addressing is owner, owner-agents, anyone, or "
                    "{anyone_in: [room keys]}."
                )
            unknown = [r for r in rooms if r not in room_keys]
            if unknown:
                raise TemplateError(
                    f"{key}: addressing anyone_in names {', '.join(map(str, unknown))}, "
                    "which this run does not create as a room."
                )
            room_addressing[names[key]] = [names[r] for r in rooms]
            entry["addressing"] = "owner"
        for join in entry.get("join") or []:
            if isinstance(join, str) and join in room_keys:
                raise TemplateError(
                    f"{key}: join names {join}, a room this template creates; list "
                    f"the agent in that room's agents instead."
                )
        agents.append(entry)

    def room_block(key: str) -> dict[str, Any]:
        spec = resources[key]
        room = {k: v for k, v in spec.items() if k not in _ROOM_ONLY}
        room["name"] = names[key]
        if isinstance(room.get("agents"), list):
            room["agents"] = [agent_name(a, key) for a in room["agents"]]
        if isinstance(room.get("aliases"), dict):
            room["aliases"] = {
                agent_name(k, key): v for k, v in room["aliases"].items()
            }
        if isinstance(room.get("sessions"), dict):
            room["sessions"] = {
                agent_name(k, key): v for k, v in room["sessions"].items()
            }
        return room

    out: dict[str, Any] = {"version": 1}
    kept_params = {
        k: resolve({kk: vv for kk, vv in v.items() if kk != "if"}, f"param {k}")
        for k, v in params.items()
    }
    if kept_params:
        out["params"] = kept_params
    if agents:
        out["agents"] = agents
    if len(group_keys) > 1:
        raise TemplateError("A template creates at most one group.")
    if group_keys:
        group = resources[group_keys[0]]
        out["group"] = {k: v for k, v in group.items() if k not in _GROUP_ONLY}
        out["group"]["name"] = names[group_keys[0]]
        rooms = []
        for key in room_keys:
            if resources[key].get("group") not in (None, group_keys[0]):
                raise TemplateError(
                    f"{key}: group names a group this template does not create."
                )
            block = room_block(key)
            if resources[key].get("kickoff"):
                block["kickoff"] = resources[key]["kickoff"]
            rooms.append(block)
        out["rooms"] = rooms
        links = []
        for link in group.get("links") or []:
            if not isinstance(link, dict):
                raise TemplateError(
                    f"{group_keys[0]}: each link is {{from, to, label}}."
                )
            ends = [link.get("from"), link.get("to")]
            for end in ends:
                if end not in room_keys:
                    raise TemplateError(
                        f"{group_keys[0]}: a link names {end}, which is not a room "
                        "this run creates."
                    )
            links.append(
                {
                    "from": names[str(ends[0])],
                    "to": names[str(ends[1])],
                    **({"label": link["label"]} if link.get("label") else {}),
                }
            )
        if links:
            out["links"] = links
    elif len(room_keys) > 1:
        raise TemplateError(
            "Several rooms go in a group: add a resource of type group, and give "
            "each room group: <its key>."
        )
    elif room_keys:
        out["room"] = room_block(room_keys[0])
        if resources[room_keys[0]].get("kickoff"):
            out["kickoff"] = resources[room_keys[0]]["kickoff"]
    # An input may carry a reference too: a directory param's default,
    # "{$agents_dir}/{expert.name}", filled into the form and sent back.
    run_inputs = {k: resolve(v, f"input {k}") for k, v in inputs.items() if k in params}
    return Compiled(
        document=yaml.safe_dump(out, sort_keys=False, allow_unicode=True),
        inputs=run_inputs,
        room_addressing=room_addressing,
        names=names,
    )
