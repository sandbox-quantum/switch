from types import SimpleNamespace
from unittest.mock import AsyncMock

import discord
import pytest

from switch_core.bridges.collaboration.discord.adapter import _WebhookIdentity


@pytest.mark.parametrize("name", ["discord-agent", "CLYDE", "", " ", "x" * 81])
async def test_invalid_identifier_uses_disclosed_stable_name(
    name: str, caplog: pytest.LogCaptureFixture
) -> None:
    webhook = SimpleNamespace(send=AsyncMock())
    payload = {"content": "x" * 2000, "suppress_embeds": True}
    identity = _WebhookIdentity(name, name)
    await identity.send(webhook, payload)
    await _WebhookIdentity(name, name).send(webhook, payload)
    first, second = [call.kwargs for call in webhook.send.call_args_list]
    assert first["username"] == second["username"]
    assert first["username"].startswith("Switch agent ")
    assert len(first["username"]) <= 80
    assert first["content"] == payload["content"]
    assert first["suppress_embeds"] is False
    assert name in first["embeds"][0].footer.text
    assert "different sender name" in first["embeds"][0].footer.text
    assert "cannot use display name" in caplog.text
    assert "embeds" not in payload


@pytest.mark.parametrize("name", ["Agent", "a", "x" * 80, "Bo*b"])
async def test_valid_username_and_payload_are_unchanged(name: str) -> None:
    webhook = SimpleNamespace(send=AsyncMock())
    await _WebhookIdentity(name, "worker").send(webhook, {"content": "hello"})
    webhook.send.assert_awaited_once_with(username=name, content="hello")


async def test_invalid_display_name_can_use_valid_identifier() -> None:
    webhook = SimpleNamespace(send=AsyncMock())
    await _WebhookIdentity("Discord helper", "worker").send(
        webhook, {"content": "hello"}
    )
    webhook.send.assert_awaited_once_with(username="worker", content="hello")


async def test_refused_display_name_retries_with_safe_identifier_once() -> None:
    refusal = discord.HTTPException(
        SimpleNamespace(status=400, reason="Bad Request"), "Invalid Form Body"
    )
    webhook = SimpleNamespace(send=AsyncMock(side_effect=[refusal, None, None]))
    identity = _WebhookIdentity("Worker", "discord-worker")
    payloads = []

    def build_payload() -> dict:
        payload = {"content": "hello"}
        payloads.append(payload)
        return payload

    await identity.send_rebuilding(webhook, build_payload)
    await identity.send_rebuilding(webhook, build_payload)
    calls = [call.kwargs for call in webhook.send.call_args_list]
    assert calls[0]["username"] == "Worker"
    assert calls[1]["username"] == calls[2]["username"]
    assert calls[1]["username"].startswith("Switch agent ")
    assert len(calls[1]["embeds"]) == 1
    assert "discord-worker" in calls[1]["embeds"][0].footer.text
    assert len(payloads) == 3
    assert payloads[0] is not payloads[1]


async def test_safe_fallback_names_distinguish_agents() -> None:
    webhook = SimpleNamespace(send=AsyncMock())
    for name in ["discord-one", "discord-two"]:
        await _WebhookIdentity(name, name).send(webhook, {"content": "hello"})
    assert len({call.kwargs["username"] for call in webhook.send.call_args_list}) == 2


@pytest.mark.parametrize("key", ["embed", "embeds"])
async def test_disclosure_refuses_existing_embeds_before_sending(key: str) -> None:
    webhook = SimpleNamespace(send=AsyncMock())
    payload = {"content": "hello", key: [discord.Embed(description="x" * 6000)]}
    with pytest.raises(ValueError, match="requires a payload without embeds"):
        await _WebhookIdentity("discord-worker", "discord-worker").send(
            webhook, payload
        )
    webhook.send.assert_not_awaited()


async def test_disclosure_stays_within_embed_limits_for_long_identifier() -> None:
    webhook = SimpleNamespace(send=AsyncMock())
    await _WebhookIdentity("x" * 10000, "x" * 10000).send(
        webhook, {"content": "x" * 2000}
    )
    embeds = webhook.send.call_args.kwargs["embeds"]
    assert len(embeds) == 1
    assert len(embeds[0]) < 6000
    assert len(embeds[0].footer.text) < 2048
