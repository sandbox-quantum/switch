from switch_core.transport.content import edited_content, message_content


def _formatted(body: str, mentions: list[str] | None = None) -> str:
    content = message_content(
        body, sender_name="Ann", format="markdown", mentions=mentions
    )
    formatted = content["formatted_body"]
    assert isinstance(formatted, str)
    return formatted


def test_raw_html_in_a_body_is_escaped() -> None:
    formatted = _formatted('<script>alert(1)</script> <img src=x onerror="alert(1)">')

    assert "<script>" not in formatted
    assert "<img" not in formatted
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in formatted


def test_a_raw_html_block_is_escaped() -> None:
    formatted = _formatted('<div onclick="x">\nblock\n</div>')

    assert "<div" not in formatted
    assert "&lt;div" in formatted


def test_markdown_still_renders() -> None:
    formatted = _formatted("**bold**\n\n> quoted\n\n`a < b & c`")

    assert "<strong>bold</strong>" in formatted
    assert "<blockquote>" in formatted
    assert "<code>a &lt; b &amp; c</code>" in formatted


def test_a_mention_is_linked() -> None:
    formatted = _formatted("hello @alice", ["@alice:example.org"])

    assert '<a href="https://matrix.to/#/@alice:example.org">alice</a>' in formatted


def test_a_mentioned_id_cannot_break_out_of_the_link() -> None:
    formatted = _formatted('@evil" onclick="x test', ['@evil" onclick="x:example.org'])

    assert (
        'href="https://matrix.to/#/@evil&quot; onclick=&quot;x:example.org"'
        in formatted
    )


def test_an_edited_body_is_escaped_too() -> None:
    content = message_content("hi", sender_name="Ann", format="markdown", mentions=None)

    edited = edited_content(content, "<b>now</b>", edited_at_ms=1)

    assert edited["formatted_body"] == "<p>&lt;b&gt;now&lt;/b&gt;</p>"
