from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class SwitchEvent(BaseModel):
    model_config = ConfigDict(extra="allow")


# ── Command ───────────────────────────────────────────────────────────────────


class CommandEvent(SwitchEvent):
    command: str
    # Raw text after the `!command` token. Agents check `@{their-name}` against
    # this to decide whether they were addressed; an empty/no-`@` args means
    # the command was untargeted (every agent responds).
    args: str = ""
    user_id: str
    user_name: str
    # Event id of this command message itself — identifies the command, so two
    # commands in one thread stay distinct. Populated at dispatch (the id is not
    # part of the event content). None for synthetic/legacy events that carry no
    # id.
    message_id: str | None = None
    # Thread root that command results reply into, so each command and its
    # output stay together: the root of the thread the command was typed in, or
    # the command's own event id when it roots its own thread. Populated at
    # dispatch. None for synthetic/legacy events that carry no id.
    thread_id: str | None = None
