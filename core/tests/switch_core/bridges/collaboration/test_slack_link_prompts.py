"""Slack's half of linking a chat account without a channel (CHOO-4121): the
account commands are answered to their sender alone wherever they were run,
and a link can be confirmed by tapping a number the app sends in its own
direct conversation."""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from slack_sdk.errors import SlackApiError

from switch_core.bridges.collaboration.models import (
    DirectMessageUnavailable,
    DirectPrompt,
    InboundCommand,
    InboundInteraction,
)
from switch_core.bridges.collaboration.session.renderers import (
    parse_answer_position,
    position_action,
)
from switch_core.bridges.collaboration.slack import adapter as slack_adapter
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)

_RESPONSE_URL = "https://hooks.slack.com/commands/T123/1/abc"
_PROMPT = DirectPrompt(
    text="**Ada** (ada@example.com) is linking this Slack account.",
    token="lnk.abcdefghijklmnop",
    labels=("23", "71", "48", "Not me"),
)


def _adapter() -> SlackAdapter:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="xoxb-test", app_token="xapp-test", workspace_id="T123"
        )
    )
    adapter.set_tenant_id("tenant-1")
    return adapter


class _WebClient:
    def __init__(self, refuse: str | None = None) -> None:
        self.refuse = refuse
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def users_info(self, **kwargs: Any) -> dict[str, Any]:
        return {"user": {"name": "ada", "profile": {"display_name": "Ada"}}}

    async def conversations_info(self, **kwargs: Any) -> dict[str, Any]:
        return {"channel": {"is_private": False}}

    async def conversations_open(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("conversations_open", kwargs))
        if self.refuse is not None:
            raise SlackApiError("refused", {"ok": False, "error": self.refuse})
        return {"channel": {"id": "D42"}}

    async def chat_postMessage(self, **kwargs: Any) -> dict[str, str]:
        self.calls.append(("chat_postMessage", kwargs))
        return {"ts": "111.1"}

    async def chat_postEphemeral(self, **kwargs: Any) -> dict[str, str]:
        self.calls.append(("chat_postEphemeral", kwargs))
        return {"message_ts": "222.2"}

    async def chat_update(self, **kwargs: Any) -> dict[str, str]:
        self.calls.append(("chat_update", kwargs))
        if self.refuse is not None:
            raise SlackApiError("refused", {"ok": False, "error": self.refuse})
        return {"ts": kwargs["ts"]}


def _command(**overrides: Any) -> InboundCommand:
    fields: dict[str, Any] = {
        "channel_id": "C999",
        "channel_type": "channel_public",
        "sender_id": "U-ada",
        "sender_name": "ada",
        "command": "link-account",
        "args": "7KQ2-M9XD",
    }
    fields.update(overrides)
    return InboundCommand(**fields)


class TestAccountSlashCommands:
    async def test_runs_without_a_visible_running_post(self) -> None:
        adapter = _adapter()
        web = _WebClient()
        adapter._web_client = web  # type: ignore[assignment]
        commands: list[InboundCommand] = []

        async def on_command(command: InboundCommand) -> None:
            commands.append(command)

        adapter._on_command = on_command

        await adapter._handle_slash_command(
            {
                "command": "/link-account",
                "text": "7KQ2-M9XD",
                "channel_id": "C999",
                "user_id": "U-ada",
                "response_url": _RESPONSE_URL,
            }
        )

        # A Running post would show the code to the channel, and fails where
        # the app is not a member.
        assert [name for name, _ in web.calls if name == "chat_postMessage"] == []
        [command] = commands
        assert command.command == "link-account"
        assert command.args == "7KQ2-M9XD"
        assert command.reply_ref == _RESPONSE_URL
        assert command.message_ref is None

    async def test_another_slash_command_still_posts_running(self) -> None:
        adapter = _adapter()
        web = _WebClient()
        adapter._web_client = web  # type: ignore[assignment]
        commands: list[InboundCommand] = []

        async def on_command(command: InboundCommand) -> None:
            commands.append(command)

        adapter._on_command = on_command

        await adapter._handle_slash_command(
            {
                "command": "/agents-status",
                "text": "",
                "channel_id": "C999",
                "user_id": "U-ada",
                "response_url": _RESPONSE_URL,
            }
        )

        assert [name for name, _ in web.calls] == ["chat_postMessage"]
        assert commands[0].reply_ref is None


class TestAnsweringAccountCommands:
    async def test_a_slash_command_is_answered_through_its_response_url(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        posted: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            posted.append(request)
            return httpx.Response(200, text="ok")

        real_client = httpx.AsyncClient
        monkeypatch.setattr(
            slack_adapter.httpx,
            "AsyncClient",
            lambda **kwargs: real_client(
                transport=httpx.MockTransport(handler), **kwargs
            ),
        )
        adapter = _adapter()
        web = _WebClient()
        adapter._web_client = web  # type: ignore[assignment]

        await adapter.answer_command(_command(reply_ref=_RESPONSE_URL), "✅ **Linked**")

        [request] = posted
        assert str(request.url) == _RESPONSE_URL
        body = request.read().decode()
        assert '"response_type":"ephemeral"' in body.replace(" ", "")
        assert "*Linked*" in body
        assert web.calls == []

    async def test_a_govslack_response_url_is_answered(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        posted: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            posted.append(request)
            return httpx.Response(200, text="ok")

        real_client = httpx.AsyncClient
        monkeypatch.setattr(
            slack_adapter.httpx,
            "AsyncClient",
            lambda **kwargs: real_client(
                transport=httpx.MockTransport(handler), **kwargs
            ),
        )
        adapter = _adapter()
        adapter._web_client = _WebClient()  # type: ignore[assignment]
        gov = "https://hooks.slack-gov.com/commands/T123/1/abc"

        await adapter.answer_command(_command(reply_ref=gov), "Done")

        assert [str(request.url) for request in posted] == [gov]

    async def test_a_response_url_that_is_not_slacks_is_never_posted_to(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise AssertionError(f"posted to {request.url}")

        real_client = httpx.AsyncClient
        monkeypatch.setattr(
            slack_adapter.httpx,
            "AsyncClient",
            lambda **kwargs: real_client(
                transport=httpx.MockTransport(handler), **kwargs
            ),
        )
        adapter = _adapter()
        web = _WebClient()
        adapter._web_client = web  # type: ignore[assignment]

        await adapter.answer_command(
            _command(reply_ref="https://attacker.example/collect"), "secret"
        )

        # Falls back to the ephemeral post, which only Slack delivers.
        assert [name for name, _ in web.calls] == ["chat_postEphemeral"]

    async def test_a_typed_command_is_answered_ephemerally(self) -> None:
        adapter = _adapter()
        web = _WebClient()
        adapter._web_client = web  # type: ignore[assignment]

        await adapter.answer_command(_command(root_id="C999:100.1"), "Done")

        [(name, kwargs)] = web.calls
        assert name == "chat_postEphemeral"
        assert kwargs["channel"] == "C999"
        assert kwargs["user"] == "U-ada"
        assert kwargs["thread_ts"] == "100.1"


class TestDirectPrompts:
    async def test_the_prompt_goes_to_the_apps_conversation_with_the_person(
        self,
    ) -> None:
        adapter = _adapter()
        web = _WebClient()
        adapter._web_client = web  # type: ignore[assignment]

        ref = await adapter.send_direct_prompt("U-ada", _PROMPT)

        assert ref == "D42:111.1"
        (_, opened), (_, posted) = web.calls
        assert opened == {"users": "U-ada"}
        assert posted["channel"] == "D42"
        section, actions = posted["blocks"]
        assert (
            section["text"]["text"]
            == "*Ada* (ada@example.com) is linking this Slack account."
        )
        buttons = actions["elements"]
        assert [b["text"]["text"] for b in buttons] == list(_PROMPT.labels)
        assert [parse_answer_position(b["action_id"]) for b in buttons] == [1, 2, 3, 4]
        assert {b["value"] for b in buttons} == {_PROMPT.token}
        assert [b.get("style") for b in buttons] == [None, None, None, "danger"]

    async def test_the_link_opens_the_apps_conversation_in_its_workspace(
        self,
    ) -> None:
        adapter = _adapter()
        adapter._team_id = "T-installed"

        link = adapter.direct_prompt_link("D42:111.1")

        assert link == "https://slack.com/app_redirect?channel=D42&team=T-installed"

    async def test_without_a_known_workspace_slack_picks_the_persons_default(
        self,
    ) -> None:
        assert (
            _adapter().direct_prompt_link("D42:111.1")
            == "https://slack.com/app_redirect?channel=D42"
        )

    async def test_slack_refusing_the_conversation_falls_back_to_the_code(
        self,
    ) -> None:
        adapter = _adapter()
        adapter._web_client = _WebClient(refuse="cannot_dm_bot")  # type: ignore[assignment]

        with pytest.raises(DirectMessageUnavailable, match="cannot_dm_bot"):
            await adapter.send_direct_prompt("U-ada", _PROMPT)

    async def test_an_answered_prompt_loses_its_buttons(self) -> None:
        adapter = _adapter()
        web = _WebClient()
        adapter._web_client = web  # type: ignore[assignment]

        await adapter.settle_direct_prompt("D42:111.1", "✅ **Linked**")

        [(name, kwargs)] = web.calls
        assert name == "chat_update"
        assert kwargs["channel"] == "D42"
        assert kwargs["ts"] == "111.1"
        assert [block["type"] for block in kwargs["blocks"]] == ["section"]
        assert "*Linked*" in kwargs["text"]

    async def test_settling_never_raises(self) -> None:
        adapter = _adapter()
        adapter._web_client = _WebClient(refuse="message_not_found")  # type: ignore[assignment]

        await adapter.settle_direct_prompt("D42:111.1", "Done")


def _press(value: str = _PROMPT.token, position: int = 2) -> dict[str, Any]:
    """A tap on one of the prompt's buttons, as Socket Mode hands it over."""
    return {
        "type": "block_actions",
        "user": {"id": "U-ada"},
        "channel": {"id": "D42"},
        "container": {"channel_id": "D42", "message_ts": "111.1"},
        "actions": [{"action_id": position_action(position), "value": value}],
    }


class TestTapsReachTheLinkFlow:
    async def test_a_tap_in_the_apps_conversation_is_passed_on_with_who_tapped(
        self,
    ) -> None:
        adapter = _adapter()
        adapter._web_client = _WebClient()  # type: ignore[assignment]
        pressed: list[InboundInteraction] = []

        async def on_interaction(interaction: InboundInteraction) -> None:
            pressed.append(interaction)

        adapter.set_interaction_handler(on_interaction)

        await adapter.dispatch_event(envelope_type="interactive", payload=_press())

        [interaction] = pressed
        # Who tapped is what Slack says; the button carries only the token.
        assert interaction.sender_id == "U-ada"
        assert interaction.value == _PROMPT.token
        assert parse_answer_position(interaction.action_id) == 2
        assert interaction.message_ref == "D42:111.1"


class TestNoSilentFailures:
    async def test_a_tap_that_cannot_be_acted_on_is_answered_privately(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        adapter = _adapter()
        web = _WebClient()
        adapter._web_client = web  # type: ignore[assignment]

        async def broken(_interaction: InboundInteraction) -> None:
            raise RuntimeError(f"database refused token {_PROMPT.token} hunter2")

        adapter.set_interaction_handler(broken)

        await adapter.dispatch_event(envelope_type="interactive", payload=_press())

        [(name, kwargs)] = web.calls
        assert name == "chat_postEphemeral"
        assert kwargs["channel"] == "D42"
        assert kwargs["user"] == "U-ada"
        # Says it could not be processed, and nothing of why.
        assert "couldn" in kwargs["text"].lower()
        assert "hunter2" not in kwargs["text"]
        assert "RuntimeError" not in kwargs["text"]
        assert "Could not act on a button press" in caplog.text
        assert "RuntimeError" in caplog.text
        # The log names the failure, never what the person's press carried.
        assert _PROMPT.token not in caplog.text
        assert "hunter2" not in caplog.text

    async def test_a_link_command_that_cannot_be_acted_on_is_answered_privately(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        posted: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            posted.append(request)
            return httpx.Response(200, text="ok")

        real_client = httpx.AsyncClient
        monkeypatch.setattr(
            slack_adapter.httpx,
            "AsyncClient",
            lambda **kwargs: real_client(
                transport=httpx.MockTransport(handler), **kwargs
            ),
        )
        adapter = _adapter()
        web = _WebClient()
        adapter._web_client = web  # type: ignore[assignment]

        async def broken(_command: InboundCommand) -> None:
            raise RuntimeError("code 7KQ2-M9XD for user 42 blew up")

        adapter._on_command = broken

        await adapter.dispatch_event(
            envelope_type="slash_commands",
            payload={
                "command": "/link-account",
                "text": "7KQ2-M9XD",
                "channel_id": "D-self",
                "user_id": "U-ada",
                "response_url": _RESPONSE_URL,
            },
        )

        [request] = posted
        assert str(request.url) == _RESPONSE_URL
        body = request.read().decode()
        assert '"response_type":"ephemeral"' in body.replace(" ", "")
        assert "couldn" in body.lower()
        # Neither the code nor the error goes back.
        assert "7KQ2-M9XD" not in body
        assert "blew up" not in body
        assert web.calls == []
        # Nor does the code reach the log, though the error carried it.
        assert "Could not act on /link-account" in caplog.text
        assert "7KQ2-M9XD" not in caplog.text

    def test_the_reply_names_no_reason(self) -> None:
        assert slack_adapter.COULD_NOT_PROCESS.startswith("Switch couldn't process")


class TestCodeInstructions:
    def test_an_own_app_says_what_a_tap_that_does_nothing_means(self) -> None:
        text = SlackAdapter.link_code_instructions("7KQ2-M9XD", {})

        assert text.startswith("Type `/link-account 7KQ2-M9XD`")
        assert "Interactivity is off" in text

    def test_switchs_own_app_does_not(self) -> None:
        text = SlackAdapter.link_code_instructions(
            "7KQ2-M9XD", {"event_delivery": "webhook"}
        )

        assert "Interactivity" not in text
