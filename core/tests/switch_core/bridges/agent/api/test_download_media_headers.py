"""The agent media route serves an uploaded file as a sandboxed download.

The bytes are whatever someone uploaded, HTML included, so they must never be
rendered inline on Switch's origin. The route is called directly, with the
protocol stubbed: the headers are the route's own work.
"""

from types import SimpleNamespace
from typing import Any, cast

from switch_core.bridges.agent.api.handlers import download_media

_HTML = b"<html><script>alert(1)</script></html>"


class _Protocol:
    def __init__(self, filename: str | None, content_type: str, data: bytes) -> None:
        self.filename, self.content_type, self.data = filename, content_type, data

    async def download_media(
        self, agent_id: str, room_id: str, mxc: str
    ) -> tuple[bytes, str, str | None]:
        return self.data, self.content_type, self.filename


async def _call(
    filename: str | None, content_type: str = "text/html", data: bytes = _HTML
) -> Any:
    return await download_media(
        "agent-1",
        "room-1",
        "switch-media://abc",
        agent=cast(Any, SimpleNamespace(id="agent-1")),
        protocol=cast(Any, _Protocol(filename, content_type, data)),
    )


async def test_an_html_file_is_a_sandboxed_download_with_its_bytes_and_type() -> None:
    response = await _call("report.html")

    assert response.body == _HTML
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["content-disposition"].startswith(
        'attachment; filename="report.html";'
    )
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["content-security-policy"] == "default-src 'none'; sandbox"


async def test_a_file_with_no_name_is_still_a_download() -> None:
    response = await _call(None)

    assert response.headers["content-disposition"] == "attachment"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["content-security-policy"] == "default-src 'none'; sandbox"


async def test_an_svg_file_is_a_download_too() -> None:
    response = await _call("logo.svg", "image/svg+xml", b"<svg onload=alert(1)/>")

    assert response.headers["content-disposition"].startswith(
        'attachment; filename="logo.svg";'
    )
    assert response.headers["content-security-policy"] == "default-src 'none'; sandbox"


async def test_a_safe_image_may_be_shown_inline() -> None:
    response = await _call("shot.png", "image/png", b"\x89PNG")

    assert response.headers["content-disposition"].startswith(
        'inline; filename="shot.png";'
    )
    assert response.headers["x-content-type-options"] == "nosniff"
