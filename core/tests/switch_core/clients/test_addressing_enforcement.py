from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace

from switch_core.clients.agent_client import (
    _ADDRESSING_DENIED_MESSAGE,
    AUTO_REPLY_FLAG,
    AgentClient,
)


@asynccontextmanager
async def _session_factory():  # type: ignore[no-untyped-def]
    yield object()


def _meta(room_id: str = "room-1") -> SimpleNamespace:
    return SimpleNamespace(room_id=room_id)


def _event(
    sender: str = "@u:switch.local", auto_reply: bool = False
) -> SimpleNamespace:
    content: dict = {"sender_name": "human"}
    if auto_reply:
        content[AUTO_REPLY_FLAG] = True
    return SimpleNamespace(
        sender=sender,
        body="@fixer help",
        source={"content": content},
        event_id="$evt",
    )


class TestResolveSenderPrincipal:
    """mxid → Client → Agent (agent sender) or ExternalUser (human sender)."""

    def _client(self, *, client, agent, external_user) -> SimpleNamespace:  # type: ignore[no-untyped-def]
        async def _get_by_mxid(_session, _mxid):  # type: ignore[no-untyped-def]
            return client

        async def _agent_by_client(_session, _cid):  # type: ignore[no-untyped-def]
            return agent

        async def _ext_by_client(_session, _cid):  # type: ignore[no-untyped-def]
            return external_user

        return SimpleNamespace(
            client_store=SimpleNamespace(get_by_matrix_user_id=_get_by_mxid),
            _agent_store=SimpleNamespace(get_by_client_id=_agent_by_client),
            _external_user_store=SimpleNamespace(get_by_client_id=_ext_by_client),
        )

    async def test_agent_sender(self) -> None:
        client = self._client(
            client=SimpleNamespace(id="c1"),
            agent=SimpleNamespace(id="agent-7"),
            external_user=None,
        )
        result = await AgentClient._resolve_sender_principal(
            client, object(), "@a:switch.local"
        )
        assert result == ("agent", "agent-7")

    async def test_human_sender(self) -> None:
        client = self._client(
            client=SimpleNamespace(id="c1"),
            agent=None,
            external_user=SimpleNamespace(id="ext-3"),
        )
        result = await AgentClient._resolve_sender_principal(
            client, object(), "@u:switch.local"
        )
        assert result == ("user", "ext-3")

    async def test_unknown_client_is_none(self) -> None:
        client = self._client(client=None, agent=None, external_user=None)
        result = await AgentClient._resolve_sender_principal(
            client, object(), "@ghost:switch.local"
        )
        assert result is None

    async def test_client_with_no_agent_or_external_user_is_none(self) -> None:
        # A Client that is neither an agent nor a bridged human (e.g. a system
        # client) does not resolve to an addressing principal.
        client = self._client(
            client=SimpleNamespace(id="c1"), agent=None, external_user=None
        )
        result = await AgentClient._resolve_sender_principal(
            client, object(), "@system:switch.local"
        )
        assert result is None


def _allowed_client(
    *,
    policy: dict | None,
    principal: tuple[str, str] | None,
    group_id: str | None = None,
) -> SimpleNamespace:
    """Fake client for _addressing_allowed: the agent carries `policy`, the
    sender resolves to `principal`, and the room has `group_id`."""

    agent = SimpleNamespace(name="fixer", addressing_policy=policy)

    async def _fresh_agent():  # type: ignore[no-untyped-def]
        return agent

    async def _resolve(_session, _mxid):  # type: ignore[no-untyped-def]
        return principal

    async def _get_room(_session, _room_id):  # type: ignore[no-untyped-def]
        return SimpleNamespace(group_id=group_id)

    return SimpleNamespace(
        agent=agent,
        _fresh_agent=_fresh_agent,
        session_factory=_session_factory,
        _resolve_sender_principal=_resolve,
        _room_store=SimpleNamespace(get=_get_room),
    )


class TestAddressingAllowed:
    async def test_open_policy_allows_without_lookup(self) -> None:
        # No policy → open; must not even need a resolvable sender.
        client = _allowed_client(policy=None, principal=None)
        assert await AgentClient._addressing_allowed(client, _event(), _meta()) is True

    async def test_permitted_sender(self) -> None:
        policy = {"rules": [{"users": ["ext-3"], "agents": []}]}
        client = _allowed_client(policy=policy, principal=("user", "ext-3"))
        assert await AgentClient._addressing_allowed(client, _event(), _meta()) is True

    async def test_denied_sender(self) -> None:
        policy = {"rules": [{"users": ["ext-3"], "agents": []}]}
        client = _allowed_client(policy=policy, principal=("user", "someone-else"))
        assert await AgentClient._addressing_allowed(client, _event(), _meta()) is False

    async def test_unresolvable_sender_fails_closed(self) -> None:
        # A restricted agent must not be addressable by an unresolvable sender.
        policy = {"rules": [{"users": ["ext-3"], "agents": []}]}
        client = _allowed_client(policy=policy, principal=None)
        assert await AgentClient._addressing_allowed(client, _event(), _meta()) is False

    async def test_group_scoped_policy(self) -> None:
        policy = {"rules": [{"room_groups": ["g1"], "agents": []}]}
        allowed = _allowed_client(
            policy=policy, principal=("user", "u1"), group_id="g1"
        )
        denied = _allowed_client(policy=policy, principal=("user", "u1"), group_id="g2")
        assert await AgentClient._addressing_allowed(allowed, _event(), _meta()) is True
        assert await AgentClient._addressing_allowed(denied, _event(), _meta()) is False


def _gate_client(*, allowed: bool) -> SimpleNamespace:
    """Fake client for _gate_addressed: records any auto-reply sent."""
    sent: list[dict] = []

    async def _addressing_allowed(_event, _meta):  # type: ignore[no-untyped-def]
        return allowed

    async def _send_message(room_id, body, **kwargs):  # type: ignore[no-untyped-def]
        sent.append({"room_id": room_id, "body": body, **kwargs})

    def _sender_handle(_event):  # type: ignore[no-untyped-def]
        return "human"

    client = SimpleNamespace(
        _addressing_allowed=_addressing_allowed,
        send_message=_send_message,
        _sender_handle=_sender_handle,
    )
    client.sent = sent  # type: ignore[attr-defined]
    return client


def _room() -> SimpleNamespace:
    return SimpleNamespace(room_id="!matrix:switch.local")


class TestGateAddressed:
    async def test_not_addressed_short_circuits(self) -> None:
        client = _gate_client(allowed=False)
        result = await AgentClient._gate_addressed(
            client, _room(), _event(), _meta(), "$root", False
        )
        assert result is False
        assert client.sent == []  # no reply for an untagged message

    async def test_allowed_stays_addressed(self) -> None:
        client = _gate_client(allowed=True)
        result = await AgentClient._gate_addressed(
            client, _room(), _event(), _meta(), "$root", True
        )
        assert result is True
        assert client.sent == []

    async def test_denied_demotes_and_replies(self) -> None:
        client = _gate_client(allowed=False)
        result = await AgentClient._gate_addressed(
            client, _room(), _event(), _meta(), "$root", True
        )
        assert result is False
        assert len(client.sent) == 1
        reply = client.sent[0]
        assert _ADDRESSING_DENIED_MESSAGE in reply["body"]
        assert reply["body"].startswith("@human")
        # Guarded so a denied auto-reply can't re-trigger another one.
        assert reply["extra_content"] == {AUTO_REPLY_FLAG: True}
        assert reply["thread_root_id"] == "$root"

    async def test_denied_auto_reply_does_not_ping_pong(self) -> None:
        # If the tagging message was itself an auto-reply, do not reply again.
        client = _gate_client(allowed=False)
        result = await AgentClient._gate_addressed(
            client, _room(), _event(auto_reply=True), _meta(), "$root", True
        )
        assert result is False
        assert client.sent == []
