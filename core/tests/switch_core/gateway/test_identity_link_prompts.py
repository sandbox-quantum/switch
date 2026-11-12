"""A link can be confirmed by tapping the number Switch Console shows in a
message Switch's bot sends the account (CHOO-4121).

Against real Postgres and real stores, calling the route handlers and the
press handler directly, with the platform faked: what matters is which rows a
tap leaves behind, since a claim row is what every owner check trusts.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.account_links import PROMPT_LIMIT, PROMPT_WINDOW, is_prompt_token
from switch_core.bridges.collaboration import link_prompts
from switch_core.bridges.collaboration.link_prompts import NOT_ME_LABEL, answer_prompt
from switch_core.bridges.collaboration.models import (
    DirectMessageUnavailable,
    DirectPrompt,
    InboundInteraction,
)
from switch_core.bridges.collaboration.session.renderers import position_action
from switch_core.db.audit import AuditAction
from switch_core.db.models import (
    TENANT_ZERO_ID,
    AuditEvent,
    Client,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    ExternalUserLinkRequest,
    TenantMember,
    User,
)
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.collaborations import (
    claim_bridge_identity,
    issue_identity_link_code,
)
from switch_core.gateway.schemas import ClaimIdentityRequest, IssueLinkCodeRequest

_STORE = ExternalUserStore()


class _Adapter:
    """The platform: who it can message, and what it was asked to do."""

    display_name = "Acme Slack"

    def __init__(self, refuse: str | None = None, cannot: str | None = None) -> None:
        self.refuse = refuse
        self.cannot = cannot
        self.sent: list[tuple[str, DirectPrompt]] = []
        self.settled: list[tuple[str, str]] = []
        self.told: list[str] = []

    async def account_unlinkable_reason(self, _external_user_id: str) -> None:
        return None

    def direct_prompt_unavailable(self) -> str | None:
        return self.cannot

    def escape_label_for_body(self, label: str) -> str:
        return f"<{label}>"

    async def send_direct_prompt(
        self, external_user_id: str, prompt: DirectPrompt
    ) -> str:
        if self.refuse is not None:
            raise DirectMessageUnavailable(self.refuse)
        self.sent.append((external_user_id, prompt))
        return f"D-{external_user_id}:{len(self.sent)}"

    def direct_prompt_link(self, message_ref: str) -> str | None:
        return f"https://chat.example/{message_ref}"

    async def settle_direct_prompt(self, message_ref: str, text: str) -> None:
        self.settled.append((message_ref, text))

    async def tell_actor(
        self,
        _channel_id: str,
        _actor_ref: str,
        _actor_name: str,
        _thread_ref: str | None,
        text: str,
    ) -> None:
        self.told.append(text)


class _Lifecycle:
    def __init__(self, adapter: _Adapter | None) -> None:
        self._adapter = adapter

    def link_code_instructions(self, _type: str, _config: object, code: str) -> str:
        return f"Post `!link-account {code}`."

    def get_adapter(self, _bridge_id: str) -> _Adapter | None:
        return self._adapter


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


async def _claim(world: _World, adapter: _Adapter | None, *, wants_prompt: bool = True):  # type: ignore[no-untyped-def]
    async with world.session_factory() as session:
        summary = await claim_bridge_identity(
            world.bridge_id,
            ClaimIdentityRequest(
                external_user_id="U-ada",
                username="ada",
                expects_confirmation=True,
                wants_prompt=wants_prompt,
            ),
            session,
            CollaborationBridgeStore(),
            _STORE,
            UserStore(),
            _Lifecycle(adapter),  # type: ignore[arg-type]
            world.ada,
            False,
        )
    assert summary.link_request is not None
    assert summary.link_request.code is not None
    return summary.link_request.code


async def _issue(world: _World, adapter: _Adapter | None):  # type: ignore[no-untyped-def]
    async with world.session_factory() as session:
        return await issue_identity_link_code(
            world.bridge_id,
            world.account.id,
            session,
            CollaborationBridgeStore(),
            _STORE,
            _Lifecycle(adapter),  # type: ignore[arg-type]
            world.ada,
            IssueLinkCodeRequest(wants_prompt=True),
        )


async def _tap(
    world: _World,
    adapter: _Adapter,
    prompt: DirectPrompt,
    *,
    label: str,
    sender: str = "U-ada",
) -> None:
    position = prompt.labels.index(label) + 1
    await answer_prompt(
        InboundInteraction(
            channel_id="D-U-ada",
            sender_id=sender,
            sender_name="ada",
            sender_display_name="Ada",
            action_id=position_action(position),
            value=prompt.token,
            message_ref="D-U-ada:1",
        ),
        adapter=adapter,  # type: ignore[arg-type]
        session_factory=world.session_factory,
        tenant_id=TENANT_ZERO_ID,
        external_user_store=_STORE,
        user_store=UserStore(),
    )


async def _verified(world: _World) -> bool:
    async with world.session_factory() as session:
        claim = await _STORE.get_claim(session, world.account.id, world.ada.id)
        return claim is not None and claim.verified_at is not None


async def _waiting(world: _World) -> bool:
    async with world.session_factory() as session:
        request = await _STORE.get_link_request(session, world.account.id, world.ada.id)
        return request is not None


async def _older_link(world: _World) -> None:
    """A link made before links needed confirming: it counts, unverified."""
    async with world.session_factory() as session:
        session.add(
            ExternalUserClaim(external_user_id=world.account.id, user_id=world.ada.id)
        )
        await session.commit()


class TestSendingAPrompt:
    async def test_a_claim_that_asks_sends_the_account_the_numbers(
        self, world: _World
    ) -> None:
        adapter = _Adapter()

        code = await _claim(world, adapter)

        assert code.prompt is not None
        assert code.prompt.sent is True
        assert code.prompt.unavailable_reason is None
        # Opens the message that went out, so nobody has to look for it.
        assert code.prompt.link == "https://chat.example/D-U-ada:1"
        [(to, prompt)] = adapter.sent
        assert to == "U-ada"
        assert is_prompt_token(prompt.token)
        assert prompt.labels[-1] == NOT_ME_LABEL
        assert str(code.prompt.number) in prompt.labels[:-1]
        assert len(set(prompt.labels)) == len(prompt.labels)
        # Says who is asking, so someone who did not start it knows to decline.
        assert world.ada.name in prompt.text
        assert world.ada.email in prompt.text

    async def test_a_claim_that_does_not_ask_sends_nothing(self, world: _World) -> None:
        adapter = _Adapter()

        code = await _claim(world, adapter, wants_prompt=False)

        assert code.prompt is None
        assert adapter.sent == []

    async def test_a_console_from_before_confirmation_is_sent_no_message(
        self, world: _World
    ) -> None:
        # It is shown its code in a 409 and can't show a number, so even a
        # client that asked for a prompt without confirmation gets no message.
        adapter = _Adapter()
        async with world.session_factory() as session:
            with pytest.raises(HTTPException) as answered:
                await claim_bridge_identity(
                    world.bridge_id,
                    ClaimIdentityRequest(
                        external_user_id="U-ada", username="ada", wants_prompt=True
                    ),
                    session,
                    CollaborationBridgeStore(),
                    _STORE,
                    UserStore(),
                    _Lifecycle(adapter),  # type: ignore[arg-type]
                    world.ada,
                    False,
                )

        assert answered.value.status_code == 409
        assert "link-account" in answered.value.detail
        assert adapter.sent == []

    async def test_who_is_asking_goes_through_the_platforms_escape(
        self, world: _World
    ) -> None:
        # The requester sets their own name; the bot's message must not carry
        # a link or a mention written into it.
        adapter = _Adapter()

        await _claim(world, adapter)

        [(_to, prompt)] = adapter.sent
        assert f"**<{world.ada.name}>** (<{world.ada.email}>)" in prompt.text

    async def test_a_platform_that_can_never_send_one_spends_no_allowance(
        self, world: _World
    ) -> None:
        adapter = _Adapter(cannot="Switch can't send direct messages on Teams.")
        await _claim(world, adapter)
        for _ in range(PROMPT_LIMIT):
            code = await _issue(world, adapter)

        assert code.prompt.sent is False
        assert code.prompt.unavailable_reason == (
            "Switch can't send direct messages on Teams."
        )
        async with world.session_factory() as session:
            account = await session.get(ExternalUser, world.account.id)
            assert account is not None
            assert account.link_prompts_sent == 0

    async def test_a_platform_that_cannot_reach_the_person_says_why(
        self, world: _World
    ) -> None:
        code = await _claim(world, _Adapter(refuse="They haven't started the bot."))

        assert code.prompt is not None
        assert code.prompt.sent is False
        assert code.prompt.unavailable_reason == "They haven't started the bot."
        assert code.prompt.link is None

    async def test_an_account_is_only_messaged_so_often(self, world: _World) -> None:
        adapter = _Adapter()
        await _claim(world, adapter)
        for _ in range(PROMPT_LIMIT - 1):
            await _issue(world, adapter)

        withheld = await _issue(world, adapter)

        assert len(adapter.sent) == PROMPT_LIMIT
        assert withheld.prompt.sent is False
        assert withheld.prompt.unavailable_reason == link_prompts.PROMPT_LIMITED
        # The code still works: the limit is on messages, not on linking.
        assert withheld.code

    async def test_the_allowance_comes_back_after_the_window(
        self, world: _World
    ) -> None:
        adapter = _Adapter()
        await _claim(world, adapter)
        for _ in range(PROMPT_LIMIT - 1):
            await _issue(world, adapter)
        async with world.session_factory() as session:
            await session.execute(
                update(ExternalUser)
                .where(ExternalUser.id == world.account.id)
                .values(
                    link_prompt_window_started_at=ExternalUser.link_prompt_window_started_at
                    - PROMPT_WINDOW
                )
            )
            await session.commit()

        again = await _issue(world, adapter)

        assert again.prompt.sent is True


class TestTappingAPrompt:
    async def test_the_right_number_confirms_the_link(self, world: _World) -> None:
        adapter = _Adapter()
        code = await _claim(world, adapter)
        [(_to, prompt)] = adapter.sent

        await _tap(world, adapter, prompt, label=str(code.prompt.number))

        assert await _verified(world)
        assert not await _waiting(world)
        [(ref, text)] = adapter.settled
        assert ref == "D-U-ada:1"
        assert "Linked this Acme Slack account" in text
        assert "Ada" in text
        async with world.session_factory() as session:
            event = (
                await session.execute(
                    select(AuditEvent).where(
                        AuditEvent.action == AuditAction.BRIDGE_IDENTITY_CLAIMED,
                        AuditEvent.target_id == world.account.id,
                    )
                )
            ).scalar_one()
        assert event.details["by"] == "prompt"

    async def test_a_wrong_number_cancels_the_request(self, world: _World) -> None:
        adapter = _Adapter()
        code = await _claim(world, adapter)
        [(_to, prompt)] = adapter.sent
        wrong = next(
            label for label in prompt.labels[:-1] if label != str(code.prompt.number)
        )

        await _tap(world, adapter, prompt, label=wrong)

        assert not await _verified(world)
        assert not await _waiting(world)
        assert adapter.settled[0][1] == link_prompts.WRONG_NUMBER

    async def test_not_me_cancels_the_request(self, world: _World) -> None:
        adapter = _Adapter()
        await _claim(world, adapter)
        [(_to, prompt)] = adapter.sent

        await _tap(world, adapter, prompt, label=NOT_ME_LABEL)

        assert not await _verified(world)
        assert not await _waiting(world)
        assert adapter.settled[0][1] == link_prompts.DECLINED

    async def test_only_the_account_it_was_sent_to_can_answer(
        self, world: _World
    ) -> None:
        adapter = _Adapter()
        code = await _claim(world, adapter)
        [(_to, prompt)] = adapter.sent

        await _tap(
            world, adapter, prompt, label=str(code.prompt.number), sender="U-mallory"
        )

        assert not await _verified(world)
        assert await _waiting(world)
        assert adapter.settled == []
        assert adapter.told == [link_prompts.SOMEONE_ELSE]

    async def test_a_newer_code_retires_the_older_prompt(self, world: _World) -> None:
        adapter = _Adapter()
        first = await _claim(world, adapter)
        [(_to, old_prompt)] = adapter.sent
        await _issue(world, adapter)

        await _tap(world, adapter, old_prompt, label=str(first.prompt.number))

        assert not await _verified(world)
        assert await _waiting(world)
        assert adapter.settled == []
        assert adapter.told == [link_prompts.NOT_WAITING]

    async def test_a_second_tap_does_not_undo_the_first(self, world: _World) -> None:
        adapter = _Adapter()
        code = await _claim(world, adapter)
        [(_to, prompt)] = adapter.sent

        await _tap(world, adapter, prompt, label=str(code.prompt.number))
        await _tap(world, adapter, prompt, label=str(code.prompt.number))

        assert await _verified(world)
        [(_ref, text)] = adapter.settled
        assert "Linked" in text
        assert adapter.told == [link_prompts.NOT_WAITING]

    async def test_an_expired_request_confirms_nothing(self, world: _World) -> None:
        adapter = _Adapter()
        code = await _claim(world, adapter)
        [(_to, prompt)] = adapter.sent
        async with world.session_factory() as session:
            await session.execute(
                update(ExternalUserLinkRequest)
                .where(ExternalUserLinkRequest.external_user_id == world.account.id)
                .values(
                    code_expires_at=ExternalUserLinkRequest.code_expires_at
                    - PROMPT_WINDOW
                )
            )
            await session.commit()

        await _tap(world, adapter, prompt, label=str(code.prompt.number))

        assert not await _verified(world)
        assert adapter.settled[0][1] == link_prompts.EXPIRED

    async def test_someone_since_removed_from_the_workspace_is_not_linked(
        self, world: _World
    ) -> None:
        adapter = _Adapter()
        code = await _claim(world, adapter)
        [(_to, prompt)] = adapter.sent
        async with world.session_factory() as session:
            member = await session.get(TenantMember, (TENANT_ZERO_ID, world.ada.id))
            assert member is not None
            await session.delete(member)
            await session.commit()

        await _tap(world, adapter, prompt, label=str(code.prompt.number))

        assert not await _verified(world)
        assert not await _waiting(world)
        assert adapter.settled[0][1] == link_prompts.NO_LONGER_MEMBER

    async def test_not_me_on_an_older_link_removes_it(self, world: _World) -> None:
        # A link made before links needed confirming counts until confirmed;
        # the account's holder saying it isn't theirs is the end of it.
        adapter = _Adapter()
        await _older_link(world)
        await _issue(world, adapter)
        [(_to, prompt)] = adapter.sent

        await _tap(world, adapter, prompt, label=NOT_ME_LABEL)

        async with world.session_factory() as session:
            assert (
                await _STORE.get_claim(session, world.account.id, world.ada.id) is None
            )
        assert not await _waiting(world)
        assert adapter.settled[0][1] == link_prompts.declined_older(world.ada.name)

    async def test_a_wrong_number_on_an_older_link_leaves_it(
        self, world: _World
    ) -> None:
        # It may be the holder's own mistap, so only the request goes.
        adapter = _Adapter()
        await _older_link(world)
        code = await _issue(world, adapter)
        [(_to, prompt)] = adapter.sent
        wrong = next(
            label for label in prompt.labels[:-1] if label != str(code.prompt.number)
        )

        await _tap(world, adapter, prompt, label=wrong)

        async with world.session_factory() as session:
            claim = await _STORE.get_claim(session, world.account.id, world.ada.id)
        assert claim is not None
        assert claim.verified_at is None
        assert adapter.settled[0][1] == link_prompts.WRONG_NUMBER

    async def test_the_code_still_works_beside_the_prompt(self, world: _World) -> None:
        adapter = _Adapter()
        code = await _claim(world, adapter)

        async with world.session_factory() as session:
            await _STORE.redeem_link_code(
                session, world.account, code.code, UserStore()
            )
            await session.commit()

        assert await _verified(world)
