"""Per-room agent alias validation.

An alias is a room-scoped handle: `@<alias>` addresses an agent in that room
exactly like its real name. Aliases share the same character class as agent
names so the `@<token>` mention regex tokenises them identically, and they must
not collide with anything else that is `@`-addressable in the same room (another
agent's real name, a room role, or another agent's alias). Matching is
case-insensitive, mirroring the mention regex.
"""

import re

from switch_core.room_wide_mention import is_reserved_mention_name

_ALIAS_RE = re.compile(r"^[A-Za-z0-9._-]+$")


class AliasError(ValueError):
    """A proposed alias is malformed or collides with an existing handle."""


def validate_alias_format(alias: str) -> None:
    """Raise AliasError unless `alias` is a single `@`-token-safe handle that
    is not one of the room-wide mention words."""
    if not _ALIAS_RE.match(alias or ""):
        raise AliasError(
            f"Invalid alias '{alias}': aliases may contain only letters, digits, "
            "'.', '-' and '_' (no spaces or '@')."
        )
    if is_reserved_mention_name(alias):
        raise AliasError(
            f"Alias '{alias}' is reserved for room-wide mentions, so it cannot "
            "name an agent."
        )


def check_alias_collisions(
    alias: str,
    *,
    target_agent_id: str,
    agent_names: list[str],
    role_names: list[str],
    aliases_by_agent: dict[str, str],
) -> None:
    """Raise AliasError if `alias` clashes with another addressable handle in the
    room: a real agent name, a room role name, or another agent's alias.

    `aliases_by_agent` maps agent_id -> current alias; the target agent replacing
    its own alias is allowed. All comparisons are case-insensitive.
    """
    low = alias.lower()
    if any(low == name.lower() for name in agent_names):
        raise AliasError(
            f"Alias '{alias}' clashes with an agent's real name in this room."
        )
    if any(low == role.lower() for role in role_names):
        raise AliasError(f"Alias '{alias}' clashes with a room role name.")
    for agent_id, existing in aliases_by_agent.items():
        if agent_id != target_agent_id and existing.lower() == low:
            raise AliasError(
                f"Alias '{alias}' is already used by another agent in this room."
            )


def validate_alias_map(
    aliases: dict[str, str],
    *,
    agent_names: list[str],
    role_names: list[str],
) -> None:
    """Validate a whole agent_name -> alias map (used at room creation).

    Each target agent name must be one of the room's agents; each alias must be
    well-formed and must not clash with a real agent name, a role name, or
    another alias in the same map. Raises AliasError on the first problem.
    """
    known = {name.lower() for name in agent_names}
    seen: dict[str, str] = {}
    for agent_name, alias in aliases.items():
        if agent_name.lower() not in known:
            raise AliasError(
                f"Cannot alias '{agent_name}': it is not an agent in this room."
            )
        validate_alias_format(alias)
        check_alias_collisions(
            alias,
            target_agent_id=agent_name,
            agent_names=agent_names,
            role_names=role_names,
            aliases_by_agent=seen,
        )
        seen[agent_name] = alias
