"""A rate limit a platform put on a whole kind of call, and the log of it."""

import logging
import time

logger = logging.getLogger(__name__)


class Cooldown:
    """One platform-wide wait, shared by every call it holds back.

    A 429 usually answers for the workspace or the chat rather than for the
    message that earned it, so the wait it asks for holds back every call of
    that kind. Kept in one place so each of those reads the same answer, and so
    that both edges are said out loud: a silent cooldown and a bridge that has
    stopped working look exactly the same from the outside, and this one can be
    minutes long.

    Shared between adapters because the trap is shared. Both Slack's and
    Telegram's cooldowns were written as a bare deadline that nothing logged,
    and in both the visible result is every card in the workspace stopping at
    once with nothing anywhere saying why. A copy of the two log lines would
    have drifted; what has to stay identical is that a lift is always reported
    for a start that was reported.

    The lift is noticed by the first caller to ask after it passes rather than
    on a timer, so the line lands next to the work it let through.
    """

    def __init__(self, platform: str, kind: str, scope: str, consequence: str) -> None:
        self._platform = platform
        self._kind = kind
        self._scope = scope
        self._consequence = consequence
        self._until = 0.0

    def remaining(self) -> float:
        """Seconds left to wait, zero once the platform is taking these again."""
        left = self._until - time.monotonic()
        if left > 0:
            return left
        if self._until:
            self._until = 0.0
            logger.warning(
                "%s is taking %s again after a rate limit.", self._platform, self._kind
            )
        return 0.0

    def start(self, delay: float) -> None:
        """Hold every call of this kind back for what the platform asked for."""
        self._until = time.monotonic() + delay
        logger.warning(
            "%s is rate limiting %s for the whole %s; holding them all back for "
            "%.0fs. %s",
            self._platform,
            self._kind,
            self._scope,
            delay,
            self._consequence,
        )
