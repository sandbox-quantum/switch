"""Advisory checks on a template document, for a form to show before upload.

Deliberately weaker than provisioning. It answers "will this obviously not do
what you meant", never "is this a valid room template" — the registry stores
documents whose shape this server may not know yet, and a check that insisted
on today's shape would start refusing tomorrow's. Group templates already have
a different top-level key from room templates, and agent templates are coming,
so nothing here asks what kind of document it is looking at.

What that leaves is the mistakes that are wrong under every shape: text that
is not YAML, a params block that provisioning will reject, and placeholders
that do not line up with the parameters declared for them — the typo that
otherwise ships silently, because an undeclared `{owner}` is left in the
document verbatim rather than failing.

Nothing here rejects an upload. The registry accepts what it is given; this
only lets a person see the problem first.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

import yaml
from pydantic import ValidationError

from switch_core.rooms_yaml import PLACEHOLDER_RE, ParamSpec
from switch_core.template_v2 import (
    RESOURCE_TYPES,
    TemplateError,
    condition_params,
    is_v2,
    template_document,
)

# Top-level keys any shape of template may carry, across every shape known to
# be in flight — room, group, and the kickoff message that rides beside them.
# Additive on purpose, and only ever a warning: an unrecognised key is as
# likely to be a format this server predates as it is to be a typo.
_KNOWN_TOP_LEVEL = frozenset(
    {
        "room",
        "group",
        "rooms",
        "links",
        "params",
        "version",
        "kickoff",
        "agent",
        "agents",
        "form",
    }
)

# `{$...}` placeholders the server fills in itself, plus `$agents_dir`, which
# the Console fills in (the directory it keeps agents under, on the machine
# the agent runs on) before the document reaches the server. A template does
# not declare them and must not be told to.
_BUILTINS = frozenset(
    {"$creator", "$creator_email", "$date", "$timestamp", "$agents_dir"}
)

# Matched here rather than left to `PLACEHOLDER_RE`, which only learned about
# the `$` prefix alongside the builtins themselves. Scanning for them directly
# means a misspelled `{$creatr}` is caught the same way whichever version of
# the format module this server is running.
_BUILTIN_RE = re.compile(r"\{(\$[A-Za-z_][A-Za-z0-9_]*)\}")


# The findings an upload is refused for. Deliberately only the three that are
# true of a template under every shape it could ever take: text that is not
# YAML, nothing at all, or something other than a mapping. A document failing
# one of these cannot be provisioned by any consumer, now or later, so storing
# it serves nobody.
#
# Everything else stays advisory, and the reason is evidence rather than
# caution. The params checks are the format's, and the format moves: this
# checker called the canonical example invalid twice in a week. Console's
# parser and this server also disagree today about a bare param with no spec —
# Console reads it as a string, the server refuses it — so a block on that
# would refuse a document the Console wizard renders happily.
_BLOCKING_CODES = frozenset({"empty", "invalid_yaml", "not_a_mapping"})

# What runs an agent, where, and in which folder. Switch Console supplies none
# of these itself, so a template that creates an agent must say all three.
# Where it runs is said with `location` (this computer or an SSH host, which
# the Console resolves) or `machine` (one of the owner's machines on the
# server). Only ever a warning here: the run refuses to create an agent the
# template leaves one unsaid for, and that is where the refusal belongs.
_RUNTIME_SETTINGS: dict[str, tuple[str, ...]] = {
    "provider": ("provider",),
    "location": ("location", "machine"),
    "directory": ("directory",),
}
_RUNTIME_FIELDS = ("provider", "location", "machine", "directory")


@dataclass(frozen=True)
class Finding:
    code: str
    message: str
    # The param or key the finding is about, when it is about one.
    subject: str | None = None

    @property
    def blocking(self) -> bool:
        return self.code in _BLOCKING_CODES


@dataclass(frozen=True)
class LintResult:
    errors: list[Finding] = field(default_factory=list)
    warnings: list[Finding] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    @property
    def blocked(self) -> bool:
        """Whether an upload of this document should be refused outright."""
        return any(f.blocking for f in self.errors)


def _walk_strings(node: Any) -> list[str]:
    """Every string anywhere in the document, so no placeholder is missed."""
    if isinstance(node, str):
        return [node]
    if isinstance(node, dict):
        found: list[str] = []
        for key, value in node.items():
            if isinstance(key, str):
                found.append(key)
            found.extend(_walk_strings(value))
        return found
    if isinstance(node, list):
        return [s for item in node for s in _walk_strings(item)]
    return []


def _unknown_keys(details: list[Any]) -> set[str]:
    """The field names an `extra_forbidden` complaint was about."""
    return {str(d["loc"][-1]) for d in details if d["loc"]}


def _check_params(raw: Any, errors: list[Finding], warnings: list[Finding]) -> set[str]:
    """Validate the params block against the spec provisioning will apply.

    Uses `ParamSpec` itself rather than re-describing it, so a form cannot
    accept a param that provisioning would then refuse — and so a field added
    to the spec is understood here the moment it is added there, with nothing
    to keep in step by hand.

    One kind of complaint is demoted to a warning: a field `ParamSpec` does not
    know. `extra="forbid"` cannot tell "you misspelled it" from "this server is
    older than the template", and the second is ordinary for a registry that
    holds documents written against a newer Switch than the one reading them.
    """
    if not isinstance(raw, dict):
        errors.append(
            Finding(
                "params_not_a_mapping",
                "'params' must be a mapping of parameter name to its spec.",
            )
        )
        return set()

    declared: set[str] = set()
    for name, spec in raw.items():
        if not isinstance(name, str):
            errors.append(
                Finding(
                    "param_name_not_a_string", f"Parameter name {name!r} is not text."
                )
            )
            continue
        declared.add(name)
        if spec is None:
            errors.append(
                Finding(
                    "param_has_no_spec",
                    f"Parameter '{name}' has no spec. Give it at least a type.",
                    name,
                )
            )
            continue
        try:
            parsed = ParamSpec.model_validate(spec)
        except ValidationError as e:
            unknown = [d for d in e.errors() if d["type"] == "extra_forbidden"]
            malformed = [d for d in e.errors() if d["type"] != "extra_forbidden"]
            for detail in unknown:
                where = ".".join(str(p) for p in detail["loc"]) or "spec"
                warnings.append(
                    Finding(
                        "unknown_param_field",
                        f"Parameter '{name}' sets '{where}', which this server "
                        "does not know. It may be from a newer Switch, or a typo.",
                        name,
                    )
                )
            for detail in malformed:
                where = ".".join(str(p) for p in detail["loc"]) or "spec"
                errors.append(
                    Finding(
                        "invalid_param_spec",
                        f"Parameter '{name}' is not valid: {where} — {detail['msg']}.",
                        name,
                    )
                )
            # An unknown field is the only complaint, so the rest of the spec
            # is sound and the checks below still have something to say.
            if malformed:
                continue
            try:
                parsed = ParamSpec.model_validate(
                    {k: v for k, v in spec.items() if k not in _unknown_keys(unknown)}
                    if isinstance(spec, dict)
                    else spec
                )
            except ValidationError:
                continue

        # Two things a well-formed ParamSpec can still say that provisioning
        # will refuse. They surface here because they only bite at the moment
        # somebody tries to use the template, which is far from the mistake.
        if parsed.type == "enum":
            if not parsed.enum:
                errors.append(
                    Finding(
                        "enum_without_choices",
                        f"Parameter '{name}' is an enum but lists no choices.",
                        name,
                    )
                )
            elif parsed.default is not None and parsed.default not in parsed.enum:
                errors.append(
                    Finding(
                        "default_not_in_enum",
                        f"Parameter '{name}' defaults to {parsed.default!r}, which is "
                        f"not one of its choices ({', '.join(parsed.enum)}).",
                        name,
                    )
                )
    return declared


def _check_agent_runtime(document: dict[str, Any], warnings: list[Finding]) -> None:
    """Warn for each agent the document never says how to run.

    An agent entry says a runtime setting with its own field, or the document
    says it for every agent with a param of that type that no entry's field
    reads.
    """
    if isinstance(document.get("agents"), list):
        entries = [e for e in document["agents"] if isinstance(e, dict)]
    elif isinstance(document.get("agent"), dict):
        entries = [document["agent"]]
    else:
        return
    params = document.get("params")
    params = params if isinstance(params, dict) else {}
    field_texts = [
        str(entry[setting])
        for entry in entries
        for setting in _RUNTIME_FIELDS
        if entry.get(setting) is not None
    ]

    def applies_to_all(kinds: tuple[str, ...]) -> bool:
        return any(
            isinstance(spec, dict)
            and spec.get("type") in kinds
            and not any(f"{{{name}}}" in text for text in field_texts)
            for name, spec in params.items()
        )

    for index, entry in enumerate(entries):
        label = entry.get("name") or entry.get("display_name") or f"agent {index + 1}"
        for setting, kinds in _RUNTIME_SETTINGS.items():
            said = any(entry.get(kind) is not None for kind in kinds)
            if not said and not applies_to_all(kinds):
                what = {
                    "provider": f"which coding agent runs {label}",
                    "location": f"which machine {label} runs on",
                    "directory": f"which directory {label} works in",
                }[setting]
                ways = " or ".join(f"'{kind}:'" for kind in kinds)
                params_ = " or ".join(f"'{kind}'" for kind in kinds)
                warnings.append(
                    Finding(
                        "agent_runtime_unsaid",
                        f"The template never says {what}. Give it {ways} or "
                        f"declare a {params_} param. The agent will not be created "
                        "until it does.",
                        setting,
                    )
                )


_KNOWN_TOP_LEVEL_V2 = frozenset({"version", "params", "resources", "form"})
_NAME_REF_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\.name\}")


def _conditions(node: Any, into: list[str]) -> list[str]:
    """Every condition written in a resource: field values written as
    ``[{if, value}, ...]``."""
    if isinstance(node, list):
        for item in node:
            if isinstance(item, dict) and "value" in item and "if" in item:
                into.append(str(item["if"]))
            _conditions(item, into)
    elif isinstance(node, dict):
        for value in node.values():
            _conditions(value, into)
    return into


def _without_document(spec: dict[str, Any]) -> dict[str, Any]:
    if spec.get("type") != "template":
        return spec
    return {k: v for k, v in spec.items() if k != "document"}


def _lint_nested(
    key: str, spec: dict[str, Any], errors: list[Finding], warnings: list[Finding]
) -> None:
    """A ``template`` resource: what it saves must be a template, read here
    as one, its findings said against the resource."""
    try:
        document = template_document(key, spec)
    except TemplateError as e:
        errors.append(Finding("invalid_template_resource", str(e), key))
        return
    if not spec.get("name"):
        errors.append(
            Finding(
                "invalid_template_resource",
                f"resource '{key}' needs a 'name': what the template is saved as.",
                key,
            )
        )
    inner = lint_template(yaml.safe_dump(document, sort_keys=False))
    errors.extend(
        Finding(f.code, f"resource '{key}', in its document: {f.message}", key)
        for f in inner.errors
    )
    warnings.extend(
        Finding(f.code, f"resource '{key}', in its document: {f.message}", key)
        for f in inner.warnings
    )


def _lint_v2(
    document: dict[str, Any], errors: list[Finding], warnings: list[Finding]
) -> None:
    """The checks for a ``version: 2`` document (see ``template_v2``)."""
    for key in sorted(k for k in document if isinstance(k, str)):
        if key not in _KNOWN_TOP_LEVEL_V2:
            warnings.append(
                Finding(
                    "unknown_top_level_key",
                    f"'{key}' is not a key of a version 2 template. Everything "
                    "it creates goes under 'resources'.",
                    key,
                )
            )
    raw_params = document.get("params") or {}
    params = (
        {
            k: (
                {kk: vv for kk, vv in v.items() if kk != "if"}
                if isinstance(v, dict)
                else v
            )
            for k, v in raw_params.items()
        }
        if isinstance(raw_params, dict)
        else raw_params
    )
    declared = _check_params(params, errors, warnings) if raw_params else set()

    conditions: list[tuple[str, str]] = []
    if isinstance(raw_params, dict):
        for name, spec in raw_params.items():
            if isinstance(spec, dict) and "if" in spec:
                conditions.append((str(name), str(spec["if"])))

    resources = document.get("resources")
    if not isinstance(resources, dict) or not resources:
        errors.append(
            Finding(
                "no_resources",
                "A version 2 template lists what it creates under 'resources', "
                "each with a key and a type.",
            )
        )
        return
    agents: list[dict[str, Any]] = []
    room_count = 0
    has_group = False
    for key, spec in resources.items():
        if not isinstance(spec, dict):
            errors.append(
                Finding(
                    "resource_not_a_mapping",
                    f"Resource '{key}' must be a mapping.",
                    str(key),
                )
            )
            continue
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", str(key)):
            errors.append(
                Finding(
                    "invalid_resource_key",
                    f"Resource key '{key}' must be letters, digits and _.",
                    str(key),
                )
            )
        kind = spec.get("type")
        if kind not in RESOURCE_TYPES:
            errors.append(
                Finding(
                    "invalid_resource_type",
                    f"Resource '{key}' needs a type: one of {', '.join(RESOURCE_TYPES)}.",
                    str(key),
                )
            )
            continue
        if "if" in spec:
            conditions.append((str(key), str(spec["if"])))
        if kind == "template":
            _lint_nested(str(key), spec, errors, warnings)
            spec = _without_document(spec)
        conditions.extend((str(key), c) for c in _conditions(spec, []))
        if kind == "agent":
            agents.append({k: v for k, v in spec.items() if k not in ("type", "if")})
        elif kind == "room":
            room_count += 1
        elif kind == "group":
            has_group = True
    if room_count > 1 and not has_group:
        errors.append(
            Finding(
                "rooms_without_group",
                "Several rooms go in a group: add a resource of type group, and "
                "give each room group: <its key>.",
            )
        )

    read_by_conditions: set[str] = set()
    for where, condition in conditions:
        try:
            name = condition_params(condition)
        except ValueError as e:
            errors.append(Finding("invalid_condition", f"{where}: {e}", where))
            continue
        read_by_conditions.add(name)
        if name not in declared:
            warnings.append(
                Finding(
                    "undeclared_condition",
                    f"{where}: the condition '{condition}' reads '{name}', which "
                    "no parameter declares, so it never holds.",
                    where,
                )
            )

    # A template resource's document is the inner template's own: its
    # placeholders are its params, not this document's.
    strings = _walk_strings(
        {
            key: _without_document(spec) if isinstance(spec, dict) else spec
            for key, spec in resources.items()
        }
    )
    for text_node in strings:
        for ref in _NAME_REF_RE.findall(text_node):
            if ref not in resources:
                warnings.append(
                    Finding(
                        "unknown_reference",
                        f"'{{{ref}.name}}' names no resource of this template.",
                        ref,
                    )
                )

    _check_agent_runtime({"agents": agents, "params": params}, warnings)

    used = {m for t in strings for m in re.findall(PLACEHOLDER_RE, t)}
    builtins_used = {m for t in strings for m in _BUILTIN_RE.findall(t)}
    used -= builtins_used
    for name in sorted(builtins_used - _BUILTINS):
        warnings.append(
            Finding(
                "unknown_builtin",
                f"'{{{name}}}' looks like a server-provided value, but this "
                f"server provides only {', '.join(sorted(_BUILTINS))}.",
                name,
            )
        )
    for name in sorted(used - declared):
        warnings.append(
            Finding(
                "undeclared_placeholder",
                f"'{{{name}}}' is used but no parameter declares it, so it will "
                "be left in the document as written.",
                name,
            )
        )
    param_texts = _walk_strings(params) if isinstance(params, dict) else []
    used_by_params = {m for t in param_texts for m in re.findall(PLACEHOLDER_RE, t)}
    applies_to_all = (
        {
            name
            for name, spec in params.items()
            if isinstance(spec, dict) and spec.get("type") in _RUNTIME_FIELDS
        }
        if isinstance(params, dict) and agents
        else set()
    )
    for name in sorted(
        declared - used - read_by_conditions - used_by_params - applies_to_all
    ):
        warnings.append(
            Finding(
                "unused_param", f"Parameter '{name}' is declared but never used.", name
            )
        )


def lint_template(text: str) -> LintResult:
    """Check a template document without storing or provisioning anything."""
    errors: list[Finding] = []
    warnings: list[Finding] = []

    if not text.strip():
        errors.append(Finding("empty", "The document is empty."))
        return LintResult(errors, warnings)

    try:
        document = yaml.safe_load(text)
    except yaml.YAMLError as e:
        # A mark carries the line and column, which is the whole value of the
        # message to someone staring at an editor.
        mark = getattr(e, "problem_mark", None)
        where = f" at line {mark.line + 1}, column {mark.column + 1}" if mark else ""
        problem = getattr(e, "problem", None) or "could not be parsed"
        errors.append(Finding("invalid_yaml", f"Not valid YAML{where}: {problem}."))
        return LintResult(errors, warnings)

    if document is None:
        errors.append(Finding("empty", "The document is empty."))
        return LintResult(errors, warnings)

    if not isinstance(document, dict):
        errors.append(
            Finding(
                "not_a_mapping",
                "The document must be a mapping of keys at the top level, "
                f"not {type(document).__name__}.",
            )
        )
        return LintResult(errors, warnings)

    if is_v2(document):
        _lint_v2(document, errors, warnings)
        return LintResult(errors, warnings)

    for key in sorted(k for k in document if isinstance(k, str)):
        if key not in _KNOWN_TOP_LEVEL:
            warnings.append(
                Finding(
                    "unknown_top_level_key",
                    f"'{key}' is not a key this server recognises. It will be "
                    "stored as-is, but check it is not a typo.",
                    key,
                )
            )

    declared = (
        _check_params(document["params"], errors, warnings)
        if "params" in document
        else set()
    )
    # An agent template's room refers to the agent as `{agent}`. The Console
    # fills that in with the agent's name, so the template uses it without
    # declaring it.
    if "agent" in document:
        declared = declared | {"agent"}
    # `$new` in a room param's chain means the room this document describes,
    # so a document without one has nothing for it to mean.
    if (
        "room" not in document
        and "rooms" not in document
        and isinstance(document.get("params"), dict)
    ):
        for name, spec in document["params"].items():
            default = spec.get("default") if isinstance(spec, dict) else None
            if isinstance(default, list) and "$new" in default:
                errors.append(
                    Finding(
                        "new_without_room",
                        f"Parameter '{name}' lists '$new' among its defaults, but "
                        "the document describes no room to create.",
                        name,
                    )
                )

    _check_agent_runtime(document, warnings)

    # Placeholders are looked for everywhere except the params block, which
    # declares them rather than using them.
    body = {k: v for k, v in document.items() if k != "params"}
    body_strings = _walk_strings(body)
    used = {
        match
        for text_node in body_strings
        for match in re.findall(PLACEHOLDER_RE, text_node)
    }
    builtins_used = {
        match for text_node in body_strings for match in _BUILTIN_RE.findall(text_node)
    }
    # Whether `$creator` also came back from PLACEHOLDER_RE depends on this
    # server's version of it; either way it is a builtin, not a missing param.
    used -= builtins_used
    # Inside an entry of `agents:`, `{agent}` is that entry's own name, filled
    # in when it is created (`directory: "{$agents_dir}/{agent}"`). Only a use
    # outside the entries needs the single `agent:` form to mean something.
    if isinstance(document.get("agents"), list) and "agent" not in declared:
        outside = {k: v for k, v in body.items() if k != "agents"}
        if not any(
            "agent" in re.findall(PLACEHOLDER_RE, text_node)
            for text_node in _walk_strings(outside)
        ):
            used.discard("agent")

    # `{$...}` is the server's to fill, not the template's to declare, so it is
    # held to a different question: is it one the server actually knows?
    for name in sorted(builtins_used - _BUILTINS):
        warnings.append(
            Finding(
                "unknown_builtin",
                f"'{{{name}}}' looks like a server-provided value, but this "
                f"server provides only {', '.join(sorted(_BUILTINS))}.",
                name,
            )
        )

    for name in sorted(used - declared):
        team_agent = name == "agent" and isinstance(document.get("agents"), list)
        warnings.append(
            Finding(
                "undeclared_placeholder",
                "'{agent}' outside an agent's own entry is ambiguous in a "
                "template with an agents: list, since it could be any of them. "
                "Name the agent by the text written as its name, or use the "
                "single agent: form, so it is not left in the document as written."
                if team_agent
                else f"'{{{name}}}' is used but no parameter declares it, so it "
                "will be left in the document as written.",
                name,
            )
        )
    # `agent` is the Console's to fill, not a declared param, so a room that
    # never names the agent is not an unused parameter. Nor is a provider,
    # location or directory param in a document with agents: one no agent's
    # field reads applies to every agent.
    applies_to_all = (
        {
            name
            for name, spec in document["params"].items()
            if isinstance(spec, dict) and spec.get("type") in _RUNTIME_FIELDS
        }
        if ("agent" in document or "agents" in document)
        and isinstance(document.get("params"), dict)
        else set()
    )
    for name in sorted(declared - used - {"agent"} - applies_to_all):
        warnings.append(
            Finding(
                "unused_param",
                f"Parameter '{name}' is declared but never used.",
                name,
            )
        )

    return LintResult(errors, warnings)
