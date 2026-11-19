from switch_core.transport.content import _rendered


class TestRenderedSanitisation:
    def test_raw_html_in_body_is_escaped(self) -> None:
        result = _rendered('<script>alert(1)</script>', None)
        assert "<script>" not in result
        assert "&lt;script&gt;" in result

    def test_markdown_still_renders(self) -> None:
        result = _rendered("**bold**", None)
        assert "<strong>bold</strong>" in result

    def test_mention_is_linked(self) -> None:
        result = _rendered("hello @alice", ["@alice:server"])
        assert 'href="https://matrix.to/#/@alice:server"' in result
        assert ">alice</a>" in result

    def test_mention_user_id_is_escaped_in_href(self) -> None:
        result = _rendered('@evil test', ['@evil" onclick="x:server'])
        assert 'onclick' not in result
