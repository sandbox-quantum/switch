"""Reaching the process that holds a workspace's machine.

A decision on a machine is asked over the controller's connection, which
lives in the one process holding its socket (`decision/machine.py`). Two
things have to reach that process from another, over the signal bus
(`signals.py`), and neither carries room content:

- `decision.wake {process_id, tenant_id}`: a message waiting for a decision
  was written elsewhere; the holder decides the workspace's waiting messages
  now (`MessageRouter.wake_decisions`), rather than on its next sweep.
- `decision.test {process_id, test_id, controller_id, model, threshold}`: an
  admin pressed Test in a process that does not hold the machine. The holder
  asks the machine the fixed sample decision and answers with
  `decision.tested {process_id, test_id, ...outcome}`: the sample's pick,
  confidence and time, or why there was none.

A signal names the process it is for, and every other process ignores it.
One that is lost costs a sweep's delay (a wake) or a Test that says the
machine did not answer.
"""

from __future__ import annotations

import asyncio
import dataclasses
import logging
import uuid
from typing import TYPE_CHECKING, Any

from switch_core.decision.client import TestOutcome, machine_test_error

if TYPE_CHECKING:
    from switch_core.decision.client import DynamicDecisionClient
    from switch_core.delivery.router import MessageRouter
    from switch_core.signals import SignalBus

logger = logging.getLogger(__name__)

WAKE_SIGNAL = "decision.wake"
TEST_SIGNAL = "decision.test"
TESTED_SIGNAL = "decision.tested"

# How much longer than a decision's own deadline a relayed Test waits for the
# holder's answer: two signals and a database round trip.
RELAY_GRACE_SECONDS = 5.0
# The most of a failed Test's message that travels back in a signal.
_MESSAGE_CHARS = 1000


class DecisionSignals:
    """The decision family on the signal bus. One per process, wired once
    the router and the decision client exist."""

    def __init__(
        self,
        *,
        bus: SignalBus,
        router: MessageRouter,
        client: DynamicDecisionClient,
    ) -> None:
        self._bus = bus
        self._router = router
        self._client = client
        self._tests: dict[str, asyncio.Future[TestOutcome]] = {}
        self._running: set[asyncio.Task[None]] = set()
        bus.handle(WAKE_SIGNAL, self._on_wake)
        bus.handle(TEST_SIGNAL, self._on_test)
        bus.handle(TESTED_SIGNAL, self._on_tested)
        router.use_decision_wakes(self.wake)
        client.use_test_relay(self.relay_test)

    def _mine(self, signal: dict[str, Any]) -> bool:
        return signal.get("process_id") == self._bus.process_id

    def wake(self, process_id: str, tenant_id: str) -> None:
        self._bus.publish(WAKE_SIGNAL, process_id=process_id, tenant_id=tenant_id)

    def _on_wake(self, signal: dict[str, Any]) -> None:
        if self._mine(signal):
            self._router.wake_decisions(signal["tenant_id"])

    async def relay_test(
        self, process_id: str, controller_id: str, model: str, threshold: float
    ) -> TestOutcome:
        """Ask the process holding the machine to run the sample decision on
        it, and wait for its answer."""
        test_id = uuid.uuid4().hex
        answer: asyncio.Future[TestOutcome] = asyncio.get_running_loop().create_future()
        self._tests[test_id] = answer
        self._bus.publish(
            TEST_SIGNAL,
            process_id=process_id,
            test_id=test_id,
            controller_id=controller_id,
            model=model,
            threshold=threshold,
        )
        try:
            return await asyncio.wait_for(
                answer, timeout=self._client.timeout_seconds + RELAY_GRACE_SECONDS
            )
        except TimeoutError:
            logger.warning(
                "Decision routing: process %s did not answer the Test relayed to "
                "it for controller %s",
                process_id,
                controller_id,
            )
            return machine_test_error(
                "machine_offline",
                "The Switch server process holding the machine's connection did "
                "not answer. Try again.",
                None,
            )
        finally:
            self._tests.pop(test_id, None)

    def _on_test(self, signal: dict[str, Any]) -> None:
        if not self._mine(signal):
            return
        task = asyncio.get_running_loop().create_task(self._answer_test(signal))
        self._running.add(task)
        task.add_done_callback(self._running.discard)

    async def _answer_test(self, signal: dict[str, Any]) -> None:
        try:
            if self._client.machines.held_here(signal["controller_id"]):
                outcome = await self._client.ask_machine_sample(
                    controller_id=signal["controller_id"],
                    model=signal["model"],
                    threshold=float(signal["threshold"]),
                )
            else:
                outcome = machine_test_error(
                    "machine_offline",
                    "The machine disconnected before it could be asked.",
                    None,
                )
        except Exception:
            logger.error(
                "Decision routing: the Test relayed for controller %s failed",
                signal.get("controller_id"),
                exc_info=True,
            )
            outcome = machine_test_error(
                "bad_answer",
                "The machine could not be asked; see the server log.",
                None,
            )
        fields = dataclasses.asdict(outcome)
        if fields["error_message"] is not None:
            fields["error_message"] = fields["error_message"][:_MESSAGE_CHARS]
        self._bus.publish(
            TESTED_SIGNAL,
            process_id=signal["from"],
            test_id=signal["test_id"],
            **fields,
        )

    def _on_tested(self, signal: dict[str, Any]) -> None:
        if not self._mine(signal):
            return
        answer = self._tests.get(signal["test_id"])
        if answer is None or answer.done():
            return
        answer.set_result(
            TestOutcome(
                ok=bool(signal.get("ok")),
                agent=signal.get("agent"),
                model_choice=signal.get("model_choice"),
                confidence=signal.get("confidence"),
                latency_ms=signal.get("latency_ms"),
                backend=signal.get("backend"),
                error_code=signal.get("error_code"),
                error_message=signal.get("error_message"),
            )
        )
