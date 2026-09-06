"""The email bridge, inbound only.

An agent gets an address people can forward mail to. That is the whole of
Sprint 2 — no outbound, because "reply to a third party" is a different story
with its own authorization question, and dropping it removes most of the
weight: no SMTP, no `In-Reply-To` threading, and a sender allowlist in place of
DMARC evaluation.

Three things about this adapter are unlike every other one:

- **The sender is not authenticated by a platform.** Slack saying a message is
  from `U123` makes it so; an email `From` header is typed by whoever sent it.
  Against an owner-scoped addressing policy a forged `From` is privilege
  escalation, not spam, so mail from an address not on the allowlist never
  becomes a room message at all.
- **It cannot reply.** `send_message` raises rather than dropping an agent's
  words somewhere invisible.
- **The message is not unwrapped.** A forwarded mail arrives with its banner,
  its quoted headers and its chain intact, because the consumer is a language
  model that reads all of that perfectly well. Recovering the original sender
  as structured metadata has no cross-client standard and buys nothing here.
"""

from __future__ import annotations

from email.message import EmailMessage
from typing import Any

import pytest

from switch_core.bridges.collaboration.email.adapter import (
    EmailAdapter,
    EmailConnectionConfig,
)
from switch_core.bridges.collaboration.models import (
    BridgeOperationError,
    ChannelCreationUnsupported,
    InboundMessage,
)

OWNER = "owner@example.com"
STRANGER = "someone-else@example.net"


def _config(**overrides: Any) -> EmailConnectionConfig:
    values: dict[str, Any] = {
        "listen_port": 8099,
        "agent_address": "atlas@agents.example.com",
        "allowed_senders": [OWNER],
        "webhook_secret": "s" * 32,
    }
    values.update(overrides)
    return EmailConnectionConfig(**values)


def _adapter(**overrides: Any) -> tuple[EmailAdapter, list[InboundMessage]]:
    adapter = EmailAdapter(config=_config(**overrides))
    received: list[InboundMessage] = []

    async def on_message(msg: InboundMessage) -> None:
        received.append(msg)

    adapter.bind_message_handler(on_message)
    return adapter, received


def _mime(
    *,
    sender: str = f"Sam Owner <{OWNER}>",
    subject: str = "A subject",
    body: str = "The body.",
    html: str | None = None,
    headers: dict[str, str] | None = None,
    attachments: list[tuple[str, str, bytes]] | None = None,
) -> bytes:
    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = "atlas@agents.example.com"
    msg["Subject"] = subject
    msg["Message-ID"] = "<abc123@example.com>"
    for key, value in (headers or {}).items():
        msg[key] = value
    msg.set_content(body)
    if html is not None:
        msg.add_alternative(html, subtype="html")
    for filename, mimetype, data in attachments or []:
        maintype, _, subtype = mimetype.partition("/")
        msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=filename)
    return msg.as_bytes()


# ── What the agent ends up seeing ────────────────────────────────────────────


async def test_a_plain_message_becomes_a_room_message() -> None:
    adapter, received = _adapter()

    await adapter.ingest(_mime(body="Can you look at this?"))

    (msg,) = received
    assert "Can you look at this?" in msg.content
    assert msg.sender_id == OWNER
    assert msg.sender_name == "Sam Owner"


async def test_the_subject_reaches_the_agent() -> None:
    """It is where half the meaning of an email lives.

    Dropping it leaves an agent reading a forwarded body with no idea what the
    thread was called.
    """
    adapter, received = _adapter()

    await adapter.ingest(_mime(subject="Northwind API sunset", body="…"))

    assert "Northwind API sunset" in received[0].content


async def test_an_html_only_message_is_rendered_to_text() -> None:
    adapter, received = _adapter()
    msg = EmailMessage()
    msg["From"] = OWNER
    msg["Subject"] = "HTML"
    msg["Message-ID"] = "<h@example.com>"
    msg.set_content("<p>Hello <b>there</b></p>", subtype="html")

    await adapter.ingest(msg.as_bytes())

    body = received[0].content
    assert "Hello" in body and "there" in body
    assert "<p>" not in body


async def test_the_plain_part_is_preferred_over_the_html_one() -> None:
    adapter, received = _adapter()

    await adapter.ingest(_mime(body="the plain one", html="<p>the html one</p>"))

    assert "the plain one" in received[0].content


async def test_a_forward_is_passed_through_whole() -> None:
    """No unwrapping. The banner and the quoted chain are the context.

    A model reads them; the alternative is parsing a format every mail client
    writes differently, to recover metadata nothing here needs.
    """
    forwarded = (
        "Here you go.\n\n"
        "---------- Forwarded message ---------\n"
        "From: Vendor <api@vendor.example>\n"
        "Subject: v1 sunset\n\n"
        "We are retiring v1 on March 1."
    )
    adapter, received = _adapter()

    await adapter.ingest(_mime(body=forwarded))

    body = received[0].content
    assert "Forwarded message" in body
    assert "api@vendor.example" in body
    assert "retiring v1 on March 1" in body


async def test_the_sender_falls_back_to_the_address_when_unnamed() -> None:
    adapter, received = _adapter()

    await adapter.ingest(_mime(sender=OWNER))

    assert received[0].sender_name == OWNER


# ── Where it lands ───────────────────────────────────────────────────────────


async def test_mail_from_one_person_lands_in_one_room() -> None:
    """The channel is the correspondent, so a forwarding habit builds a thread
    rather than a room per message."""
    adapter, received = _adapter()

    await adapter.ingest(_mime(subject="first"))
    await adapter.ingest(_mime(subject="second"))

    # Both, explicitly: a set of one is also what a silently dropped second
    # message produces.
    assert len(received) == 2
    assert {m.channel_id for m in received} == {OWNER}


async def test_the_address_is_matched_and_recorded_case_insensitively() -> None:
    adapter, received = _adapter()

    await adapter.ingest(_mime(sender=f"Sam <{OWNER.upper()}>"))

    assert received[0].channel_id == OWNER


async def test_an_email_room_is_direct_so_every_message_addresses_the_agent() -> None:
    """There is no `@mention` convention in email, and inventing one would mean
    every forward needed a magic word to be seen."""
    adapter, received = _adapter()

    await adapter.ingest(_mime())

    assert received[0].channel_type == "direct"


async def test_the_message_id_is_carried_as_the_message_ref() -> None:
    adapter, received = _adapter()

    await adapter.ingest(_mime())

    assert received[0].message_ref == "<abc123@example.com>"


# ── Who is allowed to reach the agent ────────────────────────────────────────


async def test_mail_from_an_unlisted_address_never_becomes_a_message() -> None:
    """`From` is typed by the sender.

    Every other bridge sits behind a platform that authenticated the account.
    Here, admitting an unverified address to an agent whose addressing policy is
    owner-scoped hands a stranger the owner's authority.
    """
    adapter, received = _adapter()

    await adapter.ingest(_mime(sender=f"Not You <{STRANGER}>"))

    assert received == []


async def test_the_refusal_is_logged_rather_than_silent(
    caplog: Any,
) -> None:
    adapter, _ = _adapter()

    with caplog.at_level("WARNING"):
        await adapter.ingest(_mime(sender=STRANGER))

    assert any(STRANGER in r.getMessage() for r in caplog.records)


async def test_an_allowlisted_address_is_matched_regardless_of_case() -> None:
    adapter, received = _adapter(allowed_senders=[OWNER.upper()])

    await adapter.ingest(_mime(sender=OWNER))

    assert len(received) == 1


async def test_an_empty_allowlist_admits_nobody() -> None:
    """Not "everybody" — an unset allowlist on a publicly reachable inbox is a
    misconfiguration, and reading it as "open" is the expensive direction."""
    adapter, received = _adapter(allowed_senders=[])

    await adapter.ingest(_mime())

    assert received == []


# ── Loops ────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("header", "value"),
    [
        ("Auto-Submitted", "auto-replied"),
        ("Auto-Submitted", "auto-generated"),
        ("Precedence", "bulk"),
        ("Precedence", "junk"),
        ("X-Autoreply", "yes"),
        ("Return-Path", "<>"),
    ],
)
async def test_machine_generated_mail_is_dropped(header: str, value: str) -> None:
    """An autoresponder and an agent that answers mail is a loop that costs
    money and does not stop on its own."""
    adapter, received = _adapter()

    await adapter.ingest(_mime(headers={header: value}))

    assert received == []


@pytest.mark.parametrize("value", ["no", "auto-forwarded"])
async def test_a_person_s_mail_is_not_mistaken_for_a_machine(value: str) -> None:
    """Both values mean a human wrote it, and the check must read the value.

    `no` is what a well-behaved client puts on ordinary mail. `auto-forwarded`
    is RFC 3834's value for a human's mail being *relayed* — which is exactly
    how mail reaches this bridge, so reading it as a loop drops every message on
    any deployment whose forwarder follows the RFC.
    """
    adapter, received = _adapter()

    await adapter.ingest(_mime(headers={"Auto-Submitted": value}))

    assert len(received) == 1


async def test_a_forwarded_newsletter_is_not_a_loop_on_its_own() -> None:
    """`List-*` survives a server-side forward.

    A client-side "Forward" strips those headers; a sieve `redirect` or an MTA
    rule does not. Dropping on them alone loses mail a person deliberately sent,
    which is the whole use case.
    """
    adapter, received = _adapter()

    await adapter.ingest(_mime(headers={"List-Id": "<announce.example.com>"}))

    assert len(received) == 1


async def test_a_bulk_list_message_is_still_a_loop() -> None:
    """The combination is what says a machine sent it to a list, rather than a
    person forwarding something that once came from one."""
    adapter, received = _adapter()

    await adapter.ingest(
        _mime(headers={"List-Id": "<announce.example.com>", "Precedence": "list"})
    )

    assert received == []


# ── Attachments ──────────────────────────────────────────────────────────────


async def test_an_attachment_arrives_with_its_bytes() -> None:
    adapter, received = _adapter()

    await adapter.ingest(
        _mime(attachments=[("quote.pdf", "application/pdf", b"%PDF-1.4 fake")])
    )

    (att,) = received[0].attachments
    assert att.filename == "quote.pdf"
    assert att.mimetype == "application/pdf"
    assert att.data == b"%PDF-1.4 fake"


async def test_an_oversize_attachment_is_disclosed_rather_than_dropped() -> None:
    """A file that vanishes silently is worse than one that is refused loudly —
    the sender believes the agent has it."""
    adapter, received = _adapter()
    adapter.set_max_attachment_bytes(10)

    await adapter.ingest(
        _mime(attachments=[("big.pdf", "application/pdf", b"x" * 100)])
    )

    msg = received[0]
    assert msg.attachments == []
    (failure,) = msg.attachment_failures
    assert failure.filename == "big.pdf"


async def test_a_message_that_is_only_an_attachment_still_arrives() -> None:
    adapter, received = _adapter()

    await adapter.ingest(
        _mime(body="", attachments=[("a.txt", "text/plain", b"contents")])
    )

    assert len(received) == 1
    assert received[0].attachments[0].filename == "a.txt"


async def test_a_forwarded_part_containing_junk_does_not_raise() -> None:
    """A `message/rfc822` part whose content is not a message.

    `get_payload(0)` raises TypeError when the payload is a string rather than a
    list, and that escapes as a 500 the provider redelivers forever — failing
    identically every time, since the message will never parse.

    Note the shape survives a parse round-trip as an empty nested message, so
    this exercises the path rather than the raise; the guard in `_read_content`
    is for a payload reaching it unparsed. Asserted here because what matters at
    this entry point is that a junk forward costs the forward, not the delivery.
    """
    outer = EmailMessage()
    outer["From"] = f"Sam Owner <{OWNER}>"
    outer["Subject"] = "fwd"
    outer["Message-ID"] = "<broken@example.com>"
    outer.set_content("See attached.")
    outer.add_attachment(
        b"not a message at all",
        maintype="application",
        subtype="octet-stream",
        filename="x.eml",
    )
    # Relabel the part as a forwarded message without giving it the structure.
    for part in outer.iter_attachments():
        part.replace_header("Content-Type", "message/rfc822")

    adapter, received = _adapter()
    await adapter.ingest(outer.as_bytes())

    assert len(received) == 1
    assert "See attached." in received[0].content


async def test_a_huge_forwarded_message_is_truncated_visibly() -> None:
    """Serialising a nested message includes its own attachments in base64, so
    an unbounded flatten sails past what a Matrix event holds — and that
    rejection is another permanent 500."""
    inner = EmailMessage()
    inner["From"] = "Vendor <api@vendor.example>"
    inner["Subject"] = "big"
    inner.set_content("x" * 200_000)

    outer = EmailMessage()
    outer["From"] = f"Sam Owner <{OWNER}>"
    outer["Subject"] = "fwd"
    outer["Message-ID"] = "<fwd2@example.com>"
    outer.set_content("See below.")
    outer.add_attachment(inner, filename="big.eml")

    adapter, received = _adapter()
    await adapter.ingest(outer.as_bytes())

    body = received[0].content
    assert "truncated" in body
    assert len(body) < 100_000


# ── Malformed input ──────────────────────────────────────────────────────────


async def test_a_message_with_no_from_header_is_refused() -> None:
    adapter, received = _adapter()
    msg = EmailMessage()
    msg["Subject"] = "no sender"
    msg.set_content("hello")

    await adapter.ingest(msg.as_bytes())

    assert received == []


async def test_unparseable_bytes_do_not_take_the_listener_down() -> None:
    """One malformed delivery must not stop the next one arriving.

    Note these bytes do not actually raise — `message_from_bytes` returns a
    defective message with no `From`, so this exits through the ordinary refusal
    below. The exception path is covered by the handler test instead.
    """
    adapter, received = _adapter()

    await adapter.ingest(b"\xff\xfe not a mime message at all")
    await adapter.ingest(_mime())

    assert len(received) == 1


async def test_a_message_with_two_from_headers_is_dropped() -> None:
    """RFC 7489 requires rejecting these, because implementations disagree about
    which is authoritative — so a receiving MTA could DMARC-pass the second
    while this bridge attributes the mail to the first."""
    # Both headers allowlisted, so only the count check can cause the drop.
    # With an unlisted address in one of them the allowlist does the work and
    # this passes with the count check deleted.
    adapter, received = _adapter(allowed_senders=[OWNER, "other@example.com"])
    raw = _mime().replace(b"From: ", b"From: Other <other@example.com>\r\nFrom: ", 1)

    await adapter.ingest(raw)

    assert received == []


async def test_a_message_forwarded_as_an_attachment_is_still_read() -> None:
    """Apple Mail's and Outlook's default forward, and every "report this
    message" flow, arrive as `message/rfc822`.

    That part has no transfer encoding, so decoding it yields nothing: read as
    an attachment it becomes a failure and the forwarded mail is discarded,
    leaving only the covering note. The bridge would silently lose the thing it
    exists to carry.
    """
    inner = EmailMessage()
    inner["From"] = "Vendor <api@vendor.example>"
    inner["Subject"] = "v1 sunset"
    inner.set_content("We are retiring v1 on March 1.")

    outer = EmailMessage()
    outer["From"] = f"Sam Owner <{OWNER}>"
    outer["Subject"] = "fwd"
    outer["Message-ID"] = "<fwd@example.com>"
    outer.set_content("See below.")
    outer.add_attachment(inner, filename="forwarded.eml")

    adapter, received = _adapter()
    await adapter.ingest(outer.as_bytes())

    body = received[0].content
    assert "See below." in body
    assert "retiring v1 on March 1" in body
    assert received[0].attachment_failures == []


# ── What this adapter declines to do ─────────────────────────────────────────


def test_the_platform_capabilities_are_declared_honestly() -> None:
    assert EmailAdapter.supports_channel_creation is False
    assert EmailAdapter.supports_directory_search is False
    assert EmailAdapter.renders_custom_url_schemes is False


def test_it_declares_that_it_does_not_authenticate_senders() -> None:
    """Every other adapter inherits True and means it. This one is the reason
    the flag exists: the addressing layer cannot treat a `From` header the way
    it treats a Slack user id."""
    assert EmailAdapter.authenticates_senders is False


async def test_sending_raises_rather_than_dropping_the_agent_s_reply() -> None:
    """Inbound-only is a real limitation and must read as one.

    Returning quietly would put an agent's answer nowhere, with the room
    showing it as sent.
    """
    adapter, _ = _adapter()

    with pytest.raises(BridgeOperationError) as excinfo:
        await adapter.send_message(OWNER, "Atlas", "here is your answer")

    assert "inbound" in str(excinfo.value).lower()


async def test_an_admin_notice_is_logged_rather_than_raising(caplog: Any) -> None:
    """The bridge core posts notices through `admin_message`, and one of them
    fires on the path that auto-creates a room.

    A room auto-created for a new correspondent resolves no agents — email has
    no channel membership to read them from — so the core posts its "no agents
    here" notice. Left to the default, that reaches `send_message` and raises,
    out of the room-creation path, for a bridge working exactly as intended.

    There is no external channel to post a notice to, so this is a disclosed
    degradation: logged, loudly, rather than sent or silently discarded.
    """
    adapter, _ = _adapter()

    with caplog.at_level("WARNING"):
        result = await adapter.admin_message(OWNER, "No agents are in this room.")

    assert result is None
    assert any("No agents are in this room." in r.getMessage() for r in caplog.records)


async def test_editing_and_deleting_raise_because_email_is_append_only() -> None:
    adapter, _ = _adapter()

    with pytest.raises(BridgeOperationError):
        await adapter.update_message(OWNER, "<abc123@example.com>", "edited")
    with pytest.raises(BridgeOperationError):
        await adapter.delete_message(OWNER, "<abc123@example.com>")


async def test_typing_is_a_no_op_so_no_status_email_is_ever_sent() -> None:
    """The base runtime-state handling drives `send_typing`. If that sent mail,
    every turn would post "working on it…" to somebody's inbox."""
    adapter, _ = _adapter()

    assert await adapter.send_typing(OWNER, "Atlas", True) is None
    assert await adapter.send_typing(OWNER, "Atlas", False) is None


async def test_creating_a_channel_is_declined_before_it_is_attempted() -> None:
    adapter, _ = _adapter()

    with pytest.raises(ChannelCreationUnsupported):
        await adapter.create_channel("nope", "topic")


# ── Registration-time behaviour ──────────────────────────────────────────────


def test_the_listener_port_is_declared_as_an_exclusive_resource() -> None:
    """Two bridges on one port is a bind error in a background task minutes
    later; declared here it is a refusal at registration naming the port."""
    resource = EmailAdapter.exclusive_resource(_config(listen_port=9123).model_dump())

    assert resource is not None
    assert "9123" in resource


async def test_a_webhook_secret_is_minted_at_registration() -> None:
    """Without one, anything that can reach the port can post mail as anyone.

    Minted in `prepare_config` rather than defaulted on the model: a default is
    re-evaluated every time a stored config is validated, so every restart would
    mint a fresh secret and silently invalidate the URL the provider is posting
    to.
    """
    prepared = await EmailAdapter.prepare_config(
        {
            "listen_port": 8099,
            "agent_address": "atlas@agents.example.com",
            "allowed_senders": [OWNER],
        }
    )

    secret = prepared["webhook_secret"]
    assert isinstance(secret, str)
    assert len(secret) >= 32


async def test_an_existing_secret_survives_being_prepared_again() -> None:
    prepared = await EmailAdapter.prepare_config(
        {
            "listen_port": 8099,
            "agent_address": "atlas@agents.example.com",
            "allowed_senders": [OWNER],
            "webhook_secret": "keep-me-" + "k" * 24,
        }
    )

    assert prepared["webhook_secret"] == "keep-me-" + "k" * 24


async def test_it_refuses_to_listen_without_a_usable_secret() -> None:
    """`prepare_config` mints one at registration and nothing re-runs it.

    A config updated afterwards can carry an empty secret, and the route is then
    `/inbound/` — reachable by anyone who can reach the port, accepting mail as
    any allowed sender, with the bridge logging "listening on…" and looking
    healthy. `start` is the last place to catch that.
    """
    adapter = EmailAdapter(config=_config(webhook_secret=""))

    async def unused(_msg: Any) -> None:  # pragma: no cover - never called
        raise AssertionError("nothing should be delivered")

    with pytest.raises(BridgeOperationError) as excinfo:
        await adapter.start(unused, unused, unused, unused, unused)

    assert "secret" in str(excinfo.value)


async def test_a_short_secret_is_refused_too() -> None:
    """Long enough to be minted, short enough to guess, is still open."""
    adapter = EmailAdapter(config=_config(webhook_secret="short"))

    async def unused(_msg: Any) -> None:  # pragma: no cover - never called
        raise AssertionError("nothing should be delivered")

    with pytest.raises(BridgeOperationError):
        await adapter.start(unused, unused, unused, unused, unused)


def test_the_secret_survives_being_nested_in_another_schema() -> None:
    """Hiding it by overriding `model_json_schema` only worked on a direct call.

    Pydantic builds a nested or `TypeAdapter`-wrapped schema from the core
    schema and never calls that classmethod, so the secret came back — and
    FastAPI's OpenAPI generation is one of those paths. `SkipJsonSchema` holds
    everywhere.
    """
    from pydantic import TypeAdapter

    schema = TypeAdapter(EmailConnectionConfig).json_schema()

    assert "webhook_secret" not in schema["properties"]


def test_the_secret_is_kept_out_of_the_operator_form() -> None:
    """It is minted, not typed. Showing it as a field invites someone to supply
    a weak one, and the dashboard builds its form from this schema."""
    schema = EmailConnectionConfig.model_json_schema()

    assert "webhook_secret" not in schema["properties"]
