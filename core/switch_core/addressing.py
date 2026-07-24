"""Scoped agent-addressing permissions (CHOO-1585).

Controls WHO may *address* an agent — i.e. cause it to receive a message it is
expected to respond to (an `@name` / `@alias` / `@role` mention, a targeted
message, or a task delegation). By default any room participant can address any
agent; this module adds an opt-in allow-list model per agent.

Model:
  - Each agent carries an `AddressingPolicy`: an ordered list of allow-rules.
  - A rule constrains four dimensions of the *incoming* addressing attempt:
      * `rooms`       — the room the message is in
      * `room_groups` — the group that room belongs to (``None`` if ungrouped)
      * `users`       — matched when the sender is a human
      * `agents`      — matched when the sender is another agent
  - Each dimension is either ``"*"`` (any), or an explicit list of ids. An
    empty list ``[]`` is the "none" value: it matches nothing. The sender is
    exactly one kind (user XOR agent), so a rule that should admit only humans
    sets ``agents: []`` and vice-versa.
  - A rule *allows* an attempt when the context matches (room AND group) AND
    the sender matches (its own kind's dimension). Addressing is permitted when
    **any** rule allows it.

Defaults / precedence (agreed on CHOO-1585):
  - An agent with **no rules** preserves today's behaviour: anyone may address
    it (allow-all). Enforcement only kicks in once at least one rule exists.
  - With rules present it is **deny-by-default**: only attempts matching a rule
    are permitted.

This module is deliberately pure (no DB, no I/O) so it is trivially testable
and reusable from the receive path, the protocol service, and the gateway.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, field_validator

SenderKind = Literal["user", "agent"]

ANY = "*"

# A dimension is "*" (any) or an explicit list of ids ([] = none / match nothing).
Dimension = str | list[str]


class AddressingRule(BaseModel):
    """One allow-rule. An attempt is allowed when it matches this rule on all
    four dimensions (see module docstring). Each dimension defaults to ``"*"``
    (unconstrained); note that leaving ``users``/``agents`` at ``"*"`` admits
    that whole sender kind — set the one you want to exclude to ``[]``."""

    rooms: Dimension = ANY
    room_groups: Dimension = ANY
    users: Dimension = ANY
    agents: Dimension = ANY

    @field_validator("rooms", "room_groups", "users", "agents")
    @classmethod
    def _valid_dimension(cls, value: Dimension) -> Dimension:
        if value == ANY:
            return value
        if isinstance(value, list) and all(isinstance(v, str) for v in value):
            return value
        raise ValueError(f'dimension must be "*" or a list of ids, got {value!r}')

    def _matches(
        self,
        *,
        room_id: str,
        group_id: str | None,
        sender_kind: SenderKind,
        sender_id: str,
    ) -> bool:
        if not _dim_contains(self.rooms, room_id):
            return False
        if not _dim_contains(self.room_groups, group_id):
            return False
        sender_dim = self.users if sender_kind == "user" else self.agents
        return _dim_contains(sender_dim, sender_id)


class AddressingPolicy(BaseModel):
    """An agent's addressing allow-list. Empty ``rules`` → allow-all."""

    rules: list[AddressingRule] = []

    def is_open(self) -> bool:
        """True when the policy imposes no restriction (no rules)."""
        return not self.rules

    def allows(
        self,
        *,
        room_id: str,
        group_id: str | None,
        sender_kind: SenderKind,
        sender_id: str,
    ) -> bool:
        """Whether an addressing attempt from this sender, in this room, is
        permitted. Allow-all when the policy is open; otherwise permitted iff
        at least one rule matches."""
        if self.is_open():
            return True
        return any(
            rule._matches(
                room_id=room_id,
                group_id=group_id,
                sender_kind=sender_kind,
                sender_id=sender_id,
            )
            for rule in self.rules
        )


def _dim_contains(dimension: Dimension, value: str | None) -> bool:
    """Whether a single dimension admits ``value``. ``"*"`` admits anything;
    a list admits only its members; ``None`` (e.g. an ungrouped room) is admitted
    only by ``"*"``."""
    if dimension == ANY:
        return True
    if value is None:
        return False
    return value in dimension


def parse_policy(raw: dict | None) -> AddressingPolicy:
    """Build a policy from a stored JSONB blob (``None`` → open policy)."""
    if not raw:
        return AddressingPolicy()
    return AddressingPolicy.model_validate(raw)


def can_address(
    policy: AddressingPolicy,
    *,
    room_id: str,
    group_id: str | None,
    sender_kind: SenderKind,
    sender_id: str,
) -> bool:
    """Convenience free function mirroring :meth:`AddressingPolicy.allows`."""
    return policy.allows(
        room_id=room_id,
        group_id=group_id,
        sender_kind=sender_kind,
        sender_id=sender_id,
    )
