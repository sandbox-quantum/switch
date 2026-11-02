from urllib.parse import unquote

import pytest
from starlette.responses import Response

from switch_core.content_disposition import content_disposition


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
