"""How a definition's "Advanced configuration" is checked.

The fields each provider takes are declared with the provider, in
`switch_core.providers.registry` (`switch_core.providers.advanced_fields` holds
the field model): every definition is checked against them whatever machine
runs the agent. `switch_core.providers.schema` serves them, at
`GET /gateway/management/providers` and `GET /gateway/management/advanced-config`,
and the `get_advanced_config` agent operation, so a client can build its form
from them.

An advanced config is a JSON object keyed by field. A field that is not set is
left out, never sent as null, "" or [].
"""

from __future__ import annotations

import math
from typing import Any

from switch_core.providers.advanced_fields import AdvancedField
from switch_core.providers.registry import agent_provider

MAX_KEYS = 32
MAX_STRING_CHARS = 4096
MAX_LIST_ITEMS = 64
MAX_LIST_ITEM_CHARS = 256


def provider_fields(provider: str) -> list[dict[str, Any]]:
    """The provider's fields as served. Raises ValueError for a provider
    Switch does not run."""
    return [field.wire() for field in agent_provider(provider).advanced_fields]


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
    fields = {field.key: field for field in agent_provider(provider).advanced_fields}
    if len(config) > MAX_KEYS:
        raise ValueError(f"advanced_config takes at most {MAX_KEYS} fields")
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
