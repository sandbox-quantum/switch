"""A beating connection keeps its credential in memory; a gone one does not.

An agent beats every 2 s and the auth cache TTL is capped below the 6 s
heartbeat TTL, so roughly every third beat used to miss and read Postgres —
thousands a minute, each a checkout of the pool whose exhaustion is the
failure being chased. The entry now survives its TTL for as long as the agent
holds a live connection.

That is a credential living longer than it used to, so what these tests pin
is the boundary rather than the speed-up: it extends only while connected, it
never resurrects an entry that was invalidated, and revocation still lands on
the next request.
"""

from __future__ import annotations

import time

import pytest

from switch_core.bridges.agent.api_key_cache import ApiKeyCache
from switch_core.db.models import Agent, ApiKey

_HASH = "hash-of-a-token"
_TTL = 0.05


def _agent(agent_id: str = "agent-1") -> Agent:
    agent = Agent(
        name="a",
        description="d",
        agent_type="claude-code",
        connector_type="mcp",
        integration_profile={},
        client_id="c1",
        api_key_id="k1",
    )
    agent.id = agent_id
    return agent


def _key() -> ApiKey:
    key = ApiKey(
        user_id="u1", key_hash=_HASH, encrypted_key="x", label="l", type="agent"
    )
    key.id = "k1"
    return key


def _cache(connected: set[str]) -> ApiKeyCache:
    return ApiKeyCache(
        ttl_seconds=_TTL,
        max_entries=10,
        agent_is_connected=lambda agent_id: agent_id in connected,
    )


def _expire() -> None:
    time.sleep(_TTL * 2)


class TestExtensionWhileConnected:
    def test_survives_its_ttl_while_the_agent_is_connected(self) -> None:
        cache = _cache(connected={"agent-1"})
        cache.put(_HASH, _key(), _agent())
        _expire()

        assert cache.get(_HASH) is not None, (
            "a live connection's credential was evicted — every third beat "
            "goes back to the database"
        )

    def test_stays_valid_across_repeated_reads(self) -> None:
        # The beat case: read again and again, well past the TTL each time.
        cache = _cache(connected={"agent-1"})
        cache.put(_HASH, _key(), _agent())
        for _ in range(3):
            _expire()
            assert cache.get(_HASH) is not None

    def test_expires_normally_once_the_connection_is_gone(self) -> None:
        connected = {"agent-1"}
        cache = _cache(connected)
        cache.put(_HASH, _key(), _agent())
        _expire()
        assert cache.get(_HASH) is not None

        connected.clear()
        assert cache.get(_HASH) is None, (
            "the credential outlived the connection it was extended for"
        )

    def test_a_different_agents_connection_does_not_extend_it(self) -> None:
        cache = _cache(connected={"someone-else"})
        cache.put(_HASH, _key(), _agent("agent-1"))
        _expire()

        assert cache.get(_HASH) is None


class TestRevocationStillWins:
    def test_invalidate_beats_a_live_connection(self) -> None:
        # Key rotation. The connection is still live, so the extension would
        # apply — invalidation has to be stronger than it, or a rotated key
        # keeps working for as long as its owner keeps beating.
        cache = _cache(connected={"agent-1"})
        cache.put(_HASH, _key(), _agent())
        cache.invalidate(_HASH)

        assert cache.get(_HASH) is None

    def test_invalidate_agent_beats_a_live_connection(self) -> None:
        # Agent deletion. Same argument, and the more serious one: deleting an
        # agent does not itself close its connections, so if the entry could
        # be extended past this the agent would go on authenticating.
        cache = _cache(connected={"agent-1"})
        cache.put(_HASH, _key(), _agent())
        cache.invalidate_agent("agent-1")

        assert cache.get(_HASH) is None

    def test_extension_never_resurrects_an_absent_entry(self) -> None:
        # Being connected must not conjure a credential that was never cached
        # or has been dropped — the extension renews, it does not create.
        cache = _cache(connected={"agent-1"})
        assert cache.get(_HASH) is None


class TestUnchangedWithoutAProbe:
    def test_a_cache_with_no_probe_expires_as_before(self) -> None:
        # Every other construction site (tests, the MCP door's own wiring)
        # passes no probe and must behave exactly as it did.
        cache = ApiKeyCache(ttl_seconds=_TTL, max_entries=10)
        cache.put(_HASH, _key(), _agent())
        _expire()

        assert cache.get(_HASH) is None

    @pytest.mark.parametrize("connected", [True, False])
    def test_a_disabled_cache_stores_nothing_either_way(self, connected: bool) -> None:
        cache = ApiKeyCache(
            ttl_seconds=0,
            max_entries=10,
            agent_is_connected=lambda _: connected,
        )
        cache.put(_HASH, _key(), _agent())

        assert cache.get(_HASH) is None
