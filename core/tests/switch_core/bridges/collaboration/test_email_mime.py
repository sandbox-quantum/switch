from __future__ import annotations

from datetime import UTC, datetime
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser

import pytest

from switch_core.bridges.collaboration.email.mime import (
    SWITCH_HEADER,
    MailboxConfigError,
    authentication_verdict,
    automated_reason,
    build_message,
    clean_subject,
    html_to_text,
    normalise_address,
    parse_allowed_senders,
    read_message,
    render_html,
    reply_subject,
    sender_allowed,
    stable_message_id,
    strip_reply,
    thread_root,
)
from switch_core.bridges.collaboration.models import OutboundAttachment


def _mail(headers: dict[str, str], body: str = "Hello") -> EmailMessage:
    message = EmailMessage()
    for name, value in headers.items():
        message[name] = value
    message.set_content(body)
    return message


def _raw(headers: dict[str, str], body: str = "Hello") -> bytes:
    return _mail(headers, body).as_bytes()


BASIC = {
    "From": "Ada Lovelace <Ada@Example.com>",
    "To": "room@acme.test",
    "Subject": "Deploy failed",
    "Message-ID": "<one@example.com>",
}


# ── Addresses and the allow list ─────────────────────────────────────────────


def test_an_address_is_lowercased_and_stripped_of_its_name() -> None:
    assert normalise_address("  Ada <Ada@Example.COM> ") == "ada@example.com"


@pytest.mark.parametrize("value", ["", "nobody", "@example.com", "a@", "a@b@c"])
def test_something_that_is_not_an_address_is_refused(value: str) -> None:
    with pytest.raises(MailboxConfigError):
        normalise_address(value)


def test_the_allow_list_reads_every_separator_and_drops_repeats() -> None:
    assert parse_allowed_senders("A@x.com, b@x.com;\n@Acme.com\nA@x.com") == (
        "a@x.com",
        "b@x.com",
        "@acme.com",
    )


@pytest.mark.parametrize("value", ["", " , ", "@", "@nodot", "not-an-address"])
def test_an_unusable_allow_list_is_refused(value: str) -> None:
    with pytest.raises(MailboxConfigError):
        parse_allowed_senders(value)


def test_a_sender_is_allowed_by_address_or_by_domain() -> None:
    allowed = ("ada@example.com", "@acme.com")
    assert sender_allowed("ADA@example.com", allowed)
    assert sender_allowed("anyone@acme.com", allowed)
    assert not sender_allowed("eve@example.com", allowed)
    assert not sender_allowed("eve@notacme.com", allowed)


def test_a_subdomain_is_not_its_parent_on_the_allow_list() -> None:
    assert not sender_allowed("eve@acme.com.evil.test", ("@acme.com",))


# ── Threads and subjects ─────────────────────────────────────────────────────


def test_a_new_message_has_no_thread_root() -> None:
    assert thread_root(_mail(BASIC)) is None


def test_the_root_is_the_oldest_reference() -> None:
    message = _mail(
        {**BASIC, "References": "<root@x> <middle@x>", "In-Reply-To": "<middle@x>"}
    )
    assert thread_root(message) == "<root@x>"


def test_in_reply_to_is_the_root_when_a_client_sends_no_references() -> None:
    assert thread_root(_mail({**BASIC, "In-Reply-To": "<root@x>"})) == "<root@x>"


@pytest.mark.parametrize(
    ("subject", "cleaned"),
    [
        ("Re: Deploy", "Deploy"),
        ("RE: Fwd: AW: Deploy", "Deploy"),
        ("Re[2]: Deploy", "Deploy"),
        ("Regarding the deploy", "Regarding the deploy"),
        ("", ""),
    ],
)
def test_a_subject_loses_only_its_prefixes(subject: str, cleaned: str) -> None:
    assert clean_subject(subject) == cleaned


def test_a_reply_subject_carries_one_prefix() -> None:
    assert reply_subject("Re: Re: Deploy") == "Re: Deploy"


# ── Automated mail ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "headers",
    [
        {"Auto-Submitted": "auto-replied"},
        {"Auto-Submitted": "auto-generated"},
        {"Precedence": "bulk"},
        {"Precedence": "list"},
        {"Precedence": "junk"},
        {"List-Id": "<team.lists.example.com>"},
        {"X-Autoreply": "yes"},
        {"X-Autorespond": "1"},
    ],
)
def test_automated_mail_is_recognised(headers: dict[str, str]) -> None:
    assert automated_reason(_mail({**BASIC, **headers}), "<ada@example.com>")


def test_a_bounce_is_recognised_by_its_empty_return_path() -> None:
    assert automated_reason(_mail(BASIC), "<>") is not None


def test_a_delivery_report_is_recognised() -> None:
    report = EmailMessage()
    report["From"] = "mailer-daemon@example.com"
    report.set_content("failed")
    report.make_mixed()
    report.set_type("multipart/report")
    assert automated_reason(report, "<x@example.com>") is not None


def test_a_person_writing_is_not_automated() -> None:
    message = _mail({**BASIC, "Auto-Submitted": "no"})
    assert automated_reason(message, "<ada@example.com>") is None


# ── Who really sent it ───────────────────────────────────────────────────────


def _authenticated(*results: str) -> EmailMessage:
    message = _mail(BASIC)
    for result in results:
        message["Authentication-Results"] = result
    return message


@pytest.mark.parametrize(
    "result",
    [
        "mx.acme.test; dmarc=pass header.from=example.com",
        "mx.acme.test; dkim=pass header.d=example.com; spf=fail",
        "mx.acme.test; dkim=pass header.i=@example.com",
        "mx.acme.test; spf=pass smtp.mailfrom=bounce@example.com",
        "mx.acme.test; spf=pass smtp.mailfrom=mail.example.com",
    ],
)
def test_a_verified_domain_passes(result: str) -> None:
    verdict = authentication_verdict(_authenticated(result), "ada@example.com", None)
    assert verdict.passed, verdict.detail


@pytest.mark.parametrize(
    "result",
    [
        "mx.acme.test; dmarc=fail header.from=example.com",
        "mx.acme.test; dkim=pass header.d=evil.test",
        "mx.acme.test; spf=pass smtp.mailfrom=evil.test",
        "mx.acme.test; none",
        "mx.acme.test; dkim=none",
    ],
)
def test_anything_else_fails(result: str) -> None:
    verdict = authentication_verdict(_authenticated(result), "ada@example.com", None)
    assert not verdict.passed


def test_no_header_fails() -> None:
    assert not authentication_verdict(_mail(BASIC), "ada@example.com", None).passed


def test_a_header_the_sender_wrote_below_the_servers_is_not_believed() -> None:
    message = _authenticated(
        "mx.acme.test; dmarc=fail header.from=example.com",
        "mx.acme.test; dmarc=pass header.from=example.com",
    )
    assert not authentication_verdict(message, "ada@example.com", None).passed


def test_only_the_named_server_is_believed() -> None:
    forged = _authenticated("mx.evil.test; dmarc=pass header.from=example.com")
    verdict = authentication_verdict(forged, "ada@example.com", "mx.acme.test")
    assert not verdict.passed
    genuine = _authenticated(
        "mx.evil.test; dmarc=fail",
        "MX.acme.test 1; dmarc=pass header.from=example.com",
    )
    assert authentication_verdict(genuine, "ada@example.com", "mx.acme.test").passed


# ── What the person wrote ────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "tail",
    [
        "On Thu, Oct 30, 2026 at 10:15 AM Ada <ada@example.com> wrote:\n> old",
        "On Thu, Oct 30, 2026 at 10:15 AM A Very Long Name Indeed\n<ada@example.com> wrote:\n> old",
        "-----Original Message-----\nFrom: Ada\nold",
        "---------- Forwarded message ---------\nFrom: Ada\nold",
        "From: Ada <ada@example.com>\nSent: Thursday\nTo: Room\nSubject: x\n\nold",
        "________________________________\nFrom: Ada\nold",
        "-- \nAda Lovelace\nCTO",
        "--\nAda Lovelace",
    ],
)
def test_quoted_history_and_signatures_are_cut(tail: str) -> None:
    assert strip_reply(f"Please go ahead.\n\n{tail}") == "Please go ahead."


def test_an_answer_written_below_the_quote_is_kept() -> None:
    text = "On 2026-10-31 11:01, Scout wrote:\n> Reply with A1.\n\nA1 1\n"
    assert strip_reply(text) == "A1 1"


def test_answers_written_between_quotes_are_kept() -> None:
    text = "On Thu, Scout wrote:\n> First?\n\nYes.\n\n> Second?\n\nNo.\n"
    assert strip_reply(text) == "Yes.\n\n\nNo."


def test_a_quote_opening_with_nothing_quoted_after_it_ends_the_message() -> None:
    assert strip_reply("Done.\n\nOn Thu, Scout wrote:\nOld words.") == "Done."


def test_quoted_lines_between_answers_are_dropped() -> None:
    text = "> first question\nyes\n> second question\nno"
    assert strip_reply(text) == "yes\nno"


def test_a_phone_footer_is_dropped() -> None:
    assert strip_reply("Do it.\n\nSent from my iPhone") == "Do it."


def test_a_line_that_only_starts_like_a_header_is_kept() -> None:
    text = "From: the top, please.\nThanks"
    assert strip_reply(text) == text


def test_html_becomes_readable_text_without_what_it_quotes() -> None:
    markup = """
    <html><head><style>p {color: red}</style></head><body>
    <p>Hello &amp; welcome</p>
    <ul><li>one</li><li>two</li></ul>
    <a href="https://example.com/x">the docs</a>
    <div class="gmail_quote">On Thu Ada wrote: old</div>
    <blockquote>older</blockquote>
    <div id="divRplyFwdMsg">From: Ada</div>
    </body></html>
    """
    text = html_to_text(markup)
    assert "Hello & welcome" in text
    assert "- one" in text
    assert "the docs (https://example.com/x)" in text
    assert "old" not in text
    assert "From: Ada" not in text
    assert "color" not in text


def test_a_script_is_not_text() -> None:
    assert "alert" not in html_to_text("<p>hi</p><script>alert(1)</script>")


# ── Reading a whole message ──────────────────────────────────────────────────


def test_a_plain_message_is_read() -> None:
    read = read_message(_raw(BASIC, "Please look.\n\n-- \nAda"), 1024)
    assert read.message_id == "<one@example.com>"
    assert read.root_id is None
    assert read.sender_address == "ada@example.com"
    assert read.sender_name == "Ada Lovelace"
    assert read.subject == "Deploy failed"
    assert read.text == "Please look."
    assert read.automated is None
    assert not read.from_switch


def test_a_sender_with_no_name_is_called_by_their_address() -> None:
    read = read_message(_raw({**BASIC, "From": "ada@example.com"}), 1024)
    assert read.sender_name == "ada"


def test_html_only_mail_is_read_as_text() -> None:
    message = _mail(BASIC)
    message.set_content("<p>Only <b>HTML</b></p>", subtype="html")
    assert read_message(message.as_bytes(), 1024).text == "Only HTML"


def test_the_plain_part_wins_over_html() -> None:
    message = _mail(BASIC, "plain words")
    message.add_alternative("<p>html words</p>", subtype="html")
    assert read_message(message.as_bytes(), 1024).text == "plain words"


def test_an_attachment_comes_through_with_its_bytes() -> None:
    message = _mail(BASIC)
    message.add_attachment(
        b"col\n1\n", maintype="text", subtype="csv", filename="report.csv"
    )
    read = read_message(message.as_bytes(), 1024)
    assert [(a.filename, a.mimetype) for a in read.attachments] == [
        ("report.csv", "text/csv")
    ]
    assert read.attachments[0].data.replace(b"\r\n", b"\n") == b"col\n1\n"
    assert read.attachment_failures == []


def test_an_oversized_attachment_is_refused_by_name() -> None:
    message = _mail(BASIC)
    message.add_attachment(
        b"x" * 2048,
        maintype="application",
        subtype="octet-stream",
        filename="big.bin",
    )
    read = read_message(message.as_bytes(), 1024)
    assert read.attachments == []
    assert [f.filename for f in read.attachment_failures] == ["big.bin"]
    assert "over the" in read.attachment_failures[0].reason


def test_switchs_own_mail_is_recognised() -> None:
    assert read_message(_raw({**BASIC, SWITCH_HEADER: "b1"}), 1024).from_switch


def test_a_header_with_encoded_words_is_decoded() -> None:
    raw = (
        b"From: =?utf-8?b?QWTDoQ==?= <ada@example.com>\r\n"
        b"Subject: =?utf-8?q?caf=C3=A9?=\r\n"
        b"Message-ID: <e@x>\r\n\r\nHi\r\n"
    )
    read = read_message(raw, 1024)
    assert read.sender_name == "Adá"
    assert read.subject == "café"


# ── Writing a message ────────────────────────────────────────────────────────


def _built(**overrides: object) -> EmailMessage:
    arguments: dict[str, object] = {
        "mailbox": "room@acme.test",
        "sender_name": "Scout",
        "recipients": ["ada@example.com", "bob@example.com"],
        "subject": "Re: Deploy failed",
        "text": "**Done.**",
        "message_id": "<out@acme.test>",
        "root_id": "<root@example.com>",
        "bridge_id": "bridge-1",
        "attachments": [],
        "date": datetime(2026, 10, 31, 12, 0, tzinfo=UTC),
        **overrides,
    }
    built = build_message(**arguments)  # type: ignore[arg-type]
    return BytesParser(policy=policy.default).parsebytes(built.as_bytes())  # type: ignore[return-value]


def test_a_reply_is_threaded_and_comes_from_the_mailbox_under_the_agents_name() -> None:
    message = _built()
    assert str(message["From"]) == "Scout <room@acme.test>"
    assert str(message["To"]) == "ada@example.com, bob@example.com"
    assert message["Message-ID"] == "<out@acme.test>"
    assert message["In-Reply-To"] == "<root@example.com>"
    assert message["References"] == "<root@example.com>"
    assert message["Auto-Submitted"] == "auto-replied"
    assert message[SWITCH_HEADER] == "bridge-1"


def test_a_new_message_names_no_thread() -> None:
    message = _built(root_id=None)
    assert message["In-Reply-To"] is None
    assert message["References"] is None
    assert message["Auto-Submitted"] == "auto-generated"


def test_a_message_has_text_and_html_parts() -> None:
    message = _built()
    plain = message.get_body(preferencelist=("plain",))
    rich = message.get_body(preferencelist=("html",))
    assert plain is not None and "**Done.**" in plain.get_content()
    assert rich is not None and "<strong>Done.</strong>" in rich.get_content()


def test_markup_in_an_agents_words_is_shown_not_interpreted() -> None:
    rendered = render_html("<script>alert(1)</script> and <img src=x>")
    assert "<script>" not in rendered
    assert "<img" not in rendered
    assert "&lt;script&gt;" in rendered


def test_a_line_break_stays_a_line_break() -> None:
    assert "Permission needed<br" in render_html("Permission needed\nWrite a file")


def test_a_windows_path_keeps_its_backslashes() -> None:
    rendered = render_html(r"Write C:\Users\ada\.switch\notes.txt")
    assert r"C:\Users\ada\.switch\notes.txt" in rendered


def test_a_name_with_special_characters_stays_a_name() -> None:
    message = _built(sender_name='Ops, "night" shift')
    assert message["From"].addresses[0].addr_spec == "room@acme.test"
    assert message["From"].addresses[0].display_name == 'Ops, "night" shift'


def test_a_header_cannot_be_injected_through_a_subject() -> None:
    with pytest.raises(ValueError):
        _built(subject="Hi\r\nBcc: eve@evil.test")


def test_files_are_attached() -> None:
    message = _built(
        attachments=[
            OutboundAttachment(
                filename="report.csv", mimetype="text/csv", data=b"col\n1\n"
            )
        ]
    )
    names = [part.get_filename() for part in message.iter_attachments()]
    assert names == ["report.csv"]


def test_a_stable_id_is_the_same_each_time_and_on_the_mailboxs_domain() -> None:
    first = stable_message_id("room@acme.test", "request-a/b")
    assert first == stable_message_id("room@acme.test", "request-a/b")
    assert first.endswith("@acme.test>")
    assert "/" not in first
