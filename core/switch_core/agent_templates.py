"""Stored templates as the server reads them for an agent.

The registry keeps documents verbatim and never parses them. When an agent
asks what a template is, or asks to run one, something has to: this module
says which kind a document is, which agents it would create, and how to turn
an agent or team template into the agents to create and the room document
the server provisions after them.

Each agent a template describes is either created, as a managed agent on one
of the owner's machines (`plan_template`, then `template_runs`), or, where
the entry says `allow_existing: true`, filled with an agent that already
exists. Either way the ``agent:``/``agents:`` block is then dropped and the
room half runs like any room template, naming the agents by their names.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

import yaml
from pydantic import ValidationError

from switch_core.agent_icon import InvalidIconUrl, validate_icon_url
from switch_core.rooms_yaml import (
    CONSOLE_PARAM_TYPES,
    ENTITY_PARAM_TYPES,
    FIRST,
    PLACEHOLDER_RE,
    ParamSpec,
    coerce_param,
    interpolate,
)
from switch_core.template_runs import (
    AGENTS_DIR,
    AgentsNotCreated,
    ConnectionPlan,
    NewAgentPlan,
    Problem,
)
from switch_core.template_v2 import NestedTemplate, compile_v2, is_v2

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
    """The kind the registry files a document under, by the Console's rule
    (``kindOf``): a ``group:`` or ``rooms:`` makes a group, then several
    agents a group, one agent an agent template, anything else a room."""
    data = _load(text)
    if is_v2(data):
        resources = data.get("resources")
        kinds = [
            spec.get("type")
            for spec in (resources.values() if isinstance(resources, dict) else [])
            if isinstance(spec, dict)
        ]
        if "group" in kinds or kinds.count("room") > 1 or kinds.count("agent") > 1:
            return "group"
        return "agent" if "agent" in kinds else "room"
    if "group" in data or isinstance(data.get("rooms"), list):
        return "group"
    agents = _agents(data)
    if agents:
        return "agent" if len(agents) == 1 else "group"
    return "room"


# Past this a display name is not slugged, as in the Console's agent-slug.
_MAX_SLUG_INPUT = 128


def _slug(value: str) -> str:
    """An agent name from a display name, the Console's
    ``slugifyAgentNamePart``: what an unnamed agent is created under."""
    if len(value) > _MAX_SLUG_INPUT:
        return ""
    slug = re.sub(r"[^a-z0-9._]+", "-", value.lower())
    return re.sub(r"^[._-]+|[._-]+$", "", slug)


def _written_name(agent: dict[str, Any]) -> str:
    """How a slot is named in the template: its ``name``, or for an agent
    that has none, its ``display_name``."""
    return str(agent.get("name") or agent.get("display_name") or "")


def _resolved_name(agent: dict[str, Any], values: dict[str, Any]) -> str:
    """The name the agent would be created under once the inputs are in."""
    if agent.get("name"):
        return str(interpolate(str(agent["name"]), values))
    return _slug(str(interpolate(str(agent.get("display_name") or ""), values)))


@dataclass(frozen=True)
class AgentSlot:
    """An agent a template describes: created by a run, or, where
    ``allow_existing`` is true, filled with one that already exists. Fields
    are as the template writes them, placeholders and all, a setting said for
    every agent by a param no entry reads shown as that ``{param}``; None
    where it says nothing."""

    name: str
    description: str | None
    allow_existing: bool
    # A version 2 resource's key, and the condition it is created under.
    key: str | None
    condition: str | None
    provider: str | None
    machine: str | None
    location: str | None
    model: str | None
    directory: str | None
    connections: list[dict[str, Any]]


def _written(entry: dict[str, Any], key: str) -> str | None:
    value = entry.get(key)
    return None if value is None else str(value)


def _slot_connections(entry: dict[str, Any]) -> list[dict[str, Any]]:
    raw = entry.get("connections")
    out: list[dict[str, Any]] = []
    for item in raw if isinstance(raw, list) else []:
        if isinstance(item, dict):
            repos = item.get("repos") or []
            out.append(
                {
                    "service": str(item.get("service")),
                    "access": item.get("access"),
                    "repos": [
                        str(r) for r in (repos if isinstance(repos, list) else [repos])
                    ],
                }
            )
        else:
            out.append({"service": str(item), "access": None, "repos": []})
    return out


def _v2_slots(data: dict[str, Any]) -> list[AgentSlot]:
    resources = data.get("resources")
    slots = []
    for key, spec in resources.items() if isinstance(resources, dict) else []:
        if not isinstance(spec, dict) or spec.get("type") != "agent":
            continue
        slots.append(
            AgentSlot(
                name=_written_name(spec),
                description=str(spec["description"])
                if spec.get("description")
                else None,
                allow_existing=spec.get("allow_existing") is True,
                key=str(key),
                condition=_written(spec, "if"),
                provider=_written(spec, "provider"),
                machine=_written(spec, "machine"),
                location=_written(spec, "location"),
                model=_written(spec, "model"),
                directory=_written(spec, "directory"),
                connections=_slot_connections(spec),
            )
        )
    return slots


def repo_note(repo: str) -> str:
    """What an agent created from a template with a ``repo`` is told: to
    clone it into its directory. Access to a private one comes from a
    connection the template lists, or the machine's own credentials."""
    return (
        f"\n\nYou work on the repository {repo}. If your working directory is "
        f"not a clone of it yet, clone {repo} into it first."
    )


def agent_slots(text: str) -> list[AgentSlot]:
    data = _load(text)
    if is_v2(data):
        return _v2_slots(data)
    planner = _Planner(data, {}, None)

    def said(entry: dict[str, Any], key: str) -> str | None:
        if entry.get(key) is not None:
            return str(entry[key])
        shared = planner.for_all(key)
        return f"{{{shared}}}" if shared else None

    return [
        AgentSlot(
            name=_written_name(a),
            description=str(a["description"]) if a.get("description") else None,
            allow_existing=a.get("allow_existing") is True,
            key=None,
            condition=None,
            provider=said(a, "provider"),
            machine=said(a, "machine"),
            location=said(a, "location"),
            model=_written(a, "model"),
            directory=said(a, "directory"),
            connections=_slot_connections(a),
        )
        for a in planner.entries
    ]


def _known_values(data: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """The values that can be filled in before the server sees the document:
    each given input, else each plain (non-list) default, checked and coerced
    exactly as the server would. A chain or a value nobody gave is left for
    the server to resolve."""
    raw = data.get("params") or {}
    if not isinstance(raw, dict):
        raise ValueError("'params' must be a mapping of param name to its spec")
    try:
        declared = {name: ParamSpec.model_validate(spec) for name, spec in raw.items()}
    except ValidationError as e:
        raise ValueError(f"Invalid param spec: {e}") from e
    undeclared = set(inputs) - set(declared)
    if undeclared:
        raise ValueError(f"Undeclared input(s): {', '.join(sorted(undeclared))}")
    values: dict[str, Any] = {}
    for name, spec in declared.items():
        # An agent, room, bridge or user is left for the server, which checks
        # that it exists; only a slot it names is swapped (see room_document).
        if spec.type in ENTITY_PARAM_TYPES:
            continue
        if inputs.get(name) is not None:
            values[name] = coerce_param(inputs[name], spec, name)
        elif spec.default is not None and not isinstance(spec.default, list):
            values[name] = coerce_param(spec.default, spec, name)
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


def _room_part(data: dict[str, Any]) -> dict[str, Any] | None:
    """The keys the server provisions rooms from, or None for a document
    that describes no room."""
    part = {
        k: data[k] for k in ("room", "group", "rooms", "links", "kickoff") if k in data
    }
    if not part.get("room") and "group" not in part and "rooms" not in part:
        return None
    return part


def room_document(
    text: str, filled: dict[str, str], inputs: dict[str, Any]
) -> tuple[str, dict[str, Any]]:
    """The room half of an agent or team template, each agent it would
    create replaced by the existing agent that fills its slot.

    ``filled`` maps a slot, by the name the template writes or the name it
    resolves to with ``inputs``, to the name of the agent standing in it: an
    existing one, or the one the run creates. Returns the document and the
    inputs to run it with. A document with no agents is returned as it is.
    """
    data = _load(text)
    agents = _agents(data)
    if not agents:
        return text, inputs

    values = _known_values(data, inputs)
    replacements: dict[str, str] = {}
    unfilled: list[str] = []
    for agent in agents:
        written = _written_name(agent)
        resolved = _resolved_name(agent, values)
        chosen = filled.get(written) or filled.get(resolved)
        if not chosen:
            unfilled.append(resolved or written or "an unnamed agent")
            continue
        for key in (written, resolved):
            if key:
                replacements[key] = chosen
    if unfilled:
        raise ValueError(f"No agent named for {', '.join(unfilled)}")

    room_part = _room_part(data)
    if room_part is None:
        raise ValueError("The template has no room to provision")
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
    params = {name: spec for name, spec in declared.items() if name in still_used}
    run_inputs = {k: v for k, v in inputs.items() if k in params}
    for name, spec in list(params.items()):
        # An agent param that names a slot, as its input, its default or a
        # candidate in its default list, now names the agent filling it.
        # Only agent params: a bridge or room that shares a slot's name is
        # something else.
        if not isinstance(spec, dict) or spec.get("type") != "agent":
            continue
        given = inputs.get(name)
        if isinstance(given, str) and given in replacements:
            run_inputs[name] = replacements[given]
        default = spec.get("default")
        if isinstance(default, str) and default in replacements:
            params[name] = {**spec, "default": replacements[default]}
        elif isinstance(default, list):
            params[name] = {
                **spec,
                "default": [
                    replacements.get(c, c) if isinstance(c, str) else c for c in default
                ],
            }

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


# ── Planning a run on the server ──────────────────────────────────────────

_AGENT_ADDRESSING = ("owner", "owner-agents", "anyone")


@dataclass(frozen=True)
class TemplatePlan:
    """What running a template creates: the agents, by slot, and the room
    document after them (None when the template describes no room), with the
    inputs to provision it with. ``existing`` maps each slot filled with an
    agent that already exists to that agent's name."""

    new_agents: list[NewAgentPlan]
    existing: dict[str, str]
    document: str | None
    inputs: dict[str, Any]
    # Per agent created, the rooms (by name) whose members may address it
    # beyond its owner: a version 2 `addressing: {anyone_in: [...]}`.
    room_addressing: dict[str, list[str]]
    # The templates the run saves for the deployer: version 2 `template`
    # resources.
    templates: list[NestedTemplate]


def _machine_ready(machine: dict[str, Any], provider: str | None) -> bool:
    if machine.get("state") != "online":
        return False
    if provider is None:
        return True
    return any(
        entry.get("provider") == provider
        and entry.get("installed")
        and entry.get("auth") not in ("missing", "expired")
        for entry in machine.get("providers") or []
    )


def _why_not_ready(machine: dict[str, Any], providers: set[str]) -> str:
    name = str(machine.get("name"))
    state = machine.get("state")
    if state != "online":
        return f"{name} is {state}"
    entries = {str(e.get("provider")): e for e in machine.get("providers") or []}
    for provider in sorted(providers):
        entry = entries.get(provider)
        if entry is None or not entry.get("installed"):
            return f"{provider} is not installed on {name}"
        if entry.get("auth") in ("missing", "expired"):
            return f"{provider} is not signed in on {name}"
    return f"{name} cannot take it"


def _find_machine(machines: list[dict[str, Any]], ref: str) -> dict[str, Any] | None:
    by_id = next((m for m in machines if m.get("id") == ref), None)
    if by_id is not None:
        return by_id
    named = [m for m in machines if m.get("name") == ref]
    return named[0] if len(named) == 1 else None


def _ready_providers(machine: dict[str, Any] | None) -> list[str]:
    if machine is None:
        return []
    return [
        str(entry["provider"])
        for entry in machine.get("providers") or []
        if entry.get("installed") and entry.get("auth") not in ("missing", "expired")
    ]


class _Planner:
    """Resolves each agent entry to what it creates, collecting every problem
    rather than stopping at the first."""

    def __init__(
        self,
        data: dict[str, Any],
        values: dict[str, Any],
        machines: list[dict[str, Any]] | None,
    ) -> None:
        self.data = data
        self.values = values
        self.machines = machines
        raw = data.get("params")
        self.params: dict[str, dict[str, Any]] = {
            k: v
            for k, v in (raw if isinstance(raw, dict) else {}).items()
            if isinstance(v, dict)
        }
        self.entries = _agents(data)
        self.problems: list[Problem] = []
        self.room_inputs: dict[str, str] = {}
        # Why `$first` found no machine, one line per machine the owner has.
        self.unready: list[str] = []

    def field_texts(self) -> list[str]:
        return [
            str(entry[key])
            for entry in self.entries
            for key in ("provider", "location", "machine", "directory")
            if entry.get(key) is not None
        ]

    def for_all(self, kind: str) -> str | None:
        """The param of type ``kind`` that no entry's field reads, which says
        it for every agent."""
        texts = self.field_texts()
        for name, spec in self.params.items():
            if spec.get("type") == kind and not any(
                f"{{{name}}}" in text for text in texts
            ):
                return name
        return None

    def chain(self, name: str) -> list[str]:
        default = self.params.get(name, {}).get("default")
        if isinstance(default, list):
            return [str(c) for c in default]
        return [] if default is None else [str(default)]

    def providers_on(self, name: str) -> set[str]:
        """The providers the agents a machine param places say outright:
        what the machine it resolves to must be able to run."""
        shared = self.for_all("machine") == name
        wanted: set[str] = set()
        for entry in self.entries:
            field_ = entry.get("machine")
            if field_ == f"{{{name}}}" or (field_ is None and shared):
                provider = entry.get("provider")
                text = (
                    str(interpolate(provider, self.values))
                    if provider is not None
                    else ""
                )
                if text and not PLACEHOLDER_RE.search(text):
                    wanted.add(text)
        return wanted

    def resolve_machine_param(self, name: str) -> str | None:
        """A machine param's value, one for every agent it places: as given,
        else the first candidate of its default the owner has (``$first``:
        the first online machine that can run all their providers)."""
        if name in self.values:
            return str(self.values[name])
        if self.machines is None:
            return None
        ordered = sorted(self.machines, key=lambda m: str(m.get("name")))
        providers = self.providers_on(name)
        for candidate in self.chain(name):
            if candidate == FIRST:
                ready = next(
                    (
                        m
                        for m in ordered
                        if _machine_ready(m, None)
                        and all(_machine_ready(m, p) for p in providers)
                    ),
                    None,
                )
                if ready is not None:
                    self.values[name] = str(ready["id"])
                    return str(ready["id"])
                self.unready = [_why_not_ready(m, providers) for m in ordered]
                continue
            found = _find_machine(self.machines, candidate)
            if found is not None:
                self.values[name] = str(found["id"])
                return str(found["id"])
        return None

    def first_machine(self, entry: dict[str, Any]) -> str | None:
        """``$first`` for one entry: the first online machine, by name, that
        can run the provider it says outright."""
        if self.machines is None:
            return None
        provider = entry.get("provider")
        text = str(interpolate(provider, self.values)) if provider is not None else ""
        wanted = {text} if text and not PLACEHOLDER_RE.search(text) else set()
        ordered = sorted(self.machines, key=lambda m: str(m.get("name")))
        ready = next(
            (
                m
                for m in ordered
                if _machine_ready(m, None) and all(_machine_ready(m, p) for p in wanted)
            ),
            None,
        )
        if ready is None:
            self.unready = [_why_not_ready(m, wanted) for m in ordered]
            return None
        return str(ready["id"])

    def resolve_provider_param(self, name: str, machine_ref: str | None) -> str | None:
        """A provider param's value: as given, else the first candidate of its
        default ready on the agent's machine (``$first``: the first ready)."""
        if name in self.values:
            return str(self.values[name])
        machine = (
            _find_machine(self.machines, machine_ref)
            if self.machines is not None and machine_ref is not None
            else None
        )
        ready = _ready_providers(machine)
        for candidate in self.chain(name):
            if candidate == FIRST:
                if ready:
                    return ready[0]
                continue
            if machine is None or candidate in ready:
                return candidate
        return None

    def unready_text(self) -> str:
        if self.machines == []:
            return " (your owner has no machines)"
        return f" ({'; '.join(self.unready)})" if self.unready else ""

    def problem(self, slot: str, code: str, message: str) -> None:
        self.problems.append(Problem(slot, code, message))

    def text(self, slot: str, node: Any, values: dict[str, Any], what: str) -> Any:
        """``node`` with the values filled in; a placeholder left over names
        an input nobody gave."""
        result = interpolate(node, values)
        left = sorted(
            n
            for n in _placeholders(result, set())
            if not n.startswith("$") and n in self.params
        )
        if left:
            self.problem(
                slot,
                "input_missing",
                f"its {what} needs {', '.join(left)}, which has no value; give "
                "it in inputs.",
            )
        return result

    def plan(self, entry: dict[str, Any], slot: str) -> NewAgentPlan | None:
        before = len(self.problems)
        values = dict(self.values)
        name = _resolved_name(entry, values)
        values["agent"] = name

        provider_field = entry.get("provider")
        machine: str | None = None
        machine_field = entry.get("machine")
        if machine_field is not None:
            ref = PLACEHOLDER_RE.fullmatch(str(machine_field))
            if ref and self.params.get(ref.group(1), {}).get("type") == "machine":
                machine = self.resolve_machine_param(ref.group(1))
                if machine is None:
                    self.problem(
                        slot,
                        "machine_unresolved",
                        f"none of the machines its '{ref.group(1)}' input "
                        "offers is one of your owner's machines that can take it"
                        f"{self.unready_text()}; give a machine in inputs.",
                    )
            else:
                machine = str(self.text(slot, machine_field, values, "machine"))
        elif (shared := self.for_all("machine")) is not None:
            machine = self.resolve_machine_param(shared)
            if machine is None:
                self.problem(
                    slot,
                    "machine_unresolved",
                    f"none of the machines the '{shared}' input offers is one "
                    f"of your owner's machines that can take it{self.unready_text()}; "
                    "give a machine in inputs.",
                )
        elif entry.get("location") is not None or self.for_all("location"):
            # A location (this computer, an SSH host) is something a Console
            # knows, not the server: it names a machine only when it is one
            # of the owner's machines, and otherwise stands for `$first`.
            field_ = entry.get("location")
            if field_ is None:
                field_ = f"{{{self.for_all('location')}}}"
            written = str(interpolate(field_, values))
            found = (
                _find_machine(self.machines, written)
                if self.machines is not None and not PLACEHOLDER_RE.search(written)
                else None
            )
            machine = (
                str(found["id"]) if found is not None else self.first_machine(entry)
            )
            if machine is None:
                self.problem(
                    slot,
                    "machine_unresolved",
                    f"none of your owner's machines can take it{self.unready_text()}.",
                )
        else:
            self.problem(
                slot,
                "machine_unsaid",
                "the template never says which machine it runs on. Give it a "
                "'machine:' or declare a 'machine' param.",
            )

        provider: str | None = None
        if provider_field is not None:
            ref = PLACEHOLDER_RE.fullmatch(str(provider_field))
            if ref and self.params.get(ref.group(1), {}).get("type") == "provider":
                provider = self.resolve_provider_param(ref.group(1), machine)
            else:
                provider = str(self.text(slot, provider_field, values, "provider"))
        elif (shared := self.for_all("provider")) is not None:
            provider = self.resolve_provider_param(shared, machine)
        else:
            self.problem(
                slot,
                "provider_unsaid",
                "the template never says which coding agent runs it. Give it a "
                "'provider:' or declare a 'provider' param.",
            )
        if provider is None and len(self.problems) == before:
            self.problem(
                slot,
                "provider_unresolved",
                "none of the coding agents its provider input offers is ready "
                "on its machine; give a provider in inputs.",
            )

        directory: str | None = None
        directory_field = entry.get("directory")
        if directory_field is None and (shared := self.for_all("directory")):
            directory_field = f"{{{shared}}}"
        if directory_field is None:
            self.problem(
                slot,
                "directory_unsaid",
                "the template never says which directory it works in. Give it "
                f"a 'directory:' ({AGENTS_DIR}/{{agent}} is its own folder on "
                "the machine) or declare a 'directory' param.",
            )
        else:
            directory = str(self.text(slot, directory_field, values, "directory"))

        # A room param is the server's to check, so it is not among the known
        # values; for a join it is the name the deployer gave.
        join_values = {**values, **self.room_inputs}
        join = []
        for j in interpolate(entry.get("join") or [], join_values):
            if not isinstance(j, str) or not j.strip():
                continue
            left = [n for n in PLACEHOLDER_RE.findall(j) if n in self.params]
            if left:
                self.problem(
                    slot,
                    "input_missing",
                    f"it joins the room {', '.join(left)} names, which has no "
                    "value; give it in inputs.",
                )
                continue
            join.append(j)

        addressing = str(entry.get("addressing") or "owner")
        if addressing not in _AGENT_ADDRESSING:
            self.problem(
                slot,
                "invalid_addressing",
                f"addressing '{addressing}' is not one of "
                f"{', '.join(_AGENT_ADDRESSING)}.",
            )

        instructions = str(
            self.text(slot, entry.get("instructions") or "", values, "instructions")
        )
        if not instructions.strip():
            self.problem(slot, "instructions_unsaid", "it has no instructions.")

        connections = self.connections(entry, slot, values)
        repo = entry.get("repo")
        if repo:
            repo_text = str(self.text(slot, repo, values, "repo"))
            instructions += repo_note(repo_text)

        isolation = str(interpolate(entry.get("isolation") or "shared", values))
        if isolation not in ("shared", "isolated"):
            self.problem(
                slot,
                "invalid_isolation",
                f"isolation '{isolation}' is not shared or isolated.",
            )
        auto_approve = interpolate(entry.get("auto_approve", False), values)
        if not isinstance(auto_approve, bool):
            self.problem(
                slot, "invalid_auto_approve", "auto_approve is not true or false."
            )
        icon_url: str | None = None
        written_icon = entry.get("icon_url")
        if written_icon:
            try:
                icon_url = validate_icon_url(
                    str(self.text(slot, written_icon, values, "icon_url"))
                )
            except InvalidIconUrl as invalid:
                self.problem(slot, "invalid_icon_url", str(invalid))
        can_manage_agents = interpolate(entry.get("can_manage_agents", False), values)
        if not isinstance(can_manage_agents, bool):
            self.problem(
                slot,
                "invalid_can_manage_agents",
                "can_manage_agents is not true or false.",
            )
        advanced = self.text(
            slot, entry.get("advanced_config") or {}, values, "advanced_config"
        )
        if not isinstance(advanced, dict):
            self.problem(
                slot, "invalid_advanced_config", "advanced_config is not a mapping."
            )
        model = entry.get("model")
        model_text = (
            str(self.text(slot, model, values, "model")) if model is not None else ""
        )
        display_name = entry.get("display_name")

        if len(self.problems) > before:
            return None
        assert machine is not None and provider is not None
        return NewAgentPlan(
            slot=slot,
            name=name,
            description=str(
                interpolate(entry.get("description") or "", values) or name
            ),
            display_name=(
                str(interpolate(display_name, values)) if display_name else None
            ),
            icon_url=icon_url,
            instructions=instructions,
            provider=provider,
            machine=machine,
            model=model_text or None,
            advanced_config=dict(advanced),
            isolation=isolation,
            auto_approve=bool(auto_approve),
            directory=directory,
            addressing=addressing,
            can_manage_agents=bool(can_manage_agents),
            connections=connections,
            joins=join,
        )

    def connections(
        self, entry: dict[str, Any], slot: str, values: dict[str, Any]
    ) -> list[ConnectionPlan]:
        raw = entry.get("connections") or []
        if not isinstance(raw, list):
            self.problem(slot, "invalid_connections", "connections is not a list.")
            return []
        plans: list[ConnectionPlan] = []
        for item in self.text(slot, raw, values, "connections"):
            if isinstance(item, str):
                item = {"service": item}
            if not isinstance(item, dict) or not item.get("service"):
                self.problem(
                    slot,
                    "invalid_connections",
                    "each connection is a service name or {service, access, repos}.",
                )
                continue
            access = item.get("access")
            if access not in (None, "read", "write"):
                self.problem(
                    slot,
                    "invalid_connections",
                    f"{item['service']}: access '{access}' is not read or write.",
                )
                continue
            repos = item.get("repos") or []
            if isinstance(repos, str):
                repos = [repos]
            plans.append(
                ConnectionPlan(
                    service=str(item["service"]),
                    access=access,
                    repositories=[str(r) for r in repos if str(r).strip()],
                )
            )
        return plans


def plan_template(
    text: str,
    filled: dict[str, str],
    inputs: dict[str, Any],
    *,
    builtins: dict[str, str],
    machines: list[dict[str, Any]] | None,
) -> TemplatePlan:
    """What running ``text`` on the server creates.

    ``filled`` puts an existing agent in a slot, by the name the template
    writes or the one it resolves to; only an entry that says
    ``allow_existing: true`` takes one. Every other entry is created as a
    managed agent. ``machines`` is the owner's machines as ``list_machines``
    reports them (None without agent management), for a ``machine`` or
    ``provider`` param's candidates. Refused with every problem found, before
    anything is created.
    """
    data = _load(text)
    room_addressing: dict[str, list[str]] = {}
    templates: list[NestedTemplate] = []
    if is_v2(data):
        compiled = compile_v2(text, inputs, builtins)
        text, inputs, room_addressing, templates = (
            compiled.document,
            compiled.inputs,
            compiled.room_addressing,
            compiled.templates,
        )
        # A version 2 slot is filled by its resource's key.
        filled = {compiled.names.get(k, k): v for k, v in filled.items()}
        data = _load(text)
    values = {**builtins, **_known_values(data, inputs)}
    values.pop(AGENTS_DIR[1:-1], None)
    planner = _Planner(data, values, machines)
    planner.room_inputs = {
        name: str(value)
        for name, value in inputs.items()
        if planner.params.get(name, {}).get("type") == "room"
        and value not in (None, "")
    }
    known = set(filled)
    names: dict[str, str] = {}
    existing: dict[str, str] = {}
    new_agents: list[NewAgentPlan] = []
    for index, entry in enumerate(planner.entries):
        written = _written_name(entry)
        resolved = _resolved_name(entry, values)
        slot = resolved or written or f"agent {index + 1}"
        chosen = filled.get(written) or filled.get(resolved)
        known -= {written, resolved}
        if chosen:
            if entry.get("allow_existing") is not True:
                planner.problem(
                    slot,
                    "existing_not_allowed",
                    "the template does not let an existing agent stand in for "
                    "it (no allow_existing: true); it is created.",
                )
                continue
            existing[slot] = chosen
            for key in (written, resolved):
                if key:
                    names[key] = chosen
            continue
        plan = planner.plan(entry, slot)
        if plan is not None:
            new_agents.append(plan)
            for key in (written, resolved):
                if key:
                    names[key] = plan.name
    for unknown in sorted(known):
        planner.problem(
            unknown,
            "no_such_slot",
            "the template has no agent by that name. get_template lists its "
            "agent slots.",
        )
    if planner.problems:
        raise AgentsNotCreated(planner.problems)
    if _room_part(data) is None:
        return TemplatePlan(new_agents, existing, None, {}, room_addressing, templates)
    document, run_inputs = room_document(text, names, inputs)
    return TemplatePlan(
        new_agents, existing, document, run_inputs, room_addressing, templates
    )
