"""The settings a managed agent of each provider may carry, its "Advanced configuration".

Each field is a key, a label and a type a client can build a form from. These
are the only definitions of them: Switch Console builds the advanced form of
every agent, its own and managed ones, from what the server serves, and its
provider plugins only apply the values, by key, when a session launches. Each
provider in `switch_core.providers.registry` names its fields; a provider with
none has an empty tuple.

`model` and the instructions are not here: they are top-level definition fields.
A `select` field's served options start with `{"value": "", "label": <unset
label>}`, the choice a form shows for "leave it unset"; "" is not a value it
accepts.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

FieldType = Literal["text", "textarea", "number", "boolean", "list", "select"]


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
