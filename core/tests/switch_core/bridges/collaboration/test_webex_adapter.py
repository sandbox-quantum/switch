"""The Webex adapter against a fake Webex API at the HTTP transport."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from dataclasses import replace
from typing import Any

import httpx
import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.adapter import (
    RemovalFailed,
    RequestCard,
    RichContentFailed,
    RichContentThrottled,
    RichContentWedged,
    TurnActivity,
)
from switch_core.bridges.collaboration.install import (
    WebhookAuthenticityError,
    WebhookPayloadError,
    WebhookRequest,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
    InboundAppJoin,
    InboundCommand,
    InboundInteraction,
    InboundMessage,
    InboundUserJoin,
)
from switch_core.bridges.collaboration.session.renderers import (
    RequestReference,
    parse_answer_position,
)
from switch_core.bridges.collaboration.webex.adapter import (
    WebexAdapter,
    WebexConnectionConfig,
)
from switch_core.bridges.collaboration.webex.cards import CARD_CONTENT_TYPE
from switch_core.bridges.collaboration.webex.chunking import (
    MAX_MESSAGE_BYTES,
    chunk_message,
)
from switch_core.bridges.collaboration.webex.client import WebexApiError, WebexClient
from switch_core.bridges.collaboration.webex.markup import read_message

from .session_fixtures import _item, _turn, open_request
from .webex_fake import (
    ADDRESS,
    BOT_ID,
    SECRET,
    TOKEN,
    FakeWebex,
    adapter_for,
    envelope,
    spark_signature,
)

ROOM = "room-1"
PERSON = "person-ada"


class Heard:
    def __init__(self) -> None:
        self.messages: list[InboundMessage] = []
        self.commands: list[InboundCommand] = []
        self.app_joins: list[InboundAppJoin] = []
        self.user_joins: list[InboundUserJoin] = []
        self.presses: list[InboundInteraction] = []

    async def message(self, m: InboundMessage) -> None:
        self.messages.append(m)

    async def command(self, c: InboundCommand) -> None:
        self.commands.append(c)

    async def agent_join(self, _: Any) -> None:
        return None

    async def user_join(self, j: InboundUserJoin) -> None:
        self.user_joins.append(j)

    async def app_join(self, j: InboundAppJoin) -> None:
        self.app_joins.append(j)

    async def press(self, i: InboundInteraction) -> None:
        self.presses.append(i)


@pytest.fixture
def fake() -> FakeWebex:
    return FakeWebex()


@pytest.fixture
async def started(fake: FakeWebex) -> tuple[WebexAdapter, Heard]:
    adapter = adapter_for(fake)
    heard = Heard()
    adapter.set_interaction_handler(heard.press)
    await adapter.start(
        heard.message, heard.command, heard.agent_join, heard.user_join, heard.app_join
    )
    return adapter, heard


def _request(body: bytes, **headers: str) -> WebhookRequest:
    return WebhookRequest(method="POST", headers=headers, query={}, body=body)


def _person_message(fake: FakeWebex, message_id: str, **fields: Any) -> None:
    fake.messages[message_id] = {
        "id": message_id,
        "roomId": ROOM,
        "roomType": "group",
        "personId": PERSON,
        "personEmail": "ada@example.com",
        **fields,
    }


async def _deliver(adapter: WebexAdapter, payload: dict[str, Any]) -> None:
    body = json.dumps(payload).encode()
    request = _request(body, **{"X-Spark-Signature": spark_signature(body)})
    await adapter.verify_webhook(request)
    event = adapter.parse_webhook(request)
    await adapter.dispatch_event(
        envelope_type=event.envelope_type, payload=event.payload
    )


# ── Connection config and credentials ───────────────────────────────────────


async def test_a_webhook_secret_is_minted_once_when_the_connection_is_made() -> None:
    prepared = await WebexAdapter.prepare_config({"bot_token": TOKEN})
    again = await WebexAdapter.prepare_config(prepared)

    assert len(str(prepared["webhook_secret"])) >= 32
    assert again["webhook_secret"] == prepared["webhook_secret"]


def test_the_connect_form_asks_only_for_the_bot_token() -> None:
    schema = WebexConnectionConfig.model_json_schema()

    assert list(schema["properties"]) == ["bot_token"]


@pytest.mark.parametrize("token", ["", "   ", "two words"])
def test_a_token_that_cannot_be_one_is_refused(token: str) -> None:
    with pytest.raises(ValidationError):
        WebexConnectionConfig(bot_token=token)


async def test_a_good_bot_token_is_accepted(
    fake: FakeWebex, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        WebexAdapter,
        "_connect",
        staticmethod(lambda t: WebexClient.connect(t, transport=fake.transport())),
    )

    await WebexAdapter.verify_credentials({"bot_token": TOKEN})


async def test_a_rejected_token_says_where_to_get_a_new_one(
    fake: FakeWebex, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake.fail[("GET", "/v1/people/me")] = httpx.Response(
        401, json={"message": "The request requires a valid access token"}
    )
    monkeypatch.setattr(
        WebexAdapter,
        "_connect",
        staticmethod(lambda t: WebexClient.connect(t, transport=fake.transport())),
    )

    with pytest.raises(BridgeCredentialError, match="developer.webex.com"):
        await WebexAdapter.verify_credentials({"bot_token": TOKEN})


async def test_a_persons_token_is_refused_so_switch_never_acts_as_them(
    fake: FakeWebex, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake.me["type"] = "person"
    monkeypatch.setattr(
        WebexAdapter,
        "_connect",
        staticmethod(lambda t: WebexClient.connect(t, transport=fake.transport())),
    )

    with pytest.raises(BridgeCredentialError, match="not a bot"):
        await WebexAdapter.verify_credentials({"bot_token": TOKEN})


def test_failures_are_classified_by_type() -> None:
    assert WebexAdapter.classify_failure(WebexApiError(401, "x")) == "auth_failed"
    assert WebexAdapter.classify_failure(WebexApiError(429, "x")) == "network"
    assert WebexAdapter.classify_failure(WebexApiError(500, "x")) == "platform_error"
    assert WebexAdapter.classify_failure(httpx.ConnectError("x")) == "network"
    assert WebexAdapter.classify_failure(ValueError("x")) is None


async def test_without_a_public_address_starting_fails_loudly(fake: FakeWebex) -> None:
    adapter = adapter_for(fake)
    adapter.set_webhook_url(None)
    heard = Heard()

    with pytest.raises(BridgeOperationError, match="MESSAGING_PUBLIC_URL"):
        await adapter.start(
            heard.message,
            heard.command,
            heard.agent_join,
            heard.user_join,
            heard.app_join,
        )


# ── Webhook registration ────────────────────────────────────────────────────


async def test_starting_registers_the_three_webhooks_on_this_address(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    assert sorted(h["resource"] for h in fake.webhooks) == [
        "attachmentActions",
        "memberships",
        "messages",
    ]
    assert {h["targetUrl"] for h in fake.webhooks} == {ADDRESS}
    assert {h["secret"] for h in fake.webhooks} == {SECRET}


async def test_restarting_repairs_rather_than_duplicates(fake: FakeWebex) -> None:
    fake.webhooks = [
        {
            "id": "old",
            "targetUrl": ADDRESS,
            "resource": "messages",
            "event": "created",
            "secret": "stale",
            "status": "inactive",
        },
        {
            "id": "dup",
            "targetUrl": ADDRESS,
            "resource": "messages",
            "event": "created",
            "secret": "stale",
            "status": "active",
        },
        {
            "id": "theirs",
            "targetUrl": "https://elsewhere.example/hook",
            "resource": "messages",
            "event": "created",
            "status": "active",
        },
    ]
    adapter = adapter_for(fake)
    heard = Heard()

    await adapter.start(
        heard.message, heard.command, heard.agent_join, heard.user_join, heard.app_join
    )

    ours = [h for h in fake.webhooks if h["targetUrl"] == ADDRESS]
    assert len(ours) == 3
    kept = next(h for h in ours if h["id"] == "old")
    assert (kept["secret"], kept["status"]) == (SECRET, "active")
    assert any(h["id"] == "theirs" for h in fake.webhooks)


def _throttled() -> httpx.Response:
    return httpx.Response(429, headers={"Retry-After": "0"}, json={"message": "slow"})


async def test_a_throttled_webhook_setup_waits_and_finishes(fake: FakeWebex) -> None:
    fake.fail_next[("POST", "/v1/webhooks")] = [_throttled(), _throttled()]
    adapter = adapter_for(fake)
    heard = Heard()

    await adapter.start(
        heard.message, heard.command, heard.agent_join, heard.user_join, heard.app_join
    )

    assert sorted(h["resource"] for h in fake.webhooks) == [
        "attachmentActions",
        "memberships",
        "messages",
    ]


async def test_a_webhook_setup_that_stays_throttled_fails_loudly(
    fake: FakeWebex,
) -> None:
    fake.fail[("POST", "/v1/webhooks")] = _throttled()
    adapter = adapter_for(fake)
    heard = Heard()

    with pytest.raises(WebexApiError) as raised:
        await adapter.start(
            heard.message,
            heard.command,
            heard.agent_join,
            heard.user_join,
            heard.app_join,
        )

    assert raised.value.throttled
    assert len(fake.sent("POST", "/v1/webhooks")) == 5


async def test_a_quiet_pod_registers_nothing(fake: FakeWebex) -> None:
    adapter = adapter_for(fake, listening=False)
    heard = Heard()

    await adapter.start(
        heard.message, heard.command, heard.agent_join, heard.user_join, heard.app_join
    )

    assert fake.webhooks == []


async def test_removing_the_connection_removes_its_webhooks_only(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, _ = started
    fake.webhooks.append(
        {"id": "theirs", "targetUrl": "https://elsewhere.example/hook"}
    )

    await adapter.withdraw()

    assert [h["id"] for h in fake.webhooks] == ["theirs"]


# ── Webhooks in ─────────────────────────────────────────────────────────────


async def test_a_legacy_sha1_signature_is_accepted(
    started: tuple[WebexAdapter, Heard],
) -> None:
    adapter, _ = started
    body = b'{"resource":"messages"}'

    await adapter.verify_webhook(
        _request(body, **{"X-Spark-Signature": spark_signature(body)})
    )


async def test_the_newer_signature_header_is_read_as_webex_documents_it(
    started: tuple[WebexAdapter, Heard],
) -> None:
    adapter, _ = started
    body = b'{"resource":"messages"}'
    sha256 = hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()
    sha512 = hmac.new(SECRET.encode(), body, hashlib.sha512).hexdigest()

    await adapter.verify_webhook(
        _request(body, **{"X-Webex-Signature": f"SHA-256={sha256}, SHA-512={sha512}"})
    )
    await adapter.verify_webhook(
        _request(body, **{"x-webex-signature": f"SHA-512={sha512}"})
    )


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"X-Spark-Signature": spark_signature(b"{}", "another-secret")},
        {"X-Webex-Signature": "SHA-256=" + "0" * 64},
        {"X-Webex-Signature": "MD5=abc"},
    ],
)
async def test_a_delivery_that_does_not_prove_itself_is_refused(
    started: tuple[WebexAdapter, Heard], headers: dict[str, str]
) -> None:
    adapter, _ = started

    with pytest.raises(WebhookAuthenticityError):
        await adapter.verify_webhook(_request(b"{}", **headers))


async def test_a_signed_body_that_cannot_be_read_is_refused(
    started: tuple[WebexAdapter, Heard],
) -> None:
    adapter, _ = started

    for body in (b"not json", b"[]", b'{"resource":"messages","event":"created"}'):
        with pytest.raises(WebhookPayloadError):
            adapter.parse_webhook(_request(body))


async def test_events_are_named_by_what_happened_not_by_the_webhook(
    started: tuple[WebexAdapter, Heard],
) -> None:
    """Webex puts the webhook's own id at the top of every delivery it makes,
    so two different messages arrive with the same `id`."""
    adapter, _ = started
    first = adapter.parse_webhook(
        _request(json.dumps(envelope("messages", "msg-1")).encode())
    )
    second = adapter.parse_webhook(
        _request(json.dumps(envelope("messages", "msg-2")).encode())
    )
    retry = adapter.parse_webhook(
        _request(json.dumps(envelope("messages", "msg-1")).encode())
    )

    assert first.external_event_id != second.external_event_id
    assert first.external_event_id == retry.external_event_id
    assert first.answers_inline is False


# ── Inbound messages ────────────────────────────────────────────────────────


async def test_a_message_is_fetched_and_relayed_with_its_thread(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, heard = started
    _person_message(fake, "msg-1", text="hello there", parentId="root-1")

    await _deliver(adapter, envelope("messages", "msg-1", personId=PERSON))

    [message] = heard.messages
    assert (message.channel_id, message.channel_type) == (ROOM, "group")
    assert (message.content, message.message_ref, message.root_id) == (
        "hello there",
        "msg-1",
        "root-1",
    )
    assert message.sender_name == "ada@example.com"


async def test_the_bots_own_messages_are_not_relayed_or_fetched(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, heard = started

    await _deliver(adapter, envelope("messages", "sent-1", personId=BOT_ID))

    assert heard.messages == []
    assert ("GET", "/v1/messages/sent-1", None) not in fake.calls


async def test_the_bots_mention_comes_out_and_an_agents_stays(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, heard = started
    _person_message(
        fake,
        "msg-1",
        text="Switch @coder fix it",
        html=(
            f'<p><spark-mention data-object-type="person" data-object-id="{BOT_ID}">'
            "Switch</spark-mention> @coder fix <strong>it</strong></p>"
        ),
        mentionedPeople=[BOT_ID],
    )

    await _deliver(adapter, envelope("messages", "msg-1", personId=PERSON))

    [message] = heard.messages
    assert message.content == "@coder fix **it**"
    assert message.self_mention_token is None


def _webex_id(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")


def test_the_bots_mention_is_recognised_when_the_client_pads_its_id() -> None:
    uuid = "00000000-0000-4000-8000-000000000001"
    bot_id = _webex_id(f"ciscospark://us/PEOPLE/{uuid}")
    written = _webex_id(f'ciscospark://us/PEOPLE/{uuid}" data-mention-origin="client')

    content, named_bot = read_message(
        {
            "text": "Switch hello",
            "html": (
                '<spark-mention data-object-type="person" '
                f'data-object-id="{written}">Switch</spark-mention> hello'
            ),
            "mentionedPeople": [bot_id],
        },
        bot_id,
        "Switch",
    )

    assert (content, named_bot) == ("hello", True)


def test_another_persons_mention_is_not_taken_for_the_bot() -> None:
    bot_id = _webex_id("ciscospark://us/PEOPLE/00000000-0000-4000-8000-000000000001")
    ada = _webex_id("ciscospark://us/PEOPLE/00000000-0000-4000-8000-000000000002")

    content, named_bot = read_message(
        {
            "text": "Ada hello",
            "html": (
                '<spark-mention data-object-type="person" '
                f'data-object-id="{ada}">Ada</spark-mention> hello'
            ),
            "mentionedPeople": [ada],
        },
        bot_id,
        "Switch",
    )

    assert (content, named_bot) == ("@Ada hello", False)


async def test_a_message_naming_only_the_bot_is_addressed_to_it(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, heard = started
    _person_message(
        fake, "msg-1", text="Switch mail ada@example.com", mentionedPeople=[BOT_ID]
    )

    await _deliver(adapter, envelope("messages", "msg-1", personId=PERSON))

    [message] = heard.messages
    assert message.content == "mail ada@example.com"
    assert message.self_mention_token == "switch-test"


async def test_a_direct_space_is_a_direct_channel(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, heard = started
    _person_message(fake, "msg-1", text="hi", roomType="direct")

    await _deliver(adapter, envelope("messages", "msg-1", personId=PERSON))

    assert heard.messages[0].channel_type == "direct"
    assert heard.messages[0].self_mention_token is None


async def test_a_bang_command_is_a_command(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, heard = started
    _person_message(
        fake, "msg-1", text="Switch !invite-agent coder", mentionedPeople=[BOT_ID]
    )

    await _deliver(adapter, envelope("messages", "msg-1", personId=PERSON))

    [command] = heard.commands
    assert (command.command, command.args, command.message_ref) == (
        "invite-agent",
        "coder",
        "msg-1",
    )
    assert heard.messages == []


async def test_another_bots_message_is_marked_as_an_apps(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, heard = started
    _person_message(fake, "msg-1", text="build passed", personEmail="ci@webex.bot")

    await _deliver(adapter, envelope("messages", "msg-1", personId=PERSON))

    assert heard.messages[0].sender_is_app is True


async def test_files_come_in_and_an_oversized_one_is_refused_visibly(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, heard = started
    adapter.set_max_attachment_bytes(10)
    fake.files["small"] = (
        b"tiny",
        {
            "content-type": "text/plain",
            "content-disposition": 'attachment; filename="notes.txt"',
        },
    )
    fake.files["big"] = (b"x" * 50, {"content-type": "image/png"})
    _person_message(
        fake,
        "msg-1",
        text="files",
        files=[
            "https://webexapis.com/v1/contents/small",
            "https://webexapis.com/v1/contents/big",
            "https://attacker.example/v1/contents/x",
        ],
    )

    await _deliver(adapter, envelope("messages", "msg-1", personId=PERSON))

    [message] = heard.messages
    assert [(a.filename, a.data) for a in message.attachments] == [
        ("notes.txt", b"tiny")
    ]
    reasons = [f.reason for f in message.attachment_failures]
    assert "too large" in reasons[0]
    assert "not hosted by Webex" in reasons[1]
    assert not any(p.startswith("/v1/contents/x") for _, p, _ in fake.calls), (
        "the token must never be sent to a host other than Webex"
    )


async def test_a_file_still_being_scanned_says_so(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, heard = started
    fake.fail[("GET", "/v1/contents/locked")] = httpx.Response(
        423, headers={"retry-after": "5"}
    )
    _person_message(
        fake, "msg-1", text="", files=["https://webexapis.com/v1/contents/locked"]
    )

    await _deliver(adapter, envelope("messages", "msg-1", personId=PERSON))

    assert "scanning" in heard.messages[0].attachment_failures[0].reason


async def test_the_bot_joining_a_space_adopts_it_and_a_person_joining_is_seen(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, heard = started

    await _deliver(
        adapter,
        envelope(
            "memberships", "mem-1", roomId=ROOM, personId=BOT_ID, roomType="group"
        ),
    )
    await _deliver(
        adapter,
        envelope(
            "memberships",
            "mem-2",
            roomId=ROOM,
            personId=PERSON,
            personEmail="ada@example.com",
            roomType="group",
        ),
    )

    assert [(j.channel_id, j.channel_type) for j in heard.app_joins] == [
        (ROOM, "group")
    ]
    assert [j.external_user_id for j in heard.user_joins] == [PERSON]


async def test_a_space_the_bot_joins_is_named_by_its_title(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, heard = started
    fake.rooms[ROOM] = {"id": ROOM, "type": "group", "title": "Release planning"}

    await _deliver(
        adapter,
        envelope(
            "memberships", "mem-1", roomId=ROOM, personId=BOT_ID, roomType="group"
        ),
    )

    assert [j.channel_name for j in heard.app_joins] == ["Release planning"]


async def test_a_person_joining_first_names_the_space_too(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, heard = started
    fake.rooms[ROOM] = {"id": ROOM, "type": "group", "title": "Release planning"}

    await _deliver(
        adapter,
        envelope(
            "memberships",
            "mem-2",
            roomId=ROOM,
            personId=PERSON,
            personEmail="ada@example.com",
            roomType="group",
        ),
    )

    assert [j.channel_name for j in heard.user_joins] == ["Release planning"]


async def test_a_space_whose_title_cannot_be_read_is_still_adopted(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, heard = started

    await _deliver(
        adapter,
        envelope(
            "memberships", "mem-1", roomId=ROOM, personId=BOT_ID, roomType="group"
        ),
    )

    assert [(j.channel_id, j.channel_name) for j in heard.app_joins] == [(ROOM, None)]


# ── Outbound ────────────────────────────────────────────────────────────────


async def test_a_reply_goes_in_its_thread_under_the_agents_name(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, _ = started

    ref = await adapter.send_message(ROOM, "coder", "done", "root-1")

    [body] = fake.sent()
    assert body == {"roomId": ROOM, "markdown": "**coder**\ndone", "parentId": "root-1"}
    assert ref == "sent-1"


async def test_an_agent_name_cannot_page_or_forge_a_link(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, _ = started

    await adapter.send_message(ROOM, "<@all> [click](https://evil.example)", "hi")

    markdown = fake.sent()[0]["markdown"]
    assert "<@all>" not in markdown
    assert "](" not in markdown


def test_agent_text_cannot_page_with_webex_mention_syntax(
    fake: FakeWebex,
) -> None:
    adapter = adapter_for(fake)

    rendered = adapter.translate_outbound(
        "hey <@personEmail:boss@example.com> and <@all>"
    )

    assert "<@personEmail:" not in rendered
    assert "<@all>" not in rendered


async def test_a_long_reply_is_split_and_the_first_part_is_its_reference(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, _ = started
    text = "\n".join(f"line {i} " + "word " * 30 for i in range(200))

    ref = await adapter.send_message(ROOM, "coder", text)

    sent = fake.sent()
    assert len(sent) > 1
    assert all(len(b["markdown"].encode()) <= 7439 for b in sent)
    assert ref == "sent-1"


def test_splitting_counts_bytes_and_keeps_code_fences_closed() -> None:
    text = "```python\n" + "\n".join("print('é' * 40)" for _ in range(900)) + "\n```"

    parts = chunk_message(text)

    assert len(parts) > 1
    assert all(len(p.encode()) <= MAX_MESSAGE_BYTES for p in parts)
    assert all(p.count("```") % 2 == 0 for p in parts)
    assert all(p.startswith("```python") for p in parts)


async def test_edits_and_deletes_reach_webex(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, _ = started

    await adapter.update_message(ROOM, "sent-1", "fixed")
    await adapter.delete_message(ROOM, "sent-1")

    assert fake.sent("PUT", "/v1/messages/sent-1") == [
        {"roomId": ROOM, "markdown": "fixed"}
    ]
    assert ("DELETE", "/v1/messages/sent-1", None) in fake.calls


async def test_a_file_goes_out_as_one_message_with_its_caption(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, _ = started

    await adapter.send_attachment(
        ROOM, "coder", "out.txt", "text/plain", b"data", "here"
    )

    [body] = fake.sent()
    assert b'name="files"; filename="out.txt"' in body
    assert b"**coder**\nhere" in body


async def test_an_outbound_file_over_webexs_limit_is_refused_visibly(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, _ = started

    await adapter.send_attachment(
        ROOM,
        "coder",
        "huge.bin",
        "application/octet-stream",
        b"x" * (100 * 1024 * 1024 + 1),
    )

    [body] = fake.sent()
    assert "could not send huge.bin" in body["markdown"]


async def test_a_refused_send_is_an_operation_error(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, _ = started
    fake.fail[("POST", "/v1/messages")] = httpx.Response(
        403, json={"message": "The bot is not in this space"}
    )

    with pytest.raises(BridgeOperationError, match="not in this space"):
        await adapter.send_message(ROOM, "coder", "hi")


# ── Spaces ──────────────────────────────────────────────────────────────────


async def test_a_space_is_created_and_people_added_reporting_who_was_not(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, _ = started

    room_id = await adapter.create_channel("Launch", "topic")
    fake.fail[("POST", "/v1/memberships")] = httpx.Response(404)
    failed = await adapter.add_users_to_channel(room_id, ["Ada"], ["person-ada"])

    assert room_id == "new-room"
    assert fake.sent("POST", "/v1/rooms") == [{"title": "Launch"}]
    assert failed == ["person-ada"]


async def test_space_type_is_read_from_webex(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, _ = started
    fake.rooms["dm"] = {"id": "dm", "type": "direct"}
    fake.rooms["grp"] = {"id": "grp", "type": "group"}

    assert await adapter.get_channel_type("dm") == "direct"
    assert await adapter.get_channel_type("grp") == "group"


def test_what_webex_cannot_do_is_declared() -> None:
    assert WebexAdapter.receives_webhooks is True
    assert WebexAdapter.draws_session_activity is True
    assert WebexAdapter.supports_directory_search is False
    assert WebexAdapter.supports_activity_reactions is False
    assert WebexAdapter.renders_custom_url_schemes is False
    assert WebexAdapter.keeps_quiet_unless_listening is True
    assert WebexAdapter.channel_on_delete == "left"


# ── Session activity and request cards ─────────────────────────────────────


def _card() -> RequestCard:
    return RequestCard(open_request(), RequestReference(token="tok-1", handle="R7"))


def _running() -> TurnActivity:
    return TurnActivity(
        [_item(kind="assistant-message", title="", text="Looking")], _turn("running")
    )


async def test_a_request_is_posted_as_a_card_with_a_button_per_option(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, _ = started

    ref = await adapter.post_rich(ROOM, "coder", _card(), "root-1")

    [body] = fake.sent()
    assert body["parentId"] == "root-1"
    assert body["markdown"].startswith("**coder**")
    [attachment] = body["attachments"]
    assert attachment["contentType"] == CARD_CONTENT_TYPE
    actions = attachment["content"]["actions"]
    assert actions and all(a["type"] == "Action.Submit" for a in actions)
    assert [a["data"]["position"] for a in actions] == list(range(1, len(actions) + 1))
    assert {a["data"]["token"] for a in actions} == {"tok-1"}
    assert ref == "sent-1"


async def test_a_card_for_someone_mentions_them_beside_it_not_in_it(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, _ = started
    card = replace(_card(), notify_external_id=PERSON)

    ref = await adapter.post_rich(ROOM, "coder", card, "root-1")

    ping, posted = fake.sent()
    assert ping["markdown"].startswith(f"<@personId:{PERSON}>")
    assert ping["parentId"] == "root-1"
    assert "attachments" not in ping
    assert posted["attachments"]
    assert "<@" not in posted["markdown"]
    assert ref == "sent-2"


async def test_removing_an_answered_card_removes_its_mention_too(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, _ = started
    ref = await adapter.post_rich(
        ROOM, "coder", replace(_card(), notify_external_id=PERSON)
    )

    await adapter.remove_publication(ROOM, ref)

    deleted = [p for m, p, _ in fake.calls if m == "DELETE"]
    assert deleted == [f"/v1/messages/{ref}", "/v1/messages/sent-1"]


async def test_without_anywhere_for_a_press_to_go_a_card_is_text(
    fake: FakeWebex,
) -> None:
    adapter = adapter_for(fake)
    heard = Heard()
    await adapter.start(
        heard.message, heard.command, heard.agent_join, heard.user_join, heard.app_join
    )

    await adapter.post_rich(ROOM, "coder", _card())

    assert "attachments" not in fake.sent()[0]


async def test_a_press_on_a_card_is_handed_to_switch_as_the_option_it_names(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, heard = started
    fake.actions["act-1"] = {
        "id": "act-1",
        "type": "submit",
        "messageId": "sent-1",
        "personId": PERSON,
        "roomId": ROOM,
        "inputs": {"kind": "switch", "do": "answer", "token": "tok-1", "position": 2},
    }
    fake.people[PERSON] = {"id": PERSON, "emails": ["ada@example.com"]}

    await _deliver(adapter, envelope("attachmentActions", "act-1", personId=PERSON))

    [press] = heard.presses
    assert parse_answer_position(press.action_id) == 2
    assert (press.value, press.message_ref, press.sender_id, press.sender_name) == (
        "tok-1",
        "sent-1",
        PERSON,
        "ada@example.com",
    )


@pytest.mark.parametrize(
    "inputs",
    [
        {"token": "tok-1", "position": 1},
        {"kind": "switch", "do": "answer", "token": "tok-1", "position": 0},
        {"kind": "switch", "do": "answer", "token": "", "position": 1},
        {"kind": "switch", "do": "answer", "token": "tok-1", "position": True},
    ],
)
async def test_a_press_switch_did_not_draw_is_ignored(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard], inputs: dict[str, Any]
) -> None:
    adapter, heard = started
    fake.actions["act-1"] = {
        "id": "act-1",
        "personId": PERSON,
        "roomId": ROOM,
        "inputs": inputs,
    }

    await _deliver(adapter, envelope("attachmentActions", "act-1", personId=PERSON))

    assert heard.presses == []


async def test_a_press_that_did_not_land_tells_the_person_who_pressed(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, _ = started

    async def refuse(interaction: InboundInteraction) -> None:
        await adapter.tell_actor(
            interaction.channel_id,
            interaction.sender_id,
            interaction.sender_name,
            None,
            "That request was already answered.",
        )

    adapter.set_interaction_handler(refuse)
    fake.actions["act-1"] = {
        "id": "act-1",
        "messageId": "sent-1",
        "personId": PERSON,
        "roomId": ROOM,
        "inputs": {"kind": "switch", "do": "answer", "token": "tok-1", "position": 1},
    }
    fake.people[PERSON] = {"id": PERSON, "emails": ["ada@example.com"]}

    await _deliver(adapter, envelope("attachmentActions", "act-1", personId=PERSON))

    [notice] = fake.sent()
    assert notice["markdown"].startswith(f"<@personId:{PERSON}>")
    assert "already answered" in notice["markdown"]


async def test_a_turns_status_is_text_edited_in_place(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, _ = started

    ref = await adapter.post_rich(ROOM, "coder", _running())
    done = TurnActivity(
        [_item(kind="assistant-message", title="", text="Done")], _turn("completed")
    )
    await adapter.update_rich(ROOM, "coder", ref, done, None)

    assert "attachments" not in fake.sent()[0]
    assert len(fake.sent("PUT", f"/v1/messages/{ref}")) == 1


async def test_a_redraw_that_changes_nothing_spends_no_edit(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, _ = started
    ref = await adapter.post_rich(ROOM, "coder", _running())

    await adapter.update_rich(ROOM, "coder", ref, _running(), None)

    assert fake.sent("PUT", f"/v1/messages/{ref}") == []


async def test_a_running_turn_keeps_its_last_edit_for_the_end(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, _ = started
    ref = await adapter.post_rich(ROOM, "coder", _running())

    for step in range(15):
        items = [
            _item(itemId=f"item-{step}", title=f"Step {step}", status="in-progress")
        ]
        await adapter.update_rich(
            ROOM, "coder", ref, TurnActivity(items, _turn("running")), None
        )
    done = TurnActivity(
        [_item(kind="assistant-message", title="", text="Done")], _turn("completed")
    )
    await adapter.update_rich(ROOM, "coder", ref, done, None)

    assert len(fake.sent("PUT", f"/v1/messages/{ref}")) == 10


async def test_past_the_edit_limit_the_message_is_wedged(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, _ = started
    ref = await adapter.post_rich(ROOM, "coder", _running())
    adapter._edits[ref] = 10
    done = TurnActivity(
        [_item(kind="assistant-message", title="", text="Done")], _turn("completed")
    )

    with pytest.raises(RichContentWedged):
        await adapter.update_rich(ROOM, "coder", ref, done, None)


async def test_a_refused_publication_and_a_throttle_are_told_apart(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, _ = started
    fake.fail[("POST", "/v1/messages")] = httpx.Response(400, json={"message": "bad"})
    with pytest.raises(RichContentFailed):
        await adapter.post_rich(ROOM, "coder", _card())

    fake.fail[("POST", "/v1/messages")] = httpx.Response(
        429, headers={"retry-after": "7"}
    )
    with pytest.raises(RichContentThrottled) as throttled:
        await adapter.post_rich(ROOM, "coder", _card())
    assert throttled.value.retry_after == 7

    fake.fail[("POST", "/v1/messages")] = httpx.Response(503)
    with pytest.raises(WebexApiError):
        await adapter.post_rich(ROOM, "coder", _card())


async def test_an_answered_card_is_taken_down(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, _ = started
    assert WebexAdapter.removes_answered_cards is True

    await adapter.remove_publication(ROOM, "sent-1")
    fake.fail[("DELETE", "/v1/messages/gone")] = httpx.Response(404)
    await adapter.remove_publication(ROOM, "gone")
    fake.fail[("DELETE", "/v1/messages/stuck")] = httpx.Response(403)

    with pytest.raises(RemovalFailed):
        await adapter.remove_publication(ROOM, "stuck")


async def test_a_settled_request_is_drawn_without_buttons(
    fake: FakeWebex, started: tuple[WebexAdapter, Heard]
) -> None:
    adapter, _ = started
    card = _card()
    settled = replace(card, request=card.request.model_copy(update={"state": "closed"}))

    await adapter.post_rich(ROOM, "coder", settled)

    assert "attachments" not in fake.sent()[0]
