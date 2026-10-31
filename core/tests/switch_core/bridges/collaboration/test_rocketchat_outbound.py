"""What Switch sends to Rocket.Chat: messages under each agent's name, files,
edits, the working reaction, rooms and the directory."""

from __future__ import annotations

import json
from typing import Any

import pytest

from switch_core.bridges.collaboration.adapter import (
    ActivityMarkRefused,
    AgentPresentation,
    TurnActivity,
)
from switch_core.bridges.collaboration.models import BridgeOperationError
from switch_core.bridges.collaboration.rocketchat.adapter import RocketChatAdapter
from switch_core.bridges.collaboration.rocketchat.markup import (
    from_rocketchat,
    to_rocketchat,
)
from switch_core.bridges.collaboration.rocketchat.rest import RocketChatApiError
from switch_core.sessions.contract import TurnUpsert
from tests.switch_core.bridges.collaboration.rocketchat_fakes import (
    BOT_ID,
    ROOM,
    Call,
    FakeRocketChat,
    refused,
    started_adapter,
)


@pytest.fixture
def fake() -> FakeRocketChat:
    return FakeRocketChat()


@pytest.fixture
async def adapter(
    fake: FakeRocketChat, monkeypatch: pytest.MonkeyPatch
) -> RocketChatAdapter:
    adapter = await started_adapter(fake, monkeypatch)

    async def presentation(name: str) -> AgentPresentation | None:
        if name == "coder":
            return AgentPresentation(
                display_name="Coder [bot]", icon_url="https://icons.example/coder.png"
            )
        return None

    adapter.set_agent_presentation_resolver(presentation)
    return adapter


def _posts(fake: FakeRocketChat) -> list[dict[str, Any]]:
    return [call.body for call in fake.called("chat.postMessage")]


# ── Messages ─────────────────────────────────────────────────────────────────


async def test_an_agent_posts_under_its_own_name_and_icon_in_the_thread(
    adapter: RocketChatAdapter, fake: FakeRocketChat
) -> None:
    ref = await adapter.send_message(ROOM, "coder", "hello", "root")
    assert ref == "posted-1"
    assert _posts(fake) == [
        {
            "roomId": ROOM,
            "text": "hello",
            "alias": "Coder [bot]",
            "avatar": "https://icons.example/coder.png",
            "tmid": "root",
        }
    ]


async def test_a_long_message_is_split_in_order_into_the_same_thread(
    adapter: RocketChatAdapter, fake: FakeRocketChat
) -> None:
    body = "\n".join(f"line {i:04d} " + "x" * 90 for i in range(100))
    ref = await adapter.send_message(ROOM, "coder", body, "root")

    posts = _posts(fake)
    assert ref == "posted-1"
    assert len(posts) == 3
    assert all(len(post["text"]) <= 4000 for post in posts)
    assert all(
        post["tmid"] == "root" and post["alias"] == "Coder [bot]" for post in posts
    )
    assert "\n".join(post["text"] for post in posts) == body


async def test_a_split_never_tears_a_code_block(
    adapter: RocketChatAdapter, fake: FakeRocketChat
) -> None:
    body = "```python\n" + "print('x')\n" * 800 + "```"
    await adapter.send_message(ROOM, "coder", body)
    for post in _posts(fake):
        assert post["text"].count("```") % 2 == 0


async def test_without_the_impersonate_permission_the_name_moves_into_the_text(
    adapter: RocketChatAdapter, fake: FakeRocketChat, caplog: pytest.LogCaptureFixture
) -> None:
    def post(call: Call) -> Any:
        if "alias" in call.body:
            return refused(400, "Not enough permission")
        return {"message": {"_id": "plain-1"}}

    fake.on("chat.postMessage", post)
    ref = await adapter.send_message(ROOM, "coder", "hello", "root")
    await adapter.send_message(ROOM, "coder", "again")

    assert ref == "plain-1"
    plain = [body for body in _posts(fake) if "alias" not in body]
    # Escaped as any label put in a body is, so a name cannot forge markup.
    label = adapter.escape_label_for_body("Coder [bot]")
    assert plain[0] == {"roomId": ROOM, "text": f"**{label}**: hello", "tmid": "root"}
    assert len(plain) == 2
    warnings = [r for r in caplog.records if "message-impersonate" in r.message]
    assert len(warnings) == 1


async def test_once_names_go_in_the_text_redraws_keep_them_there(
    adapter: RocketChatAdapter, fake: FakeRocketChat
) -> None:
    fake.on(
        "chat.postMessage",
        lambda call: (
            refused(400, "Not enough permission")
            if "alias" in call.body
            else {"message": {"_id": "plain"}}
        ),
    )
    fake.on("chat.update", lambda _: {"message": {}})
    await adapter.send_message(ROOM, "coder", "first")
    await adapter.send_message(ROOM, "coder", "second")
    # Learned once: the second message is not offered with an alias again.
    assert len([b for b in _posts(fake) if "alias" in b]) == 1

    turn = TurnUpsert(
        type="turn.upsert", turn_id="turn-1", status="running", command_id=None
    )
    activity = TurnActivity(items=[], turn=turn)
    await adapter.update_rich(ROOM, "coder", "plain", activity, None)
    [update] = fake.called("chat.update")
    label = adapter.escape_label_for_body("Coder [bot]")
    assert update.body["text"].startswith(f"**{label}**: ")


async def test_a_message_refused_for_another_reason_is_reported_not_posted(
    adapter: RocketChatAdapter, fake: FakeRocketChat, caplog: pytest.LogCaptureFixture
) -> None:
    fake.on(
        "chat.postMessage",
        lambda _: refused(400, "[invalid-channel]", "invalid-channel"),
    )
    assert await adapter.send_message("gone", "coder", "hello") is None
    assert "did not accept a message in room gone" in caplog.text
    assert "message-impersonate" not in caplog.text


async def test_a_server_error_is_not_mistaken_for_a_missing_permission(
    adapter: RocketChatAdapter, fake: FakeRocketChat
) -> None:
    fake.on("chat.postMessage", lambda _: refused(500, "Internal error"))
    assert await adapter.send_message(ROOM, "coder", "hello") is None
    assert len(fake.called("chat.postMessage")) == 1


async def test_a_notice_is_the_bot_speaking_rendered_for_rocket_chat(
    adapter: RocketChatAdapter, fake: FakeRocketChat
) -> None:
    await adapter.admin_message(ROOM, "*Note*: @all see `a*b*c`", "root")
    [post] = _posts(fake)
    assert "alias" not in post and "avatar" not in post
    # Italic crosses to underscores, the room-wide mention is defused, code is
    # left as written.
    assert post["text"].startswith("_Note_: @​all")
    assert post["text"].endswith("`a*b*c`")


async def test_an_edit_and_a_delete_address_the_message(
    adapter: RocketChatAdapter, fake: FakeRocketChat
) -> None:
    fake.on("chat.update", lambda _: {"message": {}})
    fake.on("chat.delete", lambda _: {})
    await adapter.update_message(ROOM, "m1", "x" * 5000)
    await adapter.delete_message(ROOM, "m1")

    [update] = fake.called("chat.update")
    assert update.body["msgId"] == "m1" and update.body["roomId"] == ROOM
    assert len(update.body["text"]) == 4000 and update.body["text"].endswith("…")
    assert fake.called("chat.delete")[0].body == {"roomId": ROOM, "msgId": "m1"}


async def test_a_refused_delete_names_the_permission(
    adapter: RocketChatAdapter, fake: FakeRocketChat, caplog: pytest.LogCaptureFixture
) -> None:
    fake.on(
        "chat.delete", lambda _: refused(400, "Not allowed", "error-action-not-allowed")
    )
    await adapter.delete_message(ROOM, "m1")
    assert "delete-own-message" in caplog.text


# ── Files ────────────────────────────────────────────────────────────────────


async def test_a_file_is_uploaded_then_posted_with_the_agent_named(
    adapter: RocketChatAdapter, fake: FakeRocketChat
) -> None:
    fake.on(
        "rooms.media",
        lambda _: {"file": {"_id": "file-1", "url": "/file-upload/file-1/r.pdf"}},
    )
    fake.on("rooms.mediaConfirm", lambda call: {"message": {"_id": "file-msg"}})

    ref = await adapter.send_attachment(
        ROOM, "coder", "r.pdf", "application/pdf", b"%PDF", "the *report*", "root"
    )

    assert ref == "file-msg"
    [upload] = fake.called(f"rooms.media/{ROOM}")
    assert b'filename="r.pdf"' in upload.body and b"%PDF" in upload.body
    [confirm] = fake.called(f"rooms.mediaConfirm/{ROOM}/file-1")
    label = adapter.escape_label_for_body("Coder [bot]")
    assert confirm.body == {"msg": f"**{label}**: the _report_", "tmid": "root"}


async def test_a_file_the_server_refuses_is_replaced_by_a_notice(
    adapter: RocketChatAdapter, fake: FakeRocketChat
) -> None:
    fake.on(
        "rooms.media",
        lambda _: refused(
            400, "File size exceeds the allowed limit", "error-file-too-large"
        ),
    )
    ref = await adapter.send_attachment(
        ROOM, "coder", "big.zip", "application/zip", b"x", "here", "root"
    )
    assert ref == "posted-1"
    [notice] = _posts(fake)
    assert notice["alias"] == "Coder [bot]" and notice["tmid"] == "root"
    assert notice["text"].startswith("here\n_could not share the file big.zip")
    assert "File size exceeds the allowed limit" in notice["text"]


# ── Working indicator ────────────────────────────────────────────────────────


async def test_the_working_and_queued_reactions_are_set_and_cleared(
    adapter: RocketChatAdapter, fake: FakeRocketChat
) -> None:
    fake.on("chat.react", lambda _: {})
    await adapter.mark_activity(ROOM, "m1", agent_name="coder", mark="working", on=True)
    await adapter.mark_activity(ROOM, "m1", agent_name="coder", mark="queued", on=False)
    assert [c.body for c in fake.called("chat.react")] == [
        {"messageId": "m1", "emoji": ":eyes:", "shouldReact": True},
        {"messageId": "m1", "emoji": ":hourglass_flowing_sand:", "shouldReact": False},
    ]


async def test_a_refused_reaction_is_told_apart_from_one_worth_retrying(
    adapter: RocketChatAdapter, fake: FakeRocketChat
) -> None:
    fake.on("chat.react", lambda _: refused(400, "Not allowed", "error-not-allowed"))
    with pytest.raises(ActivityMarkRefused):
        await adapter.mark_activity(
            ROOM, "m1", agent_name="coder", mark="working", on=True
        )

    fake.on("chat.react", lambda _: refused(503, "Service unavailable"))
    with pytest.raises(RocketChatApiError):
        await adapter.mark_activity(
            ROOM, "m1", agent_name="coder", mark="working", on=True
        )


async def test_typing_sends_nothing(
    adapter: RocketChatAdapter, fake: FakeRocketChat
) -> None:
    before = len(fake.calls)
    await adapter.send_typing(ROOM, "coder", True)
    assert len(fake.calls) == before


# ── Answering a card by replying ─────────────────────────────────────────────


def _thread(*replies: tuple[str, str]) -> Any:
    return lambda _: {
        "messages": [{"_id": ref, "ts": ts} for ref, ts in replies],
    }


async def test_the_first_reply_under_a_card_is_recognised(
    adapter: RocketChatAdapter, fake: FakeRocketChat
) -> None:
    fake.on(
        "chat.getThreadMessages",
        _thread(("second", "2026-10-31T18:02:00Z"), ("first", "2026-10-31T18:01:00Z")),
    )
    assert await adapter.is_first_reply(ROOM, "card", "first")
    assert not await adapter.is_first_reply(ROOM, "card", "second")
    assert fake.called("chat.getThreadMessages")[0].params["tmid"] == "card"


async def test_a_thread_that_cannot_be_read_is_never_a_first_reply(
    adapter: RocketChatAdapter, fake: FakeRocketChat
) -> None:
    fake.on("chat.getThreadMessages", lambda _: refused(500, "boom"))
    assert not await adapter.is_first_reply(ROOM, "card", "first")


# ── Rooms ────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("channel_type", "method", "key"),
    [
        ("channel_public", "channels.create", "channel"),
        ("channel_private", "groups.create", "group"),
        ("group", "groups.create", "group"),
    ],
)
async def test_a_room_is_created_with_a_name_rocket_chat_accepts(
    adapter: RocketChatAdapter,
    fake: FakeRocketChat,
    channel_type: Any,
    method: str,
    key: str,
) -> None:
    fake.on(method, lambda _: {key: {"_id": "new-room"}})
    room = await adapter.create_channel(
        "Q3 Planning: Ops/Infra!", "quarterly", channel_type=channel_type
    )
    assert room == "new-room"
    assert fake.called(method)[0].body == {
        "name": "q3-planning-ops-infra",
        "extraData": {"topic": "quarterly"},
    }
    # Known without asking the server again.
    assert await adapter._channel_type("new-room", "") == (
        "channel_public" if key == "channel" else "channel_private"
    )


async def test_a_room_the_server_will_not_create_says_why(
    adapter: RocketChatAdapter, fake: FakeRocketChat
) -> None:
    fake.on(
        "channels.create",
        lambda _: refused(
            400, "A channel with name 'ops' exists", "error-duplicate-channel-name"
        ),
    )
    with pytest.raises(BridgeOperationError, match="A channel with name 'ops' exists"):
        await adapter.create_channel("ops", "")


async def test_a_direct_message_is_opened_with_the_person(
    adapter: RocketChatAdapter, fake: FakeRocketChat
) -> None:
    fake.on(
        "users.info",
        lambda call: {"user": {"_id": call.params["userId"], "username": "ada"}},
    )
    fake.on("im.create", lambda _: {"room": {"_id": "dm-1", "rid": "dm-1", "t": "d"}})
    room = await adapter.create_dm_channel(
        agent_name="coder", user_name="Ada", user_external_id="ada-id"
    )
    assert room == "dm-1"
    assert fake.called("im.create")[0].body == {"username": "ada"}


async def test_people_who_cannot_be_added_are_handed_back(
    adapter: RocketChatAdapter, fake: FakeRocketChat
) -> None:
    fake.on("rooms.info", lambda _: {"room": {"_id": ROOM, "t": "p"}})
    fake.on(
        "groups.invite",
        lambda call: (
            {}
            if call.body["userId"] == "ada-id"
            else refused(400, "Cannot invite", "error-empty-invite-list")
        ),
    )
    left_out = await adapter.add_users_to_channel(
        ROOM, ["ada", "eve"], ["ada-id", "eve-id"]
    )
    assert left_out == ["eve-id"]
    assert [c.body for c in fake.called("groups.invite")] == [
        {"roomId": ROOM, "userId": "ada-id"},
        {"roomId": ROOM, "userId": "eve-id"},
    ]


@pytest.mark.parametrize(
    ("room_type", "method"), [("c", "channels.archive"), ("p", "groups.archive")]
)
async def test_a_deleted_rooms_channel_is_archived(
    adapter: RocketChatAdapter, fake: FakeRocketChat, room_type: str, method: str
) -> None:
    fake.on("rooms.info", lambda _: {"room": {"_id": ROOM, "t": room_type}})
    fake.on(method, lambda _: {})
    outcome = await adapter.retire_channel(ROOM)
    assert outcome.outcome == "archived"
    assert fake.called(method)[0].body == {"roomId": ROOM}


async def test_archiving_refused_is_reported_and_a_dm_is_kept(
    adapter: RocketChatAdapter, fake: FakeRocketChat
) -> None:
    fake.on("rooms.info", lambda _: {"room": {"_id": ROOM, "t": "c"}})
    fake.on(
        "channels.archive",
        lambda _: refused(400, "Not allowed", "error-action-not-allowed"),
    )
    outcome = await adapter.retire_channel(ROOM)
    assert outcome.outcome == "failed" and "Not allowed" in str(outcome.reason)

    fake.on("rooms.info", lambda _: {"room": {"_id": "dm", "t": "d"}})
    assert (await adapter.retire_channel("dm")).outcome == "kept"


async def test_links_open_the_room_on_the_server(
    adapter: RocketChatAdapter, fake: FakeRocketChat
) -> None:
    fake.on(
        "rooms.info", lambda _: {"room": {"_id": ROOM, "t": "p", "name": "design team"}}
    )
    assert (
        await adapter.channel_deeplink(ROOM)
        == "https://chat.example.com/group/design%20team"
    )
    assert await adapter.home_deeplink() == "https://chat.example.com/home"


# ── Directory ────────────────────────────────────────────────────────────────


async def test_the_directory_is_searched_without_the_bot(
    adapter: RocketChatAdapter, fake: FakeRocketChat
) -> None:
    fake.on(
        "users.autocomplete",
        lambda _: {
            "items": [
                {"_id": "zed-id", "username": "zed", "name": "Zed"},
                {"_id": BOT_ID, "username": "switchbot", "name": "Switch Bot"},
                {"_id": "ada-id", "username": "ada", "name": None},
            ]
        },
    )
    found = await adapter.search_directory_users(" a ")
    assert [(u.external_user_id, u.display_name) for u in found] == [
        ("ada-id", "ada"),
        ("zed-id", "Zed"),
    ]
    assert json.loads(fake.called("users.autocomplete")[0].params["selector"]) == {
        "term": "a"
    }
    assert await adapter.search_directory_users("  ") == []


# ── Markup ───────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("switch", "rocket_chat"),
    [
        ("*italic* and **bold**", "_italic_ and **bold**"),
        ("* a bullet\n* another", "* a bullet\n* another"),
        ("2 * 3 * 4", "2 * 3 * 4"),
        ("`*kept*` and ```\n*kept*\n```", "`*kept*` and ```\n*kept*\n```"),
        ("a *b* c *d*", "a _b_ c _d_"),
        ("[see](https://h.example/*a*/b) *x*", "[see](https://h.example/*a*/b) _x_"),
        ("https://h.example/*a* *x*", "https://h.example/*a* _x_"),
    ],
)
def test_switch_markdown_is_rendered_for_rocket_chat(
    switch: str, rocket_chat: str
) -> None:
    assert to_rocketchat(switch) == rocket_chat


@pytest.mark.parametrize(
    ("rocket_chat", "switch"),
    [
        ("*bold* and _italic_", "**bold** and _italic_"),
        ("**bold**", "**bold**"),
        ("`*code*`", "`*code*`"),
    ],
)
def test_rocket_chat_markdown_is_read_into_switch(
    rocket_chat: str, switch: str
) -> None:
    assert from_rocketchat(rocket_chat) == switch
