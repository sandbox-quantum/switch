from __future__ import annotations

import random
import time
from collections import OrderedDict

from switch_core.bridges.agent.protocol.agent_connections import HEARTBEAT_TTL_SECONDS
from switch_core.db.models import Agent, ApiKey

# Each entry lives a random 80–120% of the TTL. A restart empties the cache
# for every agent at once, and with a fixed TTL every entry then expires in
# the same instant too, so the whole fleet hits the database together again on
# every cycle. Spreading the expiries breaks that herd up after the first one.
EXPIRY_JITTER = 0.2


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
    """

    def __init__(self, *, ttl_seconds: float, max_entries: int) -> None:
        if ttl_seconds < 0:
            raise ValueError(f"ttl_seconds must not be negative, got {ttl_seconds!r}")
        if ttl_seconds * (1 + EXPIRY_JITTER) >= HEARTBEAT_TTL_SECONDS:
            raise ValueError(
                f"ttl_seconds, with its {EXPIRY_JITTER:.0%} jitter, must stay "
                f"below the agent heartbeat TTL of {HEARTBEAT_TTL_SECONDS}s, "
                f"got {ttl_seconds!r}"
            )
        if max_entries < 1:
            raise ValueError(f"max_entries must be at least 1, got {max_entries!r}")
        self._ttl = ttl_seconds
        self._max_entries = max_entries
        self._entries: OrderedDict[str, tuple[float, ApiKey, Agent]] = OrderedDict()

    @property
    def enabled(self) -> bool:
        return self._ttl > 0

    def get(self, token_hash: str) -> tuple[ApiKey, Agent] | None:
        entry = self._entries.get(token_hash)
        if entry is None:
            return None
        expires_at, api_key, agent = entry
        if expires_at <= time.monotonic():
            del self._entries[token_hash]
            return None
        self._entries.move_to_end(token_hash)
        return api_key, agent

    def put(self, token_hash: str, api_key: ApiKey, agent: Agent) -> None:
        if not self.enabled:
            return
        lifetime = self._ttl * random.uniform(1 - EXPIRY_JITTER, 1 + EXPIRY_JITTER)
        self._entries[token_hash] = (time.monotonic() + lifetime, api_key, agent)
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
