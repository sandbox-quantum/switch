"""WhatsApp in: the connection, the webhook address, and what arrives on it."""

from __future__ import annotations

import logging

import httpx
import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.install import (
    WebhookAuthenticityError,
    WebhookPayloadError,
    WebhookRequest,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
)
from switch_core.bridges.collaboration.session.renderers import position_action
from switch_core.bridges.collaboration.whatsapp import adapter as adapter_module
from switch_core.bridges.collaboration.whatsapp.adapter import (
    WhatsAppAdapter,
    WhatsAppConnectionConfig,
)

from .whatsapp_fakes import (
    APP_ID,
    BUSINESS_NUMBER,
    CONFIG,
    CONTACT,
    CONTACT_BSUID,
    NOW,
    VERIFY,
    FakeMeta,
    Inbox,
    deliver,
    delivery,
    install_fake_meta,
    media_message,
    pressed,
    signed,
    started,
    text,
)


@pytest.fixture(autouse=True)
def meta(monkeypatch: pytest.MonkeyPatch) -> FakeMeta:
    return install_fake_meta(monkeypatch)


# ── The connection ───────────────────────────────────────────────────────────


def test_a_complete_config_parses() -> None:
    config = WhatsAppConnectionConfig.model_validate(CONFIG)

    assert config.phone_number_id == "1111111111"


@pytest.mark.parametrize("field", ["app_id", "phone_number_id"])
def test_an_id_that_is_not_meta_s_numeric_id_is_refused(field: str) -> None:
    with pytest.raises(ValidationError, match="digits"):
        WhatsAppConnectionConfig.model_validate({**CONFIG, field: "+1 555 000"})


@pytest.mark.parametrize("field", ["access_token", "app_secret", "verify_token"])
def test_a_blank_credential_is_refused(field: str) -> None:
    with pytest.raises(ValidationError):
        WhatsAppConnectionConfig.model_validate({**CONFIG, field: "  "})


def test_the_connect_form_asks_for_exactly_these_and_masks_the_secrets() -> None:
    masked_words = (
        "token",
        "password",
        "secret",
        "api_key",
        "private_key",
        "credential",
    )
    fields = WhatsAppConnectionConfig.model_json_schema()["properties"]

    assert set(fields) == {
        "access_token",
        "app_secret",
        "app_id",
        "phone_number_id",
        "verify_token",
        "new_chat_agents",
    }
    for secret in ("access_token", "app_secret", "verify_token"):
        assert any(word in secret for word in masked_words)


def test_agents_for_new_chats_are_read_from_a_comma_separated_list() -> None:
    config = WhatsAppConnectionConfig.model_validate(
        {**CONFIG, "new_chat_agents": " triage, ,support "}
    )

    assert config.new_chat_agents == "triage, support"
    assert config.agents_for_new_chats == ["triage", "support"]
    assert WhatsAppConnectionConfig.model_validate(CONFIG).agents_for_new_chats == []


async def test_a_new_chat_starts_with_the_agents_the_connection_names() -> None:
    adapter = WhatsAppAdapter(
        config=WhatsAppConnectionConfig.model_validate(
            {**CONFIG, "new_chat_agents": "triage"}
        )
    )

    assert await adapter.get_channel_agent_names(CONTACT) == ["triage"]


def test_one_meta_app_is_one_connection_whatever_the_number() -> None:
    first = WhatsAppAdapter.claimed_workspace(CONFIG)
    second = WhatsAppAdapter.claimed_workspace({**CONFIG, "phone_number_id": "999"})

    assert first == second == f"Meta app {APP_ID}"


async def test_credentials_that_work_are_accepted(meta: FakeMeta) -> None:
    await WhatsAppAdapter.verify_credentials(CONFIG)

    asked = [request.url.path for request in meta.requests]
    assert asked[0].endswith("/debug_token")
    assert asked[1].endswith("/1111111111")


async def test_a_token_from_another_app_is_refused_naming_both(meta: FakeMeta) -> None:
    meta.token["app_id"] = "999999"

    with pytest.raises(BridgeCredentialError, match="999999.*222222222"):
        await WhatsAppAdapter.verify_credentials(CONFIG)


async def test_a_token_without_the_messaging_permission_is_refused(
    meta: FakeMeta,
) -> None:
    meta.token["scopes"] = ["whatsapp_business_management"]

    with pytest.raises(BridgeCredentialError, match="whatsapp_business_messaging"):
        await WhatsAppAdapter.verify_credentials(CONFIG)


async def test_an_expired_token_is_refused(meta: FakeMeta) -> None:
    meta.token["is_valid"] = False

    with pytest.raises(BridgeCredentialError, match="not valid"):
        await WhatsAppAdapter.verify_credentials(CONFIG)


async def test_a_wrong_app_secret_is_refused_with_meta_s_reason(meta: FakeMeta) -> None:
    meta.refuse("/debug_token", 400, 101, "Error validating client secret.")

    with pytest.raises(BridgeCredentialError, match="Error validating client secret"):
        await WhatsAppAdapter.verify_credentials(CONFIG)


async def test_a_number_the_token_cannot_reach_is_refused(meta: FakeMeta) -> None:
    meta.refuse("/1111111111", 400, 100, "Object with ID '1111111111' does not exist")

    with pytest.raises(BridgeCredentialError, match="phone number ID 1111111111"):
        await WhatsAppAdapter.verify_credentials(CONFIG)


async def test_it_will_not_start_without_a_public_address() -> None:
    adapter = WhatsAppAdapter(config=WhatsAppConnectionConfig.model_validate(CONFIG))
    adapter.set_webhook_url(None)
    inbox = Inbox()

    with pytest.raises(BridgeOperationError, match="MESSAGING_PUBLIC_URL"):
        await adapter.start(
            inbox.message, inbox.command, inbox.ignore, inbox.ignore, inbox.ignore
        )


# ── The webhook address ──────────────────────────────────────────────────────


def _address_check(token: str) -> WebhookRequest:
    return WebhookRequest(
        method="GET",
        headers={},
        query={
            "hub.mode": "subscribe",
            "hub.verify_token": token,
            "hub.challenge": "1158201444",
        },
        body=b"",
    )


async def test_meta_s_address_check_is_answered_with_its_challenge() -> None:
    adapter = await started(Inbox())
    request = _address_check(VERIFY)

    await adapter.verify_webhook(request)
    event = adapter.parse_webhook(request)

    assert event.handshake == "1158201444"
    assert not event.answers_inline


async def test_an_address_check_with_the_wrong_token_is_refused() -> None:
    adapter = await started(Inbox())

    with pytest.raises(WebhookAuthenticityError):
        await adapter.verify_webhook(_address_check("guessed"))


async def test_a_delivery_signed_with_another_secret_is_refused() -> None:
    adapter = await started(Inbox())

    with pytest.raises(WebhookAuthenticityError):
        await adapter.verify_webhook(signed(delivery(text("hi")), secret="another"))


async def test_an_unsigned_delivery_is_refused() -> None:
    adapter = await started(Inbox())
    body = signed(delivery(text("hi"))).body

    with pytest.raises(WebhookAuthenticityError):
        await adapter.verify_webhook(
            WebhookRequest(method="POST", headers={}, query={}, body=body)
        )


@pytest.mark.parametrize(
    "body", [b"not json", b"[]", b'{"object": "page", "entry": []}']
)
async def test_a_body_that_is_not_a_whatsapp_delivery_is_refused(body: bytes) -> None:
    adapter = await started(Inbox())

    with pytest.raises(WebhookPayloadError):
        adapter.parse_webhook(
            WebhookRequest(method="POST", headers={}, query={}, body=body)
        )


async def test_a_retried_delivery_carries_the_same_event_id() -> None:
    adapter = await started(Inbox())

    first = adapter.parse_webhook(signed(delivery(text("hi"))))
    retry = adapter.parse_webhook(signed(delivery(text("hi"))))
    other = adapter.parse_webhook(signed(delivery(text("hi", wamid="wamid.IN2"))))

    assert first.external_event_id is not None
    assert first.external_event_id == retry.external_event_id
    assert first.external_event_id != other.external_event_id


async def test_events_for_another_number_on_the_same_app_are_not_dispatched() -> None:
    inbox = Inbox()
    adapter = await started(inbox)

    await deliver(adapter, delivery(text("hi"), phone_number_id="999"))

    assert inbox.messages == []


# ── What arrives ─────────────────────────────────────────────────────────────


async def test_a_text_becomes_a_message_in_the_person_s_chat(meta: FakeMeta) -> None:
    inbox = Inbox()
    adapter = await started(inbox)

    await deliver(adapter, delivery(text("hi @triage, *urgent*")))

    (message,) = inbox.messages
    assert message.channel_id == CONTACT
    assert message.channel_type == "direct"
    assert message.sender_id == CONTACT
    assert message.sender_name.startswith("AdaLovelace_")
    assert CONTACT not in message.sender_name
    assert message.channel_name == "Ada Lovelace"
    assert message.content == "hi @triage, *urgent*"
    assert adapter.translate_inbound(message.content) == "hi @triage, **urgent**"
    assert message.message_ref == "wamid.IN1"
    assert message.root_id is None
    assert meta.receipts() == [
        {"messaging_product": "whatsapp", "status": "read", "message_id": "wamid.IN1"}
    ]


async def test_a_person_with_a_username_is_known_by_their_scoped_id() -> None:
    inbox = Inbox()
    adapter = await started(inbox)
    payload = delivery(text("hi"))
    value = payload["entry"][0]["changes"][0]["value"]
    value["contacts"] = [{"profile": {"name": "Ada"}, "user_id": CONTACT_BSUID}]
    message = value["messages"][0]
    del message["from"]
    message["from_user_id"] = CONTACT_BSUID

    await deliver(adapter, payload)

    (relayed,) = inbox.messages
    assert relayed.channel_id == CONTACT_BSUID
    assert relayed.sender_id == CONTACT_BSUID
    assert relayed.channel_name == "Ada"


async def test_a_person_whose_number_is_given_is_known_by_it() -> None:
    inbox = Inbox()
    adapter = await started(inbox)
    payload = delivery(text("hi"))
    value = payload["entry"][0]["changes"][0]["value"]
    value["contacts"] = [
        {"profile": {"name": "Ada"}, "user_id": CONTACT_BSUID, "wa_id": CONTACT}
    ]
    value["messages"][0]["from_user_id"] = CONTACT_BSUID

    await deliver(adapter, payload)

    (relayed,) = inbox.messages
    assert relayed.channel_id == CONTACT
    assert relayed.sender_id == CONTACT
    assert relayed.channel_name == "Ada"


async def test_two_people_with_one_profile_name_are_two_people() -> None:
    inbox = Inbox()
    adapter = await started(inbox)
    other = delivery(text("me too", wamid="wamid.IN2"))
    other["entry"][0]["changes"][0]["value"]["contacts"][0]["wa_id"] = "15557654321"
    other["entry"][0]["changes"][0]["value"]["messages"][0]["from"] = "15557654321"

    await deliver(adapter, delivery(text("hi")))
    await deliver(adapter, other)

    first, second = inbox.messages
    assert first.sender_name != second.sender_name


async def test_a_profile_named_like_an_agent_is_not_taken_for_one() -> None:
    inbox = Inbox()
    adapter = await started(inbox)
    payload = delivery(text("hi"))
    payload["entry"][0]["changes"][0]["value"]["contacts"][0]["profile"]["name"] = (
        "triage"
    )

    await deliver(adapter, payload)

    assert inbox.messages[0].sender_name != "triage"


async def test_opening_a_chat_for_the_first_time_is_not_a_message() -> None:
    inbox = Inbox()
    adapter = await started(inbox)
    welcome = {
        "from": CONTACT,
        "id": "wamid.W",
        "timestamp": NOW,
        "type": "request_welcome",
    }

    await deliver(adapter, delivery(welcome))

    assert inbox.messages == []


async def test_an_account_level_error_is_logged(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter = await started(Inbox())
    payload = delivery()
    payload["entry"][0]["changes"][0]["value"]["errors"] = [
        {"code": 131042, "title": "Business eligibility payment issue"}
    ]

    with caplog.at_level(logging.ERROR):
        await deliver(adapter, payload)

    assert "payment issue" in caplog.text


async def test_meta_unreachable_while_checking_credentials_says_so(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def unreachable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route", request=request)

    monkeypatch.setattr(
        adapter_module,
        "new_http",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(unreachable)),
    )

    with pytest.raises(BridgeCredentialError, match="Could not reach Meta"):
        await WhatsAppAdapter.verify_credentials(CONFIG)


async def test_a_quote_reply_is_threaded_under_the_message_it_quotes() -> None:
    inbox = Inbox()
    adapter = await started(inbox)
    quoted = {"from": BUSINESS_NUMBER, "id": "wamid.OUT7"}

    await deliver(adapter, delivery(text("yes, that one", context=quoted)))

    assert inbox.messages[0].root_id == "wamid.OUT7"


async def test_a_forward_is_not_mistaken_for_a_reply() -> None:
    inbox = Inbox()
    adapter = await started(inbox)

    await deliver(adapter, delivery(text("fwd", context={"forwarded": True})))

    assert inbox.messages[0].root_id is None


async def test_a_bang_command_reaches_the_command_handler() -> None:
    inbox = Inbox()
    adapter = await started(inbox)

    await deliver(adapter, delivery(text("!interrupt now")))

    assert inbox.messages == []
    (command,) = inbox.commands
    assert (command.command, command.args) == ("interrupt", "now")
    assert command.channel_id == CONTACT
    assert command.message_ref == "wamid.IN1"


@pytest.mark.parametrize("command", ["invite-agent", "list-switch-agents"])
async def test_a_command_that_reaches_every_agent_is_refused_from_whatsapp(
    meta: FakeMeta, command: str
) -> None:
    inbox = Inbox()
    adapter = await started(inbox)

    await deliver(adapter, delivery(text(f"!{command} triage")))

    assert inbox.commands == []
    (notice,) = meta.sent()
    assert f"!{command} is not available on WhatsApp" in notice["text"]["body"]


@pytest.mark.parametrize("args", ["triage", "@Triage"])
async def test_an_agent_the_connection_puts_in_new_chats_can_be_invited(
    meta: FakeMeta, args: str
) -> None:
    inbox = Inbox()
    adapter = await started(inbox, new_chat_agents="support, triage")

    await deliver(adapter, delivery(text(f"!invite-agent {args}")))

    (command,) = inbox.commands
    assert (command.command, command.args) == ("invite-agent", args)
    assert meta.sent() == []


@pytest.mark.parametrize(
    "body", ["!invite-agent deployer", "!invite-agent triage deployer"]
)
async def test_any_other_agent_is_still_refused(meta: FakeMeta, body: str) -> None:
    inbox = Inbox()
    adapter = await started(inbox, new_chat_agents="triage")

    await deliver(adapter, delivery(text(body)))

    assert inbox.commands == []
    (notice,) = meta.sent()
    assert "!invite-agent is not available on WhatsApp" in notice["text"]["body"]


async def test_the_business_number_s_own_messages_are_not_relayed() -> None:
    inbox = Inbox()
    adapter = await started(inbox)

    await deliver(adapter, delivery(text("echo", **{"from": BUSINESS_NUMBER})))

    assert inbox.messages == []


async def test_a_message_older_than_any_remembered_delivery_is_dropped() -> None:
    inbox = Inbox()
    adapter = await started(inbox)

    await deliver(adapter, delivery(text("replayed", timestamp="1600000000")))

    assert inbox.messages == []


@pytest.mark.parametrize(
    "body",
    [
        b'{"object": "whatsapp_business_account", "entry": ["x"]}',
        b'{"object": "whatsapp_business_account", "entry": [{"changes": "abc"}]}',
    ],
)
async def test_a_delivery_of_an_unknown_shape_is_unreadable_not_a_crash(
    body: bytes,
) -> None:
    adapter = await started(Inbox())

    with pytest.raises(WebhookPayloadError):
        adapter.parse_webhook(
            WebhookRequest(method="POST", headers={}, query={}, body=body)
        )


async def test_malformed_records_in_a_delivery_are_skipped() -> None:
    inbox = Inbox()
    adapter = await started(inbox)
    payload = delivery(text("still here"))
    value = payload["entry"][0]["changes"][0]["value"]
    value["messages"].insert(0, "not a message")
    value["contacts"].append({"profile": "not a profile", "wa_id": "1"})
    value["statuses"] = ["not a status"]

    await deliver(adapter, payload)

    assert [m.content for m in inbox.messages] == ["still here"]


async def test_a_button_press_on_a_card_becomes_an_interaction() -> None:
    inbox = Inbox()
    adapter = await started(inbox)

    await deliver(adapter, delivery(pressed("sw:tok-1:2", "2. Deny")))

    (interaction,) = inbox.interactions
    assert interaction.action_id == position_action(2)
    assert interaction.value == "tok-1"
    assert interaction.sender_id == CONTACT
    assert interaction.sender_name.startswith("AdaLovelace_")
    assert interaction.message_ref == "wamid.CARD"
    assert interaction.channel_id == CONTACT
    assert inbox.messages == []


@pytest.mark.parametrize(
    "reply_id", ["sw:tok-1:0", "sw:tok-1:x", "other:tok-1:1", "sw::1", "sw:tok-1:²"]
)
async def test_a_press_this_bridge_did_not_mint_is_not_an_answer(reply_id: str) -> None:
    inbox = Inbox()
    adapter = await started(inbox)

    await deliver(adapter, delivery(pressed(reply_id, "Deny")))

    assert inbox.interactions == []


async def test_an_image_arrives_as_an_attachment_with_its_caption(
    meta: FakeMeta,
) -> None:
    meta.media["7001"] = ("image/jpeg", b"\xff\xd8jpeg")
    inbox = Inbox()
    adapter = await started(inbox)
    image = media_message("image", "7001", mime_type="image/jpeg", caption="the bug")

    await deliver(adapter, delivery(image))

    (message,) = inbox.messages
    assert message.content == "the bug"
    (attachment,) = message.attachments
    assert attachment.mimetype == "image/jpeg"
    assert attachment.data == b"\xff\xd8jpeg"
    assert attachment.filename.endswith(".jpg")


async def test_a_document_keeps_its_own_filename(meta: FakeMeta) -> None:
    meta.media["7002"] = ("application/pdf", b"%PDF-1.7")
    inbox = Inbox()
    adapter = await started(inbox)
    document = media_message(
        "document", "7002", filename="report.pdf", mime_type="application/pdf"
    )

    await deliver(adapter, delivery(document))

    assert inbox.messages[0].attachments[0].filename == "report.pdf"


async def test_a_file_over_the_limit_is_disclosed_and_never_downloaded(
    meta: FakeMeta,
) -> None:
    meta.media["7003"] = ("video/mp4", b"x" * 4096)
    inbox = Inbox()
    adapter = await started(inbox)
    adapter.set_max_attachment_bytes(1024)

    await deliver(
        adapter, delivery(media_message("video", "7003", mime_type="video/mp4"))
    )

    (message,) = inbox.messages
    assert message.attachments == []
    (failure,) = message.attachment_failures
    assert "limit" in failure.reason
    assert all(request.url.host == "graph.facebook.com" for request in meta.requests)


async def test_a_file_meta_gives_no_size_for_is_still_held_to_the_limit(
    meta: FakeMeta,
) -> None:
    meta.media["7005"] = ("video/mp4", b"x" * 4096)
    meta.hide_sizes = True
    inbox = Inbox()
    adapter = await started(inbox)
    adapter.set_max_attachment_bytes(1024)

    await deliver(
        adapter, delivery(media_message("video", "7005", mime_type="video/mp4"))
    )

    (message,) = inbox.messages
    assert message.attachments == []
    assert "limit" in message.attachment_failures[0].reason


async def test_media_meta_says_is_somewhere_else_is_not_fetched(meta: FakeMeta) -> None:
    meta.media["7006"] = ("image/jpeg", b"jpeg")
    meta.media_host = "169.254.169.254"
    inbox = Inbox()
    adapter = await started(inbox)

    await deliver(
        adapter, delivery(media_message("image", "7006", mime_type="image/jpeg"))
    )

    assert inbox.messages[0].attachments == []
    assert all(r.url.host == "graph.facebook.com" for r in meta.requests)


async def test_a_file_whatsapp_will_not_hand_over_is_disclosed() -> None:
    inbox = Inbox()
    adapter = await started(inbox)

    await deliver(
        adapter, delivery(media_message("audio", "7004", mime_type="audio/ogg"))
    )

    (message,) = inbox.messages
    assert message.attachments == []
    assert len(message.attachment_failures) == 1


async def test_a_message_kind_bots_cannot_read_is_said_rather_than_dropped() -> None:
    inbox = Inbox()
    adapter = await started(inbox)
    unsupported = {
        "from": CONTACT,
        "id": "wamid.POLL",
        "timestamp": NOW,
        "type": "unsupported",
        "errors": [{"code": 131051, "title": "Message type unknown"}],
    }

    await deliver(adapter, delivery(unsupported))

    (message,) = inbox.messages
    assert "WhatsApp" in message.content
    assert "not" in message.content


async def test_a_shared_location_is_written_out() -> None:
    inbox = Inbox()
    adapter = await started(inbox)
    location = {
        "from": CONTACT,
        "id": "wamid.LOC",
        "timestamp": NOW,
        "type": "location",
        "location": {"latitude": 51.5, "longitude": -0.12, "name": "Office"},
    }

    await deliver(adapter, delivery(location))

    content = inbox.messages[0].content
    assert "51.5" in content
    assert "Office" in content


async def test_a_reaction_from_the_person_is_not_a_message() -> None:
    inbox = Inbox()
    adapter = await started(inbox)
    reaction = {
        "from": CONTACT,
        "id": "wamid.R",
        "timestamp": NOW,
        "type": "reaction",
        "reaction": {"message_id": "wamid.OUT1", "emoji": "👍"},
    }

    await deliver(adapter, delivery(reaction))

    assert inbox.messages == []
    assert inbox.commands == []


async def test_a_group_message_is_not_relayed_and_says_why(
    caplog: pytest.LogCaptureFixture,
) -> None:
    inbox = Inbox()
    adapter = await started(inbox)

    with caplog.at_level(logging.WARNING):
        await deliver(adapter, delivery(text("hello group", group_id="GROUP-1")))

    assert inbox.messages == []
    assert "group" in caplog.text.lower()


async def test_a_reply_refused_for_the_24_hour_window_is_logged_with_the_reason(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter = await started(Inbox())
    failed = {
        "id": "wamid.OUT3",
        "status": "failed",
        "timestamp": NOW,
        "recipient_id": CONTACT,
        "errors": [{"code": 131047, "title": "Re-engagement message"}],
    }

    with caplog.at_level(logging.ERROR):
        await deliver(adapter, delivery(statuses=[failed]))

    assert "24 hours" in caplog.text
    assert "wamid.OUT3" in caplog.text


async def test_delivered_and_read_receipts_are_quiet(
    caplog: pytest.LogCaptureFixture,
) -> None:
    inbox = Inbox()
    adapter = await started(inbox)
    read = {
        "id": "wamid.OUT3",
        "status": "read",
        "timestamp": "1",
        "recipient_id": CONTACT,
    }

    with caplog.at_level(logging.WARNING):
        await deliver(adapter, delivery(statuses=[read]))

    assert inbox.messages == []
    assert "WhatsApp" not in caplog.text
