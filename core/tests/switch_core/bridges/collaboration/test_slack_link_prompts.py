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
)
from switch_core.bridges.collaboration.session.renderers import (
    parse_answer_position,
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
