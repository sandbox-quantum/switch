"""An answer to a card that did not land, and who gave it."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

# A reason can quote something the host chose the length of: an option id is
# `min_length=1` in the contract and has no maximum. Short, because this is one
# sentence in a channel and the whole of it is meant to be read at a glance.
_MAX_REASON = 300


@dataclass(frozen=True)
class Refused:
    """An answer that was aimed at a card and did not land.

    `reason` finishes the sentence "…, because", the same way `Unanswerable`'s
    does, because most of these are one: the wording that explains a refusal to
    whoever reads the log is the wording that explains it to whoever typed.
    `handle` names the card when it is known, so the person can be told which
    of several they were answering. `card_ref` is the card's own post — set
    whenever a card was found, which is every refusal past the lookup — so a
    notice can be said in the card's thread rather than wherever the answer
    happened to be typed, which may be nowhere at all.
    """

    reason: str
    handle: str | None
    card_ref: str | None = None

    def told(self) -> str:
        """What to say to the person who gave the answer.

        One sentence, and never an apology: they did something reasonable and
        it did not work, so the useful part is which card and why.
        """
        card = f" to {self.handle}" if self.handle else ""
        reason = self.reason
        if len(reason) > _MAX_REASON:
            reason = reason[: _MAX_REASON - 1].rstrip() + "…"
        return f"Your answer{card} did not land, because {reason}."


class InboundActor(Protocol):
    """As much of an inbound event as naming who sent it needs.

    A press and a typed answer arrive as different models, and the bridge names
    the person behind either one the same way.
    """

    channel_id: str
    sender_id: str
    sender_name: str
