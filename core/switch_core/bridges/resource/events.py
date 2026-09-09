from __future__ import annotations

from switch_core.events import SwitchEvent


class ResourceLoadEntry(SwitchEvent):
    id: str
    name: str
    description: str
    content: str
