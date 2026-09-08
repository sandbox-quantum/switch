"""Keeping a posted request card in step with the request behind it.

The inbound half turns a press into a command; this is what the room sees
afterwards. A request moves open → submitting → resolved or closed, and the
card that stands for it is edited in place each time, so the channel carries
one message per request rather than a running commentary.

Slack-shaped, for the same reason `post_blocks` is: Block Kit is Slack's own
form and the platforms that need something like a card need something
different. The neutral seam belongs here when a second platform wants one, not
before.
"""

from __future__ import annotations

import logging

from slack_sdk.errors import SlackApiError

from switch_core.bridges.collaboration.slack.adapter import SlackAdapter
from switch_core.db.models import SessionRequestPost

from .contract import ApprovalContent, SnapshotRequest
from .renderers import RequestReference
from .renderers.slack import render_approval

logger = logging.getLogger(__name__)


def posted_options(request: SnapshotRequest) -> list[dict[str, str]]:
    """What the card offered, in the order it offered it, for the record.

    A typed "1" means the first thing on the card the person is looking at, and
    nothing else in Switch holds that. Kept in the same order the renderers
    number and lay out, so the record and the card cannot disagree about which
    option is which.
    """
    content = request.content
    if not isinstance(content, ApprovalContent):
        raise ValueError(
            f"Request {request.request_id} is not an approval: {content.kind}."
        )
    return [
        {"optionId": option.option_id, "decision": option.decision}
        for option in content.options
    ]


class SessionRequestCards:
    """One bridge's posted request cards, as the requests behind them change."""

    def __init__(self, adapter: SlackAdapter) -> None:
        self._adapter = adapter

    async def refresh(self, post: SessionRequestPost, request: SnapshotRequest) -> None:
        """Redraw the card for `request` where it was posted.

        When the edit fails the outcome is posted into the thread instead. A
        stale card is the one failure that cannot be left silent: it goes on
        showing buttons for a request that has already settled, and a reader has
        no way to tell that pressing one will do nothing.
        """
        message = render_approval(
            request, RequestReference(token=post.token, handle=post.handle)
        )
        try:
            await self._adapter.update_blocks(
                post.external_channel_id,
                post.external_post_id,
                message.text,
                message.blocks,
            )
        except SlackApiError as error:
            logger.error(
                "Could not update the card for request %s in channel %s: %s. "
                "Posting the outcome as a reply instead.",
                post.request_id,
                post.external_channel_id,
                error,
            )
            await self._adapter.admin_message(
                post.external_channel_id,
                f"The card for request {post.handle} above could not be updated, "
                f"so it may still be offering buttons that no longer "
                f"work.\n{message.text}",
                post.external_post_id,
            )
