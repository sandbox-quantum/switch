"""A stand-in session, so a real channel has real work to read and answer.

Nothing produces `HostEvent`s. Not core, not the agent runtime, not any of the
three connectors — the contract exists on both sides as types with no producer
at either end, so until a host learns to speak it there is no session to show.
This replays the bundled fixture in place of one.

What it replays is a whole turn: the agent reads some files, runs the tests,
says what it found, and stops to ask permission for the edit that would fix it.
So the channel gets the work and then the question, which is the order they
happened in and the order they make sense in.

Both go to the channel the trigger was typed in. Nothing in the contract says
where a session's activity should be shown, by design — that is Switch's
decision — and here the person asking for it has made it.

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
from pathlib import Path

from switch_core.db.models import SessionRequestPost

from .outbound import SessionRequestCards, SessionTurnActivity
from .transport import FixtureEventSource, project

logger = logging.getLogger(__name__)

TRIGGER = "!session-demo"

# The fixture the parity suite already reads, so what lands in the channel is
# the same recorded session the tests assert against.
_RECORDING = (
    Path(__file__).resolve().parents[5]
    / "console/packages/shared/src/session-v1/examples.activity.json"
)
_STREAM = "turnActivity"


class SessionDemo:
    """Posts the recorded session's turn, and then its open request."""

    def __init__(
        self, cards: SessionRequestCards, activity: SessionTurnActivity
    ) -> None:
        self._cards = cards
        self._activity = activity

    async def handle(self, content: str, channel_id: str, room_id: str) -> bool:
        """Whether this message was the trigger, having acted on it if so."""
        if content.strip().lower() != TRIGGER:
            return False
        logger.warning(
            "Posting a demo turn and request card in channel %s. There is no "
            "session behind either: it is the recorded fixture, replayed "
            "because SESSION_DEMO_ENABLED is set. An answer will be built and "
            "dropped like any other.",
            channel_id,
        )
        post = await self._post(channel_id, room_id)
        logger.warning(
            "Demo card %s is answerable by pressing it, by typing `%s 1`, or "
            "by replying `yes` directly under it.",
            post.handle,
            post.handle,
        )
        return True

    async def _post(self, channel_id: str, room_id: str) -> SessionRequestPost:
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
        if not _RECORDING.exists():
            raise FileNotFoundError(
                f"The session fixtures are not at {_RECORDING}. SESSION_DEMO_ENABLED "
                f"needs the repository checkout, not just the installed package."
            )
        source = FixtureEventSource.from_examples(_RECORDING, events=[_STREAM])
        projection = await project(source, source.session_id)
        requests = projection.open_requests()
        if not requests:
            raise ValueError(
                f"The recorded session {source.session_id} has no open request, "
                f"so there is no card to post."
            )
        request = requests[0]
        session = projection.snapshot.session
        await self._activity.post(
            projection.turn_activity(request.turn_id),
            channel_id=channel_id,
            thread_root_id=None,
            agent_name=session.agent_id,
        )
        return await self._cards.post(
            request,
            channel_id=channel_id,
            thread_root_id=None,
            room_id=room_id,
            session_id=f"{session.session_id}-{secrets.token_hex(4)}",
            epoch=session.epoch,
            agent_name=session.agent_id,
        )
