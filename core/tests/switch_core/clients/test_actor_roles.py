"""Each kind of actor reports itself under its own role in message metrics."""

from __future__ import annotations

from typing import get_args

from switch_core.clients.actor import (
    Actor,
    ActorRole,
    AgentActor,
    HumanActor,
    SystemActor,
)


def test_every_actor_class_has_its_own_role() -> None:
    roles = {cls: cls.role for cls in (Actor, HumanActor, AgentActor, SystemActor)}
    assert roles == {
        Actor: "bridge",
        HumanActor: "human",
        AgentActor: "agent",
        SystemActor: "system",
    }
    # Every role an actor can have is one a dashboard can expect, and no two
    # kinds of actor share one.
    assert set(roles.values()) == set(get_args(ActorRole.__value__))
