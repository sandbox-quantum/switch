"""Each provider's "Advanced configuration": the settings a managed agent may carry.

The one schema per provider, owned here: every definition is checked against
it whatever machine runs the agent, and `GET /gateway/management/advanced-config`
and the `get_advanced_config` agent operation serve it so a client can build its
form from it. The fields, labels and help mirror the advanced forms Switch
Console offers for its own agents (Claude Code's subagent fields, the Codex
profile and OpenCode settings in `console/packages/plugins`).

`model` and the instructions are not here: they are top-level definition fields.

An advanced config is a JSON object keyed by field. A field that is not set is
left out, never sent as null, "" or []. A `select` field's served options start
with `{"value": "", "label": <unset label>}`, the choice a form shows for
"leave it unset"; "" is not a value it accepts.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Literal

FieldType = Literal["text", "textarea", "number", "boolean", "list", "select"]

MAX_KEYS = 32
MAX_STRING_CHARS = 4096
MAX_LIST_ITEMS = 64
MAX_LIST_ITEM_CHARS = 256


@dataclass(frozen=True)
class Option:
    value: str
    label: str


@dataclass(frozen=True)
class Catalogue:
    """Where a form can offer choices for a free-text field: `model` for the
    provider's models, `model-variant` for the variants of the model named in
    `model_field`."""

    kind: Literal["model", "model-variant"]
    model_field: str | None


@dataclass(frozen=True)
class AdvancedField:
    key: str
    label: str
    type: FieldType
    help: str | None
    placeholder: str | None
    # A select's choices, the unset choice ("") first.
    options: tuple[Option, ...] | None
    catalogue: Catalogue | None

    def accepted_values(self) -> list[str]:
        return [option.value for option in self.options or () if option.value != ""]

    def wire(self) -> dict[str, Any]:
        catalogue: dict[str, Any] | None = None
        if self.catalogue is not None:
            catalogue = {"kind": self.catalogue.kind}
            if self.catalogue.model_field is not None:
                catalogue["model_field"] = self.catalogue.model_field
        return {
            "key": self.key,
            "label": self.label,
            "type": self.type,
            "help": self.help,
            "placeholder": self.placeholder,
            "options": None
            if self.options is None
            else [
                {"value": option.value, "label": option.label}
                for option in self.options
            ],
            "catalogue": catalogue,
        }


def _field(
    key: str,
    label: str,
    type: FieldType,
    *,
    help: str | None = None,
    placeholder: str | None = None,
    catalogue: Catalogue | None = None,
) -> AdvancedField:
    return AdvancedField(
        key=key,
        label=label,
        type=type,
        help=help,
        placeholder=placeholder,
        options=None,
        catalogue=catalogue,
    )


def _select(
    key: str,
    label: str,
    unset: str,
    values: list[str] | list[tuple[str, str]],
    *,
    help: str | None = None,
) -> AdvancedField:
    """A select whose values are labelled by themselves unless given as
    (value, label) pairs."""
    options = [Option(value="", label=unset)]
    for value in values:
        if isinstance(value, tuple):
            options.append(Option(value=value[0], label=value[1]))
        else:
            options.append(Option(value=value, label=value))
    return AdvancedField(
        key=key,
        label=label,
        type="select",
        help=help,
        placeholder=None,
        options=tuple(options),
        catalogue=None,
    )


_ON_OFF = [("true", "On"), ("false", "Off")]

CLAUDE_FIELDS: tuple[AdvancedField, ...] = (
    _field(
        "tools",
        "Tools",
        "list",
        placeholder="Read, Grep, Bash",
        help="Comma-separated allowlist. Empty inherits all tools. The Switch tools are always kept.",
    ),
    _field(
        "disallowedTools",
        "Disallowed tools",
        "list",
        placeholder="Write, Edit",
        help="Comma-separated tools to deny from the inherited/allowed set.",
    ),
    _select(
        "permissionMode",
        "Permission mode",
        "Default (inherit)",
        ["default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "plan"],
    ),
    _select(
        "color",
        "Color",
        "None",
        ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"],
    ),
    _field("maxTurns", "Max turns", "number", placeholder="unlimited"),
    _field(
        "background",
        "Always run in background",
        "boolean",
        help="Run this subagent as a background task.",
    ),
    _select(
        "isolation",
        "Isolation",
        "None",
        [("worktree", "worktree (isolated git copy)")],
    ),
    _select("effort", "Effort", "Inherit", ["low", "medium", "high", "xhigh", "max"]),
    _select("memory", "Persistent memory", "Off", ["user", "project", "local"]),
)

CODEX_FIELDS: tuple[AdvancedField, ...] = (
    _select(
        "effort",
        "Reasoning effort",
        "Default",
        ["none", "low", "medium", "high", "xhigh", "max"],
        help="How hard the model thinks before answering. `none` disables reasoning.",
    ),
    _select(
        "verbosity",
        "Verbosity",
        "Default",
        ["low", "medium", "high"],
        help="How much prose the model writes in its answers.",
    ),
    _select(
        "reasoningSummary",
        "Reasoning summary",
        "Default",
        ["auto", "concise", "detailed", "none"],
        help="How much of the model's thinking is summarised back as it works.",
    ),
    _select(
        "webSearch",
        "Web search",
        "Default",
        _ON_OFF,
        help="Whether this agent may search the web.",
    ),
)

OPENCODE_FIELDS: tuple[AdvancedField, ...] = (
    _field(
        "variant",
        "Reasoning variant",
        "text",
        placeholder="e.g. high — blank uses the model default",
        help="OpenCode's reasoning-effort control. Which values a model takes is the model's own business, so the choices follow the model above; most local models have none.",
        catalogue=Catalogue(kind="model-variant", model_field="model"),
    ),
    _field(
        "temperature",
        "Temperature",
        "number",
        placeholder="e.g. 0.2",
        help="How much randomness the model is allowed. Blank leaves it to the model.",
    ),
    _field(
        "topP",
        "Top-p",
        "number",
        placeholder="e.g. 0.9",
        help="Nucleus-sampling cutoff. Blank leaves it to the model.",
    ),
    _field(
        "maxSteps",
        "Step limit",
        "number",
        placeholder="e.g. 40",
        help="How many tool-calling steps the agent may take before it has to answer.",
    ),
    _select(
        "webSearch",
        "Web search",
        "Default",
        _ON_OFF,
        help="Whether this agent may search the web.",
    ),
    _field(
        "smallModel",
        "Utility model",
        "text",
        placeholder="e.g. ollama/gemma4:latest — blank uses your OpenCode default",
        help="The cheaper model OpenCode uses for background work like naming the conversation. Worth setting to match the model above when the point is to keep everything on one machine — otherwise that background work goes wherever your own config sends it.",
        catalogue=Catalogue(kind="model", model_field=None),
    ),
)

# Keyed by every provider a definition can name (`schemas.Provider`).
ADVANCED_FIELDS: dict[str, tuple[AdvancedField, ...]] = {
    "claude": CLAUDE_FIELDS,
    "codex": CODEX_FIELDS,
    "opencode": OPENCODE_FIELDS,
    "cursor": (),
    "antigravity": (),
}


def provider_fields(provider: str) -> list[dict[str, Any]]:
    """The provider's fields as served. Raises ValueError for a provider
    Switch does not run."""
    if provider not in ADVANCED_FIELDS:
        raise ValueError(
            f"unknown provider {provider!r}; one of {', '.join(ADVANCED_FIELDS)}"
        )
    return [field.wire() for field in ADVANCED_FIELDS[provider]]


def advanced_config_schema() -> dict[str, Any]:
    """Every provider's fields, as `GET /gateway/management/advanced-config`
    serves them."""
    return {
        "providers": {
            provider: {"fields": provider_fields(provider)}
            for provider in ADVANCED_FIELDS
        }
    }


def _value_problem(field: AdvancedField, value: Any) -> str | None:
    """What is wrong with `value` for `field`, or None when it is acceptable."""
    if value is None or value == "" or value == []:
        return "is empty; leave the field out to leave it unset"
    if field.type in ("text", "textarea"):
        if not isinstance(value, str):
            return "must be a string"
        if len(value) > MAX_STRING_CHARS:
            return f"must be at most {MAX_STRING_CHARS} characters"
        return None
    if field.type == "number":
        if isinstance(value, bool) or not isinstance(value, int | float):
            return "must be a number"
        if not math.isfinite(value):
            return "must be a finite number"
        return None
    if field.type == "boolean":
        if not isinstance(value, bool):
            return "must be true or false"
        return None
    if field.type == "list":
        if not isinstance(value, list) or not all(
            isinstance(item, str) for item in value
        ):
            return "must be a list of strings"
        if len(value) > MAX_LIST_ITEMS:
            return f"must have at most {MAX_LIST_ITEMS} items"
        if not all(1 <= len(item) <= MAX_LIST_ITEM_CHARS for item in value):
            return f"items must be 1 to {MAX_LIST_ITEM_CHARS} characters"
        return None
    accepted = field.accepted_values()
    if not isinstance(value, str) or value not in accepted:
        quoted = ", ".join(f'"{choice}"' for choice in accepted)
        return f"must be one of {quoted}"
    return None


def validate_advanced_config(provider: str, config: dict[str, Any]) -> None:
    """Raise ValueError naming every field of `config` that `provider` does
    not take, or takes in another form."""
    if provider not in ADVANCED_FIELDS:
        raise ValueError(f"unknown provider {provider!r}")
    if len(config) > MAX_KEYS:
        raise ValueError(f"advanced_config takes at most {MAX_KEYS} fields")
    fields = {field.key: field for field in ADVANCED_FIELDS[provider]}
    problems = []
    for key, value in config.items():
        field = fields.get(key)
        if field is None:
            known = (
                f"it takes {', '.join(fields)}"
                if fields
                else "it has no advanced configuration"
            )
            problems.append(f"{provider} has no setting {key!r} ({known})")
            continue
        problem = _value_problem(field, value)
        if problem is not None:
            problems.append(f"{provider} setting {key!r} {problem}")
    if problems:
        raise ValueError("advanced_config: " + "; ".join(problems))
