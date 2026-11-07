"""The Webex adapter against a recorded-shape Webex API.

Webex is stood in for by an `httpx.MockTransport` that answers the handful of
REST calls the adapter makes, the way Webex answers them, and records what it
was sent. The event socket is not involved here: activities are handed to the
adapter as the socket hands them over (`test_webex_socket.py` covers the
socket itself).
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.adapter import (
    PrivateNoticeRefused,
    RequestCard,
    RichContentFailed,
    RichContentThrottled,
    TurnActivity,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    InboundCommand,
    InboundInteraction,
    InboundMessage,
)
from switch_core.bridges.collaboration.session.renderers import (
    RequestReference,
    position_action,
)
from switch_core.bridges.collaboration.webex.adapter import (
    WebexAdapter,
    WebexConnectionConfig,
)
from switch_core.bridges.collaboration.webex.cards import CARD_CONTENT_TYPE
from switch_core.bridges.collaboration.webex.client import (
    ServiceCatalog,
    WebexApiError,
    WebexId,
)
from switch_core.bridges.collaboration.webex.text import MAX_MESSAGE_BYTES

from .session_fixtures import (
    EXAMPLES_PATH,
    _item,
    _turn,
    open_request,
    requests_through,
)

BOT_UUID = "b0b0b0b0-0000-4000-8000-000000000001"
ADA_UUID = "ada0ada0-0000-4000-8000-000000000002"
ROOM_UUID = "f00df00d-0000-4000-8000-000000000003"
DM_UUID = "d1d1d1d1-0000-4000-8000-000000000004"


def wid(kind: str, uuid: str) -> str:
    return WebexId("us", kind, uuid).encode()


BOT = wid("PEOPLE", BOT_UUID)
ADA = wid("PEOPLE", ADA_UUID)
ROOM = wid("ROOM", ROOM_UUID)
DM = wid("ROOM", DM_UUID)


def _json_response(
    status: int, body: object | None = None, **headers: str
) -> httpx.Response:
    return httpx.Response(
        status, json=body if body is not None else {}, headers=headers
    )


class FakeWebex:
    """Enough of webexapis.com for the adapter, and a record of what it sent."""

    def __init__(self) -> None:
        self.people: dict[str, dict[str, Any]] = {
            BOT: {
                "id": BOT,
                "type": "bot",
                "displayName": "Switch",
                "emails": ["switch@webex.bot"],
            },
            ADA: {
                "id": ADA,
                "type": "person",
                "displayName": "Ada L",
                "emails": ["ada@example.com"],
            },
        }
        self.rooms: dict[str, dict[str, Any]] = {
            ROOM: {"id": ROOM, "title": "Payments", "type": "group"},
            DM: {"id": DM, "title": "Ada L", "type": "direct"},
        }
        self.messages: dict[str, dict[str, Any]] = {}
        self.actions: dict[str, dict[str, Any]] = {}
        self.memberships: list[dict[str, Any]] = [
            {"id": "m-bot", "roomId": ROOM, "personId": BOT}
        ]
        self.sent: list[tuple[str, str, Any]] = []
        # (method, path prefix) -> responses to give, once each, before answering normally.
        self.refusals: dict[tuple[str, str], list[httpx.Response]] = {}
        self._next = 0

    def refuse(self, method: str, path: str, *responses: httpx.Response) -> None:
        self.refusals.setdefault((method, path), []).extend(responses)

    def posts(self) -> list[dict[str, Any]]:
        return [
            body
            for method, path, body in self.sent
            if method == "POST" and path == "/messages"
        ]

    def edits(self) -> list[tuple[str, dict[str, Any]]]:
        return [
            (path.split("/", 2)[2], body)
            for method, path, body in self.sent
            if method == "PUT" and path.startswith("/messages/")
        ]

    def add_message(self, uuid: str, **fields: Any) -> str:
        message_id = wid("MESSAGE", uuid)
        self.messages[message_id] = {
            "id": message_id,
            "roomId": ROOM,
            "roomType": "group",
            "personId": ADA,
            "personEmail": "ada@example.com",
            "created": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            **fields,
        }
        return message_id

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer bot-token"
        path = request.url.path.removeprefix("/v1")
        method = request.method
        body: Any = None
        if request.content and request.headers.get("content-type", "").startswith(
            "application/json"
        ):
            body = json.loads(request.content)
        elif request.content:
            body = request.content
        self.sent.append((method, path, body))
        for (refused_method, prefix), queue in self.refusals.items():
            if refused_method == method and path.startswith(prefix) and queue:
                return queue.pop(0)
        return self._answer(method, path, request, body)

    def _id(self, kind: str) -> str:
        self._next += 1
        return wid(kind, f"00000000-0000-4000-8000-{self._next:012d}")

    def _answer(
        self, method: str, path: str, request: httpx.Request, body: Any
    ) -> httpx.Response:
        params = request.url.params
        if path == "/people/me":
            return _json_response(200, self.people[BOT])
        if path.startswith("/people/"):
            person = self.people.get(path.split("/", 2)[2])
            return (
                _json_response(200, person)
                if person
                else _json_response(404, {"message": "not found"})
            )
        if path == "/people":
            email = params.get("email")
            items = (
                [p for p in self.people.values() if email in p.get("emails", [])]
                if email
                else []
            )
            return _json_response(200, {"items": items})
        if path.startswith("/rooms/"):
            room = self.rooms.get(path.split("/", 2)[2])
            return (
                _json_response(200, room)
                if room
                else _json_response(404, {"message": "not found"})
            )
        if path == "/rooms" and method == "GET":
            return _json_response(200, {"items": list(self.rooms.values())})
        if path == "/rooms" and method == "POST":
            room = {"id": self._id("ROOM"), "title": body["title"], "type": "group"}
            self.rooms[room["id"]] = room
            return _json_response(200, room)
        if path == "/messages" and method == "GET":
            room_id = params.get("roomId")
            items = [m for m in self.messages.values() if m["roomId"] == room_id]
            return _json_response(200, {"items": list(reversed(items))})
        if path == "/messages" and method == "POST":
            sent = {"id": self._id("MESSAGE"), "personId": BOT}
            if isinstance(body, dict):
                sent.update(body)
                sent.setdefault("roomId", DM if body.get("toPersonId") else ROOM)
            return _json_response(200, sent)
        if path.startswith("/messages/") and method == "GET":
            message = self.messages.get(path.split("/", 2)[2])
            return (
                _json_response(200, message)
                if message
                else _json_response(404, {"message": "not found"})
            )
        if path.startswith("/messages/") and method == "PUT":
            return _json_response(200, {"id": path.split("/", 2)[2], **body})
        if path.startswith("/messages/") and method == "DELETE":
            return httpx.Response(204)
        if path.startswith("/attachment/actions/"):
            return _json_response(200, self.actions[path.split("/", 3)[3]])
        if path == "/memberships" and method == "GET":
            person = params.get("personId")
            items = [
                m
                for m in self.memberships
                if m["roomId"] == params.get("roomId")
                and (person is None or m["personId"] == person)
            ]
            return _json_response(200, {"items": items})
        if path == "/memberships" and method == "POST":
            return _json_response(200, {"id": self._id("MEMBERSHIP"), **body})
        if path.startswith("/memberships/") and method == "DELETE":
            return httpx.Response(204)
        return _json_response(404, {"message": f"no fake for {method} {path}"})


class Inbox:
    def __init__(self) -> None:
        self.messages: list[InboundMessage] = []
        self.commands: list[InboundCommand] = []
        self.presses: list[InboundInteraction] = []
        self.joins: list[Any] = []

    async def message(self, event: InboundMessage) -> None:
        self.messages.append(event)

    async def command(self, event: InboundCommand) -> None:
        self.commands.append(event)

    async def press(self, event: InboundInteraction) -> None:
        self.presses.append(event)

    async def join(self, event: Any) -> None:
        self.joins.append(event)


@pytest.fixture
def webex() -> FakeWebex:
    return FakeWebex()


def _adapter(webex: FakeWebex) -> WebexAdapter:
    return WebexAdapter(
        config=WebexConnectionConfig(bot_token="bot-token"),
        http=httpx.AsyncClient(transport=httpx.MockTransport(webex)),
    )


async def _started(
    webex: FakeWebex, *, presses: bool = True
) -> tuple[WebexAdapter, Inbox]:
    adapter = _adapter(webex)
    inbox = Inbox()
    if presses:
        adapter.set_interaction_handler(inbox.press)
    adapter.set_listening(False)  # no socket here; activities are handed in
    await adapter.start(
        inbox.message, inbox.command, inbox.join, inbox.join, inbox.join
    )
    return adapter, inbox


def _post(uuid: str) -> dict[str, Any]:
    """A message activity as the event socket delivers it: bare uuids only."""
    return {
        "id": uuid,
        "verb": "post",
        "actor": {"id": ADA_UUID},
        "target": {"id": ROOM_UUID},
    }


# ── Connecting ───────────────────────────────────────────────────────────────


def test_the_token_is_taken_as_pasted_and_refused_when_it_cannot_be_one() -> None:
    assert WebexConnectionConfig(bot_token="  Bearer abc.def ").bot_token == "abc.def"
    with pytest.raises(ValidationError):
        WebexConnectionConfig(bot_token="   ")
    with pytest.raises(ValidationError):
        WebexConnectionConfig(bot_token="two words")


async def test_a_rejected_token_says_so(webex: FakeWebex) -> None:
    webex.refuse("GET", "/people/me", _json_response(401, {"message": "invalid token"}))
    adapter = _adapter(webex)
    with pytest.raises(BridgeCredentialError, match="did not accept"):
        await adapter._identify(adapter._client)


async def test_a_personal_token_is_refused_before_it_posts_as_somebody(
    webex: FakeWebex,
) -> None:
    webex.people[BOT]["type"] = "person"
    adapter = _adapter(webex)
    with pytest.raises(BridgeCredentialError, match="belongs to a person"):
        await adapter._identify(adapter._client)


def test_failures_are_classified_for_the_bridge_status() -> None:
    assert (
        WebexAdapter.classify_failure(WebexApiError("x", status=401)) == "auth_failed"
    )
    assert (
        WebexAdapter.classify_failure(WebexApiError("x", status=0)) == "config_invalid"
    )
    assert (
        WebexAdapter.classify_failure(WebexApiError("x", status=503))
        == "platform_error"
    )
    assert WebexAdapter.classify_failure(ValueError()) is None


# ── Hearing Webex ────────────────────────────────────────────────────────────


async def test_a_mention_in_a_space_reaches_the_rooms_agent(webex: FakeWebex) -> None:
    adapter, inbox = await _started(webex)
    webex.add_message(
        "aaaa0000-0000-4000-8000-000000000010",
        html=f'<p><spark-mention data-object-type="person" data-object-id="{BOT}">Switch</spark-mention> fix the build</p>',
        text="Switch fix the build",
    )
    await adapter._on_activity(_post("aaaa0000-0000-4000-8000-000000000010"))

    [message] = inbox.messages
    assert message.channel_id == ROOM
    assert message.channel_type == "channel_private"
    assert message.channel_name == "Payments"
    assert message.sender_id == ADA
    assert message.sender_name == "ada"
    assert message.content == "fix the build"
    assert message.self_mention_token == "switch"


async def test_naming_an_agent_routes_to_it_rather_than_to_the_room(
    webex: FakeWebex,
) -> None:
    adapter, inbox = await _started(webex)
    webex.add_message(
        "aaaa0000-0000-4000-8000-000000000011",
        html=f'<p><spark-mention data-object-type="person" data-object-id="{BOT}">Switch</spark-mention> @coder look</p>',
    )
    await adapter._on_activity(_post("aaaa0000-0000-4000-8000-000000000011"))
    assert inbox.messages[0].content == "@coder look"
    assert inbox.messages[0].self_mention_token is None


async def test_a_direct_message_needs_no_mention(webex: FakeWebex) -> None:
    adapter, inbox = await _started(webex)
    webex.add_message(
        "aaaa0000-0000-4000-8000-000000000012",
        roomId=DM,
        roomType="direct",
        text="hello",
    )
    await adapter._on_activity(_post("aaaa0000-0000-4000-8000-000000000012"))
    assert inbox.messages[0].channel_type == "direct"
    assert inbox.messages[0].self_mention_token == "switch"


async def test_what_the_bot_may_not_read_is_skipped_quietly(webex: FakeWebex) -> None:
    adapter, inbox = await _started(webex)
    # The socket announces every message in a space; a bot may read only the
    # ones that mention it, and Webex answers 404 for the rest.
    await adapter._on_activity(_post("aaaa0000-0000-4000-8000-0000000000ff"))
    assert inbox.messages == []


async def test_the_bots_own_messages_are_not_heard_back(webex: FakeWebex) -> None:
    adapter, inbox = await _started(webex)
    activity = _post("aaaa0000-0000-4000-8000-000000000013")
    activity["actor"] = {"id": BOT_UUID}
    await adapter._on_activity(activity)
    assert inbox.messages == []
    assert not any(path.startswith("/messages/") for _, path, _ in webex.sent)


async def test_a_message_delivered_twice_is_handed_on_once(webex: FakeWebex) -> None:
    adapter, inbox = await _started(webex)
    webex.add_message(
        "aaaa0000-0000-4000-8000-000000000014",
        roomId=DM,
        roomType="direct",
        text="once",
    )
    await adapter._on_activity(_post("aaaa0000-0000-4000-8000-000000000014"))
    await adapter._on_activity(_post("aaaa0000-0000-4000-8000-000000000014"))
    assert len(inbox.messages) == 1


async def test_a_command_is_a_command_and_a_path_is_not(webex: FakeWebex) -> None:
    adapter, inbox = await _started(webex)
    webex.add_message(
        "aaaa0000-0000-4000-8000-000000000015",
        roomId=DM,
        roomType="direct",
        text="!help me",
    )
    webex.add_message(
        "aaaa0000-0000-4000-8000-000000000016",
        roomId=DM,
        roomType="direct",
        text="/tmp/build failed",
    )
    await adapter._on_activity(_post("aaaa0000-0000-4000-8000-000000000015"))
    await adapter._on_activity(_post("aaaa0000-0000-4000-8000-000000000016"))
    [command] = inbox.commands
    assert (command.command, command.args) == ("help", "me")
    assert [m.content for m in inbox.messages] == ["/tmp/build failed"]


async def test_a_press_on_a_card_is_an_answer_by_position(webex: FakeWebex) -> None:
    adapter, inbox = await _started(webex)
    action_uuid = "acac0000-0000-4000-8000-000000000020"
    webex.actions[wid("ATTACHMENT_ACTION", action_uuid)] = {
        "id": wid("ATTACHMENT_ACTION", action_uuid),
        "type": "submit",
        "messageId": "card-message",
        "personId": ADA,
        "roomId": ROOM,
        "inputs": {"switch": "answer", "token": "tok-1", "position": "2"},
    }
    await adapter._on_activity(
        {"id": action_uuid, "verb": "cardAction", "actor": {"id": ADA_UUID}}
    )
    [press] = inbox.presses
    assert press.action_id == position_action(2)
    assert press.value == "tok-1"
    assert press.message_ref == "card-message"
    assert press.sender_id == ADA


async def test_a_press_on_somebody_elses_card_is_ignored(webex: FakeWebex) -> None:
    adapter, inbox = await _started(webex)
    action_uuid = "acac0000-0000-4000-8000-000000000021"
    webex.actions[wid("ATTACHMENT_ACTION", action_uuid)] = {
        "personId": ADA,
        "roomId": ROOM,
        "inputs": {"vote": "yes"},
    }
    await adapter._on_activity(
        {"id": action_uuid, "verb": "cardAction", "actor": {"id": ADA_UUID}}
    )
    assert inbox.presses == []


async def test_messages_missed_while_the_socket_was_down_are_read_back_once(
    webex: FakeWebex,
) -> None:
    adapter, inbox = await _started(webex)
    long_ago = (datetime.now(UTC) - timedelta(hours=2)).isoformat()
    webex.rooms[ROOM]["lastActivity"] = datetime.now(UTC).isoformat()
    webex.rooms[DM]["lastActivity"] = long_ago
    seen = webex.add_message("aaaa0000-0000-4000-8000-000000000030", text="seen live")
    webex.add_message("aaaa0000-0000-4000-8000-000000000031", text="missed one")
    webex.add_message("aaaa0000-0000-4000-8000-000000000032", text="missed two")
    webex.messages[seen]["created"] = long_ago

    await adapter._on_socket_open(datetime.now(UTC) - timedelta(minutes=1))
    assert [m.content for m in inbox.messages] == ["missed one", "missed two"]
    # A group space is listed only as far as it mentions the bot.
    listing = [
        path
        for method, path, _ in webex.sent
        if method == "GET" and path == "/messages"
    ]
    assert listing == ["/messages"]

    await adapter._on_socket_open(datetime.now(UTC) - timedelta(minutes=1))
    assert len(inbox.messages) == 2


async def test_after_a_restart_only_known_spaces_are_read_back(
    webex: FakeWebex,
) -> None:
    adapter, inbox = await _started(webex)
    webex.rooms[ROOM]["lastActivity"] = datetime.now(UTC).isoformat()
    webex.add_message("aaaa0000-0000-4000-8000-000000000033", text="while restarting")

    await adapter._on_socket_open(None)  # no space known yet: nothing to read
    assert inbox.messages == []

    await adapter.ensure_channel_subscriptions([(ROOM, "payments")])
    await adapter._on_socket_open(None)
    assert [m.content for m in inbox.messages] == ["while restarting"]


# ── Speaking on Webex ────────────────────────────────────────────────────────


async def test_an_agent_message_carries_its_name_and_its_thread(
    webex: FakeWebex,
) -> None:
    adapter, _ = await _started(webex)
    ref = await adapter.send_message(ROOM, "coder", "done", thread_root_id="root-1")
    [post] = webex.posts()
    assert post == {"roomId": ROOM, "markdown": "**coder**\ndone", "parentId": "root-1"}
    assert ref is not None


async def test_a_reply_to_a_reply_goes_under_its_root(webex: FakeWebex) -> None:
    adapter, _ = await _started(webex)
    reply = webex.add_message(
        "aaaa0000-0000-4000-8000-000000000040", parentId="the-root", text="r"
    )
    webex.refuse(
        "POST", "/messages", _json_response(400, {"message": "parent is a reply"})
    )
    await adapter.send_message(ROOM, "coder", "answer", thread_root_id=reply)
    assert webex.posts()[-1]["parentId"] == "the-root"


async def test_a_long_reply_is_split_within_webexs_limit(webex: FakeWebex) -> None:
    adapter, _ = await _started(webex)
    await adapter.send_message(ROOM, "coder", "\n\n".join(["word " * 400] * 8))
    posts = webex.posts()
    assert len(posts) > 1
    assert all(len(p["markdown"].encode()) <= MAX_MESSAGE_BYTES for p in posts)


async def test_an_agent_mentions_people_switch_knows_and_nobody_else(
    webex: FakeWebex,
) -> None:
    adapter, _ = await _started(webex)
    adapter.prime_mention_targets({"ada": ADA})
    # Core translates a body before handing it to `send_message`, as here.
    body = adapter.translate_outbound(
        "@ada review please <@personEmail:boss@corp.com> <@all>"
    )
    await adapter.send_message(ROOM, "coder", body)
    body = webex.posts()[0]["markdown"]
    assert f"<@personId:{ADA}|ada>" in body
    assert "<@personEmail" not in body
    assert "<@all>" not in body


async def test_a_refused_message_is_reported_as_not_sent(webex: FakeWebex) -> None:
    adapter, _ = await _started(webex)
    webex.refuse("POST", "/messages", _json_response(403, {"message": "not a member"}))
    assert await adapter.send_message(ROOM, "coder", "hi") is None


async def test_edits_stop_at_webexs_ten(webex: FakeWebex) -> None:
    adapter, _ = await _started(webex)
    for n in range(12):
        await adapter.update_message(ROOM, "msg-1", f"version {n}")
    assert len(webex.edits()) == 10


async def test_deleting_what_is_already_gone_is_fine(webex: FakeWebex) -> None:
    adapter, _ = await _started(webex)
    webex.refuse("DELETE", "/messages/", _json_response(404, {"message": "gone"}))
    await adapter.delete_message(ROOM, "msg-1")


# ── Turns and requests ───────────────────────────────────────────────────────


def _card(**kwargs: Any) -> RequestCard:
    return RequestCard(
        open_request(), RequestReference(token="tok-1", handle="R7"), **kwargs
    )


async def test_a_request_is_a_card_with_a_button_per_option(webex: FakeWebex) -> None:
    adapter, _ = await _started(webex)
    ref = await adapter.post_rich(ROOM, "coder", _card(notify_external_id=ADA))
    card_post, ping = webex.posts()
    assert card_post["roomId"] == ROOM
    [attachment] = card_post["attachments"]
    assert attachment["contentType"] == CARD_CONTENT_TYPE
    actions = attachment["content"]["actions"]
    assert actions
    assert all(a["data"]["token"] == "tok-1" for a in actions)
    assert [a["data"]["position"] for a in actions] == [
        str(n) for n in range(1, len(actions) + 1)
    ]
    # Webex refuses a mention beside a card, so the person is pinged on their own.
    assert "<@personId:" not in card_post["markdown"]
    assert ping["markdown"].startswith(f"<@personId:{ADA}>")
    assert ref


async def test_a_card_where_a_press_cannot_land_has_no_buttons(
    webex: FakeWebex,
) -> None:
    adapter, _ = await _started(webex, presses=False)
    await adapter.post_rich(ROOM, "coder", _card())
    content = webex.posts()[0]["attachments"][0]["content"]
    assert "actions" not in content


async def test_a_turn_status_is_markdown_that_mentions_who_it_is_for(
    webex: FakeWebex,
) -> None:
    adapter, _ = await _started(webex)
    await adapter.post_rich(
        ROOM, "coder", TurnActivity([_item()], _turn("running"), notify_external_id=ADA)
    )
    [post] = webex.posts()
    assert "attachments" not in post
    assert post["markdown"].startswith("**coder**\n")
    assert f"<@personId:{ADA}>" in post["markdown"]


async def test_redrawing_what_is_already_there_spends_no_edit(webex: FakeWebex) -> None:
    adapter, _ = await _started(webex)
    turn = TurnActivity([_item()], _turn("running"))
    ref = await adapter.post_rich(ROOM, "coder", turn)
    await adapter.update_rich(ROOM, "coder", ref, turn, None)
    assert webex.edits() == []


async def test_a_running_turn_keeps_its_last_edits_for_how_it_ends(
    webex: FakeWebex,
) -> None:
    adapter, _ = await _started(webex)
    ref = await adapter.post_rich(
        ROOM, "coder", TurnActivity([_item()], _turn("running"))
    )
    for n in range(12):
        await adapter.update_rich(
            ROOM,
            "coder",
            ref,
            TurnActivity([_item()], _turn("running"), elapsed_seconds=n * 61),
            None,
        )
    assert len(webex.edits()) == 8
    await adapter.update_rich(
        ROOM, "coder", ref, TurnActivity([_item()], _turn("completed")), None
    )
    assert len(webex.edits()) == 9


async def test_a_throttled_post_is_handed_back_to_be_retried(webex: FakeWebex) -> None:
    adapter, _ = await _started(webex)
    webex.refuse(
        "POST",
        "/messages",
        _json_response(429, {"message": "slow down"}, **{"retry-after": "30"}),
    )
    with pytest.raises(RichContentThrottled) as caught:
        await adapter.post_rich(ROOM, "coder", _card())
    assert caught.value.retry_after == 30.0


async def test_a_refused_post_is_a_rich_content_failure(webex: FakeWebex) -> None:
    adapter, _ = await _started(webex)
    webex.refuse("POST", "/messages", _json_response(400, {"message": "bad card"}))
    with pytest.raises(RichContentFailed):
        await adapter.post_rich(ROOM, "coder", _card())


async def test_a_post_webex_may_have_taken_is_not_called_a_refusal(
    webex: FakeWebex,
) -> None:
    adapter, _ = await _started(webex)
    webex.refuse("POST", "/messages", _json_response(502, {"message": "bad gateway"}))
    with pytest.raises(WebexApiError):
        await adapter.post_rich(ROOM, "coder", _card())


def _answered(**kwargs: Any) -> RequestCard:
    """The recorded demo request, answered from Webex."""
    request = requests_through(EXAMPLES_PATH, "answerLifecycle", 13)["request-demo"]
    assert request.decided_by is not None
    request = request.model_copy(
        update={
            "decided_by": request.decided_by.model_copy(update={"surface": "webex"})
        }
    )
    return RequestCard(request, RequestReference(token="tok-1", handle="R7"), **kwargs)


def _refuse_card_edits(webex: FakeWebex) -> None:
    # What an organisation that won't edit a message carrying a card answers.
    webex.refuse(
        "PUT",
        "/messages/",
        _json_response(
            400,
            {
                "message": "Support for editing messages with files via "
                "Developer APIs currently disabled"
            },
        ),
    )


async def test_an_answered_card_is_redrawn_in_place_where_webex_allows(
    webex: FakeWebex,
) -> None:
    adapter, _ = await _started(webex)
    ref = await adapter.post_rich(ROOM, "coder", _card())
    await adapter.update_rich(ROOM, "coder", ref, _answered(), None)
    [(edited, body)] = webex.edits()
    assert edited == ref
    assert "actions" not in body["attachments"][0]["content"]
    assert len(webex.posts()) == 1


async def test_a_card_webex_wont_edit_is_posted_again_and_the_old_one_deleted(
    webex: FakeWebex,
) -> None:
    # Found live: some organisations refuse any edit to a message that carries
    # a card. The card is posted again in its thread, without buttons, and the
    # one it replaces is deleted.
    adapter, _ = await _started(webex)
    root = wid("MESSAGE", ADA_UUID)
    ref = await adapter.post_rich(ROOM, "coder", _card(), root)
    _refuse_card_edits(webex)
    await adapter.update_rich(ROOM, "coder", ref, _answered(), root)
    _, again = webex.posts()
    assert again["parentId"] == root
    assert "actions" not in again["attachments"][0]["content"]
    assert ("DELETE", f"/messages/{ref}", None) in webex.sent


async def test_once_webex_has_refused_a_card_edit_cards_are_not_edited(
    webex: FakeWebex,
) -> None:
    adapter, _ = await _started(webex)
    first = await adapter.post_rich(ROOM, "coder", _card())
    second = await adapter.post_rich(ROOM, "coder", _card())
    _refuse_card_edits(webex)
    await adapter.update_rich(ROOM, "coder", first, _answered(), None)
    await adapter.update_rich(ROOM, "coder", second, _answered(), None)
    assert len(webex.edits()) == 1
    assert len(webex.posts()) == 4


async def test_a_card_posted_again_is_the_one_redrawn_after(webex: FakeWebex) -> None:
    adapter, _ = await _started(webex)
    ref = await adapter.post_rich(ROOM, "coder", _card())
    _refuse_card_edits(webex)
    await adapter.update_rich(ROOM, "coder", ref, _answered(), None)
    await adapter.update_rich(ROOM, "coder", ref, _answered(), None)
    assert len(webex.posts()) == 2
    await adapter.update_rich(
        ROOM, "coder", ref, _answered(responder_external_id=ADA), None
    )
    # The second redraw deletes the copy the first one posted, not the original.
    deleted = [path for method, path, _ in webex.sent if method == "DELETE"]
    assert len(deleted) == 2
    assert deleted[0] == f"/messages/{ref}"
    assert deleted[1] != deleted[0]


async def test_a_card_out_of_edits_is_posted_again(webex: FakeWebex) -> None:
    adapter, _ = await _started(webex)
    ref = await adapter.post_rich(ROOM, "coder", _card())
    for n in range(10):
        await adapter.update_rich(
            ROOM, "coder", ref, _card(unavailable_reason=f"Offline {n}."), None
        )
    assert len(webex.edits()) == 10
    await adapter.update_rich(ROOM, "coder", ref, _answered(), None)
    assert len(webex.edits()) == 10
    assert len(webex.posts()) == 2


async def test_a_card_answered_on_webex_names_who_answered_as_webex_does(
    webex: FakeWebex,
) -> None:
    # Elsewhere the answerer is a mention. Webex refuses a mention beside a card,
    # so the name it shows for them stands in, not Switch's internal id.
    adapter, _ = await _started(webex)
    ref = await adapter.post_rich(ROOM, "coder", _card())
    await adapter.update_rich(
        ROOM, "coder", ref, _answered(responder_external_id=ADA), None
    )
    [(_, body)] = webex.edits()
    assert "Ada L from Webex" in body["markdown"]


async def test_a_card_whose_old_copy_will_not_go_still_shows_the_answer(
    webex: FakeWebex,
) -> None:
    adapter, _ = await _started(webex)
    ref = await adapter.post_rich(ROOM, "coder", _card())
    _refuse_card_edits(webex)
    webex.refuse("DELETE", "/messages/", _json_response(403, {"message": "no"}))
    await adapter.update_rich(ROOM, "coder", ref, _answered(), None)
    assert len(webex.posts()) == 2


async def test_a_refused_replacement_card_is_a_rich_content_failure(
    webex: FakeWebex,
) -> None:
    adapter, _ = await _started(webex)
    ref = await adapter.post_rich(ROOM, "coder", _card())
    _refuse_card_edits(webex)
    webex.refuse("POST", "/messages", _json_response(400, {"message": "bad card"}))
    with pytest.raises(RichContentFailed):
        await adapter.update_rich(ROOM, "coder", ref, _answered(), None)
    assert not [path for method, path, _ in webex.sent if method == "DELETE"]


async def test_a_threaded_status_redrawn_unchanged_spends_no_edit(
    webex: FakeWebex,
) -> None:
    adapter, _ = await _started(webex)
    root = wid("MESSAGE", ADA_UUID)
    turn = TurnActivity([_item()], _turn("running"))
    ref = await adapter.post_rich(ROOM, "coder", turn, root)
    await adapter.update_rich(ROOM, "coder", ref, turn, root)
    assert webex.edits() == []


# ── Spaces and people ────────────────────────────────────────────────────────


async def test_a_private_notice_goes_to_the_person_alone(webex: FakeWebex) -> None:
    adapter, _ = await _started(webex)
    await adapter.notify_privately(
        channel_id=ROOM,
        channel_name=None,
        user_id=ADA,
        content="That went nowhere.",
        thread_root_id=None,
    )
    [post] = webex.posts()
    assert post["toPersonId"] == ADA
    assert "roomId" not in post
    assert "Payments" in post["markdown"]


async def test_a_private_notice_webex_refuses_says_so(webex: FakeWebex) -> None:
    adapter, _ = await _started(webex)
    webex.refuse("POST", "/messages", _json_response(403, {"message": "blocked"}))
    with pytest.raises(PrivateNoticeRefused):
        await adapter.notify_privately(
            channel_id=ROOM,
            channel_name="Payments",
            user_id=ADA,
            content="x",
            thread_root_id=None,
        )


async def test_deleting_a_room_takes_the_bot_out_of_the_space(webex: FakeWebex) -> None:
    adapter, _ = await _started(webex)
    outcome = await adapter.retire_channel(ROOM)
    assert outcome.outcome == "left"
    assert ("DELETE", "/memberships/m-bot", None) in webex.sent


async def test_a_new_space_gets_its_topic_as_a_first_message(webex: FakeWebex) -> None:
    adapter, _ = await _started(webex)
    room_id = await adapter.create_channel(
        "payments-refactor", "Refactor the payments client"
    )
    assert webex.rooms[room_id]["title"] == "payments-refactor"
    assert webex.posts()[0]["markdown"] == "Refactor the payments client"


async def test_people_already_in_a_space_are_not_reported_missing(
    webex: FakeWebex,
) -> None:
    adapter, _ = await _started(webex)
    webex.refuse(
        "POST", "/memberships", _json_response(409, {"message": "already a member"})
    )
    assert await adapter.add_users_to_channel(ROOM, ["ada"], [ADA]) == []


async def test_people_are_found_by_address_and_bots_are_not(webex: FakeWebex) -> None:
    adapter, _ = await _started(webex)
    [user] = await adapter.search_directory_users("ada@example.com")
    assert (user.external_user_id, user.username, user.email) == (
        ADA,
        "ada",
        "ada@example.com",
    )
    assert await adapter.search_directory_users("switch@webex.bot") == []


async def test_someone_found_by_address_can_be_linked_by_the_handle_given(
    webex: FakeWebex,
) -> None:
    # Linking an account checks it again by searching for the handle the first
    # search gave, and a free organisation answers no search by name. So the
    # handle has to lead back to the same person.
    adapter, _ = await _started(webex)
    [found] = await adapter.search_directory_users("ada@example.com")
    [again] = await adapter.search_directory_users(found.username)
    assert again.external_user_id == ADA


async def test_a_failed_search_is_an_error_not_an_empty_result(
    webex: FakeWebex,
) -> None:
    adapter, _ = await _started(webex)
    webex.refuse("GET", "/people", _json_response(500, {"message": "down"}))
    with pytest.raises(RuntimeError):
        await adapter.search_directory_users("ada@example.com")


async def test_in_a_european_org_ids_are_built_in_the_conversations_cluster(
    webex: FakeWebex,
) -> None:
    adapter, inbox = await _started(webex)
    adapter._catalog = ServiceCatalog(
        clusters={"conv-k.wbx2.com": "urn:TEAM:eu-central-1_k"}
    )
    uuid = "aaaa0000-0000-4000-8000-000000000050"
    eu_id = WebexId("urn:TEAM:eu-central-1_k", "MESSAGE", uuid).encode()
    webex.messages[eu_id] = {
        "id": eu_id,
        "roomId": DM,
        "roomType": "direct",
        "personId": ADA,
        "personEmail": "ada@example.com",
        "text": "from Frankfurt",
    }
    activity = _post(uuid)
    activity["target"]["url"] = (
        f"https://conv-k.wbx2.com/conversation/api/v1/conversations/{ROOM_UUID}"
    )
    await adapter._on_activity(activity)
    assert [m.content for m in inbox.messages] == ["from Frankfurt"]


async def test_the_bot_knows_its_own_activity_when_named_by_address(
    webex: FakeWebex,
) -> None:
    adapter, inbox = await _started(webex)
    # As the socket names an actor: address in `id`, uuid in `entryUUID`.
    for actor in (
        {"id": "switch@webex.bot", "emailAddress": "switch@webex.bot"},
        {"id": "someone@else", "entryUUID": BOT_UUID},
    ):
        activity = _post("aaaa0000-0000-4000-8000-000000000051")
        activity["actor"] = actor
        await adapter._on_activity(activity)
    assert inbox.messages == []
    assert not any(path.startswith("/messages/") for _, path, _ in webex.sent)
