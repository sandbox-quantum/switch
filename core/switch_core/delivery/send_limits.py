"""What one sender may put into a room: how long a message may be, and how
fast messages may come.

A message a person or an agent sends is admitted (`SendLimits.admit`) before
it reaches the router, so a refused one costs no room lock and no decision
pass for the agents in the room. Every row the router writes is held to the
length limit again (`require_length`), whoever wrote it, so no path into a
room is left without it.

Refusals carry a reason the sender can act on, and are told to them: an
agent's tool call fails with it, a Console chat answers 422 or 429, and a
bridged person gets a notice (`CollaborationCore`). Nothing is cut short or
dropped quietly.

The rate is a token bucket per sender, kept in this process's memory: a
sender gets `burst` messages at once, then `per_second`. With several
replicas, a sender whose messages reach more than one of them gets up to that
many times the rate.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar

from switch_core.observability.catalogue import MESSAGES_REFUSED
from switch_core.observability.metrics import metrics

if TYPE_CHECKING:
    from switch_core.config import SwitchConfig

# Past this many senders, ones whose allowance has refilled are forgotten.
_FORGET_FULL_BUCKETS_PAST = 10_000


class MessageRefused(Exception):
    """A message Switch will not write, with why in words for its sender."""

    reason: ClassVar[str]


class MessageTooLong(MessageRefused, ValueError):
    reason = "too_long"

    def __init__(self, length: int, limit: int) -> None:
        self.length = length
        self.limit = limit
        super().__init__(
            f"This message is {length:,} characters long, and Switch accepts at "
            f"most {limit:,} in one message. Send it in parts."
        )


class SendRateLimited(MessageRefused):
    """`first` is set for the first refusal since the sender's last message
    got through, so a notice about it is given once, not once per message."""

    reason = "rate_limited"

    def __init__(
        self, *, retry_after: float, burst: int, per_second: float, first: bool
    ) -> None:
        self.retry_after = retry_after
        self.first = first
        wait = max(1, math.ceil(retry_after))
        super().__init__(
            "Messages are coming faster than Switch accepts from one sender "
            f"({burst} at once, then {per_second:g} a second). Wait {wait} "
            f"second{'s' if wait != 1 else ''} and send it again."
        )


@dataclass
class _Bucket:
    tokens: float
    updated: float
    refused: bool = False


class SendLimits:
    """The limits one process holds every sender to. One per process,
    owned by the router (`MessageRouter.send_limits`)."""

    def __init__(
        self,
        *,
        max_message_chars: int,
        burst: int,
        per_second: float,
        clock: Callable[[], float],
    ) -> None:
        self.max_message_chars = max_message_chars
        self._burst = burst
        self._per_second = per_second
        self._clock = clock
        self._buckets: dict[str, _Bucket] = {}
        self._forget_past = _FORGET_FULL_BUCKETS_PAST

    @classmethod
    def from_config(
        cls, config: SwitchConfig, *, clock: Callable[[], float]
    ) -> SendLimits:
        return cls(
            max_message_chars=config.max_message_chars,
            burst=config.message_rate_burst,
            per_second=config.message_rate_per_second,
            clock=clock,
        )

    def require_length(self, body: object) -> None:
        """Raise `MessageTooLong` for a body longer than the limit."""
        if isinstance(body, str) and len(body) > self.max_message_chars:
            raise MessageTooLong(len(body), self.max_message_chars)

    def admit(
        self, sender: str, body: object, *, actor: str, starts_post: bool
    ) -> None:
        """Let `sender` send `body`, or raise why not: `MessageTooLong`, or
        `SendRateLimited` once their allowance is spent.

        `sender` is whoever is sending, the same id for each of their
        messages. A post with several files is written as several rows, and
        is one message: only the row that starts it (`starts_post`) takes
        from the allowance, so a post is never refused part way through.
        `actor` (`human` or `agent`) labels the refusal's metric."""
        try:
            self.require_length(body)
            if starts_post:
                self._take(sender)
        except MessageRefused as refused:
            metrics().increment(
                MESSAGES_REFUSED, {"reason": refused.reason, "actor": actor}
            )
            raise

    def _take(self, sender: str) -> None:
        now = self._clock()
        bucket = self._buckets.get(sender)
        if bucket is None:
            self._forget_full(now)
            bucket = self._buckets[sender] = _Bucket(tokens=self._burst, updated=now)
        else:
            bucket.tokens = min(
                self._burst,
                bucket.tokens + (now - bucket.updated) * self._per_second,
            )
            bucket.updated = now
        if bucket.tokens >= 1:
            bucket.tokens -= 1
            bucket.refused = False
            return
        first = not bucket.refused
        bucket.refused = True
        raise SendRateLimited(
            retry_after=(1 - bucket.tokens) / self._per_second,
            burst=self._burst,
            per_second=self._per_second,
            first=first,
        )

    def _forget_full(self, now: float) -> None:
        """Drop the senders whose allowance has refilled, once there are
        many: a full bucket is what a new sender gets anyway."""
        if len(self._buckets) < self._forget_past:
            return
        refill = self._burst / self._per_second
        self._buckets = {
            sender: bucket
            for sender, bucket in self._buckets.items()
            if now - bucket.updated < refill
        }
        self._forget_past = max(_FORGET_FULL_BUCKETS_PAST, 2 * len(self._buckets))
