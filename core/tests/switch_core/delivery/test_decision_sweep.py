"""The decision sweep across tenants: at most `concurrency` tenants at once,
and one tenant's failure leaves the others to finish."""

from __future__ import annotations

import asyncio
import logging

import pytest

from switch_core.delivery.router import sweep_pending_decisions


class _Decider:
    """Records how many tenants are being decided at once."""

    def __init__(self, *, failing: set[str] | None = None) -> None:
        self.running = 0
        self.most = 0
        self.done: list[str] = []
        self.failing = failing or set()

    async def __call__(self, tenant_id: str) -> int:
        self.running += 1
        self.most = max(self.most, self.running)
        try:
            await asyncio.sleep(0.01)
            if tenant_id in self.failing:
                raise RuntimeError(f"backend down for {tenant_id}")
            self.done.append(tenant_id)
            return 1
        finally:
            self.running -= 1


@pytest.mark.parametrize("concurrency", [1, 4])
async def test_at_most_concurrency_tenants_at_once(concurrency: int) -> None:
    decide = _Decider()
    tenants = [f"t{i}" for i in range(10)]

    await sweep_pending_decisions(tenants, decide, concurrency)

    assert sorted(decide.done) == sorted(tenants)
    assert decide.most == concurrency


async def test_a_slow_tenant_does_not_hold_up_the_others() -> None:
    finished: list[str] = []
    release = asyncio.Event()

    async def decide(tenant_id: str) -> int:
        if tenant_id == "slow":
            await release.wait()
        finished.append(tenant_id)
        if len(finished) == 3:
            release.set()
        return 1

    await asyncio.wait_for(
        sweep_pending_decisions(["slow", "a", "b", "c"], decide, 2), timeout=5
    )

    assert finished[:3] == ["a", "b", "c"]
    assert finished[-1] == "slow"


async def test_a_failing_tenant_is_logged_and_the_rest_finish(
    caplog: pytest.LogCaptureFixture,
) -> None:
    decide = _Decider(failing={"t1"})

    with caplog.at_level(logging.ERROR):
        await sweep_pending_decisions(["t0", "t1", "t2"], decide, 4)

    assert sorted(decide.done) == ["t0", "t2"]
    assert "Decision sweep failed for tenant t1" in caplog.text


async def test_no_tenants_waiting_decides_nothing() -> None:
    decide = _Decider()

    await sweep_pending_decisions([], decide, 4)

    assert decide.done == []
