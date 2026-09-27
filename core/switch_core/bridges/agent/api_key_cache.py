from __future__ import annotations

import time
from collections import OrderedDict
from collections.abc import Callable

from switch_core.bridges.agent.protocol.connections import HEARTBEAT_TTL_SECONDS
from switch_core.db.models import Agent, ApiKey


class ApiKeyCache:
    """A short-lived memo of resolved agent bearer tokens.

    Every authenticated request resolves its token against Postgres before the
    handler runs, and an agent connection beats every couple of seconds, so
    that one lookup is the bulk of the traffic through the connection pool —
    including the heartbeats whose deadline the pool is capable of missing.

    What it deliberately does not do:

    - **Cache a failure.** Only a token that resolved to a live agent is
      stored, so an unknown, revoked or malformed token always reaches the
      database and can never be answered from memory.
    - **Hold a plaintext token.** Entries are keyed on the same SHA-256 digest
      the database stores.
    - **Outlive a rotation.** ``invalidate_agent`` is called when a key is
      rotated or an agent deleted; expiry is the backstop, not the mechanism.

    A ``ttl_seconds`` of 0 disables it: every read misses and nothing is ever
    stored. The TTL bounds how long an already-issued credential survives its
    revocation, and it is refused at or above the heartbeat TTL — past that a
    credential could authenticate a connection the server has already given up
    on, which is longer than any of this is worth.

    ``agent_is_connected`` lets an entry outlive that TTL for exactly as long
    as the agent holds a live connection, and not one moment longer. It is
    what takes the heartbeat off the database.

    The reasoning, since extending a credential's life deserves an argument.
    An agent beats every 2 s and the TTL must stay under 6 s, so roughly every
    third beat missed and went to Postgres — thousands a minute, each one a
    checkout of a pool whose exhaustion is the failure we are chasing. What
    those lookups re-established was that a credential is still good. But the
    stream that connection is beating *for* was authenticated once, when it
    opened, and then runs for hours without being re-checked. Re-proving the
    credential every six seconds for the beat, while the stream it belongs to
    goes unexamined, was never a boundary — it was a cost.

    What the cap protected is preserved exactly, because the condition is the
    thing it was protecting: an entry can now only outlive its TTL while a
    connection is live, so it can never authenticate a connection the server
    has already given up on. And it is an extension, never a resurrection —
    `invalidate` and `invalidate_agent` remove the entry outright, so every
    revocation path (key rotation, agent deletion, tenant member removal)
    still takes effect on the next request, as before.
    """

    def __init__(
        self,
        *,
        ttl_seconds: float,
        max_entries: int,
        agent_is_connected: Callable[[str], bool] | None = None,
    ) -> None:
        if ttl_seconds < 0:
            raise ValueError(f"ttl_seconds must not be negative, got {ttl_seconds!r}")
        if ttl_seconds >= HEARTBEAT_TTL_SECONDS:
            raise ValueError(
                f"ttl_seconds must stay below the agent heartbeat TTL of "
                f"{HEARTBEAT_TTL_SECONDS}s, got {ttl_seconds!r}"
            )
        if max_entries < 1:
            raise ValueError(f"max_entries must be at least 1, got {max_entries!r}")
        self._ttl = ttl_seconds
        self._max_entries = max_entries
        self._agent_is_connected = agent_is_connected
        self._entries: OrderedDict[str, tuple[float, ApiKey, Agent]] = OrderedDict()

    @property
    def enabled(self) -> bool:
        return self._ttl > 0

    def get(self, token_hash: str) -> tuple[ApiKey, Agent] | None:
        entry = self._entries.get(token_hash)
        if entry is None:
            return None
        expires_at, api_key, agent = entry
        # Past its deadline, an entry survives only while the agent still
        # holds the connection this credential opened. The deadline is
        # deliberately left in the past rather than pushed out, so the
        # liveness check is consulted on every later read and the entry goes
        # the first time the connection is gone. Renewing it instead would let
        # the credential outlive the connection by up to a full TTL, which is
        # the one thing this must not do.
        if expires_at <= time.monotonic() and not self._still_connected(agent):
            del self._entries[token_hash]
            return None
        self._entries.move_to_end(token_hash)
        return api_key, agent

    def _still_connected(self, agent: Agent) -> bool:
        return self._agent_is_connected is not None and self._agent_is_connected(
            agent.id
        )

    def put(self, token_hash: str, api_key: ApiKey, agent: Agent) -> None:
        if not self.enabled:
            return
        self._entries[token_hash] = (time.monotonic() + self._ttl, api_key, agent)
        self._entries.move_to_end(token_hash)
        while len(self._entries) > self._max_entries:
            self._entries.popitem(last=False)

    def invalidate(self, token_hash: str) -> None:
        self._entries.pop(token_hash, None)

    def invalidate_agent(self, agent_id: str) -> None:
        """Drop every entry resolving to `agent_id`, whatever its token."""
        stale = [
            token_hash
            for token_hash, (_, _, agent) in self._entries.items()
            if agent.id == agent_id
        ]
        for token_hash in stale:
            del self._entries[token_hash]

    def clear(self) -> None:
        self._entries.clear()
