"""What it takes for someone outside the organisation to be a correspondent.

Sprint 2 let the owner forward mail to their own agent, and an allowlist was
enough: the only legitimate sender was already known. US-5 is a vendor emailing
in and being answered, which breaks both halves of that.

**The allowlist stops being sufficient**, because a legitimate sender is now
someone we did not list in advance. What replaces it is the mail
infrastructure's own verdict — SPF, DKIM and DMARC, reported in an
`Authentication-Results` header. The header is the interesting part: it is
ordinary text in an ordinary message, so a sender can write one, and trusting
the wrong one is worse than trusting none.

**And the agent has to reply**, into a thread the recipient's mail client will
recognise as the thread they started. That is `In-Reply-To` and `References`,
and getting them wrong turns a conversation into a pile of unrelated messages.
"""

from __future__ import annotations

from email.message import EmailMessage

import pytest

from switch_core.bridges.collaboration.email.authentication import (
    AuthVerdict,
    authenticated_sender,
    parse_authentication_results,
)
from switch_core.bridges.collaboration.email.reply import build_reply

AUTHSERV = "mx.agents.example.com"
VENDOR = "events@harborview.example"


def _received(*headers: str) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = f"Harborview Events <{VENDOR}>"
    msg["Subject"] = "Re: booking for March"
    msg["Message-ID"] = "<orig-1@harborview.example>"
    for header in headers:
        msg["Authentication-Results"] = header
    msg.set_content("Yes, a third breakout room is available.")
    return msg


# ── Reading the infrastructure's verdict ─────────────────────────────────────


def test_a_dmarc_pass_from_our_own_mail_host_is_a_pass() -> None:
    verdict = parse_authentication_results(
        [f"{AUTHSERV}; dmarc=pass header.from=harborview.example"],
        trusted_authserv_id=AUTHSERV,
    )

    assert verdict.dmarc == "pass"


def test_spf_and_dkim_are_read_alongside_it() -> None:
    verdict = parse_authentication_results(
        [f"{AUTHSERV}; spf=pass smtp.mailfrom=harborview.example; dkim=fail"],
        trusted_authserv_id=AUTHSERV,
    )

    assert verdict.spf == "pass"
    assert verdict.dkim == "fail"


def test_a_header_from_anyone_else_is_ignored_entirely() -> None:
    """This is the whole security of the mechanism.

    `Authentication-Results` is ordinary text in an ordinary message. A sender
    who wants to be believed can simply write one saying so — and it arrives
    *before* our own host's header, because ours is prepended on receipt.
    Only the one our infrastructure stamped means anything.
    """
    verdict = parse_authentication_results(
        ["evil.example; dmarc=pass header.from=harborview.example"],
        trusted_authserv_id=AUTHSERV,
    )

    assert verdict.dmarc == "none"


def test_the_trusted_header_is_read_even_when_a_forged_one_precedes_it() -> None:
    verdict = parse_authentication_results(
        [
            "evil.example; dmarc=pass",
            f"{AUTHSERV}; dmarc=fail header.from=harborview.example",
        ],
        trusted_authserv_id=AUTHSERV,
    )

    assert verdict.dmarc == "fail"


def test_a_value_that_looks_like_a_verdict_cannot_smuggle_one_in() -> None:
    """The exploit this parser was rewritten for.

    `=` is legal in an address local part, so `smtp.mailfrom=dmarc=pass@evil`
    puts the text `dmarc=pass` inside a header our own infrastructure genuinely
    stamped — before the real `dmarc=fail`. Scanning the whole header for
    `dmarc=...` reads the attacker's copy. Only the token at the head of each
    `;`-separated chunk is a verdict.
    """
    verdict = parse_authentication_results(
        [
            f"{AUTHSERV}; spf=pass smtp.mailfrom=dmarc=pass@evil.example; "
            "dkim=fail; dmarc=fail"
        ],
        trusted_authserv_id=AUTHSERV,
    )

    assert verdict.dmarc == "fail"
    assert not authenticated_sender(verdict)


def test_a_quoted_semicolon_cannot_invent_a_chunk_boundary() -> None:
    """The forgery that survived the first fix.

    Anchoring the verdict to the head of a `;`-separated chunk is worth nothing
    if the sender chooses where chunks begin — and a quoted local part may
    legally contain a semicolon, so `smtp.mailfrom="x;dmarc=pass"@evil` puts a
    forged verdict at the head of the chunk after it, inside a header our own
    MTA stamped.
    """
    verdict = parse_authentication_results(
        [
            f"{AUTHSERV}; dmarc=none header.from=evil.example; "
            'spf=pass smtp.mailfrom="x;dmarc=pass"@evil.example'
        ],
        trusted_authserv_id=AUTHSERV,
    )

    assert verdict.dmarc == "none"
    assert not authenticated_sender(verdict)


def test_a_quoted_id_containing_a_space_cannot_impersonate_ours() -> None:
    """The other forgery that survived.

    A quoted authserv-id is one token *including* its spaces. Taking the first
    word and stripping quotes afterwards reads `"mx.ours evil"` as `mx.ours` —
    and a border MTA strips a pre-existing header only on an exact match of its
    own id, so that one is never stripped. The attacker prepends it themselves
    and needs no MTA at all.
    """
    verdict = parse_authentication_results(
        [f'"{AUTHSERV} evil"; dmarc=pass'], trusted_authserv_id=AUTHSERV
    )

    assert verdict.dmarc == "none"


def test_a_genuine_verdict_is_not_overwritten_by_a_later_one() -> None:
    """`none` is a verdict, not an absence.

    Skipping it left the method unset so a later chunk could fill the gap —
    which is the same forgery by another route, since `dmarc=none` (the sending
    domain publishes no policy) is the common real case.
    """
    verdict = parse_authentication_results(
        [f"{AUTHSERV}; dmarc=none; dmarc=pass"], trusted_authserv_id=AUTHSERV
    )

    assert verdict.dmarc == "none"


def test_a_repeated_method_fails_closed() -> None:
    """Whichever order they arrive in. First-wins makes the verdict depend on a
    header's internal ordering, which the sender is not prevented from
    influencing."""
    assert (
        parse_authentication_results(
            [f"{AUTHSERV}; dmarc=pass; dmarc=fail"], trusted_authserv_id=AUTHSERV
        ).dmarc
        == "fail"
    )
    assert (
        parse_authentication_results(
            [f"{AUTHSERV}; dmarc=fail; dmarc=pass"], trusted_authserv_id=AUTHSERV
        ).dmarc
        == "fail"
    )


def test_no_configured_authserv_id_trusts_nothing() -> None:
    """Every header is somebody's claim about themselves until an operator says
    which one is ours."""
    verdict = parse_authentication_results(
        [f"{AUTHSERV}; dmarc=pass"], trusted_authserv_id=""
    )

    assert verdict.dmarc == "none"


@pytest.mark.parametrize(
    "header",
    [
        f'"{AUTHSERV}"; dmarc=pass',
        f"(checked by us) {AUTHSERV}; dmarc=pass",
    ],
)
def test_the_shapes_rfc_8601_permits_do_not_lose_the_verdict(header: str) -> None:
    """A quoted id and a leading comment are both legal. Failing to match them
    is safe but leaves a deployment authenticating nobody with no clue why."""
    verdict = parse_authentication_results([header], trusted_authserv_id=AUTHSERV)

    assert verdict.dmarc == "pass"


def test_no_header_at_all_is_not_a_pass() -> None:
    """Absence is not permission. Mail that reached us through a path that
    checked nothing has been checked by nothing."""
    verdict = parse_authentication_results([], trusted_authserv_id=AUTHSERV)

    assert verdict.dmarc == "none"
    assert verdict.spf == "none"
    assert verdict.dkim == "none"


def test_a_malformed_header_does_not_read_as_a_pass() -> None:
    verdict = parse_authentication_results(
        [f"{AUTHSERV}; dmarc", f"{AUTHSERV}; ===", AUTHSERV],
        trusted_authserv_id=AUTHSERV,
    )

    assert verdict.dmarc == "none"


def test_the_authserv_id_is_matched_case_insensitively_and_without_a_version() -> None:
    """RFC 8601 allows an optional version after the id, and hostnames are not
    case-sensitive. Neither should cost us the verdict."""
    verdict = parse_authentication_results(
        [f"{AUTHSERV.upper()} 1; dmarc=pass"],
        trusted_authserv_id=AUTHSERV,
    )

    assert verdict.dmarc == "pass"


# ── Turning a verdict into a decision ────────────────────────────────────────


def test_a_dmarc_pass_authenticates_the_sender() -> None:
    assert authenticated_sender(AuthVerdict(dmarc="pass", spf="none", dkim="none"))


def test_a_dmarc_fail_does_not_authenticate_however_the_rest_looks() -> None:
    """DMARC is the aligned check. SPF passing on its own says the envelope
    matched, which a forwarder satisfies while impersonating anyone."""
    assert not authenticated_sender(AuthVerdict(dmarc="fail", spf="pass", dkim="pass"))


def test_spf_and_dkim_together_do_not_stand_in_for_dmarc() -> None:
    """Neither is alignment. Both can pass for a domain that is not the one in
    the `From` header a person reads."""
    assert not authenticated_sender(AuthVerdict(dmarc="none", spf="pass", dkim="pass"))


def test_nothing_checked_is_not_authenticated() -> None:
    assert not authenticated_sender(AuthVerdict(dmarc="none", spf="none", dkim="none"))


# ── Replying into the thread they started ────────────────────────────────────


def test_the_reply_points_at_the_message_it_answers() -> None:
    reply = build_reply(
        _received(),
        body="Thanks — we will take it.",
        from_address="atlas@agents.example.com",
    )

    assert reply["In-Reply-To"] == "<orig-1@harborview.example>"


def test_the_reply_carries_the_thread_forward() -> None:
    """`References` is the chain a client walks to group a thread. Dropping the
    earlier ids leaves the reply attached to one message instead of a
    conversation."""
    original = _received()
    original["References"] = "<first@harborview.example> <second@harborview.example>"

    reply = build_reply(original, body="…", from_address="atlas@agents.example.com")

    refs = reply["References"].split()
    assert refs == [
        "<first@harborview.example>",
        "<second@harborview.example>",
        "<orig-1@harborview.example>",
    ]


def test_a_first_reply_starts_the_chain_with_the_message_it_answers() -> None:
    reply = build_reply(_received(), body="…", from_address="atlas@agents.example.com")

    assert reply["References"] == "<orig-1@harborview.example>"


@pytest.mark.parametrize(
    "subject",
    [
        "Re: booking for March",
        "Re: Re: RE: Re: booking for March",
        "Re:Re: booking for March",
        "RE : booking for March",
    ],
)
def test_the_subject_gains_one_re_and_not_a_pile_of_them(subject: str) -> None:
    """`Re: Re: Re: Re: booking` is what a naive prefix produces after four
    turns, and it is how a thread announces that a machine is writing it.

    A single existing prefix does not exercise the loop that strips them — the
    pile, and the spacing variants a real client produces, are the cases worth
    pinning.
    """
    original = _received()
    del original["Subject"]
    original["Subject"] = subject

    reply = build_reply(original, body="…", from_address="atlas@agents.example.com")

    assert reply["Subject"] == "Re: booking for March"


def test_a_subject_with_no_re_gains_one() -> None:
    original = _received()
    del original["Subject"]
    original["Subject"] = "booking for March"

    reply = build_reply(original, body="…", from_address="atlas@agents.example.com")

    assert reply["Subject"] == "Re: booking for March"


def test_the_reply_goes_to_the_person_who_wrote_and_comes_from_the_agent() -> None:
    reply = build_reply(_received(), body="…", from_address="atlas@agents.example.com")

    assert VENDOR in reply["To"]
    assert reply["From"] == "atlas@agents.example.com"


def test_reply_to_is_honoured_over_from() -> None:
    """A sender who set it meant it, and answering the wrong address is how a
    reply lands in a mailbox nobody reads."""
    original = _received()
    original["Reply-To"] = "bookings@harborview.example"

    reply = build_reply(original, body="…", from_address="atlas@agents.example.com")

    assert "bookings@harborview.example" in reply["To"]


def test_the_body_goes_out_as_both_text_and_html() -> None:
    """Markdown is what the agent writes and neither half of the audience wants
    it raw: a text-only client should read plain prose, a rich one should see
    the formatting."""
    reply = build_reply(
        _received(),
        body="We can do that.\n\n- one\n- two",
        from_address="atlas@agents.example.com",
    )

    plain = reply.get_body(preferencelist=("plain",))
    html = reply.get_body(preferencelist=("html",))
    assert plain is not None and "We can do that." in plain.get_content()
    assert html is not None and "<li>" in html.get_content()


def test_a_message_with_no_id_cannot_be_replied_to() -> None:
    """Without one there is nothing to thread against, and a reply that claims
    to answer nothing is worse than an error."""
    original = _received()
    del original["Message-ID"]

    with pytest.raises(ValueError):
        build_reply(original, body="…", from_address="atlas@agents.example.com")
