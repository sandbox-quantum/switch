"""What the bridge does to a body's text on its way to a platform keeps what
the body said: split to fit a platform's limit (`bridge.split-preserves-content`),
and translated to Slack's markup and back (`bridge.slack-markup-roundtrip`).

Pure functions, so each property runs many more examples than a machine.
"""

from __future__ import annotations

import re

import hypothesis.strategies as st
import pytest
from hypothesis import given, note, settings

from switch_core.bridges.collaboration.chunking import split_markdown
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
    SlackUser,
)


def _many() -> settings:
    """The profile's examples, twenty times over: each is microseconds."""
    current = settings()
    return settings(current, max_examples=current.max_examples * 20)


# ── Splitting ────────────────────────────────────────────────────────────────

_WORD = st.text(
    alphabet=st.characters(
        codec="utf-8",
        categories=["L", "N", "P", "S"],
        exclude_characters="`~",
    ),
    min_size=1,
    max_size=12,
)
# A word with no space to break at, longer than any limit drawn.
_LONG_WORD = st.text(alphabet="abcdefghij", min_size=60, max_size=400)
_PROSE = st.lists(st.one_of(_WORD, _WORD, _WORD, _LONG_WORD), max_size=40).map(" ".join)
_FENCE = st.sampled_from(["```", "````", "~~~"])
_INFO = st.sampled_from(["", "python", "ts", "json"])
_INDENT = st.sampled_from(["", " ", "   ", "    "])


@st.composite
def _blocks(draw: st.DrawFn) -> list[str]:
    """Lines of one block: prose, a blank line, a fenced code block (closed
    or, last of all, left open), or a line that starts with backticks and is
    not a fence."""
    kind = draw(st.sampled_from(["prose", "blank", "code", "ticks"]))
    if kind == "prose":
        return [draw(_INDENT) + draw(_PROSE)]
    if kind == "blank":
        return [""]
    if kind == "ticks":
        return [f"```{draw(_WORD)}``` {draw(_PROSE)}"]
    fence = draw(_FENCE)
    body = draw(st.lists(_PROSE, max_size=8))
    closed = draw(st.booleans())
    return [fence + draw(_INFO), *body, *([fence] if closed else [])]


@st.composite
def _markdown(draw: st.DrawFn) -> str:
    blocks = draw(st.lists(_blocks(), min_size=1, max_size=12))
    return "\n".join(line for block in blocks for line in block)


_FENCE_LINE = re.compile(r"^ {0,3}(`{3,}[^`]*|~{3,}.*)$")


def _fence_line(line: str) -> bool:
    """Whether `line` opens or closes a fence: a run of three or more
    backticks with no backtick after it, or of tildes (`chunking.py`)."""
    return _FENCE_LINE.match(line) is not None


def _text(content: str) -> str:
    """What `content` says: every character but whitespace, in order, with
    its fence lines left out, since a split adds and repeats those."""
    return "".join(
        "".join(line.split()) for line in content.split("\n") if not _fence_line(line)
    )


def _open_at_end(part: str) -> bool:
    """Whether a fence `part` opens is still open at its end."""
    marker: str | None = None
    for line in part.split("\n"):
        text = line.lstrip(" ")
        if len(line) - len(text) > 3:
            continue
        run = len(text) - len(text.lstrip(text[:1])) if text[:1] in "`~" else 0
        if marker is None:
            if run >= 3 and _fence_line(line):
                marker = text[:run]
        elif (
            text.startswith(marker[0]) and run >= len(marker) and not text[run:].strip()
        ):
            marker = None
    return marker is not None


@pytest.mark.property("bridge.split-preserves-content")
@settings(_many())
@given(content=_markdown(), limit=st.integers(min_value=40, max_value=400))
def test_a_split_fits_the_limit_and_keeps_what_was_said(
    content: str, limit: int
) -> None:
    parts = split_markdown(content, limit)
    note(f"parts: {parts!r}")

    for part in parts:
        assert len(part) <= limit, f"a part of {len(part)} over the limit {limit}"
    assert _text("\n".join(parts)) == _text(content), "the split lost or changed text"
    # A fence torn in half renders the rest of the part as plain text.
    unclosed_in_source = _open_at_end(content)
    for index, part in enumerate(parts):
        if index == len(parts) - 1 and unclosed_in_source:
            continue
        assert not _open_at_end(part), f"part {index} leaves a fence open"


@pytest.mark.property("bridge.split-preserves-content")
@settings(_many())
@given(
    lines=st.lists(_WORD.map(lambda w: w * 3), min_size=1, max_size=60),
    limit=st.integers(min_value=40, max_value=400),
)
def test_a_split_on_line_boundaries_joins_back_to_the_original(
    lines: list[str], limit: int
) -> None:
    """With no fence to close and no line longer than the limit, the parts
    are the original's lines, cut between them."""
    content = "\n".join(line[:limit] for line in lines)

    assert "\n".join(split_markdown(content, limit)) == content


# ── Slack ────────────────────────────────────────────────────────────────────

_PEOPLE = {"alice": "U0ALICE", "bob.smith": "U0BOB", "carol-x": "W0CAROL"}


def _slack() -> SlackAdapter:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="xoxb-test", app_token="xapp-test", workspace_id="T123"
        )
    )
    adapter.set_tenant_id("tenant-1")
    for name, user_id in _PEOPLE.items():
        adapter._remember_mention_target(name, user_id)
        adapter._user_cache[user_id] = SlackUser(name=name, display_name=name)
    return adapter


_PLAIN = st.text(
    alphabet=st.characters(
        codec="utf-8",
        categories=["L", "N"],
        include_characters=" ,;:!?'\"&<>.()",
    ),
    min_size=1,
    max_size=20,
).filter(lambda text: not re.search(r"&(?:amp|lt|gt);", text))
_MENTION = st.tuples(
    st.sampled_from(sorted(_PEOPLE)), st.sampled_from(["", ".", ",", "!", "?", ":"])
).map(lambda m: f"@{m[0]}{m[1]}")
# Path segments with balanced parentheses, as in an encyclopedia's
# `Mercury_(planet)`; Markdown ends a link at an unbalanced one.
_SEGMENT = st.one_of(
    st.text(alphabet="abcxyz019-_", min_size=1, max_size=8),
    st.tuples(
        st.text(alphabet="abcxyz", min_size=1, max_size=6),
        st.text(alphabet="abcxyz", min_size=1, max_size=6),
    ).map(lambda s: f"{s[0]}_({s[1]})"),
)
_URL = st.tuples(
    st.sampled_from(["https://docs.example.com", "https://en.example.org"]),
    st.lists(_SEGMENT, max_size=3),
).map(lambda u: "/".join([u[0], *u[1]]))
_LINK = st.tuples(
    st.text(alphabet="abc xyz019", min_size=1, max_size=12).map(str.strip).filter(bool),
    _URL,
).map(lambda link: f"[{link[0]}]({link[1]})")


# Text a body may hold that is markup on Slack: its own mention and link
# syntax spelled out. (An entity spelled out, such as `&amp;`, is shown
# decoded on Slack, a known gap: `_render_outbound` keeps entities, because
# escaped labels are inlined into the bodies it translates.)
_MARKUP = st.sampled_from(
    ["<@U0ALICE>", "<https://a.example|b>", "<!here>", "<#C1>", "a<b", "x & y"]
)


@st.composite
def _body(draw: st.DrawFn) -> str:
    pieces = draw(
        st.lists(st.one_of(_PLAIN, _MENTION, _LINK, _MARKUP), min_size=1, max_size=8)
    )
    return " ".join(pieces)


@pytest.mark.property("bridge.slack-markup-roundtrip")
@settings(_many())
@given(body=_body())
def test_a_body_sent_to_slack_reads_back_as_written(body: str) -> None:
    """Out through `translate_outbound` and back through `translate_inbound`,
    which reads Slack's markup and entities as Slack does: what a person on
    Slack is shown, read back into Switch, is what the body said, with the
    people it names mentioned and its links linked."""
    adapter = _slack()
    sent = adapter.translate_outbound(body)
    note(f"sent to Slack: {sent!r}")

    assert adapter.translate_inbound(sent) == body


@pytest.mark.property("bridge.slack-markup-roundtrip")
@settings(_many())
@given(body=_body())
def test_a_known_person_named_in_a_body_is_mentioned_on_slack(body: str) -> None:
    adapter = _slack()
    sent = adapter.translate_outbound(body)
    named = set(re.findall(r"@([a-z.-]+?)[.,!?:]?(?=\s|$)", body))
    note(f"sent to Slack: {sent!r}")

    for name in named & set(_PEOPLE):
        assert f"<@{_PEOPLE[name]}>" in sent, f"@{name} is not a Slack mention"


@pytest.mark.property("bridge.slack-markup-roundtrip")
@settings(_many())
@given(body=_body())
def test_a_link_in_a_body_is_one_slack_link_to_its_url(body: str) -> None:
    """Read back, a broken link can still look whole; on Slack it links
    somewhere else."""
    sent = _slack().translate_outbound(body)
    note(f"sent to Slack: {sent!r}")

    for label, url in re.findall(r"\[([^\]]+)\]\((https://\S+?)\)(?=\s|$)", body):
        assert f"<{url}|{label}>" in sent, f"[{label}]({url}) is not a Slack link"


# What the translation writes on Slack: a mention of a known person, and a
# link.
_WRITTEN = re.compile(r"<@[UW][A-Z0-9]+>|<https://[^|>\s]+\|[^>]+>")


@pytest.mark.property("bridge.slack-markup-roundtrip")
@settings(_many())
@given(body=_body())
def test_only_the_translation_writes_slack_markup(body: str) -> None:
    """A body that spells out Slack's syntax shows it as text: no mention,
    link or broadcast it did not ask for in Switch's own terms."""
    sent = _slack().translate_outbound(body)
    note(f"sent to Slack: {sent!r}")

    assert "<" not in _WRITTEN.sub("", sent), "the body wrote Slack markup"
    # Slack's format asks for every `&` escaped; a bare one reads as text
    # today, so the round trip alone does not see it.
    assert not re.search(r"&(?!(?:amp|lt|gt);)", sent), "a bare & sent to Slack"
