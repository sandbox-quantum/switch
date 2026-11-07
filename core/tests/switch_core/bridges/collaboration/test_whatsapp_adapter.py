"""WhatsApp out: messages, files, cards with native buttons, and failures."""

from __future__ import annotations

import logging
from dataclasses import replace

import httpx
import pytest

from switch_core.bridges.collaboration.adapter import (
    ActivityMarkRefused,
    ChannelNotBindable,
    RequestCard,
    RichContentFailed,
    TurnActivity,
)
from switch_core.bridges.collaboration.models import (
    BridgeOperationError,
    ChannelCreationUnsupported,
)
from switch_core.bridges.collaboration.session.renderers import (
    Control,
    RequestReference,
)
from switch_core.bridges.collaboration.whatsapp import adapter as adapter_module
from switch_core.bridges.collaboration.whatsapp.adapter import (
    WhatsAppAdapter,
    WhatsAppConnectionConfig,
    card_layout,
)
from switch_core.bridges.collaboration.whatsapp.client import WhatsAppApiError
from switch_core.bridges.collaboration.whatsapp.markup import MAX_TEXT

from .session_fixtures import (
    EXAMPLES_PATH,
    _item,
    _turn,
    open_request,
    recorded_requests,
)
from .whatsapp_fakes import (
    CONFIG,
    CONTACT,
    CONTACT_BSUID,
    FakeMeta,
    Inbox,
    install_fake_meta,
    started,
)


@pytest.fixture(autouse=True)
def meta(monkeypatch: pytest.MonkeyPatch) -> FakeMeta:
    return install_fake_meta(monkeypatch)


def _card() -> RequestCard:
    return RequestCard(open_request(), RequestReference(token="tok-1", handle="R7"))


def _settled() -> RequestCard:
    request = recorded_requests(EXAMPLES_PATH, "answerLifecycle")["request-demo"]
    return RequestCard(request, RequestReference(token="tok-1", handle="R7"))


def _activity(status: str, error_summary: str | None = None) -> TurnActivity:
    items = [_item(kind="assistant-message", title="", text="Looking now.")]
    return TurnActivity(items, _turn(status), error_summary=error_summary)


# ── What it declares ─────────────────────────────────────────────────────────


def test_it_declares_what_whatsapp_cannot_do() -> None:
    assert WhatsAppAdapter.display_name == "WhatsApp"
    assert WhatsAppAdapter.separate_attention_slot
    assert not WhatsAppAdapter.discloses_unconfirmed_posts
    assert WhatsAppAdapter.receives_webhooks
    assert WhatsAppAdapter.draws_session_activity
    assert not WhatsAppAdapter.supports_channel_creation
    assert not WhatsAppAdapter.supports_directory_search
    assert not WhatsAppAdapter.renders_custom_url_schemes
    assert WhatsAppAdapter.supports_activity_reactions
    assert not WhatsAppAdapter.supports_queue_reaction
    assert WhatsAppAdapter.icon_svg() is not None


async def test_a_chat_cannot_be_created_or_bound_by_number() -> None:
    adapter = await started(Inbox())

    with pytest.raises(ChannelCreationUnsupported):
        await adapter.create_channel("standup", "channel_private")
    assert "24 hours" in (adapter.channel_ids_refused() or "")
    assert await adapter.get_channel_type(CONTACT) == "direct"


# ── Messages ─────────────────────────────────────────────────────────────────


async def test_a_reply_is_sent_under_the_agent_s_name_quoting_its_thread(
    meta: FakeMeta,
) -> None:
    adapter = await started(Inbox())

    ref = await adapter.send_message(
        CONTACT, "triage", adapter.translate_outbound("**Done**"), "wamid.IN1"
    )

    assert ref == "wamid.OUT1"
    (sent,) = meta.sent()
    assert sent["to"] == CONTACT
    assert sent["type"] == "text"
    assert sent["text"]["body"] == "*triage*\n*Done*"
    assert sent["context"] == {"message_id": "wamid.IN1"}


async def test_a_long_reply_is_split_and_only_the_first_part_quotes(
    meta: FakeMeta,
) -> None:
    adapter = await started(Inbox())
    long = "\n\n".join(["word " * 400] * 4)

    ref = await adapter.send_message(CONTACT, "triage", long, "wamid.IN1")

    sent = meta.sent()
    assert ref == "wamid.OUT1"
    assert len(sent) > 1
    assert all(len(body["text"]["body"]) <= MAX_TEXT for body in sent)
    assert "context" in sent[0]
    assert all("context" not in body for body in sent[1:])


async def test_a_thread_root_that_is_not_a_whatsapp_message_is_not_quoted(
    meta: FakeMeta,
) -> None:
    adapter = await started(Inbox())

    await adapter.send_message(CONTACT, "triage", "hi", "turn:abc")

    assert "context" not in meta.sent()[0]


async def test_a_reply_outside_the_24_hour_window_fails_saying_why(
    meta: FakeMeta,
) -> None:
    meta.refuse("/messages", 400, 131047, "Re-engagement message")
    adapter = await started(Inbox())

    with pytest.raises(BridgeOperationError, match="24 hours"):
        await adapter.send_message(CONTACT, "triage", "hi", None)


async def test_any_other_refusal_is_raised_with_meta_s_reason(meta: FakeMeta) -> None:
    meta.refuse("/messages", 400, 131026, "Message undeliverable")
    adapter = await started(Inbox())

    with pytest.raises(BridgeOperationError, match="Message undeliverable"):
        await adapter.send_message(CONTACT, "triage", "hi", None)


async def test_edits_and_deletes_are_not_sent_and_say_so(
    meta: FakeMeta, caplog: pytest.LogCaptureFixture
) -> None:
    adapter = await started(Inbox())

    with caplog.at_level(logging.WARNING):
        await adapter.update_message(CONTACT, "wamid.OUT1", "edited")
        await adapter.delete_message(CONTACT, "wamid.OUT1")

    assert meta.sent() == []
    assert "edit" in caplog.text
    assert "delete" in caplog.text


def test_outbound_markdown_is_rendered_and_mass_mentions_defused() -> None:
    adapter = WhatsAppAdapter(config=WhatsAppConnectionConfig.model_validate(CONFIG))

    rendered = adapter.translate_outbound("# Plan\n**ship** it @here")

    assert rendered.startswith("*Plan*\n*ship* it")
    assert "@here" not in rendered


# ── Files ────────────────────────────────────────────────────────────────────


async def test_an_image_is_uploaded_and_sent_with_its_caption(meta: FakeMeta) -> None:
    adapter = await started(Inbox())

    ref = await adapter.send_attachment(
        CONTACT, "triage", "chart.png", "image/png", b"\x89PNG", caption="Today"
    )

    upload = next(r for r in meta.requests if r.url.path.endswith("/media"))
    assert b"chart.png" in upload.content
    (sent,) = meta.sent()
    assert sent["type"] == "image"
    assert sent["image"]["id"].startswith("MEDIA-UP")
    assert sent["image"]["caption"] == "*triage*\nToday"
    assert ref == "wamid.OUT1"


async def test_a_document_keeps_its_filename(meta: FakeMeta) -> None:
    adapter = await started(Inbox())

    await adapter.send_attachment(
        CONTACT, "triage", "report.pdf", "application/pdf", b"%PDF", caption=None
    )

    (sent,) = meta.sent()
    assert sent["type"] == "document"
    assert sent["document"]["filename"] == "report.pdf"
    assert sent["document"]["caption"] == "*triage*"


async def test_audio_has_no_caption_so_the_caption_follows_it(meta: FakeMeta) -> None:
    adapter = await started(Inbox())

    await adapter.send_attachment(
        CONTACT, "triage", "note.mp3", "audio/mpeg", b"ID3", caption="Listen"
    )

    audio, caption = meta.sent()
    assert audio["type"] == "audio"
    assert "caption" not in audio["audio"]
    assert caption["text"]["body"] == "*triage*\nListen"


async def test_media_too_big_to_play_inline_goes_as_a_document(
    meta: FakeMeta,
) -> None:
    adapter = await started(Inbox())
    clip = b"x" * (16 * 1024 * 1024 + 1)

    await adapter.send_attachment(
        CONTACT, "triage", "clip.mp4", "video/mp4", clip, caption=None
    )

    (sent,) = meta.sent()
    assert sent["type"] == "document"
    assert sent["document"]["filename"] == "clip.mp4"


async def test_a_file_over_every_limit_is_refused_visibly_and_not_uploaded(
    meta: FakeMeta, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setitem(adapter_module._MEDIA_LIMITS, "document", 1024)
    adapter = await started(Inbox())

    ref = await adapter.send_attachment(
        CONTACT, "triage", "report.pdf", "application/pdf", b"x" * 2048, caption=None
    )

    assert not any(r.url.path.endswith("/media") for r in meta.requests)
    (notice,) = meta.sent()
    assert "report.pdf was not sent" in notice["text"]["body"]
    assert "1 KB" in notice["text"]["body"]
    assert ref == "wamid.OUT1"


async def test_a_type_whatsapp_does_not_take_is_refused_visibly(meta: FakeMeta) -> None:
    adapter = await started(Inbox())

    await adapter.send_attachment(
        CONTACT, "triage", "anim.gif", "image/gif", b"GIF89a", caption=None
    )

    assert not any(r.url.path.endswith("/media") for r in meta.requests)
    (notice,) = meta.sent()
    assert "anim.gif was not sent" in notice["text"]["body"]
    assert "image/gif" in notice["text"]["body"]


async def test_other_text_goes_as_a_plain_text_document(meta: FakeMeta) -> None:
    adapter = await started(Inbox())

    await adapter.send_attachment(
        CONTACT, "triage", "data.json", "application/json", b"{}", caption=None
    )

    upload = next(r for r in meta.requests if r.url.path.endswith("/media"))
    assert b"text/plain" in upload.content
    assert meta.sent()[0]["document"]["filename"] == "data.json"


# ── Cards ────────────────────────────────────────────────────────────────────


def _controls(count: int) -> list[Control]:
    return [Control(position=n, label=f"Option {n}") for n in range(1, count + 1)]


@pytest.mark.parametrize(
    ("count", "layout"),
    [(1, "buttons"), (3, "buttons"), (4, "list"), (10, "list"), (11, None)],
)
def test_a_card_uses_buttons_then_a_list_then_typed_answers(
    count: int, layout: str | None
) -> None:
    assert card_layout(_controls(count), token="tok-1") == layout


def test_a_token_too_long_for_a_reply_id_falls_back_to_typed_answers() -> None:
    assert card_layout(_controls(2), token="t" * 300) is None


async def test_an_open_card_is_sent_with_a_reply_button_per_option(
    meta: FakeMeta,
) -> None:
    adapter = await started(Inbox())

    ref = await adapter.post_rich(CONTACT, "triage", _card(), "wamid.IN1")

    assert ref == "wamid.OUT1"
    (sent,) = meta.sent()
    assert sent["type"] == "interactive"
    assert sent["context"] == {"message_id": "wamid.IN1"}
    interactive = sent["interactive"]
    assert interactive["type"] == "button"
    assert interactive["body"]["text"].startswith("*triage*\n")
    assert len(interactive["body"]["text"]) <= 1024
    buttons = interactive["action"]["buttons"]
    assert [b["reply"]["id"] for b in buttons] == ["sw:tok-1:1", "sw:tok-1:2"]
    assert [b["reply"]["title"] for b in buttons] == ["1. Allow once", "2. Deny"]
    assert all(len(b["reply"]["title"]) <= 20 for b in buttons)


async def test_an_answered_card_s_redraw_sends_nothing(meta: FakeMeta) -> None:
    adapter = await started(Inbox())
    ref = await adapter.post_rich(CONTACT, "triage", _card(), None)

    await adapter.update_rich(CONTACT, "triage", ref, _settled(), None)

    assert len(meta.sent()) == 1


async def test_a_redraw_of_a_card_still_open_sends_nothing(meta: FakeMeta) -> None:
    adapter = await started(Inbox())
    ref = await adapter.post_rich(CONTACT, "triage", _card(), None)

    await adapter.update_rich(CONTACT, "triage", ref, _card(), None)

    assert len(meta.sent()) == 1


async def test_a_card_whatsapp_refuses_raises_rich_content_failed(
    meta: FakeMeta,
) -> None:
    meta.refuse("/messages", 400, 131009, "Parameter value is not valid")
    adapter = await started(Inbox())

    with pytest.raises(RichContentFailed) as raised:
        await adapter.post_rich(CONTACT, "triage", _card(), None)
    assert raised.value.text


async def test_a_card_too_long_for_buttons_is_offered_as_a_list(
    meta: FakeMeta,
) -> None:
    adapter = await started(Inbox())
    card = _card()
    content = card.request.content
    long_title = content.model_copy(update={"title": "Run: " + "x" * 400})
    wordy = replace(
        card, request=card.request.model_copy(update={"content": long_title})
    )

    await adapter.post_rich(CONTACT, "triage", wordy, None)

    (sent,) = meta.sent()
    assert sent["interactive"]["type"] == "list"
    rows = sent["interactive"]["action"]["sections"][0]["rows"]
    assert [row["id"] for row in rows] == ["sw:tok-1:1", "sw:tok-1:2"]


async def test_a_card_whatsapp_could_not_be_reached_for_is_refused_to_retry(
    meta: FakeMeta,
) -> None:
    def unreachable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route", request=request)

    adapter = await started(Inbox())
    adapter._api._http = httpx.AsyncClient(transport=httpx.MockTransport(unreachable))

    with pytest.raises(RichContentFailed):
        await adapter.post_rich(CONTACT, "triage", _card(), None)


async def test_a_card_drawn_without_buttons_still_reads_as_a_typed_answer(
    meta: FakeMeta,
) -> None:
    adapter = await started(Inbox())
    card = replace(_card(), reference=RequestReference(token="t" * 300, handle="R7"))

    await adapter.post_rich(CONTACT, "triage", card, None)

    (sent,) = meta.sent()
    assert sent["type"] == "text"
    assert "R7" in sent["text"]["body"]


# ── A turn's activity ────────────────────────────────────────────────────────


async def test_a_running_turn_posts_nothing_since_whatsapp_cannot_edit_it(
    meta: FakeMeta,
) -> None:
    adapter = await started(Inbox())

    ref = await adapter.post_rich(CONTACT, "triage", _activity("running"), None)
    await adapter.update_rich(CONTACT, "triage", ref, _activity("completed"), None)

    assert meta.sent() == []
    assert ref


async def test_a_failure_that_arrives_on_a_redraw_is_said(meta: FakeMeta) -> None:
    adapter = await started(Inbox())
    failed = _activity("error", error_summary="The agent stopped unexpectedly.")

    ref = await adapter.post_rich(CONTACT, "triage", _activity("running"), None)
    await adapter.update_rich(CONTACT, "triage", ref, _activity("running"), None)
    await adapter.update_rich(CONTACT, "triage", ref, failed, None)

    (notice,) = meta.sent()
    assert "stopped unexpectedly" in notice["text"]["body"]


async def test_a_turn_that_fails_before_its_first_post_is_said_at_once(
    meta: FakeMeta,
) -> None:
    adapter = await started(Inbox())

    ref = await adapter.post_rich(
        CONTACT, "triage", _activity("error", error_summary="No model access."), None
    )

    assert ref == "wamid.OUT1"
    assert "No model access" in meta.sent()[0]["text"]["body"]


# ── Working indicators ───────────────────────────────────────────────────────


async def test_work_is_marked_with_a_reaction_and_unmarked_after(
    meta: FakeMeta,
) -> None:
    adapter = await started(Inbox())

    await adapter.mark_activity(
        CONTACT, "wamid.IN1", agent_name="triage", mark="working", on=True
    )
    await adapter.mark_activity(
        CONTACT, "wamid.IN1", agent_name="triage", mark="working", on=False
    )

    on, off = meta.sent()
    assert on["type"] == "reaction"
    assert on["reaction"] == {"message_id": "wamid.IN1", "emoji": "👀"}
    assert off["reaction"] == {"message_id": "wamid.IN1", "emoji": ""}


async def test_working_shows_typing_against_the_message_that_asked(
    meta: FakeMeta,
) -> None:
    adapter = await started(Inbox())

    await adapter.mark_activity(
        CONTACT, "wamid.ASKED", agent_name="triage", mark="working", on=True
    )
    await adapter.mark_activity(
        CONTACT, "wamid.ASKED", agent_name="triage", mark="working", on=False
    )

    assert meta.receipts() == [
        {
            "messaging_product": "whatsapp",
            "status": "read",
            "message_id": "wamid.ASKED",
            "typing_indicator": {"type": "text"},
        }
    ]


async def test_a_person_known_only_by_username_is_written_to_by_their_scoped_id(
    meta: FakeMeta,
) -> None:
    adapter = await started(Inbox())

    await adapter.send_message(CONTACT_BSUID, "triage", "hi", None)
    await adapter.mark_activity(
        CONTACT_BSUID, "wamid.IN1", agent_name="triage", mark="working", on=True
    )

    text_message, reaction = meta.sent()
    assert text_message["recipient"] == CONTACT_BSUID
    assert "to" not in text_message
    assert reaction["recipient"] == CONTACT_BSUID


async def test_a_room_cannot_be_bound_to_a_number_typed_in() -> None:
    adapter = await started(Inbox())

    with pytest.raises(ChannelNotBindable, match="24 hours"):
        await adapter.require_bindable_channel("15559998888")


async def test_a_reaction_whatsapp_will_never_take_is_refused_for_good(
    meta: FakeMeta,
) -> None:
    meta.refuse("/messages", 400, 131009, "Message is too old to react to")
    adapter = await started(Inbox())

    with pytest.raises(ActivityMarkRefused):
        await adapter.mark_activity(
            CONTACT, "wamid.OLD", agent_name="triage", mark="working", on=True
        )


async def test_typing_with_no_message_to_answer_is_skipped(meta: FakeMeta) -> None:
    adapter = await started(Inbox())

    await adapter.send_typing(CONTACT, "triage", True)

    assert meta.receipts() == []


# ── Failures ─────────────────────────────────────────────────────────────────


def test_meta_s_failures_are_named() -> None:
    def error(code: int) -> WhatsAppApiError:
        return WhatsAppApiError(status=400, code=code, subcode=None, message="x")

    assert WhatsAppAdapter.classify_failure(error(190)) == "auth_failed"
    assert WhatsAppAdapter.classify_failure(error(131047)) == "platform_error"
    assert WhatsAppAdapter.classify_failure(ValueError("not ours")) is None
    assert WhatsAppAdapter.classify_failure(httpx.ConnectError("down")) == "network"
