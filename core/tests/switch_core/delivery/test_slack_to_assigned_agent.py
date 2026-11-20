"""A Slack post reaching a room's assigned agent, from the Slack event on.

The journeys (`test_conversation_journeys.py`) write each message straight
through a client's transport. These start one step earlier, from the event
Slack sends: the Slack adapter reads it, the collaboration bridge writes it
into the room as the person's actor, and the router decides it as it is
written. The assertion is the same: the agent's own event for the message.
Each test counts every agent's events for the post, so a second delivery, or
one to an agent the post was not for, fails it as surely as a missing one.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import func, select

from switch_core.attachments import ATTACHMENT_GROUP_KEY
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
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
REVIEWER_GROUP = "S0REV"
URL = "https://github.com/org/repo/issues/1"
MENTION_REVIEWER = f"<!subteam^{REVIEWER_GROUP}|@reviewer>"


class SlackRoom:
    """The journey's room, bridged to a Slack channel: `post` hands the
    adapter an event as Slack sends it and returns the room rows it wrote as
    the person. `_posts` stands in for the bridge's message map, so a reply
    in a Slack thread lands in the room thread of the post it replies to."""

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
        self.adapter._agent_group_names[REVIEWER_GROUP] = "reviewer"
        self.adapter._download_file = self._download  # type: ignore[method-assign]
        self.adapter._on_message = self._relay
        self._posts: dict[str, str] = {}
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

        async def _record_message_map(
            *, external_channel_id: str, transport_event_id: str, external_post_id: str
        ) -> None:
            self._posts.setdefault(external_post_id, transport_event_id)

        async def _event_for_external_post(ref: str) -> str | None:
            return self._posts.get(ref)

        async def _is_registered_agent(_name: str) -> bool:
            return False

        async def _nothing(*_args: Any, **_kwargs: Any) -> None:
            return None

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
            _record_message_map=_record_message_map,
            _event_for_external_post=_event_for_external_post,
            _handle_text_answer=_nothing,
            _repair_placeholder_username=_nothing,
            _maybe_guide_self_mention=_nothing,
            _trust_client=NullTrustClient(),
            _room_tenant=AsyncMock(return_value="tenant-1"),
        )
        return core

    async def _relay(self, msg: InboundMessage) -> None:
        await CollaborationCore._handle_inbound_message(self.core, msg)

    async def post(self, event: dict[str, object]) -> list[Message]:
        """Hand the adapter `event`, a Slack `message` event, and return the
        room rows it became. An agent's reply to it, such as the notice an
        agent with no live session posts, is not one of them."""
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
        bob = journey.clients["bob"].transport_user_id
        return [
            row
            for row in rows
            if row.transport_event_id not in before and row.sender_id == bob
        ]

    async def deliveries(self, rows: list[Message]) -> list[tuple[str, MessagePayload]]:
        """Every message event any agent was given for `rows`, as (agent name,
        payload), ordered by agent name."""
        world = self.journey.world
        names = {agent.id: name for name, agent in world.agents.items()}
        # A post of several files is one message, keyed on its group.
        keys = {
            group["id"]
            if isinstance(group := row.content.get(ATTACHMENT_GROUP_KEY), dict)
            else row.transport_event_id
            for row in rows
        }
        async with world.session_factory() as session:
            events = (
                await session.scalars(
                    select(AgentEventRow).where(
                        AgentEventRow.message_key.in_(keys),
                        AgentEventRow.type == "message",
                    )
                )
            ).all()
        delivered = []
        for event in events:
            payload = AgentEvent.model_validate(event.payload).payload
            assert isinstance(payload, MessagePayload)
            delivered.append((names[event.agent_id], payload))
        return sorted(delivered, key=lambda delivery: delivery[0])

    async def only(self, rows: list[Message], agent: str) -> MessagePayload:
        """The payload of the one event `rows` gave, asserting it went to
        `agent` and to nobody else."""
        delivered = await self.deliveries(rows)
        assert [name for name, _ in delivered] == [agent]
        return delivered[0][1]

    async def agent_event_count(self) -> int:
        """Every agent event of any type, in any room."""
        async with self.journey.world.session_factory() as session:
            count = await session.scalar(
                select(func.count()).select_from(AgentEventRow)
            )
        assert count is not None
        return count

    async def downloads(self, payload: MessagePayload) -> list[bytes]:
        """The bytes of each of `payload`'s attachments, fetched by its media
        handle."""
        transport = self.journey.process.transport(self.journey.clients["bob"])
        return [
            (await transport.download_media(attachment.mxc)).body
            for attachment in payload.attachments
        ]


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


def _rich(url: str, label: str | None, prefix: str = "") -> list[dict[str, object]]:
    """The rich_text block Slack sends with a post holding a link, after
    `prefix` text when there is one."""
    elements: list[dict[str, object]] = []
    if prefix:
        elements.append({"type": "text", "text": prefix})
    link: dict[str, object] = {"type": "link", "url": url}
    if label:
        link["text"] = label
    elements.append(link)
    return [
        {
            "type": "rich_text",
            "block_id": "b1",
            "elements": [{"type": "rich_text_section", "elements": elements}],
        }
    ]


def _contents(file: dict[str, object]) -> bytes:
    """What the stubbed download returns for `file`."""
    return f"contents of {file['url_private_download']}".encode()


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


class TestPlainText:
    async def test_plain_text(self, slack: SlackRoom) -> None:
        rows = await slack.post(_message("1700000001.000100", "what does this do?"))

        assert len(rows) == 1
        payload = await slack.only(rows, "helper")
        assert payload.body == "what does this do?"


class TestFiles:
    async def test_an_image(self, slack: SlackRoom) -> None:
        image = _file("F1", "shot.png", "image/png")
        rows = await slack.post(_file_share("1700000002.000100", "", image))

        assert [row.msgtype for row in rows] == ["m.image"]
        payload = await slack.only(rows, "helper")
        assert await slack.downloads(payload) == [_contents(image)]

    async def test_a_file_with_text(self, slack: SlackRoom) -> None:
        notes = _file("F2", "notes.md", "text/markdown")
        rows = await slack.post(
            _file_share("1700000003.000100", "notes from the call", notes)
        )

        assert [row.msgtype for row in rows] == ["m.file"]
        payload = await slack.only(rows, "helper")
        assert "notes from the call" in payload.body
        assert await slack.downloads(payload) == [_contents(notes)]

    async def test_several_files(self, slack: SlackRoom) -> None:
        spec = _file("F3", "spec.pdf", "application/pdf")
        shot = _file("F4", "shot.png", "image/png")
        rows = await slack.post(_file_share("1700000004.000100", "", spec, shot))

        assert len(rows) == 2
        payload = await slack.only(rows, "helper")
        assert sorted(await slack.downloads(payload)) == sorted(
            [_contents(spec), _contents(shot)]
        )

    async def test_a_file_in_a_thread_reply(self, slack: SlackRoom) -> None:
        [root] = await slack.post(_message("1700000008.000100", "root question"))
        shot = _file("F5", "shot.png", "image/png")
        rows = await slack.post(
            {
                **_file_share("1700000008.000200", "", shot),
                "thread_ts": "1700000008.000100",
            }
        )

        assert [row.thread_root_event_id for row in rows] == [root.transport_event_id]
        payload = await slack.only(rows, "helper")
        assert payload.thread_id == root.transport_event_id
        assert await slack.downloads(payload) == [_contents(shot)]


class TestLinks:
    """Each post carries the rich_text blocks Slack sends alongside its text."""

    async def test_a_bare_link(self, slack: SlackRoom) -> None:
        rows = await slack.post(
            _message(
                "1700000006.000100",
                f"can you look at <{URL}>",
                blocks=_rich(URL, None, prefix="can you look at "),
            )
        )

        assert len(rows) == 1
        payload = await slack.only(rows, "helper")
        assert payload.body == f"can you look at {URL}"

    async def test_a_bare_link_alone(self, slack: SlackRoom) -> None:
        rows = await slack.post(
            _message("1700000009.000100", f"<{URL}>", blocks=_rich(URL, None))
        )

        assert len(rows) == 1
        payload = await slack.only(rows, "helper")
        assert payload.body == URL

    async def test_a_labelled_link(self, slack: SlackRoom) -> None:
        rows = await slack.post(
            _message(
                "1700000005.000100",
                f"<{URL}|org/repo#1>",
                blocks=_rich(URL, "org/repo#1"),
            )
        )

        assert [row.body for row in rows] == [f"[org/repo#1]({URL})"]
        payload = await slack.only(rows, "helper")
        assert payload.body == f"[org/repo#1]({URL})"


class TestUnfurl:
    async def test_an_unfurled_link(self, slack: SlackRoom) -> None:
        """Slack sends the post, then the same post again as an edit once the
        link is unfurled: the post reaches the agent, the edit adds nothing."""
        post = _message(
            "1700000007.000100", f"<{URL}|org/repo#1>", blocks=_rich(URL, "org/repo#1")
        )
        unfurl = {
            "from_url": URL,
            "title": "Issue 1",
            "title_link": URL,
            "service_name": "GitHub",
        }

        rows = await slack.post(post)
        events_before = await slack.agent_event_count()
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
        assert await slack.agent_event_count() == events_before
        await slack.only(rows, "helper")


class TestMentioningAnotherAgent:
    """A post that tags another agent through its Slack user group is for that
    agent alone, not for the room's assigned one."""

    async def test_text(self, slack: SlackRoom) -> None:
        rows = await slack.post(
            _message("1700000010.000100", f"{MENTION_REVIEWER} please check this")
        )

        assert len(rows) == 1
        await slack.only(rows, "reviewer")

    async def test_a_file(self, slack: SlackRoom) -> None:
        rows = await slack.post(
            _file_share(
                "1700000011.000100",
                f"{MENTION_REVIEWER} see attached",
                _file("F6", "log.txt", "text/plain"),
            )
        )

        assert len(rows) == 1
        await slack.only(rows, "reviewer")

    async def test_a_link(self, slack: SlackRoom) -> None:
        rows = await slack.post(
            _message(
                "1700000012.000100",
                f"{MENTION_REVIEWER} look at <{URL}>",
                blocks=[
                    {
                        "type": "rich_text",
                        "block_id": "b1",
                        "elements": [
                            {
                                "type": "rich_text_section",
                                "elements": [
                                    {
                                        "type": "usergroup",
                                        "usergroup_id": REVIEWER_GROUP,
                                    },
                                    {"type": "text", "text": " look at "},
                                    {"type": "link", "url": URL},
                                ],
                            }
                        ],
                    }
                ],
            )
        )

        assert len(rows) == 1
        await slack.only(rows, "reviewer")
