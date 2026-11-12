"""A chat created with a `bridgeId`: a direct chat that is a private channel
on that bridge, between the caller's own linked account and the agent."""

from __future__ import annotations

import asyncio
import copy
import weakref
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from sqlalchemy import func, select, update

from switch_core.db.models import (
    Agent,
    Client,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    Room,
    User,
)
from switch_core.tenant_context import tenant_scope
from tests.switch_core.gateway.conftest import _Harness
from tests.switch_core.gateway.test_chats_routes import _code

TENANT = "00000000-0000-0000-0000-000000000000"


class _FakeCore:
    def __init__(self, transport_user_id: str, known: dict[str, str]) -> None:
        self._workspace_consumer_transport_user_id = transport_user_id
        self._known = known
        self.dm_calls: list[dict[str, str]] = []
        self.users_added: list[list[str]] = []

        async def create_dm_channel(
            *, agent_name: str, user_name: str, user_external_id: str
        ) -> str:
            self.dm_calls.append(
                {
                    "agent_name": agent_name,
                    "user_name": user_name,
                    "user_external_id": user_external_id,
                }
            )
            # Yields, so a concurrent attempt can run while the channel is made.
            await asyncio.sleep(0.05)
            return f"C-DM-{len(self.dm_calls)}"

        async def ensure_channel_subscriptions(channels: Any) -> None:
            return None

        self.adapter = SimpleNamespace(
            create_dm_channel=create_dm_channel,
            ensure_channel_subscriptions=ensure_channel_subscriptions,
        )

    async def resolve_external_user_id_map(
        self, user_names: list[str]
    ) -> dict[str, str]:
        return {n: self._known[n] for n in user_names if n in self._known}

    def begin_provisioning(self, channel_id: str) -> None:
        return None

    def end_provisioning(self, channel_id: str) -> None:
        return None

    def add_room_mapping(self, *args: Any) -> None:
        return None

    async def ensure_external_users_in_room(
        self, room_id: str, transport_room_id: str, external_user_ids: list[str]
    ) -> None:
        self.users_added.append(external_user_ids)


class _FakeCollabLifecycle:
    def __init__(self, bridges: dict[str, _FakeCore]) -> None:
        self._bridges = bridges

    def get(self, bridge_id: str) -> _FakeCore | None:
        return self._bridges.get(bridge_id)

    def rooms_changed(self, bridge_id: str) -> None:
        return None


async def _slack(chats: _Harness, *, link: User | None) -> tuple[str, _FakeCore]:
    """A running Slack bridge on which `link`, if given, has claimed `U-ALICE`."""
    async with chats.factory() as session:
        bot = Client(
            transport_user_id="@slack-bot:switch.test",
            display_name="Slack Bot",
            type="bridge",
        )
        session.add(bot)
        await session.flush()
        bridge = CollaborationBridge(
            tenant_id=TENANT,
            type="slack",
            display_name="Acme Slack",
            connection_config={},
            client_id=bot.id,
            status="active",
            channel_creation_enabled=True,
        )
        session.add(bridge)
        await session.flush()
        if link is not None:
            person = Client(
                transport_user_id="@slack-alice:switch.test",
                display_name="alice.s",
                type="human",
            )
            session.add(person)
            await session.flush()
            external = ExternalUser(
                bridge_id=bridge.id,
                external_user_id="U-ALICE",
                external_username="alice.s",
                client_id=person.id,
            )
            session.add(external)
            await session.flush()
            session.add(
                ExternalUserClaim(external_user_id=external.id, user_id=link.id)
            )
        await session.commit()
        bridge_id = bridge.id
    core = _FakeCore("@slack-bot:switch.test", {"alice.s": "U-ALICE"})
    chats.room_service._collab_lifecycle = _FakeCollabLifecycle({bridge_id: core})  # type: ignore[assignment]
    return bridge_id, core


async def _create(
    chats: _Harness,
    agents: list[Agent],
    bridge_id: str,
    request_id: str = "c1",
    resume_only: bool = False,
) -> httpx.Response:
    return await chats.client.post(
        "/chats",
        json={
            "agentIds": [agent.id for agent in agents],
            "requestId": request_id,
            "bridgeId": bridge_id,
            "resumeOnly": resume_only,
        },
        headers=chats.as_user(chats.alice),
    )


async def test_a_bridged_chat_opens_a_dm_with_the_callers_linked_account(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    bridge_id, core = await _slack(chats, link=chats.alice)

    response = await _create(chats, [agent], bridge_id)

    assert response.status_code == 200, response.text
    chat = response.json()["chat"]
    assert chat["bridgeType"] == "slack"
    assert chat["channelType"] == "direct"
    assert core.dm_calls == [
        {"agent_name": "helper", "user_name": "alice.s", "user_external_id": "U-ALICE"}
    ]
    async with chats.factory() as session:
        room = await session.get(Room, chat["roomId"])
        assert room is not None
        assert room.bridge_id == bridge_id
        assert room.external_channel_id == "C-DM-1"
        assert room.name == "helper · Acme Slack"


async def test_a_bridged_chat_goes_by_the_agents_display_name(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    async with chats.factory() as session:
        await session.execute(
            update(Agent).where(Agent.id == agent.id).values(display_name="Helper Bot")
        )
        await session.commit()
    bridge_id, core = await _slack(chats, link=chats.alice)

    response = await _create(chats, [agent], bridge_id)

    assert response.status_code == 200, response.text
    assert response.json()["chat"]["name"] == "Helper Bot · Acme Slack"
    assert [call["agent_name"] for call in core.dm_calls] == ["Helper Bot"]


async def test_the_linked_account_is_used_even_when_another_shares_its_name(
    chats: _Harness,
) -> None:
    """After a rename, another cached account on the bridge can hold the
    linked one's old handle; the hand-off must still reach the linked one."""
    agent = await chats.agent("helper", owner=chats.alice)
    bridge_id, core = await _slack(chats, link=chats.alice)
    core._known = {"alice.s": "U-OTHER"}

    response = await _create(chats, [agent], bridge_id)

    assert response.status_code == 200, response.text
    assert [call["user_external_id"] for call in core.dm_calls] == ["U-ALICE"]
    assert core.users_added == [["U-ALICE"]]


async def test_a_retry_returns_the_same_chat_and_opens_one_channel(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    bridge_id, core = await _slack(chats, link=chats.alice)

    first = await _create(chats, [agent], bridge_id)
    again = await _create(chats, [agent], bridge_id)

    assert first.status_code == 200, first.text
    assert again.status_code == 200, again.text
    assert again.json()["chat"]["roomId"] == first.json()["chat"]["roomId"]
    assert len(core.dm_calls) == 1


async def test_a_retry_with_a_changed_greeting_is_the_same_request(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    bridge_id, core = await _slack(chats, link=chats.alice)

    async def create(greeting: str) -> httpx.Response:
        return await chats.client.post(
            "/chats",
            json={
                "agentId": agent.id,
                "requestId": "c1",
                "bridgeId": bridge_id,
                "greeting": greeting,
            },
            headers=chats.as_user(chats.alice),
        )

    first = await create("Hi.")
    again = await create("Hello there.")

    assert again.status_code == 200, again.text
    assert again.json()["chat"]["roomId"] == first.json()["chat"]["roomId"]
    assert len(core.dm_calls) == 1


async def test_an_unlinked_caller_is_told_to_link_their_account(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    bridge_id, core = await _slack(chats, link=None)

    response = await _create(chats, [agent], bridge_id)

    assert response.status_code == 422
    assert _code(response) == "ACCOUNT_NOT_LINKED"
    assert core.dm_calls == []


async def test_a_bridged_chat_is_refused_while_the_flag_is_off(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    bridge_id, core = await _slack(chats, link=chats.alice)
    chats.service.buddy_slack_handoff_enabled = False

    response = await _create(chats, [agent], bridge_id)

    assert response.status_code == 409
    assert _code(response) == "BUDDY_SLACK_HANDOFF_OFF"
    assert core.dm_calls == []
    async with chats.factory() as session:
        assert await session.scalar(select(func.count()).select_from(Room)) == 0


async def test_a_bridged_chat_has_one_agent(chats: _Harness) -> None:
    one = await chats.agent("one", owner=chats.alice)
    two = await chats.agent("two", owner=chats.alice)
    bridge_id, core = await _slack(chats, link=chats.alice)

    response = await _create(chats, [one, two], bridge_id)

    assert response.status_code == 422
    assert _code(response) == "BRIDGED_CHAT_NEEDS_ONE_AGENT"
    assert core.dm_calls == []


async def _create_on(
    chats: _Harness, service: Any, agent: Agent, bridge_id: str
) -> Room:
    with tenant_scope(TENANT):
        return await service.create_chat(
            TENANT,
            chats.alice,
            agent_ids=[agent.id],
            member_user_ids=[],
            name=None,
            request_id="c1",
            greeting=None,
            kind=None,
            bridge_id=bridge_id,
            resume_only=False,
        )


async def test_two_processes_racing_one_request_open_one_channel(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    bridge_id, core = await _slack(chats, link=chats.alice)
    other = copy.copy(chats.service)
    other._locks = weakref.WeakValueDictionary()

    first, second = await asyncio.gather(
        _create_on(chats, chats.service, agent, bridge_id),
        _create_on(chats, other, agent, bridge_id),
    )

    assert first.id == second.id
    assert len(core.dm_calls) == 1


async def test_a_retry_after_a_failed_join_finishes_the_same_chat(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    bridge_id, core = await _slack(chats, link=chats.alice)
    make_lasting = chats.service._make_lasting
    failures = [RuntimeError("join failed")]

    async def failing_make_lasting(*args: Any) -> None:
        if failures:
            raise failures.pop()
        await make_lasting(*args)

    monkeypatch.setattr(chats.service, "_make_lasting", failing_make_lasting)

    with pytest.raises(RuntimeError, match="join failed"):
        await _create_on(chats, chats.service, agent, bridge_id)
    room = await _create_on(chats, chats.service, agent, bridge_id)
    again = await _create(chats, [agent], bridge_id)

    assert again.status_code == 200, again.text
    assert again.json()["chat"]["roomId"] == room.id
    assert len(core.dm_calls) == 1


async def test_a_retry_after_a_failed_bridge_invite_puts_the_bridge_in(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    bridge_id, core = await _slack(chats, link=chats.alice)
    provisioning = chats.room_service._provisioning
    invite = provisioning.invite_to_room
    bridge_invites: list[str] = []
    failures = [RuntimeError("invite failed")]

    async def failing_invite(room_id: str, user_id: str) -> None:
        if user_id == "@slack-bot:switch.test":
            if failures:
                raise failures.pop()
            bridge_invites.append(room_id)
        await invite(room_id, user_id)

    monkeypatch.setattr(provisioning, "invite_to_room", failing_invite)

    with pytest.raises(RuntimeError, match="invite failed"):
        await _create_on(chats, chats.service, agent, bridge_id)
    assert core.users_added == []
    room = await _create_on(chats, chats.service, agent, bridge_id)

    assert bridge_invites == [room.transport_room_id]
    assert core.users_added == [["U-ALICE"]]
    assert len(core.dm_calls) == 1


async def test_resuming_a_create_that_never_started_makes_nothing(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    bridge_id, core = await _slack(chats, link=chats.alice)

    response = await _create(chats, [agent], bridge_id, resume_only=True)

    assert response.status_code == 404
    assert _code(response) == "NO_SUCH_OPERATION"
    assert core.dm_calls == []
    async with chats.factory() as session:
        rooms = await session.scalar(
            select(func.count()).select_from(Room).where(Room.bridge_id == bridge_id)
        )
    assert rooms == 0
    created = await _create(chats, [agent], bridge_id)
    assert created.status_code == 200, created.text


async def test_resuming_a_finished_create_returns_its_chat(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    bridge_id, core = await _slack(chats, link=chats.alice)

    first = await _create(chats, [agent], bridge_id)
    again = await _create(chats, [agent], bridge_id, resume_only=True)

    assert again.status_code == 200, again.text
    assert again.json()["chat"]["roomId"] == first.json()["chat"]["roomId"]
    assert len(core.dm_calls) == 1


async def test_resuming_a_create_that_failed_after_saving_finishes_it(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    bridge_id, core = await _slack(chats, link=chats.alice)
    make_lasting = chats.service._make_lasting
    failures = [RuntimeError("join failed")]

    async def failing_make_lasting(*args: Any) -> None:
        if failures:
            raise failures.pop()
        await make_lasting(*args)

    monkeypatch.setattr(chats.service, "_make_lasting", failing_make_lasting)

    with pytest.raises(RuntimeError, match="join failed"):
        await _create_on(chats, chats.service, agent, bridge_id)
    resumed = await _create(chats, [agent], bridge_id, resume_only=True)
    again = await _create(chats, [agent], bridge_id)

    assert resumed.status_code == 200, resumed.text
    assert again.json()["chat"]["roomId"] == resumed.json()["chat"]["roomId"]
    assert len(core.dm_calls) == 1


async def test_two_linked_accounts_on_the_bridge_are_refused(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    bridge_id, core = await _slack(chats, link=chats.alice)
    async with chats.factory() as session:
        person = Client(
            transport_user_id="@slack-alice-old:switch.test",
            display_name="alice.old",
            type="human",
        )
        session.add(person)
        await session.flush()
        external = ExternalUser(
            bridge_id=bridge_id,
            external_user_id="U-ALICE-OLD",
            external_username="alice.old",
            client_id=person.id,
        )
        session.add(external)
        await session.flush()
        session.add(
            ExternalUserClaim(external_user_id=external.id, user_id=chats.alice.id)
        )
        await session.commit()

    response = await _create(chats, [agent], bridge_id)

    assert response.status_code == 409
    assert _code(response) == "ACCOUNTS_AMBIGUOUS"
    assert core.dm_calls == []


async def test_a_retry_after_the_linked_account_changed_is_refused(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    bridge_id, core = await _slack(chats, link=chats.alice)
    provisioning = chats.room_service._provisioning
    invite = provisioning.invite_to_room
    failures = [RuntimeError("invite failed")]

    async def failing_invite(room_id: str, user_id: str) -> None:
        if user_id == "@slack-bot:switch.test" and failures:
            raise failures.pop()
        await invite(room_id, user_id)

    monkeypatch.setattr(provisioning, "invite_to_room", failing_invite)
    with pytest.raises(RuntimeError, match="invite failed"):
        await _create_on(chats, chats.service, agent, bridge_id)
    async with chats.factory() as session:
        await session.execute(
            update(ExternalUser)
            .where(ExternalUser.external_user_id == "U-ALICE")
            .values(external_user_id="U-ALICE-NEW")
        )
        await session.commit()

    response = await _create(chats, [agent], bridge_id)

    assert response.status_code == 409
    assert _code(response) == "LINKED_ACCOUNT_CHANGED"
    assert core.users_added == []
    assert len(core.dm_calls) == 1
