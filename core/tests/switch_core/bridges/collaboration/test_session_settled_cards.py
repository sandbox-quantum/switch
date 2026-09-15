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

from switch_core.bridges.collaboration.session.renderers import MARKDOWN, Markup
from switch_core.bridges.collaboration.session.renderers.neutral import request_summary
from switch_core.bridges.collaboration.teams.adapter import _TEAMS_MARKUP
from switch_core.sessions.contract import ApprovalContent, SnapshotRequest

from .test_session_neutral_forms import REFERENCE, _identity, _option

ALLOW = _option("opt-allow", "Allow once")
ALWAYS = _option("opt-always", "Allow", decision="acceptForSession")
DENY = _option("opt-deny", "Deny")


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
                options=[ALLOW, ALWAYS, DENY],
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
