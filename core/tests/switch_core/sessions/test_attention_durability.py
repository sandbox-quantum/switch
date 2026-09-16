"""Attention replies must survive replay without paging a thread twice."""

import pytest

from ..bridges.collaboration.test_session_activity import _turn
from .test_activity_durability import ActivitySlack, activity
from .test_authority import setup


async def publish(renderer, *, status="running", error="The host is offline."):
    return await renderer.publish(
        [],
        _turn(status).model_copy(update={"command_id": "message-demo"}),
        session_id="session-demo",
        channel_id="channel-demo",
        thread_root_id="channel-demo:root",
        asked_on="channel-demo:question",
        agent_name="Agent",
        elapsed_seconds=1,
        error_summary=error,
        session_url="switchdash://session?server=https%3A%2F%2Fswitch.example&agent=a&room=r&session=s",
    )


async def test_restart_reuses_attention_and_updates_it_when_host_returns(
    session_factory,
):
    await setup(session_factory)
    platform = ActivitySlack()
    await publish(activity(session_factory, platform))
    assert platform.post_count == 2
    await publish(activity(session_factory, platform))
    assert platform.post_count == 2
    await publish(activity(session_factory, platform), error=None)
    assert platform.post_count == 2
    assert "offline" not in platform.messages["channel-demo:2"].text
    await publish(activity(session_factory, platform), status="completed", error=None)
    await publish(activity(session_factory, platform), status="completed", error=None)
    assert platform.post_count == 2
    assert "complete" in platform.messages["channel-demo:2"].text.lower()


class LostAttentionResponse(ActivitySlack):
    async def post_rich(self, channel, agent, content, thread):
        if content.error_summary and not getattr(self, "attention_attempted", False):
            self.attention_attempted = True
            self.fail_after_post = True
        return await super().post_rich(channel, agent, content, thread)


@pytest.mark.parametrize("recovered", [False, True])
async def test_lost_attention_response_is_recovered_without_reposting(
    session_factory, recovered
):
    await setup(session_factory)
    platform = LostAttentionResponse()
    with pytest.raises(TimeoutError):
        await publish(activity(session_factory, platform))
    assert platform.post_count == 2
    await publish(
        activity(session_factory, platform),
        error=None if recovered else "The host is offline.",
    )
    assert platform.post_count == 2
    assert ("offline" in platform.messages["channel-demo:2"].text) is not recovered


async def test_terminal_error_receipt_prevents_attention_replay(session_factory):
    await setup(session_factory)
    platform = ActivitySlack()
    await publish(
        activity(session_factory, platform), status="error", error="The request failed."
    )
    await publish(
        activity(session_factory, platform), status="error", error="The request failed."
    )
    assert platform.post_count == 2
