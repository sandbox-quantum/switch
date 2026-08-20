"""Who gets pinged when an agent needs its operator (CHOO-2137).

This used to be `notify_user`: one handle typed into the agent's config. A
handle only means something on one platform, so the same string was at best
right in one room and inert everywhere else — and on Discord and Teams it never
rendered as a mention at all, so it notified nobody while looking like it did.

It is now the agent's owner, resolved through the account that person has
claimed on the bridge the room is on. The link is already per messaging app,
which is exactly the granularity a handle needs.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace

from switch_core.clients.agent_client import AgentClient


@asynccontextmanager
async def _session_factory():  # type: ignore[no-untyped-def]
    yield object()


def _claimed(bridge_id: str, username: str) -> SimpleNamespace:
    """An `ExternalUser` row, with only the fields the resolver reads."""
    return SimpleNamespace(bridge_id=bridge_id, external_username=username)


def _client(claimed: list[SimpleNamespace]) -> SimpleNamespace:
    async def _get_by_user(_session, _user_id):  # type: ignore[no-untyped-def]
        return claimed

    return SimpleNamespace(
        session_factory=_session_factory,
        _external_user_store=SimpleNamespace(get_by_user=_get_by_user),
    )


def _agent(owner_id: str | None) -> SimpleNamespace:
    return SimpleNamespace(id="a1", name="worker", owner_id=owner_id)


class TestResolvingTheOwnersHandle:
    async def test_the_owners_account_on_this_bridge(self) -> None:
        client = _client([_claimed("slack-1", "louis.amaudruz")])

        handle = await AgentClient.owner_handle_in(client, _agent("u1"), "slack-1")

        assert handle == "louis.amaudruz"

    async def test_the_right_one_when_they_are_on_several_platforms(self) -> None:
        # The whole reason a single configured handle could not work: this
        # person is one name on Slack and another on Telegram.
        client = _client(
            [_claimed("slack-1", "louis.amaudruz"), _claimed("telegram-1", "louisa")]
        )

        assert (
            await AgentClient.owner_handle_in(client, _agent("u1"), "telegram-1")
            == "louisa"
        )

    async def test_nobody_when_the_owner_has_claimed_nothing_here(self) -> None:
        # Claimed on Slack, but this room is on Telegram. Naming the Slack
        # handle here would @ a stranger or nobody at all.
        client = _client([_claimed("slack-1", "louis.amaudruz")])

        assert (
            await AgentClient.owner_handle_in(client, _agent("u1"), "telegram-1")
            is None
        )

    async def test_nobody_for_an_ownerless_agent(self) -> None:
        client = _client([_claimed("slack-1", "louis.amaudruz")])

        assert (
            await AgentClient.owner_handle_in(client, _agent(None), "slack-1") is None
        )

    async def test_nobody_for_a_room_with_no_bridge(self) -> None:
        # An internal-only room has no platform to mention anyone on.
        client = _client([_claimed("slack-1", "louis.amaudruz")])

        assert await AgentClient.owner_handle_in(client, _agent("u1"), None) is None

    async def test_the_same_account_every_time_when_they_hold_several(self) -> None:
        # Claiming is not exclusive. Whichever is picked, it must not change
        # between one message and the next.
        client = _client([_claimed("slack-1", "zoe"), _claimed("slack-1", "adam")])

        first = await AgentClient.owner_handle_in(client, _agent("u1"), "slack-1")
        second = await AgentClient.owner_handle_in(client, _agent("u1"), "slack-1")

        assert first == second == "adam"
