"""A stand-in session, so a real channel has a real card to answer.

Nothing produces `HostEvent`s. Not core, not the agent runtime, not any of the
three connectors — the contract exists on both sides as types with no producer
at either end, so until a host learns to speak it there is no session to show.
This replays the bundled fixture in place of one.

The card goes to the channel the trigger was typed in. Nothing in the contract
says where a request should be shown, by design — that is Switch's decision —
and here the person asking for it has made it.

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

from .outbound import SessionRequestCards
from .transport import FixtureEventSource, project

logger = logging.getLogger(__name__)

TRIGGER = "!session-demo"

# The fixtures the parity suites already read, so the card in the channel is
# drawn from the same recorded session the tests assert against.
_EXAMPLES = (
    Path(__file__).resolve().parents[5]
    / "console/packages/shared/src/session-v1/examples.json"
)


class SessionDemo:
    """Posts the recorded session's open request into the channel asked."""

    def __init__(self, cards: SessionRequestCards) -> None:
        self._cards = cards

    async def handle(self, content: str, channel_id: str, room_id: str) -> bool:
        """Whether this message was the trigger, having acted on it if so."""
        if content.strip().lower() != TRIGGER:
            return False
        logger.warning(
            "Posting a demo request card in channel %s. There is no session "
            "behind it: it is the recorded fixture, replayed because "
            "SESSION_DEMO_ENABLED is set. An answer to it will be built and "
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
        """Post the recording's open request, under a session id of its own.

        A request gets one card, which is right for a real session and would
        give this one card ever: the recording holds a single request under a
        single session id, so every replay after the first would be refused as a
        repeat of it — in another channel, on another day, to another person.
        Each replay is therefore its own session, which is also what it is.
        Nothing reads the id back: the command an answer builds is dropped.
        """
        if not _EXAMPLES.exists():
            raise FileNotFoundError(
                f"The session fixtures are not at {_EXAMPLES}. SESSION_DEMO_ENABLED "
                f"needs the repository checkout, not just the installed package."
            )
        source = FixtureEventSource.from_examples(_EXAMPLES, events=[])
        projection = await project(source, source.session_id)
        requests = projection.open_requests()
        if not requests:
            raise ValueError(
                f"The recorded session {source.session_id} has no open request, "
                f"so there is no card to post."
            )
        session = projection.snapshot.session
        return await self._cards.post(
            requests[0],
            channel_id=channel_id,
            thread_root_id=None,
            room_id=room_id,
            session_id=f"{session.session_id}-{secrets.token_hex(4)}",
            epoch=session.epoch,
            agent_name=session.agent_id,
        )
