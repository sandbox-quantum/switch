"""A stand-in session, so a real channel has real work to read and answer.

Nothing produces `HostEvent`s. Not core, not the agent runtime, not any of the
three connectors — the contract exists on both sides as types with no producer
at either end, so until a host learns to speak it there is no session to show.
This replays the bundled fixture in place of one.

What it replays is a whole turn: the agent reads some files, runs the tests,
says what it found, and stops to ask permission for the edit that would fix it.
So the channel gets the work and then the question, which is the order they
happened in and the order they make sense in.

`!session-demo end` carries the demo already on screen in that channel one step
further, to where the turn is interrupted with the permission still unanswered.
Nothing new is posted for it: the turn message and the card are both edited
where they are, which is the whole of what that variant is there to show, and
posting a second copy of the session to show it made the one thing the variant
demonstrates the hardest thing in the channel to see.

Only the most recent demo in a channel can be ended, and a channel with none
gets a whole replay run through to the end — the ending is still what it shows,
and refusing would leave somebody typing a command that does nothing.

The turn and the card both go at the channel root, next to the message that
asked for them: the turn draws its tool calls in a `plan` block, which is a
collapsed disclosure in an ordinary message and needs no thread to live in.
Nothing in the contract says where a session's activity should be shown, by
design — that is Switch's decision — and here the person asking for it has
made it by choosing the channel.

What it stands in for is the *session*, not the bridge. Rendering the card,
minting its handle, writing its row, and everything an answer to it then goes
through, is the production path exactly as it will run. What is invented here
is only where the events came from, and it is invented in one file with the
word demo in its name rather than spread through the code it drives.

Off unless `SESSION_DEMO_ENABLED` is set, and it says so in the log when it
runs, because a card that appears in a channel with no session behind it is
otherwise indistinguishable from one that has.
"""

from __future__ import annotations

import logging
import secrets
from dataclasses import dataclass
from pathlib import Path

from switch_core.db.models import SessionRequestPost

from .outbound import SessionRequestCards, SessionTurnActivity
from .projection import SessionProjection
from .transport import FixtureEventSource, project

logger = logging.getLogger(__name__)

TRIGGER = "!session-demo"

# `!session-demo end` plays the same recording to the end of its turn, which is
# the only way to see the turn message and the card being *edited* rather than
# posted: the turn ends interrupted and the request closes unanswered, so the
# card that comes out of it is not one anybody can press.
_TO_THE_END = "end"

# The fixture the parity suite already reads, so what lands in the channel is
# the same recorded session the tests assert against.
_RECORDING_NAME = "examples.activity.json"

# Where that file is, in each of the two shapes the server runs in. A checkout
# has the console tree beside `core/`. An image has only the package — the
# Dockerfile drops the recording in next to this module — so looking in the
# checkout alone made the demo unreachable anywhere it is actually deployed.
_RECORDING_PLACES = (
    Path(__file__).resolve().parents[5]
    / "console/packages/shared/src/session-v1"
    / _RECORDING_NAME,
    Path(__file__).resolve().parent / _RECORDING_NAME,
)
_STREAM = "turnActivity"
_ENDING = "turnEnd"


def _recording() -> Path:
    """The recorded session, wherever this deployment keeps it."""
    for place in _RECORDING_PLACES:
        if place.exists():
            return place
    raise FileNotFoundError(
        f"SESSION_DEMO_ENABLED is set but {_RECORDING_NAME} is in none of "
        f"{[str(place) for place in _RECORDING_PLACES]}. An image build copies "
        f"it in beside the module; a checkout reads it from the console tree."
    )


@dataclass
class _Showing:
    """A demo left on screen, so `end` can finish it rather than repeat it.

    The session id and the turn are what make a continuation a continuation:
    the activity message is anchored on the pair, so republishing under the
    same one edits the message already there.
    """

    session_id: str
    turn_id: str
    request_id: str
    projection: SessionProjection
    post: SessionRequestPost


class SessionDemo:
    """Posts the recorded session's turn, and then its open request.

    Or, asked to run to the end, edits both where they already are.
    """

    def __init__(
        self, cards: SessionRequestCards, activity: SessionTurnActivity
    ) -> None:
        self._cards = cards
        self._activity = activity
        self._showing: dict[str, _Showing] = {}

    async def handle(self, content: str, channel_id: str, room_id: str) -> bool:
        """Whether this message was the trigger, having acted on it if so.

        Everything it posts goes at the channel root, beside the message that
        asked for it, rather than in a thread underneath: that is the point of
        drawing a turn as a `plan` block instead of streaming it.
        """
        said = content.strip().lower()
        if said not in (TRIGGER, f"{TRIGGER} {_TO_THE_END}"):
            return False
        logger.warning(
            "Posting a demo turn and request card in channel %s. There is no "
            "session behind either: it is the recorded fixture, replayed "
            "because SESSION_DEMO_ENABLED is set. An answer will be built and "
            "dropped like any other.",
            channel_id,
        )
        if said.endswith(_TO_THE_END):
            showing = self._showing.pop(channel_id, None)
            if showing is None:
                showing = await self._start(channel_id, room_id)
            post = await self._finish(showing)
            logger.warning(
                "Demo card %s was closed unanswered, and the turn above it was "
                "edited in place rather than posted again. Run `%s` on its own "
                "for a card that can still be answered.",
                post.handle,
                TRIGGER,
            )
        else:
            showing = await self._start(channel_id, room_id)
            self._showing[channel_id] = showing
            post = showing.post
            logger.warning(
                "Demo card %s is answerable by pressing it, by typing `%s 1`, or "
                "by replying `yes` directly under it.",
                post.handle,
                post.handle,
            )
        return True

    async def _start(self, channel_id: str, room_id: str) -> _Showing:
        """Post the recording's turn and then its request, under a fresh id.

        A request gets one card, which is right for a real session and would
        give this one card ever: the recording holds a single request under a
        single session id, so every replay after the first would be refused as a
        repeat of it — in another channel, on another day, to another person.
        Each replay is therefore its own session, which is also what it is.
        Nothing reads the id back: the command an answer builds is dropped.

        The turn shown is the one the request belongs to, rather than whatever
        the recording last touched. It is the same turn either way here, and
        picking it from the request is the part that stays true of a session
        doing more than one thing.
        """
        source = FixtureEventSource.from_examples(_recording(), events=[_STREAM])
        projection = await project(source, source.session_id)
        requests = projection.open_requests()
        if not requests:
            raise ValueError(
                f"The recorded session {source.session_id} has no open request, "
                f"so there is no card to post."
            )
        request = requests[0]
        session = projection.snapshot.session
        session_id = f"{session.session_id}-{secrets.token_hex(4)}"
        await self._publish(projection, request.turn_id, channel_id, session_id)
        post = await self._cards.post(
            request,
            channel_id=channel_id,
            thread_root_id=None,
            room_id=room_id,
            session_id=session_id,
            epoch=session.epoch,
            agent_name=session.agent_id,
        )
        return _Showing(
            session_id=session_id,
            turn_id=request.turn_id,
            request_id=request.request_id,
            projection=projection,
            post=post,
        )

    async def _finish(self, showing: _Showing) -> SessionRequestPost:
        """Carry the demo on screen to the end of its turn, where it stands.

        The same session and the same turn, so the activity message is the one
        already in the channel and the card is the one already posted: what
        somebody watching sees is a turn ending and a request closing, which is
        the only reason to type this. A fresh replay would show the same two
        states in two new messages, and the thing being demonstrated — that
        neither is reposted — would be the one thing invisible.
        """
        source = FixtureEventSource.from_examples(
            _recording(), events=[_STREAM, _ENDING]
        )
        async for event in source.subscribe(
            source.session_id, showing.projection.through_sequence
        ):
            showing.projection.apply(event)
        await self._publish(
            showing.projection,
            showing.turn_id,
            showing.post.external_channel_id,
            showing.session_id,
        )
        settled = showing.projection.request(showing.request_id)
        if settled is None:
            raise ValueError(
                f"The recording lost request {showing.request_id} on the way to "
                f"the end of its turn, so there is nothing to redraw the card from."
            )
        await self._cards.refresh(showing.post, settled)
        return showing.post

    async def _publish(
        self,
        projection: SessionProjection,
        turn_id: str,
        channel_id: str,
        session_id: str,
    ) -> None:
        """The turn as the projection currently has it, in its one message."""
        turn = projection.turn(turn_id)
        if turn is None:
            raise ValueError(
                f"The recording has items for turn {turn_id} but never said what "
                f"the turn itself was doing, so its state cannot be shown."
            )
        await self._activity.publish(
            projection.turn_activity(turn_id),
            turn,
            session_id=session_id,
            channel_id=channel_id,
            thread_root_id=None,
            agent_name=projection.snapshot.session.agent_id,
        )
