"""A permission card after it has been answered, on the platforms without cards.

The open form is covered in `test_session_neutral_forms.py`, which is about
whether a card may honestly ask for a number. This is the other half of the
same message — the card is edited in place, so the settled drawing is what a
reader sees for the rest of the conversation's life, and the thing it has to
say in the fewest words is what was decided.

Slack keeps its own copies of this wording in `slack.py`; these are the four
platforms that share `neutral.py`.
"""

from __future__ import annotations

import html

from markdown_it import MarkdownIt

from switch_core.bridges.collaboration.session.renderers import MARKDOWN, Markup
from switch_core.bridges.collaboration.session.renderers.neutral import request_summary
from switch_core.bridges.collaboration.teams.adapter import _TEAMS_MARKUP
from switch_core.bridges.collaboration.telegram.adapter import TELEGRAM_HTML
from switch_core.sessions.contract import ApprovalContent, SnapshotRequest

from .test_discord_sdk_only import _adapter as _discord_adapter
from .test_session_neutral_forms import REFERENCE, _identity, _option

ALLOW = _option("opt-allow", "Allow once")
ALWAYS = _option("opt-always", "Allow", decision="acceptForSession")
DENY = _option("opt-deny", "Deny")
# The two ways an `acceptForSession` label meets the footer's scope: one Switch
# writes and recognises, and one whose mention of the session is its subject.
SAID_SO = _option("opt-said-so", "Allow for this session", decision="acceptForSession")
SUBJECT = _option("opt-subject", "Inspect this session", decision="acceptForSession")


def _settled(
    *,
    state: str = "resolved",
    outcome: str = "answered",
    option_id: str | None = "opt-allow",
    actor: str | None = "actor-demo",
    detail: str | None = "pnpm test",
) -> SnapshotRequest:
    return SnapshotRequest.model_validate(
        {
            "requestId": "req-1",
            "turnId": "turn-1",
            "revision": 1,
            "state": state,
            "expiresAt": None,
            "result": {
                "type": "request.settled",
                "requestId": "req-1",
                "revision": 1,
                "outcome": outcome,
                "commandId": None,
                "result": (
                    {"kind": "approval", "optionId": option_id}
                    if option_id is not None
                    else None
                ),
            },
            "decidedBy": (
                {"actorId": actor, "surface": "mattermost", "commandId": "cmd-1"}
                if actor is not None
                else None
            ),
            "content": ApprovalContent(
                kind="approval",
                title="Run project tests",
                detail=detail,
                options=[ALLOW, ALWAYS, DENY, SAID_SO, SUBJECT],
            ).model_dump(by_alias=True),
        }
    )


def _lines(request: SnapshotRequest, markup: Markup = MARKDOWN) -> list[str]:
    return request_summary(
        request, REFERENCE, escape=_identity, limit=10_000, markup=markup
    ).splitlines()


# ── The outcome is the heading ────────────────────────────────────────────────


def test_the_answer_is_the_first_thing_the_settled_card_says() -> None:
    """Not "Permission answered" over a sentence saying what the answer was.

    The generic word cost a line to say something the outcome says better.
    """
    assert _lines(_settled()) == [
        "**Allow once** · request `R42`",
        "Run project tests",
        "`pnpm test`",
        "Chosen by actor-demo from Mattermost.",
    ]


def test_the_heading_keeps_the_shape_discord_recovers_a_card_by() -> None:
    """`discord/adapter.py:_heads_a_card` scans history for exactly this.

    Bold from the first character, ending in the request handle. A settled
    card that stops matching is a card a restart can no longer find.
    """
    head = _lines(_settled())[0]

    assert head.startswith("**")
    assert head.endswith(" · request `R42`")


def test_a_label_with_a_newline_in_it_cannot_split_the_heading() -> None:
    """The label is host text and the heading is now made of it.

    Two half-headings would each fail Discord's scan, so a card whose option
    happened to be labelled over two lines would be unrecoverable after a
    restart. Folded onto one line before it is fitted.
    """
    request = _settled(option_id="opt-multiline")
    request.content.options.append(_option("opt-multiline", "Allow\nonce"))

    head = _lines(request)[0]

    assert head == "**Allow once** · request `R42`"


def test_an_option_that_lasts_the_session_says_so_in_the_footer() -> None:
    """The scope followed the label off the footer, but not into the heading:
    bolding a parenthetical makes a long heading out of a short answer."""
    lines = _lines(_settled(option_id="opt-always"))

    assert lines[0] == "**Allow** · request `R42`"
    assert lines[-1] == (
        "Chosen by actor-demo from Mattermost (applies for the rest of this session)."
    )


def test_a_recognised_label_does_not_repeat_its_scope_in_the_footer() -> None:
    """The heading is the label here, so "Allow for this session" over "Chosen
    … (applies for the rest of this session)" is the same duplicate the open
    form had. Both drawings share `_scope`, so both are fixed by it."""
    lines = _lines(_settled(option_id="opt-said-so"))

    assert lines[0] == "**Allow for this session** · request `R42`"
    assert lines[-1] == "Chosen by actor-demo from Mattermost."


def test_a_settled_label_whose_subject_is_the_session_keeps_its_scope() -> None:
    """The heading names the option that was chosen and nothing more. Where
    the label only mentioned the session, the footer is the only place the
    reader learns that what was granted outlives the turn."""
    lines = _lines(_settled(option_id="opt-subject"))

    assert lines[0] == "**Inspect this session** · request `R42`"
    assert lines[-1] == (
        "Chosen by actor-demo from Mattermost (applies for the rest of this session)."
    )


def test_an_answer_from_nobody_in_particular_still_names_the_outcome() -> None:
    """A host may settle a request without saying who did it."""
    lines = _lines(_settled(actor=None))

    assert lines[0] == "**Allow once** · request `R42`"
    assert lines[-1] == "Answered."


def test_an_option_the_card_never_offered_is_named_rather_than_hidden() -> None:
    lines = _lines(_settled(option_id="opt-from-nowhere"))

    assert lines[0] == "**opt-from-nowhere** · request `R42`"


def test_an_answer_with_no_option_at_all_keeps_the_generic_heading() -> None:
    """The one case "Permission answered" still earns: the host said it was
    answered and never said with what. The heading must not invent one."""
    lines = _lines(_settled(option_id=None))

    assert lines[0] == "**Permission answered** · request `R42`"
    assert lines[-1] == (
        "Answered by actor-demo from Mattermost, "
        "but the host did not say which option was chosen."
    )


def test_a_card_closed_without_an_answer_says_closed_and_why() -> None:
    lines = _lines(_settled(state="closed", outcome="cancelled"))

    assert lines[0] == "**Closed** · request `R42`"
    assert lines[-1] == (
        "Cancelled before it was answered. Decided by actor-demo from Mattermost."
    )


# ── The command it is asking about ────────────────────────────────────────────


def test_the_command_is_set_apart_from_the_prose_around_it() -> None:
    """Two lines of host text in a row, one a sentence and one a command, read
    as one paragraph without it."""
    assert "`pnpm test`" in _lines(_settled())


def test_teams_leaves_the_command_alone_having_no_code_span() -> None:
    """A TextBlock renders no code span, and bold would be the card's third —
    after the heading and the handle — which marks out nothing at all."""
    lines = _lines(_settled(), markup=_TEAMS_MARKUP)

    assert lines[0] == "**Allow once** · request **R42**"
    assert lines[2] == "pnpm test"


def test_a_detail_of_several_lines_is_not_a_command_and_is_left_alone() -> None:
    """A code span drawn around a paragraph is a rendering accident on every
    platform here; a detail that runs to more than one line is prose."""
    lines = _lines(_settled(detail="It will:\nrun the suite"))

    assert "`" not in lines[2]
    assert lines[2:4] == ["It will:", "run the suite"]


# ── What the code span actually carries ───────────────────────────────────────


def _discord_escape(text: str) -> str:
    return _discord_adapter({}).escape_label_for_body(text)


def _spans(text: str) -> list[str]:
    """The literal content of every code span, as a Markdown reader sees it."""
    return [
        child.content
        for block in MarkdownIt().parse(text)
        for child in (block.children or [])
        if child.type == "code_inline"
    ]


def test_a_command_reaches_the_reader_as_the_command_it_is() -> None:
    """The prose escape must not run inside a code span.

    Nothing between backticks is read as syntax, so `my_file.txt` needs no
    defusing there — and defusing it anyway puts a backslash in front of the
    underscore in the one place on the card meant to be read literally. The
    reader cannot tell whether the backslash is part of the command.
    """
    text = request_summary(
        _settled(detail="cat my_file.txt"),
        REFERENCE,
        escape=_discord_escape,
        limit=10_000,
        markup=MARKDOWN,
    )

    assert "cat my_file.txt" in _spans(text)
    assert "\\_" not in text


def test_the_handle_is_a_literal_too() -> None:
    """Same span, same rule. A handle is alphanumeric today, so this pins the
    reasoning rather than a live defect."""
    text = request_summary(
        _settled(),
        REFERENCE,
        escape=_discord_escape,
        limit=10_000,
        markup=MARKDOWN,
    )

    assert "R42" in _spans(text)


def test_a_command_containing_a_backtick_does_not_end_its_own_span() -> None:
    """A single backtick closed the span early and spilled the rest of the
    command into the body as prose."""
    command = "echo `date`"

    assert command in _spans(_line(_settled(detail=command)))


def test_a_command_starting_and_ending_in_a_backtick_keeps_them() -> None:
    """The padding spaces a fence needs here are stripped by the reader, so
    they cost the card a little width and the reader nothing."""
    command = "`quoted`"

    assert command in _spans(_line(_settled(detail=command)))


def test_a_backslash_in_a_command_is_the_reader_s_backslash() -> None:
    """Not an escape introduced by us, and not one removed."""
    command = r"grep '\d+' log.txt"

    assert command in _spans(_line(_settled(detail=command)))


def test_telegram_still_defuses_html_inside_its_code_span() -> None:
    """Telegram's span reads its content, so it keeps the adapter's escape
    where the Markdown platforms must drop it. Dropping it here would not
    litter the card — it would break the message."""
    text = request_summary(
        _settled(detail="grep <name> file"),
        REFERENCE,
        escape=lambda body: html.escape(body, quote=False),
        limit=10_000,
        markup=TELEGRAM_HTML,
    )

    assert "<code>grep &lt;name&gt; file</code>" in text.splitlines()


def _line(request: SnapshotRequest) -> str:
    return request_summary(
        request, REFERENCE, escape=_identity, limit=10_000, markup=MARKDOWN
    )
