"""The Signal text renderer: Switch Markdown to `text` + `textStyle` ranges.

`render_markdown` keeps a marker syntax (the emphasis it supports) and
reduces what a phone cannot show; `strip_markers` turns those markers into
`start:length:STYLE` ranges over the plain text, counted in UTF-16 code
units so an emoji shifts the offsets by two, not one. The one case that
actually bites is a mass mention defused into a zero-width space *before*
a bold run: the ZWSP is a real character in the sent text, so the range
must start after it.
"""

from __future__ import annotations

from switch_core.bridges.collaboration.signal.render import (
    CHUNK_MAX,
    chunk_markers,
    render_markdown,
    strip_markers,
)


def _ranges(rendered: str) -> list[str]:
    text, ranges = strip_markers(rendered)
    return text, ranges


# ── Markdown → markers ───────────────────────────────────────────────────────


def test_emphasis_survives_as_markers() -> None:
    text, ranges = _ranges(render_markdown("**bold** *it* ~~gone~~ `code`"))
    assert text == "bold it gone code"
    assert "BOLD" in " ".join(ranges)
    assert "ITALIC" in " ".join(ranges)
    assert "STRIKETHROUGH" in " ".join(ranges)
    assert "MONOSPACE" in " ".join(ranges)


def test_plain_text_yields_no_ranges() -> None:
    text, ranges = _ranges(render_markdown("just words"))
    assert text == "just words"
    assert ranges == []


def test_a_fenced_block_becomes_a_monospace_run() -> None:
    rendered = render_markdown("before\n```py\nprint(1)\n```\nafter")
    text, ranges = _ranges(rendered)
    assert "print(1)" in text
    assert any(r.endswith("MONOSPACE") for r in ranges)


def test_an_unbalanced_marker_yields_no_range_not_a_marker_in_the_text() -> None:
    text, ranges = _ranges(render_markdown("**open but never closed"))
    # The mark is the only thing removed; what was styled stays, unstyled.
    assert text == "open but never closed"
    assert ranges == []


# ── UTF-16 offsets ───────────────────────────────────────────────────────────


def test_an_emoji_before_a_styled_run_shifts_the_offsets_by_two() -> None:
    # 🚀 is one code point but two UTF-16 units, so the BOLD that a
    # code-point count would place at offset 2 is at offset 3 in the range.
    text, ranges = _ranges("🚀 **hi**")
    assert text == "🚀 hi"
    start, length, style = ranges[0].split(":")
    assert (int(start), int(length), style) == (3, 2, "BOLD")
    # 3, not 2: the emoji occupies units 0-1 and the space is 2. Ranges are
    # UTF-16 code units, so the covered span is checked on the encoding.
    assert text.encode("utf-16-le")[3 * 2 : (3 + 2) * 2].decode("utf-16-le") == "hi"


def test_nested_styles_close_inner_first() -> None:
    text, ranges = _ranges("**bold *inner* bold**")
    assert text == "bold inner bold"
    # The ITALIC range is contained in the BOLD range.
    bold = next(r for r in ranges if r.endswith("BOLD"))
    italic = next(r for r in ranges if r.endswith("ITALIC"))
    b_start, b_len = int(bold.split(":")[0]), int(bold.split(":")[1])
    i_start, i_len = int(italic.split(":")[0]), int(italic.split(":")[1])
    assert i_start >= b_start and i_start + i_len <= b_start + b_len


# ── The defusal interaction: a ZWSP before a bold run ────────────────────────


def test_a_defused_mention_before_a_bold_run_counts_the_zwsp() -> None:
    # `translate_outbound` defuses `@everyone` into `@` + a zero-width space,
    # and that ZWSP stays in the text the markers are later stripped from. So
    # the BOLD range must be measured on the defused string, where the `hi`
    # is shifted right by the one unit the ZWSP occupies.
    from switch_core.agent_display_name import ZERO_WIDTH_SPACE
    from switch_core.room_wide_mention import defuse_mass_mention_words

    defused = defuse_mass_mention_words("@everyone **hi**")
    text, ranges = _ranges(defused)
    start, length, style = ranges[0].split(":")
    # Plain "@" + "everyone" + " " is 9 units, the ZWSP is one more, so `hi`
    # begins at 11, not 10.
    assert (int(start), int(length), style) == (11, 2, "BOLD")
    assert text[11:13] == "hi"
    assert ZERO_WIDTH_SPACE in text  # the ZWSP survives into the sent text


# ── Chunking: long replies split, styles recomputed per chunk ────────────────


def test_a_message_over_the_limit_splits_on_line_boundaries() -> None:
    body = "\n".join(f"para {i}: " + "lorem ipsum " * 8 for i in range(12))
    chunks = chunk_markers(body)

    assert len(chunks) > 1
    for chunk in chunks:
        assert len(chunk) <= CHUNK_MAX, f"chunk of {len(chunk)} chars exceeds the limit"
    # Nothing is lost or reordered across the split.
    rejoined = "".join(chunk + "\n" for chunk in chunks[:-1]) + chunks[-1]
    assert rejoined == body


def test_a_short_message_is_a_single_chunk() -> None:
    assert chunk_markers("hello world") == ["hello world"]


def test_a_style_is_not_left_open_across_a_chunk() -> None:
    # A bold run that straddles the cut must not leave a lone `*` in either
    # chunk: an emphasis cut by the boundary degrades to plain text. Long
    # enough that the run is actually split across the CHUNK_MAX boundary.
    body = "a" * 300 + " **long bold run** " + "b" * 300
    chunks = chunk_markers(body)
    assert len(chunks) > 1
    for chunk in chunks:
        text, _ = strip_markers(chunk)
        assert "*" not in text, f"stray marker survived into the text: {chunk!r}"
        # The styled word survives as plain text in the chunks that hold it.
    rejoined_text = "".join(strip_markers(chunk)[0] for chunk in chunks)
    assert "long bold run" in rejoined_text


def test_a_markedup_message_split_and_stripped_keeps_each_chunks_ranges() -> None:
    # The real pipeline: render Markdown, chunk the marker-carrying string,
    # then strip each chunk on its own so a range never crosses a boundary.
    markdown = "\n".join(f"**heading {i}** {i}: " + "text " * 40 for i in range(10))
    rendered = render_markdown(markdown)
    chunks = chunk_markers(rendered)
    assert len(chunks) > 1
    for chunk in chunks:
        text, ranges = strip_markers(chunk)
        for r in ranges:
            start, length, _style = r.split(":")
            start, length = int(start), int(length)
            total_units = len(text.encode("utf-16-le")) // 2
            assert start + length <= total_units, (
                f"range {r} runs past chunk text {text!r}"
            )
