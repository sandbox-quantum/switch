"""What a room may be shown of a session.

The contract used to carry the answer in the payload: a host said who a thing
was for and the bridge did as it was told. That field is gone, so this is the
replacement — a decision Switch takes, in one place, from the session's state
and the room association the server owns.

It is a function over a projection and an association rather than something the
renderers ask as they go, because the interesting property is a negative one.
"An unassociated session publishes nothing" is only checkable if there is a
single point where publication is decided; spread across three renderers it
becomes a claim about code nobody has read all of.

The two halves it separates are not obvious from the renderers. `render_activity`
draws a turn's messages *and* its tool disclosure in one call, and the messages
are transcript: what the model said, and what a user typed into the Console.
None of that belongs in a channel. A room reply is something an agent chooses to
say through `post_message`, and a session must not become a second mouth that
says things nobody chose.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from switch_core.db.models import SessionRoomAssociation

    from .contract import Item, SnapshotRequest
    from .projection import SessionProjection


# What the host reports as things said rather than things done. Never published:
# these are the transcript, and the disclosure is not.
TRANSCRIPT_KINDS = frozenset({"user-message", "assistant-message"})

# A request in one of these is still answerable, so it is shown as a card with
# buttons. The rest have been decided and are shown as an outcome.
LIVE_STATES = frozenset({"open", "submitting"})


@dataclass(frozen=True)
class TurnDisclosure:
    """One turn's activity, as a room may see it.

    Never a post of its own — it is the collapsed disclosure hanging off the
    turn's existing post, which is why it is grouped by turn rather than handed
    over as one flat list of items.
    """

    turn_id: str
    items: tuple[Item, ...]


@dataclass(frozen=True)
class PublicationPlan:
    """Everything one room may be shown of one session, as of one projection.

    A plan, not an instruction: it says what is publishable, not what is new.
    Which of these the room has already been shown is the publisher's question,
    answered from `session_request_posts` and `session_publications`, and it is
    kept out of here so that this stays a pure function of state anyone can read
    the rules off.
    """

    room_id: str
    thread_root_id: str | None
    cards: tuple[SnapshotRequest, ...]
    outcomes: tuple[SnapshotRequest, ...]
    disclosures: tuple[TurnDisclosure, ...]


def publication_policy(
    projection: SessionProjection,
    association: SessionRoomAssociation | None,
) -> PublicationPlan | None:
    """What this session may put in front of a channel, or nothing at all.

    `None` means publish nothing, anywhere — the answer for every session
    nobody has associated with a room, which is every Console-started session.
    It is returned rather than an empty plan so that a caller cannot iterate an
    empty plan's fields and quietly believe it did the right thing; there is
    nothing to loop over, and the branch is forced.
    """
    if association is None:
        return None

    requests = projection.snapshot.requests
    return PublicationPlan(
        room_id=association.room_id,
        thread_root_id=association.thread_id or association.origin_message_id,
        cards=tuple(x for x in requests if x.state in LIVE_STATES),
        outcomes=tuple(x for x in requests if x.state not in LIVE_STATES),
        disclosures=_disclosures(projection),
    )


def _disclosures(projection: SessionProjection) -> tuple[TurnDisclosure, ...]:
    """Each turn's publishable activity, skipping turns that have none."""
    disclosures = []
    for turn in projection.snapshot.turns:
        items = tuple(
            item
            for item in projection.turn_activity(turn.turn_id)
            if _publishable(item)
        )
        if items:
            disclosures.append(TurnDisclosure(turn_id=turn.turn_id, items=items))
    return tuple(disclosures)


def _publishable(item: Item) -> bool:
    """Whether this item is a thing done rather than a thing said.

    There is no separate rule against echoing a room's own message back at it.
    The only item a room can be the author of is the message that steered the
    turn, which the host reports as a `user-message` — already excluded, and
    `Item.kind` admits nothing else that could carry a room's authorship. A
    turn's activity is not an echo just because a room asked for it, so the
    room that asked still sees what the agent did.
    """
    return item.kind not in TRANSCRIPT_KINDS
