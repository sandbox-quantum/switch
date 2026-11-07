"""What arrives from Rocket.Chat, and what reaches Switch.

Events are the shapes Rocket.Chat 8.9 sends on `stream-room-messages` and
`stream-notify-user`, handed to the adapter the way its realtime session hands
them over. The REST calls a message leads to go to a fake server.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from switch_core.bridges.collaboration.models import (
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
)
from switch_core.bridges.collaboration.rocketchat import adapter as adapter_module
from switch_core.bridges.collaboration.rocketchat.adapter import RocketChatAdapter
from switch_core.bridges.collaboration.rocketchat.realtime import MY_MESSAGES
from tests.switch_core.bridges.collaboration.rocketchat_fakes import (
    BOT_ID,
    BOT_USERNAME,
    ROOM,
    Call,
    FakeRocketChat,
    refused,
    started_adapter,
)

ADA = {"_id": "ada-id", "username": "ada", "name": "Ada Person"}
IN_ROOM = {"roomParticipant": True, "roomType": "c", "roomName": "general"}


def _message(**fields: Any) -> dict[str, Any]:
    return {
        "_id": "msg-1",
        "rid": ROOM,
        "msg": "hello",
        "ts": {"$date": 1793472333154},
        "u": ADA,
        "_updatedAt": {"$date": 1793472333176},
        "mentions": [],
        **fields,
    }


class Received:
    def __init__(self) -> None:
        self.messages: list[InboundMessage] = []
        self.commands: list[InboundCommand] = []
        self.user_joins: list[InboundUserJoin] = []
        self.app_joins: list[InboundAppJoin] = []
        self.fail_next = False

    async def message(self, message: InboundMessage) -> None:
        if self.fail_next:
            self.fail_next = False
            raise RuntimeError("the room could not be written")
        self.messages.append(message)

    async def command(self, command: InboundCommand) -> None:
        self.commands.append(command)

    async def user_joined(self, join: InboundUserJoin) -> None:
        self.user_joins.append(join)

    async def app_joined(self, join: InboundAppJoin) -> None:
        self.app_joins.append(join)


@pytest.fixture
def fake() -> FakeRocketChat:
    return FakeRocketChat()


@pytest.fixture
async def wired(
    fake: FakeRocketChat, monkeypatch: pytest.MonkeyPatch
) -> tuple[RocketChatAdapter, Received]:
    adapter = await started_adapter(fake, monkeypatch)
    received = Received()
    adapter._on_message = received.message
    adapter._on_command = received.command
    adapter._on_user_joined = received.user_joined
    adapter._on_app_joined = received.app_joined
    return adapter, received


async def _deliver(
    adapter: RocketChatAdapter, message: dict[str, Any], room: dict[str, Any] = IN_ROOM
) -> None:
    await adapter._on_realtime_event(
        "stream-room-messages", MY_MESSAGES, [message, room]
    )


async def test_a_message_reaches_switch_with_its_room_sender_and_id(
    wired: tuple[RocketChatAdapter, Received], fake: FakeRocketChat
) -> None:
    adapter, received = wired
    await _deliver(adapter, _message(msg="hi @switchbot", mentions=[{"_id": BOT_ID}]))

    [message] = received.messages
    assert message.channel_id == ROOM
    assert message.channel_type == "channel_public"
    assert message.channel_name == "general"
    assert message.sender_id == "ada-id"
    assert message.sender_name == "ada"
    assert message.content == "hi @switchbot"
    assert message.message_ref == "msg-1"
    assert message.root_id is None
    assert message.self_mention_token == BOT_USERNAME
    assert not message.sender_is_app
    # The room's checkpoint moves past what was relayed.
    assert [c.body for c in fake.called("subscriptions.read")] == [{"rid": ROOM}]


async def test_a_thread_reply_names_its_root(
    wired: tuple[RocketChatAdapter, Received],
) -> None:
    adapter, received = wired
    await _deliver(adapter, _message(_id="reply", tmid="root"))
    assert received.messages[0].root_id == "root"


@pytest.mark.parametrize(
    ("room_type", "expected"), [("c", "channel_public"), ("p", "channel_private")]
)
async def test_a_room_type_is_read_from_the_event(
    wired: tuple[RocketChatAdapter, Received], room_type: str, expected: str
) -> None:
    adapter, received = wired
    await _deliver(adapter, _message(), {**IN_ROOM, "roomType": room_type})
    assert received.messages[0].channel_type == expected


@pytest.mark.parametrize(("users", "expected"), [(2, "direct"), (3, "group")])
async def test_a_direct_message_is_one_to_one_or_a_group(
    wired: tuple[RocketChatAdapter, Received],
    fake: FakeRocketChat,
    users: int,
    expected: str,
) -> None:
    adapter, received = wired
    fake.on(
        "rooms.info", lambda _: {"room": {"_id": ROOM, "t": "d", "usersCount": users}}
    )
    await _deliver(adapter, _message(), {**IN_ROOM, "roomType": "d"})
    assert received.messages[0].channel_type == expected


async def test_the_bots_own_messages_are_not_relayed_back(
    wired: tuple[RocketChatAdapter, Received],
) -> None:
    adapter, received = wired
    # Every agent posts as the bot, under its own alias.
    bot = {"_id": BOT_ID, "username": BOT_USERNAME}
    await _deliver(adapter, _message(u=bot, alias="coder"))
    assert received.messages == []


async def test_a_public_room_the_bot_has_not_joined_is_ignored(
    wired: tuple[RocketChatAdapter, Received],
) -> None:
    adapter, received = wired
    await _deliver(adapter, _message(), {**IN_ROOM, "roomParticipant": False})
    assert received.messages == []


async def test_a_message_sent_again_is_relayed_once(
    wired: tuple[RocketChatAdapter, Received],
) -> None:
    adapter, received = wired
    # Rocket.Chat re-sends a message whenever it changes: a reaction, a reply
    # counted under it.
    await _deliver(adapter, _message())
    await _deliver(
        adapter, _message(reactions={":eyes:": {"usernames": [BOT_USERNAME]}})
    )
    await _deliver(adapter, _message(tcount=1))
    assert len(received.messages) == 1


@pytest.mark.parametrize(
    "fields",
    [
        {"editedAt": {"$date": 1793472335000}, "msg": "edited"},
        {"t": "rm", "msg": ""},
        {"t": "room_changed_topic"},
        {"t": "ul"},
    ],
)
async def test_edits_removals_and_system_messages_are_not_relayed(
    wired: tuple[RocketChatAdapter, Received], fields: dict[str, Any]
) -> None:
    adapter, received = wired
    await _deliver(adapter, _message(**fields))
    assert received.messages == []
    assert received.user_joins == []


async def test_a_command_is_parsed(wired: tuple[RocketChatAdapter, Received]) -> None:
    adapter, received = wired
    await _deliver(adapter, _message(msg="  !invite-agent @coder  ", tmid="root"))
    [command] = received.commands
    assert (command.command, command.args) == ("invite-agent", "@coder")
    assert command.message_ref == "msg-1"
    assert command.root_id == "root"
    assert received.messages == []


async def test_an_integrations_post_cannot_run_a_command(
    wired: tuple[RocketChatAdapter, Received],
) -> None:
    adapter, received = wired
    # An incoming webhook posts as whichever user it was set up with, so the
    # post is not that person's to answer for.
    await _deliver(adapter, _message(msg="!unlink-account", bot={"i": "integration"}))
    assert received.commands == []


async def test_an_integrations_post_is_relayed_as_an_app(
    wired: tuple[RocketChatAdapter, Received],
) -> None:
    adapter, received = wired
    await _deliver(adapter, _message(msg="build failed", bot={"i": "integration"}))
    assert received.messages[0].sender_is_app


async def test_a_file_is_downloaded_with_the_bots_credentials(
    wired: tuple[RocketChatAdapter, Received], fake: FakeRocketChat
) -> None:
    adapter, received = wired
    fake.files["/file-upload/file1/note one.txt"] = b"file body"
    file = {"_id": "file1", "name": "note one.txt", "type": "text/plain", "size": 9}
    await _deliver(adapter, _message(msg="", files=[file], file=file))

    [message] = received.messages
    [attachment] = message.attachments
    assert (attachment.filename, attachment.mimetype, attachment.data) == (
        "note one.txt",
        "text/plain",
        b"file body",
    )
    [download] = [c for c in fake.calls if c.path.startswith("/file-upload/")]
    assert download.headers["X-Auth-Token"] == "test-placeholder-token"
    assert "rc_token" not in str(download.params)


async def test_an_oversized_file_is_refused_without_being_downloaded(
    wired: tuple[RocketChatAdapter, Received], fake: FakeRocketChat
) -> None:
    adapter, received = wired
    adapter.set_max_attachment_bytes(4)
    file = {"_id": "file1", "name": "big.bin", "size": 5}
    await _deliver(adapter, _message(msg="", files=[file]))

    [message] = received.messages
    assert message.attachments == []
    [failure] = message.attachment_failures
    assert failure.filename == "big.bin"
    assert "exceeds the 4 byte limit" in failure.reason
    assert not any(c.path.startswith("/file-upload/") for c in fake.calls)


async def test_a_file_larger_than_it_said_is_cut_off_at_the_limit(
    wired: tuple[RocketChatAdapter, Received], fake: FakeRocketChat
) -> None:
    adapter, received = wired
    adapter.set_max_attachment_bytes(4)
    fake.files["/file-upload/file1/a.bin"] = b"more than four"
    await _deliver(
        adapter, _message(msg="", files=[{"_id": "file1", "name": "a.bin", "size": 1}])
    )
    assert "over the 4 byte limit" in received.messages[0].attachment_failures[0].reason


async def test_a_file_that_cannot_be_downloaded_is_disclosed(
    wired: tuple[RocketChatAdapter, Received],
) -> None:
    adapter, received = wired
    await _deliver(
        adapter, _message(msg="see", files=[{"_id": "gone", "name": "x.txt"}])
    )
    [message] = received.messages
    assert message.content == "see"
    assert "download failed" in message.attachment_failures[0].reason


async def test_a_person_joining_is_reported(
    wired: tuple[RocketChatAdapter, Received],
) -> None:
    adapter, received = wired
    await _deliver(adapter, _message(_id="sys-1", t="uj", msg="ada"))
    [join] = received.user_joins
    assert (join.channel_id, join.external_user_id, join.external_username) == (
        ROOM,
        "ada-id",
        "ada",
    )


async def test_a_person_added_by_someone_else_is_looked_up(
    wired: tuple[RocketChatAdapter, Received], fake: FakeRocketChat
) -> None:
    adapter, received = wired
    fake.on(
        "users.info",
        lambda call: {"user": {"_id": "bob-id", "username": call.params["username"]}},
    )
    await _deliver(adapter, _message(_id="sys-1", t="au", msg="bob"))
    [join] = received.user_joins
    assert (join.external_user_id, join.external_username) == ("bob-id", "bob")


async def test_the_bot_added_to_a_room_by_a_person_adopts_it(
    wired: tuple[RocketChatAdapter, Received],
) -> None:
    adapter, received = wired
    subscription = {"rid": "room-2", "t": "p", "fname": "Design", "roles": []}
    await adapter._on_realtime_event(
        "stream-notify-user",
        f"{BOT_ID}/subscriptions-changed",
        ["inserted", subscription],
    )
    [join] = received.app_joins
    assert (join.channel_id, join.channel_type, join.channel_name) == (
        "room-2",
        "channel_private",
        "Design",
    )


async def test_a_room_the_bot_created_is_not_adopted_again(
    wired: tuple[RocketChatAdapter, Received],
) -> None:
    adapter, received = wired
    # Switch asked for this room and bound it already; the bot is its owner.
    subscription = {"rid": "room-2", "t": "p", "roles": ["owner"]}
    await adapter._on_realtime_event(
        "stream-notify-user",
        f"{BOT_ID}/subscriptions-changed",
        ["inserted", subscription],
    )
    await adapter._on_realtime_event(
        "stream-notify-user",
        f"{BOT_ID}/subscriptions-changed",
        ["inserted", {"rid": "dm", "t": "d", "roles": []}],
    )
    assert received.app_joins == []


async def test_a_message_switch_could_not_take_is_left_unread(
    wired: tuple[RocketChatAdapter, Received], fake: FakeRocketChat
) -> None:
    adapter, received = wired
    received.fail_next = True
    with pytest.raises(RuntimeError):
        await _deliver(adapter, _message())
    assert fake.called("subscriptions.read") == []
    # Delivered again, it is relayed: it was never recorded as seen.
    await _deliver(adapter, _message())
    assert [m.message_ref for m in received.messages] == ["msg-1"]


# ── Reading back what was missed ─────────────────────────────────────────────


@pytest.fixture
def no_age_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    """Read back from any date, so these tests can name fixed ones."""
    monkeypatch.setattr(adapter_module, "_REPLAY_LIMIT", timedelta(days=365 * 100))


def _subscription(**fields: Any) -> dict[str, Any]:
    return {
        "rid": ROOM,
        "t": "c",
        "fname": "general",
        "ls": "2026-10-31T18:00:00.000Z",
        **fields,
    }


async def test_a_reconnect_relays_what_was_said_since_the_room_was_last_read(
    wired: tuple[RocketChatAdapter, Received],
    fake: FakeRocketChat,
    no_age_limit: None,
) -> None:
    adapter, received = wired
    fake.on("subscriptions.get", lambda _: {"update": [_subscription()]})

    def synced(call: Call) -> dict[str, Any]:
        rest = {"u": ADA, "rid": ROOM}
        return {
            "result": {
                "updated": [
                    # Out of order, as the server may return them.
                    {
                        **rest,
                        "_id": "late",
                        "msg": "second",
                        "ts": "2026-10-31T18:05:00.000Z",
                    },
                    {
                        **rest,
                        "_id": "edited",
                        "msg": "first, edited",
                        "ts": "2026-10-31T18:04:00.000Z",
                        "editedAt": "2026-10-31T18:06:00.000Z",
                    },
                    # Older than the overlap: only its reactions changed.
                    {
                        **rest,
                        "_id": "old",
                        "msg": "old",
                        "ts": "2026-10-31T17:00:00.000Z",
                    },
                    {
                        **rest,
                        "_id": "mine",
                        "u": {"_id": BOT_ID},
                        "ts": "2026-10-31T18:05:00.000Z",
                    },
                ],
                "deleted": [],
            }
        }

    fake.on("chat.syncMessages", synced)
    await adapter._catch_up()

    [sync] = fake.called("chat.syncMessages")
    # Read from a little before the last read, to cover a message that arrived
    # between being relayed and the room being marked read.
    assert sync.params == {"roomId": ROOM, "lastUpdate": "2026-10-31T17:58:00Z"}
    assert [(m.message_ref, m.content) for m in received.messages] == [
        ("edited", "first, edited"),
        ("late", "second"),
    ]
    assert received.messages[0].channel_name == "general"


async def test_a_room_that_cannot_be_read_back_does_not_stop_the_others(
    wired: tuple[RocketChatAdapter, Received],
    fake: FakeRocketChat,
    no_age_limit: None,
) -> None:
    adapter, received = wired
    fake.on(
        "subscriptions.get",
        lambda _: {"update": [_subscription(rid="gone"), _subscription()]},
    )

    def synced(call: Call) -> Any:
        if call.params["roomId"] == "gone":
            return refused(400, "No permission", "error-not-allowed")
        message = {
            "_id": "m",
            "rid": ROOM,
            "u": ADA,
            "msg": "hi",
            "ts": "2026-10-31T18:01:00Z",
        }
        return {"result": {"updated": [message], "deleted": []}}

    fake.on("chat.syncMessages", synced)
    await adapter._catch_up()
    assert [m.message_ref for m in received.messages] == ["m"]


async def test_archived_and_never_read_rooms_are_not_read_back(
    wired: tuple[RocketChatAdapter, Received],
    fake: FakeRocketChat,
    no_age_limit: None,
) -> None:
    adapter, _ = wired
    fake.on(
        "subscriptions.get",
        lambda _: {"update": [_subscription(archived=True), _subscription(ls=None)]},
    )
    await adapter._catch_up()
    assert fake.called("chat.syncMessages") == []


async def test_a_room_last_read_long_ago_is_read_back_one_day_at_most(
    wired: tuple[RocketChatAdapter, Received],
    fake: FakeRocketChat,
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, _ = wired
    # A bot that sat in a room for weeks before the bridge was connected.
    fake.on(
        "subscriptions.get",
        lambda _: {"update": [_subscription(ls="2026-01-01T00:00:00Z", unread=40)]},
    )
    fake.on("chat.syncMessages", lambda _: {"result": {"updated": [], "deleted": []}})
    before = datetime.now(UTC)
    await adapter._catch_up()

    [sync] = fake.called("chat.syncMessages")
    since = datetime.fromisoformat(sync.params["lastUpdate"].replace("Z", "+00:00"))
    assert (
        before - timedelta(days=1, seconds=5)
        <= since
        <= datetime.now(UTC) - timedelta(days=1)
    )
    assert "anything older is not relayed" in caplog.text


async def test_a_quiet_room_last_read_long_ago_is_not_reported(
    wired: tuple[RocketChatAdapter, Received],
    fake: FakeRocketChat,
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, _ = wired
    fake.on(
        "subscriptions.get",
        lambda _: {"update": [_subscription(ls="2026-01-01T00:00:00Z", unread=0)]},
    )
    fake.on("chat.syncMessages", lambda _: {"result": {"updated": [], "deleted": []}})
    await adapter._catch_up()
    assert "not relayed" not in caplog.text


@pytest.mark.parametrize(
    "file",
    [
        # A name that climbs out of the download path to another API route.
        {"_id": "file1", "name": "../../../api/v1/users.list"},
        {"_id": "../../api/v1/users.list", "name": "x"},
    ],
)
async def test_a_crafted_file_cannot_point_the_download_elsewhere(
    wired: tuple[RocketChatAdapter, Received],
    fake: FakeRocketChat,
    file: dict[str, Any],
) -> None:
    adapter, received = wired
    fake.files["/file-upload/file1/../../../api/v1/users.list"] = b"stored file"
    await _deliver(adapter, _message(msg="", files=[file]))

    assert fake.called("users.list") == []
    downloads = [c for c in fake.calls if c.path.startswith("/file-upload/")]
    # The name stays one segment of the path, as sent.
    assert all(c.raw_path.count("/") == 3 for c in downloads), downloads
    [message] = received.messages
    assert message.attachments == [] or message.attachments[0].data == b"stored file"


async def test_a_failed_message_keeps_its_room_unread_until_read_back(
    wired: tuple[RocketChatAdapter, Received], fake: FakeRocketChat
) -> None:
    adapter, received = wired
    received.fail_next = True
    with pytest.raises(RuntimeError):
        await _deliver(adapter, _message(_id="lost"))
    # A later message reaches Switch, but marking the room read for it would
    # move the checkpoint past the one that did not.
    await _deliver(adapter, _message(_id="later"))
    assert [m.message_ref for m in received.messages] == ["later"]
    assert fake.called("subscriptions.read") == []

    fake.on(
        "subscriptions.get", lambda _: {"update": [_subscription(ls=_ago(minutes=5))]}
    )
    lost = {**_message(_id="lost"), "ts": _ago(minutes=1)}
    fake.on(
        "chat.syncMessages", lambda _: {"result": {"updated": [lost], "deleted": []}}
    )
    await adapter._catch_up()
    assert [m.message_ref for m in received.messages] == ["later", "lost"]
    assert [c.body for c in fake.called("subscriptions.read")] == [{"rid": ROOM}]
    # Read back, the room is marked read as messages arrive again.
    await _deliver(adapter, _message(_id="next"))
    assert len(fake.called("subscriptions.read")) == 2


async def test_reading_back_stops_a_room_at_its_first_failure(
    wired: tuple[RocketChatAdapter, Received], fake: FakeRocketChat
) -> None:
    adapter, received = wired
    fake.on(
        "subscriptions.get",
        lambda _: {
            "update": [
                _subscription(ls=_ago(minutes=5)),
                _subscription(rid="room-2", ls=_ago(minutes=5)),
            ]
        },
    )

    def synced(call: Call) -> dict[str, Any]:
        room = call.params["roomId"]
        return {
            "result": {
                "updated": [
                    {**_message(_id=f"{room}-{n}", rid=room), "ts": _ago(minutes=4 - n)}
                    for n in range(3)
                ],
                "deleted": [],
            }
        }

    fake.on("chat.syncMessages", synced)
    failing = received.message

    async def fail_second(message: InboundMessage) -> None:
        if message.message_ref == f"{ROOM}-1":
            raise RuntimeError("the room could not be written")
        await failing(message)

    adapter._on_message = fail_second
    await adapter._catch_up()

    # The first room stops where it failed and is not marked read; the next
    # room is read back all the same.
    assert [m.message_ref for m in received.messages] == [
        f"{ROOM}-0",
        "room-2-0",
        "room-2-1",
        "room-2-2",
    ]
    assert [c.body for c in fake.called("subscriptions.read")] == [{"rid": "room-2"}]


def _ago(**delta: float) -> str:
    return (datetime.now(UTC) - timedelta(**delta)).isoformat().replace("+00:00", "Z")
