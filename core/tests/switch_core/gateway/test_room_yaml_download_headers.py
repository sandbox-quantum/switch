"""The room YAML export is a download that a browser won't render.

The YAML is made by Switch, but it carries names and instructions people
typed. The route is called directly, with the room read and the export
stubbed: the headers are the route's own work.
"""

from types import SimpleNamespace
from typing import Any, cast

import pytest

# Imported first, as the app does: `gateway.rooms` alone hits an old import
# cycle through `agent_templates` that the app's own import order avoids.
import switch_core.bridges.agent.operations  # noqa: F401
from switch_core.gateway import rooms


class _Export:
    async def export(self, room_id: str, **sections: bool) -> str:
        return "room:\n  name: <script>alert(1)</script>\n"


async def test_the_room_export_is_a_sandboxed_download_named_after_the_room(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def released(*args: Any, **kwargs: Any) -> Any:
        return SimpleNamespace(id="room-1", name='Ops "war" room')

    monkeypatch.setattr(rooms, "_require_room_released", released)

    response = await rooms.export_room_yaml(
        "room-1",
        session=cast(Any, None),
        room_store=cast(Any, None),
        rooms_yaml=cast(Any, _Export()),
        user=cast(Any, SimpleNamespace(id="user-1")),
        is_admin=True,
    )

    assert response.body == b"room:\n  name: <script>alert(1)</script>\n"
    assert response.headers["content-type"].startswith("application/x-yaml")
    assert response.headers["content-disposition"].startswith(
        'attachment; filename="Ops-war-room.yaml";'
    )
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["content-security-policy"] == "default-src 'none'; sandbox"
