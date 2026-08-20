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
  - A rule additionally carries two *symbolic* subjects (CHOO-2137), resolved
    at enforcement time rather than stored as ids, so they survive the owner
    claiming a new platform identity, a bridge being recreated, or the agent
    changing hands:
      * `owner`        — the agent's own owner, whoever that currently is.
                         Human senders only.
      * `owner_agents` — any agent owned by that same person. Agent senders
                         only. This is what keeps an owner's own orchestration
                         working under an owner-scoped policy: the manager
                         dispatching a worker is the owner acting through a
                         program, and naming each agent by id would break the
                         moment they register a new one.
    Both are per-rule, so they carry that rule's room scoping like any other
    dimension.
  - A rule *allows* an attempt when the context matches (room AND group) AND
    the sender matches (its own kind's dimension, or `owner` for a human).
    Addressing is permitted when **any** rule allows it.

Defaults / precedence:
  - An agent with **no rules** is open: anyone may address it. This is what a
    pre-CHOO-2137 agent carries, and it is preserved rather than migrated.
  - With rules present it is **deny-by-default**: only attempts matching a rule
    are permitted.
  - Agents created from CHOO-2137 onwards start owner-only (see
    `owner_only_policy`) rather than open.

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
    owner: bool = False
    owner_agents: bool = False

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
        sender_user_ids: list[str],
        sender_owner_user_id: str | None,
        owner_user_id: str | None,
    ) -> bool:
        if not _dim_contains(self.rooms, room_id):
            return False
        if not _dim_contains(self.room_groups, group_id):
            return False
        if sender_kind == "user" and self._is_owner(sender_user_ids, owner_user_id):
            return True
        if sender_kind == "agent" and self._is_owners_agent(
            sender_owner_user_id, owner_user_id
        ):
            return True
        sender_dim = self.users if sender_kind == "user" else self.agents
        return _dim_contains(sender_dim, sender_id)

    def _is_owner(self, sender_user_ids: list[str], owner_user_id: str | None) -> bool:
        """Whether this rule admits the sender as the agent's owner.

        A platform account may be claimed by several Switch users, so the
        sender arrives as the set of users who say it is theirs; the owner
        need only be among them. An ownerless agent has no owner to match, and
        an unclaimed account resolves to nobody — both answer "not the owner"
        rather than making a permissive guess.
        """
        if not self.owner:
            return False
        if owner_user_id is None:
            return False
        return owner_user_id in sender_user_ids

    def _is_owners_agent(
        self, sender_owner_user_id: str | None, owner_user_id: str | None
    ) -> bool:
        """Whether this rule admits the sender as an agent of the same owner.

        Both sides must be owned for this to mean anything: two ownerless
        agents are not each other's, and an ownerless target has nobody whose
        agents these would be. Either one missing answers "no" rather than
        letting an unowned agent inherit the fleet's trust.
        """
        if not self.owner_agents:
            return False
        if owner_user_id is None or sender_owner_user_id is None:
            return False
        return sender_owner_user_id == owner_user_id


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
        sender_user_ids: list[str],
        sender_owner_user_id: str | None,
        owner_user_id: str | None,
    ) -> bool:
        """Whether an addressing attempt from this sender, in this room, is
        permitted. Allow-all when the policy is open; otherwise permitted iff
        at least one rule matches.

        `sender_user_ids` are the Switch users who have claimed a human
        sender's platform account (empty when nobody has);
        `sender_owner_user_id` is who owns an agent sender (None for a human
        or an ownerless agent); `owner_user_id` is the addressed agent's
        owner. Together they resolve the `owner` and `owner_agents` rules.
        """
        if self.is_open():
            return True
        return any(
            rule._matches(
                room_id=room_id,
                group_id=group_id,
                sender_kind=sender_kind,
                sender_id=sender_id,
                sender_user_ids=sender_user_ids,
                sender_owner_user_id=sender_owner_user_id,
                owner_user_id=owner_user_id,
            )
            for rule in self.rules
        )

    def requires_owner_identity(self) -> bool:
        """Whether any rule depends on resolving the owner's platform identity.

        Used to warn an operator that an agent is unreachable until its owner
        claims an identity on the bridges it works over — the difference
        between a policy that is merely strict and one that admits nobody.
        """
        return any(rule.owner for rule in self.rules)


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


def owner_only_policy(allowed_agent_ids: list[str]) -> AddressingPolicy:
    """Owner-only: the agent's owner anywhere, and nobody else.

    No other human, and no agent except those explicitly granted.
    `allowed_agent_ids` names individual dispatchers by id; empty means the
    agent answers only to its owner, in person.
    """
    return AddressingPolicy(
        rules=[
            AddressingRule(
                rooms=ANY,
                room_groups=ANY,
                users=[],
                agents=list(allowed_agent_ids),
                owner=True,
            )
        ]
    )


def owner_and_owner_agents_policy() -> AddressingPolicy:
    """The owner, plus any agent that owner runs (CHOO-2137).

    The default a Switch Console agent is created on. Strict owner-only is one
    step too strict to be the thing everyone starts on: an owner's manager
    agent dispatching their worker is still the owner acting, and an agent that
    refuses its own owner's orchestration looks broken rather than private.
    Somebody else's agent is admitted by neither.
    """
    return AddressingPolicy(
        rules=[
            AddressingRule(
                rooms=ANY,
                room_groups=ANY,
                users=[],
                agents=[],
                owner=True,
                owner_agents=True,
            )
        ]
    )


def can_address(
    policy: AddressingPolicy,
    *,
    room_id: str,
    group_id: str | None,
    sender_kind: SenderKind,
    sender_id: str,
    sender_user_ids: list[str],
    sender_owner_user_id: str | None,
    owner_user_id: str | None,
) -> bool:
    """Convenience free function mirroring :meth:`AddressingPolicy.allows`."""
    return policy.allows(
        room_id=room_id,
        group_id=group_id,
        sender_kind=sender_kind,
        sender_id=sender_id,
        sender_user_ids=sender_user_ids,
        sender_owner_user_id=sender_owner_user_id,
        owner_user_id=owner_user_id,
    )
