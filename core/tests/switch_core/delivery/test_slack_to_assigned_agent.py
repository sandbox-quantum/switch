"""A Slack post reaching a room's assigned agent, from the Slack event on.

The journeys (`test_conversation_journeys.py`) write each message straight
through a client's transport. These start one step earlier, from the event
Slack sends: the Slack adapter reads it, the collaboration bridge writes it
into the room as the person's actor, and the router decides it as it is
written. The assertion is the same: the agent's own event for the message.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import select

from switch_core.attachments import ATTACHMENT_GROUP_KEY
from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import InboundMessage
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
    SlackUser,
)
from switch_core.clients.actor import ClientConfig, HumanActor
from switch_core.db.models import AgentEventRow, Message
from switch_core.db.stores.client_store import ClientStore
from switch_core.trust.client import NullTrustClient
from tests.switch_core.delivery.test_conversation_journeys import ON, Journey
from tests.switch_core.delivery.world import World

CHANNEL = "C123"
BOB = "U0BOB"


class SlackRoom:
    """The journey's room, bridged to a Slack channel: `post` hands the
    adapter an event as Slack sends it and returns the room rows it wrote."""

    def __init__(self, journey: Journey) -> None:
        self.journey = journey
        self.adapter = SlackAdapter(
            config=SlackConnectionConfig(
                bot_token="xoxb-test", app_token="xapp-test", workspace_id="T123"
            )
        )
        self.adapter.set_tenant_id(journey.room.tenant_id)
        self.adapter._channel_name_cache[CHANNEL] = "general"
        self.adapter._user_cache[BOB] = SlackUser(name="bob", display_name="bob")
        self.adapter._download_file = self._download  # type: ignore[method-assign]
        self.adapter._on_message = self._relay
        self.core = self._core()

    async def _download(self, url: str) -> bytes:
        return f"contents of {url}".encode()

    def _core(self) -> CollaborationCore:
        journey = self.journey
        world = journey.world
        bob = journey.clients["bob"]
        actor = HumanActor(
            client_id=bob.id,
            tenant_id=bob.tenant_id,
            transport_user_id=bob.transport_user_id,
            display_name=bob.display_name,
            session_factory=world.session_factory,
            client_store=ClientStore(),
            config=ClientConfig(),
            transport_factory=lambda _actor: journey.process.transport(bob),
        )
        actor.transport = journey.process.transport(bob)

        async def _ensure_human_in_room(**_kwargs: Any) -> HumanActor:
            return actor

        async def _event_for_external_post(_ref: str) -> str | None:
            return None

        async def _is_registered_agent(_name: str) -> bool:
            return False

        async def _nothing(*_args: Any, **_kwargs: Any) -> None:
            return None

        async def _not_handed_in(_msg: InboundMessage) -> bool:
            # Hosted agents v2's once-only check (`_already_handed_in`): every post
            # here is a first copy. With v2 off it is never asked.
            return False

        core = CollaborationCore.__new__(CollaborationCore)
        vars(core).update(
            _bridge_id="slack-bridge",
            _adapter=self.adapter,
            _channel_to_room={
                CHANNEL: (journey.room.id, journey.room.transport_room_id)
            },
            _channel_locks={},
            _is_registered_agent=_is_registered_agent,
            _ensure_human_in_room=_ensure_human_in_room,
            _record_message_map=_nothing,
            _event_for_external_post=_event_for_external_post,
            _handle_text_answer=_nothing,
            _repair_placeholder_username=_nothing,
            _maybe_guide_self_mention=_nothing,
            _trust_client=NullTrustClient(),
            _already_handed_in=_not_handed_in,
        )
        return core

    async def _relay(self, msg: InboundMessage) -> None:
        await CollaborationCore._handle_inbound_message(self.core, msg)

    async def post(self, event: dict[str, object]) -> list[Message]:
        """Hand the adapter `event`, a Slack `message` event, and return the
        room rows it became."""
        journey = self.journey
        async with journey.world.session_factory() as session:
            before = set(
                (
                    await session.scalars(
                        select(Message.transport_event_id).where(
                            Message.room_id == journey.room.id
                        )
                    )
                ).all()
            )
        await self.adapter.dispatch_event(
            envelope_type="events_api",
            payload={"type": "event_callback", "event": event},
        )
        await journey.process.idle()
        async with journey.world.session_factory() as session:
            rows = (
                await session.scalars(
                    select(Message)
                    .where(Message.room_id == journey.room.id)
                    .order_by(Message.seq)
                )
            ).all()
        return [row for row in rows if row.transport_event_id not in before]

    async def reached(self, rows: list[Message]) -> set[str]:
        """The agents given any of `rows` as one of their own events."""
        world = self.journey.world
        ids = {agent.id: name for name, agent in world.agents.items()}
        # A post of several files is one message, keyed on its group.
        keys = {
            group["id"]
            if isinstance(group := row.content.get(ATTACHMENT_GROUP_KEY), dict)
            else row.transport_event_id
            for row in rows
        }
        async with world.session_factory() as session:
            agent_ids = (
                await session.scalars(
                    select(AgentEventRow.agent_id).where(
                        AgentEventRow.message_key.in_(keys)
                    )
                )
            ).all()
        return {ids[agent_id] for agent_id in agent_ids}


def _message(ts: str, text: str, **fields: object) -> dict[str, object]:
    """A person's channel message as Slack's Events API sends it."""
    return {
        "type": "message",
        "user": BOB,
        "text": text,
        "ts": ts,
        "event_ts": ts,
        "channel": CHANNEL,
        "channel_type": "channel",
        "team": "T123",
        "client_msg_id": f"msg-{ts}",
        **fields,
    }


def _file(file_id: str, name: str, mimetype: str) -> dict[str, object]:
    return {
        "id": file_id,
        "name": name,
        "title": name,
        "mimetype": mimetype,
        "user": BOB,
        "size": 64,
        "mode": "hosted",
        "is_external": False,
        "url_private": f"https://files.slack.com/files-pri/T123-{file_id}/{name}",
        "url_private_download": (
            f"https://files.slack.com/files-pri/T123-{file_id}/download/{name}"
        ),
    }


def _file_share(ts: str, text: str, *files: dict[str, object]) -> dict[str, object]:
    return _message(
        ts,
        text,
        subtype="file_share",
        files=list(files),
        upload=False,
        display_as_bot=False,
    )


@pytest.fixture
async def slack(world: World) -> SlackRoom:
    journey = await Journey(world, ON).start()
    await journey.command("alice", "assign-agent", "@helper", at=0)
    return SlackRoom(journey)


class TestFromSlackToTheAssignedAgent:
    async def test_plain_text(self, slack: SlackRoom) -> None:
        rows = await slack.post(_message("1700000001.000100", "what does this do?"))

        assert len(rows) == 1
        assert await slack.reached(rows) == {"helper"}

    async def test_an_image(self, slack: SlackRoom) -> None:
        rows = await slack.post(
            _file_share("1700000002.000100", "", _file("F1", "shot.png", "image/png"))
        )

        assert [row.msgtype for row in rows] == ["m.image"]
        assert await slack.reached(rows) == {"helper"}

    async def test_a_file_with_text(self, slack: SlackRoom) -> None:
        rows = await slack.post(
            _file_share(
                "1700000003.000100",
                "notes from the call",
                _file("F2", "notes.md", "text/markdown"),
            )
        )

        assert [row.msgtype for row in rows] == ["m.file"]
        assert await slack.reached(rows) == {"helper"}

    async def test_several_files(self, slack: SlackRoom) -> None:
        rows = await slack.post(
            _file_share(
                "1700000004.000100",
                "",
                _file("F3", "spec.pdf", "application/pdf"),
                _file("F4", "shot.png", "image/png"),
            )
        )

        assert len(rows) == 2
        assert await slack.reached(rows) == {"helper"}

    async def test_a_labelled_link(self, slack: SlackRoom) -> None:
        rows = await slack.post(
            _message(
                "1700000005.000100",
                "<https://github.com/org/repo/issues/1|org/repo#1>",
            )
        )

        assert [row.body for row in rows] == [
            "[org/repo#1](https://github.com/org/repo/issues/1)"
        ]
        assert await slack.reached(rows) == {"helper"}

    async def test_a_bare_link(self, slack: SlackRoom) -> None:
        rows = await slack.post(
            _message(
                "1700000006.000100",
                "can you look at <https://github.com/org/repo/issues/1>",
            )
        )

        assert len(rows) == 1
        assert await slack.reached(rows) == {"helper"}

    async def test_an_unfurled_link(self, slack: SlackRoom) -> None:
        """Slack sends the post, then the same post again as an edit once the
        link is unfurled: the post reaches the agent, the edit adds nothing."""
        url = "https://github.com/org/repo/issues/1"
        post = _message(
            "1700000007.000100",
            f"<{url}|org/repo#1>",
            blocks=[
                {
                    "type": "rich_text",
                    "block_id": "b1",
                    "elements": [
                        {
                            "type": "rich_text_section",
                            "elements": [
                                {"type": "link", "url": url, "text": "org/repo#1"}
                            ],
                        }
                    ],
                }
            ],
        )
        unfurl = {
            "from_url": url,
            "title": "Issue 1",
            "title_link": url,
            "service_name": "GitHub",
        }

        rows = await slack.post(post)
        edits = await slack.post(
            {
                "type": "message",
                "subtype": "message_changed",
                "hidden": True,
                "channel": CHANNEL,
                "channel_type": "channel",
                "ts": "1700000007.000200",
                "event_ts": "1700000007.000200",
                "message": {**post, "attachments": [unfurl]},
                "previous_message": post,
            }
        )

        assert len(rows) == 1
        assert edits == []
        assert await slack.reached(rows) == {"helper"}
