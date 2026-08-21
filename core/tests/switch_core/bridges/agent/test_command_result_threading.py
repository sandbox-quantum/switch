from __future__ import annotations

from types import SimpleNamespace

from switch_core.bridges.agent.commands import _cmd_help, _reply
from switch_core.clients.client_base import ClientBase
from switch_core.events import CommandEvent


class _Recorder:
    """Captures reply_command calls so we can assert on thread_root_id."""

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def __call__(self, room_id: str, body: str, **kwargs: object) -> str:
        self.calls.append({"room_id": room_id, "body": body, **kwargs})
        return "$sent"


def _event(thread_id: str | None) -> CommandEvent:
    return CommandEvent(
        command="help",
        args="",
        user_id="u1",
        user_name="louisa",
        thread_id=thread_id,
    )


class TestReplyThreading:
    """Every command result is posted via _reply, which threads it under the
    originating command message (event.thread_id) — or top-level when there is
    no thread id."""

    async def test_threads_under_command_thread_id(self) -> None:
        send = _Recorder()
        client = SimpleNamespace(reply_command=send)
        await _reply(client, SimpleNamespace(room_id="!m"), _event("$cmd-root"), "hi")

        assert len(send.calls) == 1
        assert send.calls[0]["thread_root_id"] == "$cmd-root"
        assert send.calls[0]["body"] == "hi"
        # Command output defaults to markdown rendering.
        assert send.calls[0]["format"] == "markdown"

    async def test_top_level_when_no_thread_id(self) -> None:
        send = _Recorder()
        client = SimpleNamespace(reply_command=send)
        await _reply(client, SimpleNamespace(room_id="!m"), _event(None), "hi")

        assert len(send.calls) == 1
        assert send.calls[0]["thread_root_id"] is None


class TestHandlerThreads:
    """A representative handler (!help) routes its result through _reply, so it
    lands in the command's thread."""

    async def test_help_result_is_threaded(self) -> None:
        send = _Recorder()
        client = SimpleNamespace(reply_command=send)
        await _cmd_help(
            client, SimpleNamespace(room_id="!m"), _event("$cmd-root"), True
        )

        assert len(send.calls) == 1
        assert send.calls[0]["thread_root_id"] == "$cmd-root"
        assert send.calls[0]["body"].startswith("**Available commands:**")


class TestDispatchPopulatesThreadId:
    """The command's own Matrix event id is injected as the CommandEvent thread
    root at dispatch (it is not part of the event content)."""

    @staticmethod
    async def _dispatch(content: dict[str, object], event_id: str) -> CommandEvent:
        captured: list[CommandEvent] = []

        async def _on_command(_room: object, event: CommandEvent) -> None:
            captured.append(event)

        fake_self = SimpleNamespace(
            _should_ignore=lambda _room, _event: False,
            _EVENT_DISPATCH=ClientBase._EVENT_DISPATCH,
            on_command=_on_command,
        )
        unknown = SimpleNamespace(
            type="com.switch.command",
            event_id=event_id,
            source={"content": content},
        )
        await ClientBase._handle_custom_event(
            fake_self, SimpleNamespace(room_id="!m"), unknown
        )
        assert len(captured) == 1
        return captured[0]

    async def test_top_level_command_gets_its_own_event_id(self) -> None:
        # No m.thread relation → the command roots its own thread.
        event = await self._dispatch(
            {"command": "status", "args": "", "user_id": "u1", "user_name": "louisa"},
            "$the-command-event",
        )
        assert event.thread_id == "$the-command-event"

    async def test_in_thread_command_uses_relation_root(self) -> None:
        # The bridge related the command to an existing thread root → results
        # thread there, not under the command event itself.
        event = await self._dispatch(
            {
                "command": "status",
                "args": "",
                "user_id": "u1",
                "user_name": "louisa",
                "m.relates_to": {
                    "rel_type": "m.thread",
                    "event_id": "$matrix-thread-root",
                },
            },
            "$the-command-event",
        )
        assert event.thread_id == "$matrix-thread-root"
