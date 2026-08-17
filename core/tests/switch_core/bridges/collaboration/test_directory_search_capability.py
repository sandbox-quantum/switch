"""Whether a platform's user directory can be searched, declared (CHOO-2137).

Switch asks this before a connection exists, to decide whether to offer someone
the "which account is you" step while connecting a messaging app. On a platform
with no directory the honest answer on a fresh connection is always "nobody" —
a Telegram bot can only name people who have spoken to it — so the step is a
form that cannot be filled in rather than a search that comes back empty.

The flag is a claim about behaviour, and a claim can drift from the behaviour it
describes. These hold the two together.
"""

from __future__ import annotations

import pytest

from switch_core.bridges.collaboration.adapter import CollaborationAdapter
from switch_core.bridges.collaboration.discord.adapter import DiscordAdapter
from switch_core.bridges.collaboration.mattermost.adapter import MattermostAdapter
from switch_core.bridges.collaboration.slack.adapter import SlackAdapter
from switch_core.bridges.collaboration.teams.adapter import TeamsAdapter
from switch_core.bridges.collaboration.telegram.adapter import TelegramAdapter

ADAPTERS = [
    DiscordAdapter,
    MattermostAdapter,
    SlackAdapter,
    TeamsAdapter,
    TelegramAdapter,
]


@pytest.mark.parametrize("adapter_cls", ADAPTERS, ids=lambda c: c.__name__)
async def test_the_flag_agrees_with_what_the_adapter_actually_does(
    adapter_cls: type[CollaborationAdapter],
) -> None:
    """A platform declaring a directory must implement the search, and one
    declaring none must not — otherwise the flag is decoration and the UI is
    deciding on a claim nothing keeps true.

    Only the *refusal* is exercised: an adapter that implements the search
    reaches its platform, which is not this test's business. Reaching a
    network call is itself the evidence that it was implemented.
    """
    implements = (
        adapter_cls.search_directory_users
        is not CollaborationAdapter.search_directory_users
    )

    assert adapter_cls.supports_directory_search == implements, (
        f"{adapter_cls.__name__} declares "
        f"supports_directory_search={adapter_cls.supports_directory_search} "
        f"but {'does not implement' if not implements else 'implements'} "
        "search_directory_users"
    )


async def test_a_platform_without_one_refuses_rather_than_answering_emptily() -> None:
    # The refusal is what the directory fallback keys on; an empty list would
    # read as "this workspace has nobody in it".
    adapter = TelegramAdapter.__new__(TelegramAdapter)

    with pytest.raises(NotImplementedError):
        await adapter.search_directory_users("lou")


def test_telegram_is_the_one_that_cannot_be_searched() -> None:
    # Pinned rather than inferred: if a new platform arrives with no directory
    # this list should be updated deliberately, by someone who checked.
    unsearchable = {c.__name__ for c in ADAPTERS if not c.supports_directory_search}

    assert unsearchable == {"TelegramAdapter"}
