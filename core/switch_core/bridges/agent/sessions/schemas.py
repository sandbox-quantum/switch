"""Request and response bodies for the session routes.

camelCase on the wire, and unknown keys refused, because the client is the SDK
host and it speaks the contract's dialect everywhere else. The rest of the agent
bridge is snake_case; these routes are the contract's, so they follow it rather
than the neighbours.

The lease itself is not a contract type. Contract v1 names the route and says
the server returns an epoch, but declares no body for either direction — the
lease is how a host gets into a position to speak the contract, not something
the contract carries. So the shapes are defined here rather than in
`session/contract.py`, where they would imply a parity the TypeScript mirror
does not have.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, model_validator
from pydantic.alias_generators import to_camel


class _Model(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class LeaseRequest(_Model):
    """Ask for a session's lease, or say that you still hold it.

    `epoch` is what separates the two. Absent, this is an acquisition and the
    server mints a generation. Present, it is a heartbeat under the generation
    the host already has, and it is refused if the host does not still hold it.

    `takeover` is opt-in for the same reason `ConnectionSubscribeRequest` makes
    it opt-in: the usual cause of a collision is a stale process, and refusing
    surfaces that instead of quietly killing whatever was already there. A lease
    whose holder has stopped heartbeating is free without it, and so is one this
    same host already holds.

    Sending both `epoch` and `takeover` is refused rather than resolved. It
    reads as "renew, or take it back if I lost it", and the two halves want
    opposite answers: a renewal that silently became a takeover would hand the
    host a different epoch than the one it asked to keep, and a takeover that
    silently became a renewal would drop the flag on the floor. A host that
    finds its renewal refused can acquire, which is one more round trip and no
    ambiguity.
    """

    host_id: str
    epoch: str | None = None
    takeover: bool = False

    @model_validator(mode="after")
    def _renewal_does_not_take_over(self) -> LeaseRequest:
        if self.epoch is not None and self.takeover:
            raise ValueError(
                "epoch and takeover are mutually exclusive: an epoch means "
                "renew the lease you hold, takeover means acquire one you do not."
            )
        return self


class LeaseResponse(_Model):
    """The generation the host may now emit under.

    `displaced` names the host that was holding the session, when this
    acquisition took it from one. It is reported rather than logged because the
    winner is the only party in a position to notice that something else thought
    it owned this session, and a takeover nobody expected is worth a line in the
    host's own logs.
    """

    session_id: str
    epoch: str
    host_id: str
    displaced: str | None = None
