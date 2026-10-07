from __future__ import annotations

import re

import pytest

from switch_core.web_page import LOGO_SVG, render_page, status_icon


def _page(**overrides: str) -> str:
    fields = {"title": "Done", "icon": status_icon("success"), "body": "<p>ok</p>"}
    fields.update(overrides)
    return render_page(**fields)


def test_the_title_is_escaped_and_used_for_the_tab_and_heading() -> None:
    page = _page(title="<b>Acme & Co</b>")

    assert "<b>Acme" not in page
    assert "<title>&lt;b&gt;Acme &amp; Co&lt;/b&gt;</title>" in page
    assert '<h1 id="title">&lt;b&gt;Acme &amp; Co&lt;/b&gt;</h1>' in page


def test_the_page_carries_the_brand_and_its_own_styles() -> None:
    page = _page()

    assert LOGO_SVG in page
    assert "<span>Switch</span>" in page
    assert "<style>" in page
    assert "prefers-color-scheme: dark" in page


def test_the_page_makes_no_external_requests() -> None:
    page = _page()

    assert not re.search(r"<link|<img|\bsrc=|url\(|@import|@font-face", page)
    assert "<script" not in page


def test_a_script_is_only_added_when_given() -> None:
    assert "<script>run()</script>" in _page(script="run()")


@pytest.mark.parametrize("kind", ["success", "error", "info"])
def test_each_status_has_its_own_icon(kind: str) -> None:
    assert f'class="status {kind}"' in status_icon(kind)  # type: ignore[arg-type]
