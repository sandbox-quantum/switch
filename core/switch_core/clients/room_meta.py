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
    # How many agents the room holds, read with the room so a direct room's
    # "is this for its one agent?" needs no read per message. None where the
    # meta was built without it; addressing then reads the count itself.
    agent_count: int | None = None
    # The room's follow-the-conversation settings (`!follow-ups`,
    # `!assign-agent`), read with the room from its metadata.
    follow_ups_enabled: bool = True
    main_agent_id: str | None = None
    # Whether a message no rule delivers is sent to the decision service
    # (`!auto-route`), read with the room from its metadata.
    auto_route_on: bool = False
    # The agent that gets what auto-route could not decide because the
    # decision service failed (`!auto-route fallback`), if any.
    auto_route_fallback_agent_id: str | None = None
    # `{agent_id, body}`: what that agent says as it joins, in place of its
    # usual greeting (a Switch Console chat's opening message).
    agent_greeting: dict[str, str] | None = None
    # A chat started in Switch Console, where an agent arrives without its
    # join line: the console shows who joined.
    console_chat: bool = False
