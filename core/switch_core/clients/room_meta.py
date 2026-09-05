from __future__ import annotations

from pydantic import BaseModel


class RoomMeta(BaseModel):
    room_id: str
    name: str
    bridge_id: str | None = None
    # Whether agents should post their self-join greeting in this room. Driven by
    # the room's collaboration bridge toggle; True for non-bridged
    # rooms and when no bridge resolves.
    agent_greetings_enabled: bool = True
    channel_type: str | None = None
    # Who can read this room, resolved here because it needs the bridge's *type*
    # and the envelope only carries its id. Sent on every event so the agent's
    # host does not have to derive it — a second implementation of the same rule
    # in another language is how an agent gets told one thing and judged by
    # another.
    audience: str = "unknown"
