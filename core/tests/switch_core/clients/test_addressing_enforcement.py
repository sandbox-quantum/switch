from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace

from switch_core.clients.agent_client import (
    _ADDRESSING_DENIED_MESSAGE,
    _ADDRESSING_UNCLAIMED_MESSAGE,
    AUTO_REPLY_FLAG,
    AgentClient,
    _AddressingDecision,
    _SenderPrincipal,
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
    """mxid → Client → Agent (agent sender) or ExternalUser (human sender),
    plus every Switch user who has claimed the human's platform identity."""

    def _client(self, *, client, agent, external_user, claimants=()) -> SimpleNamespace:  # type: ignore[no-untyped-def]
        async def _get_by_mxid(_session, _mxid):  # type: ignore[no-untyped-def]
            return client

        async def _agent_by_client(_session, _cid):  # type: ignore[no-untyped-def]
            return agent

        async def _ext_by_client(_session, _cid):  # type: ignore[no-untyped-def]
            return external_user

        async def _claimant_ids(_session, _external_user_id):  # type: ignore[no-untyped-def]
            return list(claimants)

        return SimpleNamespace(
            client_store=SimpleNamespace(get_by_matrix_user_id=_get_by_mxid),
            _agent_store=SimpleNamespace(get_by_client_id=_agent_by_client),
            _external_user_store=SimpleNamespace(
                get_by_client_id=_ext_by_client, claimant_ids=_claimant_ids
            ),
        )

    async def test_agent_sender(self) -> None:
        # An agent carries no Switch user: it is never its owner, even its
        # owner's own agent.
        client = self._client(
            client=SimpleNamespace(id="c1"),
            agent=SimpleNamespace(id="agent-7", owner_id="user-1"),
            external_user=None,
        )
        result = await AgentClient._resolve_sender_principal(
            client, object(), "@a:switch.local"
        )
        assert result == ("agent", "agent-7", [], "user-1")

    async def test_human_sender_claimed(self) -> None:
        client = self._client(
            client=SimpleNamespace(id="c1"),
            agent=None,
            external_user=SimpleNamespace(id="ext-3"),
            claimants=["user-1"],
        )
        result = await AgentClient._resolve_sender_principal(
            client, object(), "@u:switch.local"
        )
        assert result == ("user", "ext-3", ["user-1"], None)

    async def test_human_sender_claimed_by_several(self) -> None:
        # Claiming is not exclusive, so the principal carries every claimant
        # rather than picking one.
        client = self._client(
            client=SimpleNamespace(id="c1"),
            agent=None,
            external_user=SimpleNamespace(id="ext-3"),
            claimants=["user-1", "user-2"],
        )
        result = await AgentClient._resolve_sender_principal(
            client, object(), "@u:switch.local"
        )
        assert result == ("user", "ext-3", ["user-1", "user-2"], None)

    async def test_human_sender_unclaimed(self) -> None:
        # Nobody has linked this platform identity to a Switch user.
        client = self._client(
            client=SimpleNamespace(id="c1"),
            agent=None,
            external_user=SimpleNamespace(id="ext-3"),
        )
        result = await AgentClient._resolve_sender_principal(
            client, object(), "@u:switch.local"
        )
        assert result == ("user", "ext-3", [], None)

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
    principal: tuple[str, str, list[str]] | None,
    sender_owner_id: str | None = None,
    group_id: str | None = None,
    owner_id: str | None = None,
) -> SimpleNamespace:
    """Fake client for _addressing_allowed: the agent carries `policy` and is
    owned by `owner_id`, the sender resolves to `principal` (kind, id,
    claimants) owned by `sender_owner_id`, and the room has `group_id`."""

    agent = SimpleNamespace(name="fixer", addressing_policy=policy, owner_id=owner_id)

    async def _resolve(_session, _mxid):  # type: ignore[no-untyped-def]
        if principal is None:
            return None
        kind, sender_id, claimants = principal
        return _SenderPrincipal(kind, sender_id, claimants, sender_owner_id)  # type: ignore[arg-type]

    async def _get_room(_session, _room_id):  # type: ignore[no-untyped-def]
        return SimpleNamespace(group_id=group_id)

    return SimpleNamespace(
        agent=agent,
        session_factory=_session_factory,
        _resolve_sender_principal=_resolve,
        _room_store=SimpleNamespace(get=_get_room),
    )


async def _decide(client: SimpleNamespace, room_id: str = "room-1"):  # type: ignore[no-untyped-def]
    return await AgentClient._addressing_allowed(
        client, None, client.agent, "@u:switch.local", room_id
    )


class TestAddressingAllowed:
    async def test_open_policy_allows_without_lookup(self) -> None:
        # No policy → open; must not even need a resolvable sender.
        client = _allowed_client(policy=None, principal=None)
        assert (await _decide(client)).allowed is True

    async def test_permitted_sender(self) -> None:
        policy = {"rules": [{"users": ["ext-3"], "agents": []}]}
        client = _allowed_client(policy=policy, principal=("user", "ext-3", []))
        assert (await _decide(client)).allowed is True

    async def test_denied_sender(self) -> None:
        policy = {"rules": [{"users": ["ext-3"], "agents": []}]}
        client = _allowed_client(policy=policy, principal=("user", "someone-else", []))
        decision = await _decide(client)
        assert decision.allowed is False
        assert decision.refusal == _ADDRESSING_DENIED_MESSAGE

    async def test_unresolvable_sender_fails_closed(self) -> None:
        # A restricted agent must not be addressable by an unresolvable sender.
        policy = {"rules": [{"users": ["ext-3"], "agents": []}]}
        client = _allowed_client(policy=policy, principal=None)
        decision = await _decide(client)
        assert decision.allowed is False
        assert decision.refusal == _ADDRESSING_DENIED_MESSAGE

    async def test_group_scoped_policy(self) -> None:
        policy = {"rules": [{"room_groups": ["g1"], "agents": []}]}
        allowed = _allowed_client(
            policy=policy, principal=("user", "u1", []), group_id="g1"
        )
        denied = _allowed_client(
            policy=policy, principal=("user", "u1", []), group_id="g2"
        )
        assert (await _decide(allowed)).allowed is True
        assert (await _decide(denied)).allowed is False


class TestOwnerAddressing:
    """An owner-scoped policy resolves the owner at enforcement time from the
    agent's `owner_id` and the Switch users who have claimed the sender's
    platform account."""

    _POLICY = {"rules": [{"users": [], "agents": [], "owner": True}]}

    async def test_owner_allowed(self) -> None:
        client = _allowed_client(
            policy=self._POLICY,
            principal=("user", "ext-3", ["user-1"]),
            owner_id="user-1",
        )
        assert (await _decide(client)).allowed is True

    async def test_owner_among_several_claimants_allowed(self) -> None:
        # Someone else claiming the same account does not lock the owner out.
        client = _allowed_client(
            policy=self._POLICY,
            principal=("user", "ext-3", ["user-2", "user-1"]),
            owner_id="user-1",
        )
        assert (await _decide(client)).allowed is True

    async def test_other_user_denied_with_generic_wording(self) -> None:
        # This sender IS claimed — they just aren't the owner, so telling them
        # to link their account would be wrong.
        client = _allowed_client(
            policy=self._POLICY,
            principal=("user", "ext-9", ["user-2"]),
            owner_id="user-1",
        )
        decision = await _decide(client)
        assert decision.allowed is False
        assert decision.refusal == _ADDRESSING_DENIED_MESSAGE

    async def test_claimed_by_others_only_denied_with_generic_wording(self) -> None:
        # Several claimants, none of them the owner: still claimed, so the
        # "link your account" wording would be misleading.
        client = _allowed_client(
            policy=self._POLICY,
            principal=("user", "ext-9", ["user-2", "user-3"]),
            owner_id="user-1",
        )
        decision = await _decide(client)
        assert decision.allowed is False
        assert decision.refusal == _ADDRESSING_DENIED_MESSAGE

    async def test_unclaimed_sender_gets_link_your_account_wording(self) -> None:
        client = _allowed_client(
            policy=self._POLICY,
            principal=("user", "ext-3", []),
            owner_id="user-1",
        )
        decision = await _decide(client)
        assert decision.allowed is False
        assert decision.refusal == _ADDRESSING_UNCLAIMED_MESSAGE

    async def test_unclaimed_sender_without_owner_rule_gets_generic_wording(
        self,
    ) -> None:
        # Nothing to link an account for: the policy never consults the owner.
        client = _allowed_client(
            policy={"rules": [{"users": ["ext-3"], "agents": []}]},
            principal=("user", "someone-else", []),
            owner_id="user-1",
        )
        decision = await _decide(client)
        assert decision.allowed is False
        assert decision.refusal == _ADDRESSING_DENIED_MESSAGE

    async def test_agent_sender_denied_generically(self) -> None:
        # An agent is never the owner, and the unclaimed wording is meaningless
        # for it — it has no chat account to link.
        client = _allowed_client(
            policy=self._POLICY,
            principal=("agent", "agent-7", []),
            owner_id="user-1",
        )
        decision = await _decide(client)
        assert decision.allowed is False
        assert decision.refusal == _ADDRESSING_DENIED_MESSAGE

    async def test_ownerless_agent_denies_its_would_be_owner(self) -> None:
        client = _allowed_client(
            policy=self._POLICY,
            principal=("user", "ext-3", ["user-1"]),
            owner_id=None,
        )
        assert (await _decide(client)).allowed is False

    async def test_allowed_agent_still_gets_in(self) -> None:
        policy = {"rules": [{"users": [], "agents": ["agent-7"], "owner": True}]}
        client = _allowed_client(
            policy=policy,
            principal=("agent", "agent-7", []),
            owner_id="user-1",
        )
        assert (await _decide(client)).allowed is True


class TestOwnerAgentsAddressing:
    """`owner_agents` on the room-message path (CHOO-2137)."""

    _POLICY = {"rules": [{"users": [], "agents": [], "owner_agents": True}]}

    async def test_an_agent_of_the_same_owner_is_let_in(self) -> None:
        client = _allowed_client(
            policy=self._POLICY,
            principal=("agent", "manager", []),
            sender_owner_id="user-1",
            owner_id="user-1",
        )
        assert (await _decide(client)).allowed is True

    async def test_somebody_elses_agent_is_refused(self) -> None:
        client = _allowed_client(
            policy=self._POLICY,
            principal=("agent", "their-manager", []),
            sender_owner_id="user-2",
            owner_id="user-1",
        )
        decision = await _decide(client)
        assert decision.allowed is False
        assert decision.refusal == _ADDRESSING_DENIED_MESSAGE

    async def test_the_owner_in_person_is_not_covered_by_it(self) -> None:
        # Only `owner` admits the human. A rule that says "my agents may" and
        # silently also meant "I may" would make the two shortcuts identical.
        client = _allowed_client(
            policy=self._POLICY,
            principal=("user", "ext-3", ["user-1"]),
            owner_id="user-1",
        )
        assert (await _decide(client)).allowed is False

    async def test_the_refusal_does_not_tell_an_agent_to_link_an_account(
        self,
    ) -> None:
        # The unclaimed-identity wording is for a human whose chat account
        # nobody has claimed. An agent has none to link, so pointing it at that
        # would send whoever reads the room down the wrong path.
        policy = {
            "rules": [{"users": [], "agents": [], "owner": True, "owner_agents": True}]
        }
        client = _allowed_client(
            policy=policy,
            principal=("agent", "stranger", []),
            sender_owner_id="user-2",
            owner_id="user-1",
        )
        assert (await _decide(client)).refusal == _ADDRESSING_DENIED_MESSAGE


def _gate_client(*, allowed: bool, refusal: str = _ADDRESSING_DENIED_MESSAGE):  # type: ignore[no-untyped-def]
    """Fake client for _gate_addressed and the auto-reply it hands back."""
    sent: list[dict] = []

    async def _addressing_allowed(_session, _agent, _matrix_sender, _room_id):  # type: ignore[no-untyped-def]
        return _AddressingDecision(allowed=allowed, refusal="" if allowed else refusal)

    async def _send_message(room_id, body, **kwargs):  # type: ignore[no-untyped-def]
        sent.append({"room_id": room_id, "body": body, **kwargs})

    def _sender_handle(_event):  # type: ignore[no-untyped-def]
        return "human"

    client = SimpleNamespace(
        agent=SimpleNamespace(name="fixer"),
        _addressing_allowed=_addressing_allowed,
        send_message=_send_message,
        _sender_handle=_sender_handle,
        _triggered_by_auto_reply=AgentClient._triggered_by_auto_reply,
    )
    client._post_auto_reply = AgentClient._post_auto_reply.__get__(client)
    client.sent = sent  # type: ignore[attr-defined]
    return client


def _room() -> SimpleNamespace:
    return SimpleNamespace(room_id="!matrix:switch.local")


async def _gate(client: SimpleNamespace, event: SimpleNamespace):  # type: ignore[no-untyped-def]
    """Run the gate and post whatever refusal it hands back, the way on_message
    does — the gate itself never touches Matrix, so that its caller can close
    the database session first."""
    outcome = await AgentClient._gate_addressed(
        client, None, client.agent, event, _meta()
    )
    if outcome.refusal is not None:
        await client._post_auto_reply(
            "!matrix:switch.local", event, outcome.refusal, "$root"
        )
    return outcome


class TestGateAddressed:
    async def test_allowed_stays_addressed(self) -> None:
        client = _gate_client(allowed=True)
        outcome = await _gate(client, _event())
        assert outcome.addressed is True
        assert outcome.refusal is None
        assert client.sent == []

    async def test_denied_demotes_and_replies(self) -> None:
        client = _gate_client(allowed=False)
        outcome = await _gate(client, _event())
        assert outcome.addressed is False
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
        outcome = await _gate(client, _event(auto_reply=True))
        assert outcome.addressed is False
        assert outcome.refusal is None
        assert client.sent == []

    async def test_reply_carries_the_decision_wording(self) -> None:
        # The refusal the decision chose is what the sender sees, not a
        # re-derived generic one.
        client = _gate_client(allowed=False, refusal=_ADDRESSING_UNCLAIMED_MESSAGE)
        await _gate(client, _event())
        assert _ADDRESSING_UNCLAIMED_MESSAGE in client.sent[0]["body"]

    async def test_nothing_is_posted_from_inside_the_gate(self) -> None:
        # The point of returning the refusal: the caller holds a database
        # session while the gate runs and must close it before talking to
        # Matrix.
        client = _gate_client(allowed=False)
        outcome = await AgentClient._gate_addressed(
            client, None, client.agent, _event(), _meta()
        )
        assert outcome.refusal == _ADDRESSING_DENIED_MESSAGE
        assert client.sent == []


def _command(
    args: str = "", user_id: str = "@u:switch.local", command: str = "reset"
) -> SimpleNamespace:
    return SimpleNamespace(
        command=command, args=args, user_id=user_id, thread_id="$cmd"
    )


def _command_client(*, allowed: bool, targets_me: bool):  # type: ignore[no-untyped-def]
    """Fake client for _gate_command: records any command reply posted."""
    replies: list[dict] = []

    async def _addressing_allowed(_session, _agent, _matrix_sender, _room_id):  # type: ignore[no-untyped-def]
        return _AddressingDecision(
            allowed=allowed, refusal="" if allowed else _ADDRESSING_DENIED_MESSAGE
        )

    async def _targets_me(_session, _args, _room_id):  # type: ignore[no-untyped-def]
        return targets_me

    async def _reply_command(room_id, body, **kwargs):  # type: ignore[no-untyped-def]
        replies.append({"room_id": room_id, "body": body, **kwargs})

    agent = SimpleNamespace(name="fixer")

    async def _fresh_agent(_session):  # type: ignore[no-untyped-def]
        return agent

    client = SimpleNamespace(
        agent=agent,
        session_factory=_session_factory,
        _fresh_agent=_fresh_agent,
        _addressing_allowed=_addressing_allowed,
        _command_targets_me_explicitly=_targets_me,
        reply_command=_reply_command,
    )
    client.replies = replies  # type: ignore[attr-defined]
    return client


class TestGateCommand:
    """Commands drive the agent as surely as a message does, so they run
    through the same policy — but a room-wide command is declined quietly."""

    async def test_allowed_passes_through(self) -> None:
        client = _command_client(allowed=True, targets_me=True)
        result = await AgentClient._gate_command(
            client, _room(), _command(args="@fixer"), _meta()
        )
        assert result is True
        assert client.replies == []

    async def test_denied_and_explicitly_targeted_replies(self) -> None:
        client = _command_client(allowed=False, targets_me=True)
        result = await AgentClient._gate_command(
            client, _room(), _command(args="@fixer"), _meta()
        )
        assert result is False
        assert len(client.replies) == 1
        reply = client.replies[0]
        assert reply["room_id"] == "!matrix:switch.local"
        assert reply["body"] == _ADDRESSING_DENIED_MESSAGE
        assert reply["thread_root_id"] == "$cmd"

    async def test_denied_room_wide_command_is_declined_quietly(self) -> None:
        # `!reset-all-agents` (or a bare `!reset`) makes no claim about this
        # agent; answering every one would flood a room of restricted agents.
        client = _command_client(allowed=False, targets_me=False)
        result = await AgentClient._gate_command(
            client, _room(), _command(command="reset-all-agents", args=""), _meta()
        )
        assert result is False
        assert client.replies == []


class TestCommandTargetsMeExplicitly:
    """Only an `@` token naming this agent (name, alias, or a role it holds)
    counts as explicit targeting."""

    def _client(self, *, name: str = "fixer", alias: bool = False, role: bool = False):  # type: ignore[no-untyped-def]
        async def _tags_alias(_session, _text, _room_id):  # type: ignore[no-untyped-def]
            return alias

        async def _tags_role(_session, _text, _room_id):  # type: ignore[no-untyped-def]
            return role

        client = SimpleNamespace(
            agent=SimpleNamespace(name=name),
            _text_tags_my_alias=_tags_alias,
            _text_tags_my_role=_tags_role,
        )
        client._args_tag_my_name = lambda text: AgentClient._args_tag_my_name(  # type: ignore[attr-defined]
            client, text
        )
        return client

    async def test_no_at_token_is_not_explicit(self) -> None:
        client = self._client()
        assert (
            await AgentClient._command_targets_me_explicitly(client, None, "", "room-1")
            is False
        )

    async def test_own_name_is_explicit(self) -> None:
        client = self._client()
        assert (
            await AgentClient._command_targets_me_explicitly(
                client, None, "@fixer", "room-1"
            )
            is True
        )

    async def test_another_agents_name_is_not_explicit(self) -> None:
        client = self._client()
        assert (
            await AgentClient._command_targets_me_explicitly(
                client, None, "@someone-else", "room-1"
            )
            is False
        )

    async def test_alias_is_explicit(self) -> None:
        client = self._client(alias=True)
        assert (
            await AgentClient._command_targets_me_explicitly(
                client, None, "@nickname", "room-1"
            )
            is True
        )

    async def test_held_role_is_explicit(self) -> None:
        client = self._client(role=True)
        assert (
            await AgentClient._command_targets_me_explicitly(
                client, None, "@manager", "room-1"
            )
            is True
        )
