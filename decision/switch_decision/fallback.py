"""The fallback race: ask the default backend and, when it has not answered
after a delay or has failed, ask the fallback backend too, taking whichever
answers first."""

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal

from switch_decision.backends import InvalidChoiceError, ModelAnswer, ModelServerError

Call = Callable[[], Awaitable[ModelAnswer]]

# not_needed: the primary answered before the delay. won: the fallback
# answered while the primary was still out. lost: the fallback started, the
# primary answered first. primary_failed: the primary failed, the fallback
# answered.
Outcome = Literal["not_needed", "won", "lost", "primary_failed"]


@dataclass(frozen=True)
class Settled:
    """One backend call's answer or failure, and how long it took. An
    InvalidChoiceError is an answer: the backend worked and named no candidate."""

    answer: ModelAnswer | InvalidChoiceError | None
    error: ModelServerError | None
    seconds: float


async def settle(call: Call) -> Settled:
    started = time.monotonic()
    try:
        answer: ModelAnswer | InvalidChoiceError = await call()
    except InvalidChoiceError as exc:
        answer = exc
    except ModelServerError as exc:
        return Settled(None, exc, time.monotonic() - started)
    return Settled(answer, None, time.monotonic() - started)


@dataclass(frozen=True)
class Raced:
    answer: ModelAnswer | InvalidChoiceError
    # The answering call's own time.
    seconds: float
    by_fallback: bool
    # None when no fallback is configured for the request.
    outcome: Outcome | None
    # Why the fallback started: "slow", or the primary's error kind. None
    # when it did not start.
    reason: str | None
    primary_error: ModelServerError | None
    fallback_error: ModelServerError | None


class BothFailed(Exception):
    """The primary and the fallback both failed. The primary's error is the
    one the request fails with."""

    def __init__(self, primary: Settled, fallback: Settled, reason: str):
        assert primary.error is not None and fallback.error is not None
        super().__init__(str(primary.error))
        self.primary_error = primary.error
        self.primary_seconds = primary.seconds
        self.fallback_error = fallback.error
        self.fallback_seconds = fallback.seconds
        self.reason = reason


async def race(primary: Call, fallback: Call | None, after_s: float) -> Raced:
    """The first answer. Without a fallback, the primary's answer, or its
    error raised. With one, the fallback starts once the primary has run
    `after_s` seconds without answering, or as soon as it fails; the first
    answer wins and the other call is cancelled. BothFailed when neither answers."""
    if fallback is None:
        alone = await settle(primary)
        if alone.error is not None:
            raise alone.error
        assert alone.answer is not None
        return Raced(alone.answer, alone.seconds, False, None, None, None, None)
    first = asyncio.create_task(settle(primary))
    second: asyncio.Task[Settled] | None = None
    try:
        done, _ = await asyncio.wait({first}, timeout=after_s)
        reason = "slow"
        if done:
            early = first.result()
            if early.answer is not None:
                return Raced(
                    early.answer, early.seconds, False, "not_needed", None, None, None
                )
            assert early.error is not None
            reason = early.error.kind
        second = asyncio.create_task(settle(fallback))
        pending: set[asyncio.Task[Settled]] = (
            {second} if first.done() else {first, second}
        )
        while pending:
            _, pending = await asyncio.wait(
                pending, return_when=asyncio.FIRST_COMPLETED
            )
            p = first.result() if first.done() else None
            f = second.result() if second.done() else None
            if p is not None and p.answer is not None:
                return Raced(
                    p.answer,
                    p.seconds,
                    False,
                    "lost",
                    reason,
                    None,
                    f.error if f is not None else None,
                )
            if f is not None and f.answer is not None:
                return Raced(
                    f.answer,
                    f.seconds,
                    True,
                    "won" if p is None else "primary_failed",
                    reason,
                    p.error if p is not None else None,
                    None,
                )
        raise BothFailed(first.result(), second.result(), reason)
    finally:
        for task in (first, second):
            if task is not None and not task.done():
                task.cancel()
