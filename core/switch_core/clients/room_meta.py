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
    # The room's follow-the-conversation settings (`!follow-ups`,
    # `!assign-agent`), read with the room from its metadata.
    follow_ups_enabled: bool = True
    main_agent_id: str | None = None
    # `{agent_id, body}`: what that agent says as it joins, in place of its
    # usual greeting (a Switch Console chat's opening message).
    agent_greeting: dict[str, str] | None = None
