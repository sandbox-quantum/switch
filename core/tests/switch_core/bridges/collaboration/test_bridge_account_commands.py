"""A chat account's own link commands are answered by the bridge that heard
them, without a room (CHOO-4121).

Against real Postgres and real stores, with the bridge and its platform faked:
what matters is that the link is confirmed or dropped, the answer goes back
through the adapter, and no room is made for wherever the command was typed.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.account_links import PROMPT_TOKEN_PREFIX
from switch_core.bridges.collaboration import collaboration_core
from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import (
    ChannelType,
    DirectMessageUnavailable,
    DirectPrompt,
    InboundCommand,
    InboundInteraction,
)
from switch_core.bridges.collaboration.session.renderers import position_action
from switch_core.chat_account_links import CODE_REFUSED, LINK_USAGE, NOT_LINKED
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Client,
    CollaborationBridge,
    ExternalUser,
    TenantMember,
    User,
)
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.user_store import UserStore

from .dummy_platform.adapter import (
    DummyChatAdapter,
    DummyChatConnectionConfig,
)

_STORE = ExternalUserStore()


class _Adapter:
    def __init__(self) -> None:
        self.answers: list[tuple[InboundCommand, str]] = []

    async def answer_command(self, command: InboundCommand, text: str) -> None:
        self.answers.append((command, text))


class _World:
    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        bridge_id: str,
        account: ExternalUser,
        ada: User,
    ) -> None:
        self.session_factory = session_factory
        self.bridge_id = bridge_id
        self.account = account
        self.ada = ada


async def _client(session: AsyncSession, client_type: str) -> str:
    client = Client(
        transport_user_id=f"@{client_type}-{uuid.uuid4().hex[:8]}:test",
        display_name=client_type,
        type=client_type,
    )
    session.add(client)
    await session.flush()
    return client.id


@pytest.fixture
async def world(session_factory: async_sessionmaker[AsyncSession]) -> _World:
    async with session_factory() as session:
        bridge = CollaborationBridge(
            type="slack",
            display_name="Acme Slack",
            client_id=await _client(session, "bridge"),
            status="active",
        )
        session.add(bridge)
        await session.flush()
        account = ExternalUser(
            bridge_id=bridge.id,
            external_user_id="U-ada",
            external_username="ada",
            client_id=await _client(session, "external_user"),
        )
        session.add(account)
        ada = User(name="Ada", email=f"ada-{uuid.uuid4().hex[:6]}@test", role="user")
        session.add(ada)
        await session.flush()
        session.add(
            TenantMember(tenant_id=TENANT_ZERO_ID, user_id=ada.id, role="member")
        )
        await session.commit()
        return _World(session_factory, bridge.id, account, ada)


def _bridge(world: _World) -> tuple[SimpleNamespace, _Adapter]:
    adapter = _Adapter()

    async def _no_room(**_kwargs: object) -> None:
        raise AssertionError("an account command must not create a room")

    bridge = SimpleNamespace(
        _bridge_id=world.bridge_id,
        _bridge_tenant_id=TENANT_ZERO_ID,
        _session_factory=world.session_factory,
        _external_user_store=_STORE,
        _user_store=UserStore(),
        _adapter=adapter,
        _channel_to_room={},
        _create_room_for_channel=_no_room,
    )
    bridge._handle_account_command = CollaborationCore._handle_account_command.__get__(
        bridge
    )
    return bridge, adapter


def _command(command: str, args: str = "", sender: str = "U-ada") -> InboundCommand:
    return InboundCommand(
        channel_id="D-self",
        channel_type="lobby",
        sender_id=sender,
        sender_name="ada",
        command=command,
        args=args,
        reply_ref="https://hooks.slack.com/commands/T1/1/x",
    )


def _in_channel(
    command: str,
    args: str = "",
    sender: str = "U-ada",
    channel_type: ChannelType = "channel_public",
) -> InboundCommand:
    """A command typed in a conversation, which the apps of other Switch
    servers in the workspace may see too, unlike a slash command."""
    return InboundCommand(
        channel_id="C-shared",
        channel_type=channel_type,
        sender_id=sender,
        sender_name="ada",
        command=command,
        args=args,
    )


async def _code(world: _World) -> str:
    async with world.session_factory() as session:
        request = await _STORE.request_link(
            session, world.account, world.ada.id, requested_by_user_id=world.ada.id
        )
        code, _expires = await _STORE.issue_link_code(session, request)
        await session.commit()
    return code


async def _verified(world: _World) -> bool:
    async with world.session_factory() as session:
        claim = await _STORE.get_claim(session, world.account.id, world.ada.id)
        return claim is not None and claim.verified_at is not None


class TestLinkAccount:
    async def test_a_code_from_anywhere_confirms_the_link(self, world: _World) -> None:
        code = await _code(world)
        bridge, adapter = _bridge(world)

        await CollaborationCore._handle_inbound_command(
            bridge, _command("link-account", code)
        )

        assert await _verified(world)
        [(answered, text)] = adapter.answers
        assert answered.reply_ref == "https://hooks.slack.com/commands/T1/1/x"
        assert "Linked this Acme Slack account (ada)" in text

    async def test_a_wrong_code_confirms_nothing(self, world: _World) -> None:
        await _code(world)
        bridge, adapter = _bridge(world)

        await CollaborationCore._handle_inbound_command(
            bridge, _command("link-account", "AAAA-AAAA")
        )

        assert not await _verified(world)
        assert adapter.answers[0][1] == CODE_REFUSED

    async def test_an_account_switch_has_never_seen_matches_nothing(
        self, world: _World
    ) -> None:
        code = await _code(world)
        bridge, adapter = _bridge(world)

        await CollaborationCore._handle_inbound_command(
            bridge, _command("link-account", code, sender="U-stranger")
        )

        assert not await _verified(world)
        assert adapter.answers[0][1] == CODE_REFUSED

    async def test_no_code_gets_the_usage(self, world: _World) -> None:
        bridge, adapter = _bridge(world)

        await CollaborationCore._handle_inbound_command(
            bridge, _command("link-account")
        )

        assert adapter.answers[0][1] == LINK_USAGE


class TestOnlyTheServerWithTheLinkAnswers:
    """A code typed in a channel reaches every Switch server whose app is
    there. Only the one it was issued on should answer it."""

    async def test_a_code_typed_where_no_link_waits_here_gets_no_answer(
        self, world: _World
    ) -> None:
        bridge, adapter = _bridge(world)

        await CollaborationCore._handle_inbound_command(
            bridge, _in_channel("link-account", "AAAA-AAAA")
        )

        assert adapter.answers == []

    async def test_an_account_this_server_has_never_seen_gets_no_answer(
        self, world: _World
    ) -> None:
        bridge, adapter = _bridge(world)

        await CollaborationCore._handle_inbound_command(
            bridge, _in_channel("link-account", "AAAA-AAAA", sender="U-stranger")
        )

        assert adapter.answers == []

    async def test_a_wrong_code_where_a_link_waits_is_still_refused(
        self, world: _World
    ) -> None:
        await _code(world)
        bridge, adapter = _bridge(world)

        await CollaborationCore._handle_inbound_command(
            bridge, _in_channel("link-account", "AAAA-AAAA")
        )

        assert adapter.answers[0][1] == CODE_REFUSED

    async def test_the_server_that_issued_the_code_links_it(
        self, world: _World
    ) -> None:
        code = await _code(world)
        bridge, adapter = _bridge(world)

        await CollaborationCore._handle_inbound_command(
            bridge, _in_channel("link-account", code)
        )

        assert await _verified(world)
        assert "Linked this Acme Slack account (ada)" in adapter.answers[0][1]

    @pytest.mark.parametrize("channel_type", ["direct", "lobby"])
    async def test_a_direct_conversation_with_this_app_is_always_answered(
        self, world: _World, channel_type: ChannelType
    ) -> None:
        bridge, adapter = _bridge(world)

        await CollaborationCore._handle_inbound_command(
            bridge, _in_channel("link-account", "AAAA-AAAA", channel_type=channel_type)
        )

        assert adapter.answers[0][1] == CODE_REFUSED

    async def test_unlinking_where_nothing_is_linked_here_gets_no_answer(
        self, world: _World
    ) -> None:
        bridge, adapter = _bridge(world)

        await CollaborationCore._handle_inbound_command(
            bridge, _in_channel("unlink-account")
        )
        await CollaborationCore._handle_inbound_command(
            bridge, _in_channel("unlink-account", sender="U-stranger")
        )

        assert adapter.answers == []

    async def test_unlinking_where_a_link_is_here_is_answered(
        self, world: _World
    ) -> None:
        code = await _code(world)
        async with world.session_factory() as session:
            await _STORE.redeem_link_code(session, world.account, code, UserStore())
            await session.commit()
        bridge, adapter = _bridge(world)

        await CollaborationCore._handle_inbound_command(
            bridge, _in_channel("unlink-account")
        )

        assert "**Ada**" in adapter.answers[0][1]


class TestUnlinkAccount:
    async def test_lists_and_then_drops_a_link(self, world: _World) -> None:
        code = await _code(world)
        async with world.session_factory() as session:
            await _STORE.redeem_link_code(session, world.account, code, UserStore())
            await session.commit()
        bridge, adapter = _bridge(world)

        await CollaborationCore._handle_inbound_command(
            bridge, _command("unlink-account")
        )
        await CollaborationCore._handle_inbound_command(
            bridge, _command("unlink-account", '"Ada"')
        )

        listed, dropped = (text for _command_, text in adapter.answers)
        assert "**Ada**" in listed
        assert dropped == "Unlinked this account from Switch user **Ada**."
        async with world.session_factory() as session:
            assert (
                await _STORE.get_claim(session, world.account.id, world.ada.id) is None
            )

    async def test_an_unknown_account_has_no_links(self, world: _World) -> None:
        bridge, adapter = _bridge(world)

        await CollaborationCore._handle_inbound_command(
            bridge, _command("unlink-account", sender="U-stranger")
        )

        assert adapter.answers[0][1] == NOT_LINKED


class _PrivateDummy(DummyChatAdapter):
    """A platform that can reach one person privately."""

    private_notice_delivery = "ephemeral"

    def __init__(self, *, config: DummyChatConnectionConfig) -> None:
        super().__init__(config=config)
        self.refuse = False
        self.private: list[tuple[str, str, str, str | None]] = []

    async def notify_privately(
        self,
        *,
        channel_id: str,
        channel_name: str | None,
        user_id: str,
        content: str,
        thread_root_id: str | None,
    ) -> None:
        if self.refuse:
            raise RuntimeError("refused")
        self.private.append((channel_id, user_id, content, thread_root_id))


def _typed(channel_type: str) -> InboundCommand:
    return InboundCommand(
        channel_id="chan-1",
        channel_type=channel_type,  # type: ignore[arg-type]
        sender_id="U-ada",
        sender_name="ada",
        command="link-account",
        args="7KQ2-M9XD",
        message_ref="post-9",
        root_id="root-1",
    )


class TestPlatformDefaults:
    """What a platform without a private reply or direct messages gets."""

    def _adapter(self) -> DummyChatAdapter:
        return DummyChatAdapter(config=DummyChatConnectionConfig(api_token="t"))

    async def test_an_answer_is_posted_where_the_command_was_typed(self) -> None:
        adapter = self._adapter()

        await adapter.answer_command(
            InboundCommand(
                channel_id="chan-1",
                channel_type="channel_public",
                sender_id="U-ada",
                sender_name="ada",
                command="unlink-account",
                args="",
                message_ref="post-9",
            ),
            "This account isn't linked to any Switch user.",
        )

        [(channel, _sender, content)] = adapter.sent
        assert channel == "chan-1"
        assert "isn't linked" in content

    async def test_a_platform_with_private_notices_answers_only_the_sender(
        self,
    ) -> None:
        adapter = _PrivateDummy(config=DummyChatConnectionConfig(api_token="t"))

        await adapter.answer_command(_typed("channel_public"), "Linked")

        assert adapter.private == [("chan-1", "U-ada", "Linked", "root-1")]
        assert adapter.sent == []

    async def test_a_private_notice_that_fails_is_answered_in_the_channel(
        self,
    ) -> None:
        adapter = _PrivateDummy(config=DummyChatConnectionConfig(api_token="t"))
        adapter.refuse = True

        await adapter.answer_command(_typed("channel_public"), "Linked")

        assert [content for _channel, _sender, content in adapter.sent] == ["Linked"]

    async def test_a_group_dm_is_not_treated_as_private(self) -> None:
        # Slack files a group DM with the app under "lobby", like a 1:1 one.
        adapter = _PrivateDummy(config=DummyChatConnectionConfig(api_token="t"))

        await adapter.answer_command(_typed("lobby"), "Linked")

        assert adapter.private == [("chan-1", "U-ada", "Linked", "root-1")]
        assert adapter.sent == []

    async def test_a_conversation_with_only_the_bot_is_answered_in_place(
        self,
    ) -> None:
        adapter = _PrivateDummy(config=DummyChatConnectionConfig(api_token="t"))

        await adapter.answer_command(_typed("direct"), "Linked")

        assert adapter.private == []
        assert [content for _channel, _sender, content in adapter.sent] == ["Linked"]

    async def test_a_direct_prompt_is_refused_with_the_platforms_name(self) -> None:
        with pytest.raises(DirectMessageUnavailable, match="Dummy Chat"):
            await self._adapter().send_direct_prompt(
                "U-ada", DirectPrompt(text="Tap", token="lnk.x", labels=("1",))
            )


class TestPromptPresses:
    async def test_a_press_carrying_a_prompt_token_goes_to_the_link_flow(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        answered: list[InboundInteraction] = []

        async def _answer(interaction: InboundInteraction, **_kwargs: object) -> None:
            answered.append(interaction)

        monkeypatch.setattr(collaboration_core, "answer_prompt", _answer)
        bridge = SimpleNamespace(
            _adapter=object(),
            _session_factory=object(),
            _bridge_tenant_id=TENANT_ZERO_ID,
            _external_user_store=_STORE,
            _user_store=UserStore(),
            # No approval cards on this bridge: prompts must not depend on them.
            _approval_answers=None,
        )
        press = InboundInteraction(
            channel_id="D1",
            sender_id="U-ada",
            sender_name="ada",
            sender_display_name="Ada",
            action_id=position_action(2),
            value=f"{PROMPT_TOKEN_PREFIX}abc",
        )

        await CollaborationCore._handle_inbound_interaction(bridge, press)

        assert answered == [press]
