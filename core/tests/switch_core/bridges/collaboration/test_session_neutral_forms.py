"""What a plain-text request form may and may not ask a reader to do.

`request_summary` is the only thing standing between a host's own wording and
a channel where the answer is a number typed into a message. A number is only
an honest thing to ask for while the reader can see what each number means, so
these are the cases where it cannot: a label cut short of what distinguishes
it, a scope the label never mentioned, an option that did not fit at all.
"""

from __future__ import annotations

from switch_core.bridges.collaboration.session.renderers import (
    MARKDOWN,
    RequestReference,
)
from switch_core.bridges.collaboration.session.renderers.neutral import (
    render_request,
    request_summary,
)
from switch_core.sessions.contract import (
    ApprovalContent,
    ApprovalOption,
    Question,
    QuestionOption,
    QuestionsContent,
    SnapshotRequest,
)

REFERENCE = RequestReference(token="tok-1", handle="R42")


def _identity(text: str) -> str:
    return text


def _approval(
    *options: ApprovalOption,
    state: str = "open",
    title: str = "Run a command?",
    detail: str | None = None,
) -> SnapshotRequest:
    return SnapshotRequest.model_validate(
        {
            "requestId": "req-1",
            "turnId": "turn-1",
            "revision": 1,
            "state": state,
            "expiresAt": None,
            "result": None,
            "decidedBy": None,
            "content": ApprovalContent(
                kind="approval",
                title=title,
                detail=detail,
                options=list(options),
            ).model_dump(by_alias=True),
        }
    )


def _questions(*questions: Question, state: str = "open") -> SnapshotRequest:
    return SnapshotRequest.model_validate(
        {
            "requestId": "req-1",
            "turnId": "turn-1",
            "revision": 1,
            "state": state,
            "expiresAt": None,
            "result": None,
            "decidedBy": None,
            "content": QuestionsContent(
                kind="questions", title="Before I start", questions=list(questions)
            ).model_dump(by_alias=True),
        }
    )


def _option(option_id: str, label: str, decision: str = "accept") -> ApprovalOption:
    return ApprovalOption.model_validate(
        {"optionId": option_id, "label": label, "decision": decision}
    )


def _render(request: SnapshotRequest, *, limit: int = 4000) -> str:
    return request_summary(
        request, REFERENCE, escape=_identity, limit=limit, markup=MARKDOWN
    )


def test_a_permission_label_is_shown_whole_rather_than_cut_to_a_short_ceiling():
    """A permission label is routinely a whole command line. Two of them that
    differ only past a short ceiling render as the same choice twice."""
    shared = "Run `pytest core/tests/switch_core/bridges/collaboration" + "/x" * 60
    text = _render(
        _approval(
            _option("one", f"{shared}/test_a.py"),
            _option("two", f"{shared}/test_b.py"),
        )
    )

    assert "test_a.py" in text
    assert "test_b.py" in text
    assert "Reply with `R42` and your choice, e.g. `R42 1`." in text


def test_options_that_cannot_be_told_apart_are_not_answered_by_number():
    """Cut to the same prefix, 1 and 2 are the same choice on the screen. The
    form stops asking for a number rather than inviting the wrong one."""
    shared = "Allow access to " + "x" * 4000
    text = _render(
        _approval(_option("one", f"{shared} once"), _option("two", f"{shared} always"))
    )

    assert "Reply with" not in text
    assert "Switch Console" in text


def test_an_option_that_reaches_beyond_this_session_says_so_on_the_form():
    """Two options can be labelled the same and mean "this once" and "from
    now on". The difference is what the reader is choosing between."""
    text = _render(
        _approval(
            _option("once", "Run the tests"),
            _option("always", "Run the tests", decision="acceptForSession"),
        )
    )

    assert text.splitlines()[-3:-1] == [
        "1. Run the tests",
        "2. Run the tests (applies for the rest of this session)",
    ]


def test_a_form_cut_short_by_the_message_limit_stops_asking_for_a_number():
    """Answering by number means answering the numbers on the screen. Some of
    them are not on it."""
    text = _render(
        _approval(*(_option(f"o{n}", f"Option {n}") for n in range(1, 40))), limit=200
    )

    assert "more not shown." in text
    assert "Reply with" not in text
    assert len(text) <= 200


def test_a_settled_form_that_was_cut_still_says_what_was_decided():
    """The notice replaces an instruction, never a record: a reader looking at
    a closed request came for the outcome, not for a route to answering it."""
    text = _render(
        _approval(
            *(_option(f"o{n}", f"Option {n}") for n in range(1, 40)), state="closed"
        ),
        limit=200,
    )

    assert "Closed without being answered." in text


def test_a_detail_that_names_a_second_operation_is_not_cut_off_mid_form():
    """The options say "Allow" and "Deny"; what is being allowed is in the
    detail. Cutting it there is cutting the whole of the decision."""
    text = _render(
        _approval(
            _option("yes", "Allow"),
            _option("no", "Deny", decision="decline"),
            detail="Delete the build cache. " + "x" * 4000 + " Also drop the database.",
        )
    )

    assert "Reply with" not in text
    assert "Switch Console" in text


def test_a_title_the_message_had_no_room_for_stops_the_form_asking():
    """A head line `_compose` cannot fit is dropped with no count to report —
    there is no "1 more" for a title. Silence is still the reader being asked
    to decide on something they cannot see."""
    title = "Should I " + "z" * 50 + "?"
    text = _render(_approval(_option("yes", "Allow"), title=title), limit=200)

    assert title not in text
    assert "Reply with" not in text
    assert "Switch Console" in text
    assert len(text) <= 200


def _question(
    title: str, *labels: str, descriptions: list[str] | None = None
) -> Question:
    return Question.model_validate(
        {
            "questionId": "q-1",
            "title": title,
            "prompt": "",
            "options": [
                QuestionOption.model_validate(
                    {
                        "optionId": f"o{n}",
                        "label": label,
                        "description": (
                            descriptions[n - 1] if descriptions is not None else None
                        ),
                    }
                )
                for n, label in enumerate(labels, start=1)
            ],
            "multiSelect": False,
            "allowCustomAnswer": False,
        }
    )


def test_a_question_whose_options_were_cut_short_is_not_answerable_here():
    long = "y" * 4000
    text = _render(_questions(_question("Which branch?", f"{long} a", f"{long} b")))

    assert "Reply with" not in text
    assert "Switch Console" in text


def test_a_question_whose_title_did_not_fit_is_not_answerable_here():
    """The number answers a question the reader can only see part of."""
    text = _render(_questions(_question("z" * 4000, "main", "release")))

    assert "Reply with" not in text
    assert "Switch Console" in text


def test_a_question_that_fits_is_still_answered_by_number():
    text = _render(_questions(_question("Which branch?", "main", "release")))

    assert "Reply with `R42` and your answer, e.g. `R42 1`." in text


def test_options_told_apart_only_by_their_descriptions_are_not_cut_there():
    """The labels are the same on purpose; the description is the difference.
    A ceiling that clips it clips the choice."""
    shared = "Deploy the service. " + "d" * 400
    text = _render(
        _questions(
            _question(
                "Which one?",
                "Deploy",
                "Deploy",
                descriptions=[f"{shared} to staging", f"{shared} to production"],
            )
        )
    )

    assert "to staging" in text
    assert "to production" in text
    assert "Reply with `R42` and your answer, e.g. `R42 1`." in text


def test_a_description_too_long_for_even_that_stops_the_form_asking():
    text = _render(
        _questions(
            _question(
                "Which one?",
                "Deploy",
                "Deploy",
                descriptions=["y" * 4000 + " to staging", "y" * 4000 + " to live"],
            )
        )
    )

    assert "Reply with" not in text
    assert "Switch Console" in text


def test_a_prompt_cut_short_is_not_answered_by_number_either():
    """The prompt is where a question says what it actually means."""
    question = _question("Which one?", "main", "release")
    question = question.model_copy(update={"prompt": "Note that " + "p" * 4000})
    text = _render(_questions(question))

    assert "Reply with" not in text
    assert "Switch Console" in text


# ── What the buttons already say, where there are buttons ─────────────────────
#
# Telegram is the one platform here that draws controls beside the body. An
# option printed under the button offering it is the same choice twice, and on
# a phone the second copy is what pushes the rest of the card off the screen.
# These are the cases where the button says the whole of it and the cases where
# it cannot.

BUTTON = 48


def _pressable(request: SnapshotRequest, *, limit: int = 4000) -> list[str]:
    """The card as a platform with `BUTTON`-wide controls would draw it."""
    return render_request(
        request,
        REFERENCE,
        escape=_identity,
        limit=limit,
        markup=MARKDOWN,
        responder=None,
        unavailable_reason=None,
        control_label_limit=BUTTON,
    ).text.splitlines()


def test_an_option_its_button_says_in_full_is_not_printed_under_it():
    lines = _pressable(
        _approval(
            _option("yes", "Allow once"),
            _option("no", "Decline", decision="decline"),
            detail="pnpm test",
        )
    )

    assert lines == [
        "**Permission needed** · request `R42`",
        "Run a command?",
        "`pnpm test`",
        "Reply with `R42` and your choice, e.g. `R42 1`.",
    ]


def test_the_same_card_still_lists_its_options_where_nothing_else_carries_them():
    """The platforms sharing this renderer mostly have no controls at all, and
    dropping the list there would be dropping the choices."""
    request = _approval(
        _option("yes", "Allow once"), _option("no", "Decline", decision="decline")
    )

    assert "1. Allow once" in _render(request)


def test_a_label_too_long_for_a_button_keeps_the_line_that_shows_it_whole():
    """Telegram cuts an over-long button label. The body is then the only
    place the option exists in full, so it stays."""
    label = "Allow running " + "x" * BUTTON
    lines = _pressable(
        _approval(_option("yes", label), _option("no", "Decline", decision="decline"))
    )

    assert f"1. {label}" in lines
    assert "2. Decline" not in lines


def test_an_option_that_outlasts_the_turn_keeps_the_line_saying_so():
    """A button carries the label and nothing beside it, and how far an
    approval reaches is beside it."""
    lines = _pressable(
        _approval(
            _option("once", "Allow once"),
            _option("always", "Always allow", decision="acceptForSession"),
            _option("no", "Decline", decision="decline"),
        )
    )

    assert lines[-2:] == [
        "2. Always allow (applies for the rest of this session)",
        "Reply with `R42` and your choice, e.g. `R42 1`.",
    ]


def test_a_label_that_already_named_the_session_is_not_made_to_say_it_twice():
    """The scope is printed because the label may not have said it. This one
    did, so the line is the same fact twice — and with buttons carrying the
    other two options, the only line left in the body."""
    lines = _pressable(
        _approval(
            _option("once", "Allow once"),
            _option("always", "Allow for this session", decision="acceptForSession"),
            _option("no", "Decline", decision="decline"),
        )
    )

    assert lines[-1] == "Reply with `R42` and your choice, e.g. `R42 1`."
    assert not any("applies for the rest" in line for line in lines)


def test_dropping_the_scope_does_not_drop_the_option_where_nothing_else_has_it():
    """Without buttons the line is the only place the choice exists, so it
    loses the parenthetical and keeps the option."""
    text = _render(
        _approval(
            _option("once", "Allow once"),
            _option("always", "Allow for this session", decision="acceptForSession"),
        )
    )

    assert "2. Allow for this session" in text
    assert "applies for the rest" not in text


def test_a_kept_line_keeps_the_number_its_button_was_given():
    """Pressing and typing have to mean the same thing by the same number, so
    the surviving lines are not renumbered around the dropped ones."""
    lines = _pressable(
        _approval(
            _option("once", "Allow once"),
            _option("no", "Decline", decision="decline"),
            _option("always", "Allow from now on", decision="acceptForSession"),
        )
    )

    assert "3. Allow from now on (applies for the rest of this session)" in lines


def test_a_card_with_buttons_still_refuses_a_label_it_could_not_fit():
    """The line is dropped for being said elsewhere, not for being short
    enough. A label the card itself had to cut is still a form that cannot
    honestly ask for a number — and the button shows even less of it."""
    shared = "Allow access to " + "x" * 4000
    lines = _pressable(
        _approval(_option("one", f"{shared} once"), _option("two", f"{shared} always"))
    )

    assert "Reply with" not in "\n".join(lines)
    assert "Switch Console" in "\n".join(lines)


def test_a_dropped_line_is_still_measured_against_what_the_card_can_hold():
    """A short message gives a label less room than a button does, so an
    option can fit the button and not the card. It is dropped from the body
    either way — but the card has still failed to show it whole, and a form
    that cannot show what it is asking does not ask for a number."""
    label = "Allow the deployment to proceed"
    assert len(label) <= BUTTON

    lines = _pressable(_approval(_option("yes", label)), limit=90)

    assert "Reply with" not in "\n".join(lines)
    assert "Too long to show in full here" in "\n".join(lines)
