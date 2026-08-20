"""Pure helpers for bulk subagent registration.

The DB/auth/registration wiring lives in the gateway route; the name-derivation,
in-batch dedup, and parent-option inheritance are factored out here so they can
be unit-tested without a database or a ProtocolService.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel

# Parent operational options a subagent inherits unless the caller overrides them.
_INHERITED_OPTION_KEYS = ("channels_enabled", "repo_dir")


class DerivedSubagent(BaseModel):
    """One subagent ready to register: its bare name, derived Switch name,
    description, and the fully-resolved options payload."""

    subagent_name: str
    name: str
    description: str
    options: dict[str, Any]


def inherited_parent_options(parent_metadata: Any) -> dict[str, Any]:
    """The subset of a parent's `known_agent_options` that subagents inherit."""
    if not isinstance(parent_metadata, dict):
        return {}
    parent_opts = parent_metadata.get("known_agent_options")
    if not isinstance(parent_opts, dict):
        return {}
    return {
        key: parent_opts[key]
        for key in _INHERITED_OPTION_KEYS
        if parent_opts.get(key) is not None
    }


def derive_subagent_registrations(
    *,
    parent_name: str,
    parent_metadata: Any,
    base_options: dict[str, Any],
    subagents: list[tuple[str, str]],
) -> list[DerivedSubagent]:
    """Build the per-subagent registration payloads.

    `subagents` is a list of `(subagent_name, description)`. Each Switch name is
    `<parent_name>.<subagent_name>`; options are inherited-from-parent, then the
    caller's `base_options`, then the per-subagent `subagent_name` (always last).
    Raises ValueError on a duplicate subagent name within the batch.
    """
    inherited = inherited_parent_options(parent_metadata)
    derived: list[DerivedSubagent] = []
    seen: set[str] = set()
    for subagent_name, description in subagents:
        name = f"{parent_name}.{subagent_name}"
        if name in seen:
            raise ValueError(f"Duplicate subagent in batch: {subagent_name!r}")
        seen.add(name)
        options = {**inherited, **base_options, "subagent_name": subagent_name}
        derived.append(
            DerivedSubagent(
                subagent_name=subagent_name,
                name=name,
                description=description,
                options=options,
            )
        )
    return derived
