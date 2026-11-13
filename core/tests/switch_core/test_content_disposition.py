from urllib.parse import unquote

import pytest
from starlette.responses import Response

from switch_core.content_disposition import (
    content_disposition,
    untrusted_file_headers,
)


@pytest.mark.parametrize(
    "filename",
    [
        "Device profile — SSH host.png",
        "Screenshot 2026-10-26 at 10.15.32 AM.png",
        "Capture d’écran.png",
        'quote" and\r\nX-Injected: 1.png',
    ],
)
def test_a_free_text_name_makes_a_header_the_response_can_send(filename: str) -> None:
    header = content_disposition("inline", filename, "attachment")

    Response(content=b"x", headers={"Content-Disposition": header})
    assert "\r" not in header and "\n" not in header
    plain, encoded = header.split("; ")[1:]
    assert plain.count('"') == 2
    assert unquote(encoded.removeprefix("filename*=UTF-8''")) == filename


def test_an_ascii_name_is_kept_as_it_is() -> None:
    assert content_disposition("inline", "settings_devices.png", "attachment") == (
        "inline; filename=\"settings_devices.png\"; filename*=UTF-8''settings_devices.png"
    )


def test_a_name_with_nothing_ascii_left_falls_back_to_the_stem() -> None:
    header = content_disposition("attachment", "☕.yaml", "template")

    assert header.startswith('attachment; filename="template.yaml";')


@pytest.mark.parametrize(
    ("filename", "content_type"),
    [
        ('page".html', "text/html"),
        ("logo.svg", "image/svg+xml"),
        ("notes.txt", "text/plain; charset=utf-8"),
        ("blob.bin", None),
    ],
)
def test_anything_but_a_safe_image_is_a_sandboxed_download(
    filename: str, content_type: str | None
) -> None:
    headers = untrusted_file_headers(filename, content_type, "attachment")

    Response(content=b"<svg onload=alert(1)>", headers=headers)
    assert headers["Content-Disposition"].startswith("attachment; filename=")
    assert headers["X-Content-Type-Options"] == "nosniff"
    assert headers["Content-Security-Policy"] == "default-src 'none'; sandbox"


@pytest.mark.parametrize(
    "content_type",
    ["image/png", "image/jpeg", "image/gif", "image/webp", "IMAGE/PNG; x=1"],
)
def test_a_safe_image_may_be_shown_inline_but_stays_sandboxed(
    content_type: str,
) -> None:
    headers = untrusted_file_headers("shot.png", content_type, "attachment")

    assert headers["Content-Disposition"].startswith('inline; filename="shot.png";')
    assert headers["X-Content-Type-Options"] == "nosniff"
    assert headers["Content-Security-Policy"] == "default-src 'none'; sandbox"


def test_a_file_with_no_name_still_gets_its_disposition() -> None:
    assert untrusted_file_headers(None, "text/html", "attachment") == {
        "Content-Disposition": "attachment",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
    }
    assert (
        untrusted_file_headers(None, "image/png", "attachment")["Content-Disposition"]
        == "inline"
    )
