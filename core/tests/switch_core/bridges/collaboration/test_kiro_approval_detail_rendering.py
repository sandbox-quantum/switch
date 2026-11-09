"""Kiro's bounded approval details must fit the room's real form renderer.

These exact strings are pinned against the TypeScript formatter's test too.
The long target is omitted before it reaches this renderer, never truncated.
"""

from html import escape as escape_html

import pytest

from switch_core.agent_display_name import defuse_label_markup
from switch_core.bridges.collaboration.session.renderers import MARKDOWN, RequestReference
from switch_core.bridges.collaboration.session.renderers.neutral import render_request
from switch_core.bridges.collaboration.session.renderers.slack import render_approval
from switch_core.sessions.contract import ApprovalContent, ApprovalOption, SnapshotRequest

WARNING = "Other input and file contents are not displayed in this approval. Decline if needed."
DETAILS = [
    f"{WARNING}\nReported paths:\n- /workspace/example.txt",
    f"{WARNING}\nSome paths omitted from this approval.\nNo paths shown.",
    f"{WARNING}\nReported paths:\n- /w/[a](b)",
    f"{WARNING}\nReported paths:\n- C:\\work\\file.txt",
]
REFERENCE = RequestReference(token="test-token", handle="R42")


def request(detail: str) -> SnapshotRequest:
    return SnapshotRequest.model_validate(
        {
            "requestId": "req-1",
            "turnId": "turn-1",
            "revision": 1,
            "state": "open",
            "expiresAt": None,
            "result": None,
            "decidedBy": None,
            "content": ApprovalContent(
                kind="approval",
                title="Write File",
                detail=detail,
                options=[
                    ApprovalOption(option_id="1", label="Allow", decision="accept"),
                    ApprovalOption(option_id="2", label="Deny", decision="decline"),
                ],
            ).model_dump(by_alias=True),
        }
    )


@pytest.mark.parametrize("detail", DETAILS)
@pytest.mark.parametrize("limit", [1800, 1900, 2000, 4000])
def test_neutral_form_keeps_short_details_and_controls(detail: str, limit: int) -> None:
    # HTML escaping is deliberately more expansive than the plain Markdown case.
    def escape(text: str) -> str:
        return escape_html(defuse_label_markup(text))

    card = render_request(
        request(detail),
        REFERENCE,
        escape=escape,
        limit=limit,
        markup=MARKDOWN,
        responder=None,
        unavailable_reason=None,
        control_label_limit=None,
    )
    assert card.answerable
    assert "1. Allow" in card.text and "2. Deny" in card.text
    assert "…" not in card.text
    if "Some paths omitted" in detail:
        assert "Some paths omitted" in card.text
        assert "x" * 100 not in card.text


def test_neutral_escapes_link_markup_and_slack_keeps_controls() -> None:
    detail = DETAILS[2]
    card = render_request(
        request(detail),
        REFERENCE,
        escape=defuse_label_markup,
        limit=1900,
        markup=MARKDOWN,
        responder=None,
        unavailable_reason=None,
        control_label_limit=None,
    )
    assert card.answerable
    assert "[a](b)" not in card.text
    slack = render_approval(request(detail), REFERENCE)
    assert any(block["type"] == "actions" for block in slack.blocks)


@pytest.mark.parametrize("character", ["*", "_", "~", "`", "\u2028", "\u2029"])
def test_omitted_markup_targets_do_not_reach_neutral_or_slack(character: str) -> None:
    # The formatter test pins each such target to DETAILS[1].
    target = f"/work/a{character}b.txt"
    card = render_request(
        request(DETAILS[1]),
        REFERENCE,
        escape=defuse_label_markup,
        limit=1900,
        markup=MARKDOWN,
        responder=None,
        unavailable_reason=None,
        control_label_limit=None,
    )
    slack = render_approval(request(DETAILS[1]), REFERENCE)
    assert card.answerable and target not in card.text
    assert target not in slack.text
    assert any(block["type"] == "actions" for block in slack.blocks)


@pytest.mark.parametrize(
    "target",
    [
        "C:\\work\\[a].txt",
        "/work/a\u200bb.txt",
        "/work/a  b.txt",
        " /work/file.txt",
        "/work/file.txt ",
        "C:\\work\\  file",
        "---",
        "# foo",
        "1. file",
        "workspace/file",
        "C:relative",
    ],
)
def test_ambiguous_targets_are_not_rendered(target: str) -> None:
    card = render_request(
        request(DETAILS[1]),
        REFERENCE,
        escape=defuse_label_markup,
        limit=1900,
        markup=MARKDOWN,
        responder=None,
        unavailable_reason=None,
        control_label_limit=None,
    )
    slack = render_approval(request(DETAILS[1]), REFERENCE)
    assert card.answerable and target not in card.text and target not in slack.text
    assert any(block["type"] == "actions" for block in slack.blocks)
