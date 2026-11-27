"""The warm pool's bind, crashed at each step (box side).

A crash is the operator process dying after a step: nothing tidies up, and a
fresh operator later picks the action up again against the same cluster. What
it finds depends on what Core decided meanwhile:

- the claim still open (the lease ran out in time): the bind carries on and
  ends bound once (test_box_operator.py covers this for B1 to B3);
- the claim closed (Core's 30 s bind timeout): nothing more is written. Before
  `owner_writing` the box stays a pool box nobody owns (reapable); from
  `owner_writing` on it's the person's, but never live (no box-map entry);
- a crash after B4: the retry finds it all done and changes nothing.

After every crash and retry, the box keeps the isolation of a normal box
(gVisor, placement on the agents nodes, deny-all), and the two lists were only ever
added to (`PoolKube` refuses any change or removal, as the cluster's policy
does).
"""

from __future__ import annotations

import copy

import pytest
from test_box_operator import (
    POOL_ID,
    POOL_NS,
    USER,
    PoolCore,
    PoolKube,
    bind_action,
    cfg,
    pool_action,
    result,
)

from switch_hosted_controller.box_operator import BoxOperator
from switch_hosted_controller.reaper import reap_once

STEPS = ("B1", "owner_writing", "B2", "B3", "B4")
BEFORE_OWNER = ("B1",)


class Crash(BaseException):
    """Not an Exception: nothing in the operator may catch it and carry on."""


def _pooled() -> PoolKube:
    kube = PoolKube()
    BoxOperator(PoolCore(), kube, cfg()).pool(pool_action())
    return kube


def _crash_after(stop: str):  # type: ignore[no-untyped-def]
    def stop_after(step: str) -> None:
        if step == stop:
            raise Crash(step)

    return stop_after


def _crashed_bind(kube: PoolKube, stop: str) -> PoolCore:
    core = PoolCore()
    with pytest.raises(Crash):
        BoxOperator(core, kube, cfg()).bind(bind_action(), stop_after=_crash_after(stop))
    assert [c for c in core.calls if c[0] == "result"] == [], "a crashed operator reported nothing"
    return core


def _isolation(kube: PoolKube) -> dict:
    """What makes the box safe to run, as rendered: the pod's runtime, where it
    may be placed (the agents nodes only), and the deny-all rule."""
    pod = kube.objects[("StatefulSet", POOL_NS, "box")]["spec"]["template"]["spec"]
    return {
        "runtime": pod.get("runtimeClassName"),
        "placement": copy.deepcopy((pod.get("nodeSelector"), pod.get("affinity"))),
        "default_deny": copy.deepcopy(kube.objects[("NetworkPolicy", POOL_NS, "default-deny")]),
    }


@pytest.mark.parametrize("stop", STEPS)
def test_a_crash_then_a_closed_claim_writes_nothing_more(stop: str) -> None:
    kube = _pooled()
    _crashed_bind(kube, stop)
    owners_after_crash = dict(kube.lists["box-owners"])
    live_after_crash = dict(kube.boxes)

    # Core's bind timeout closed the claim before a new operator came back.
    core = PoolCore(step_ok=False, open_=False)
    BoxOperator(core, kube, cfg()).bind(bind_action())

    if stop == "B4":
        # It was already live: the retry finds nothing to do and fails no
        # step, but it never undoes or rewrites anything either.
        assert kube.boxes == {POOL_ID: POOL_NS} == live_after_crash
        assert kube.lists["box-owners"] == {POOL_NS: USER}
        return
    assert result(core)[2:] == ("failed", POOL_NS, "bind_closed")
    assert kube.boxes == {} == live_after_crash  # never live
    assert kube.lists["box-owners"] == owners_after_crash  # nothing added
    if stop in BEFORE_OWNER:
        assert kube.lists["box-owners"] == {}  # nobody's: reapable
    else:
        # `owner_writing` was recorded before B2, so Core already counts it
        # the person's; if B2 ran, the entry is theirs.
        assert kube.lists["box-owners"] in ({}, {POOL_NS: USER})
        if stop != "owner_writing":
            assert kube.lists["box-owners"] == {POOL_NS: USER}


def test_a_crash_after_b4_and_a_retry_changes_nothing() -> None:
    kube = _pooled()
    _crashed_bind(kube, "B4")
    before = (copy.deepcopy(kube.objects), dict(kube.boxes), copy.deepcopy(kube.lists))
    writes = list(kube.list_writes)

    core = PoolCore()
    BoxOperator(core, kube, cfg()).bind(bind_action())

    assert result(core)[2:] == ("done", POOL_NS, None)
    assert (kube.objects, kube.boxes, kube.lists) == before
    assert kube.list_writes == writes  # no list written again


@pytest.mark.parametrize("stop", STEPS)
def test_isolation_holds_through_a_crash_and_a_retry(stop: str) -> None:
    kube = _pooled()
    pooled = _isolation(kube)
    assert pooled["runtime"] == "gvisor"
    assert pooled["placement"][0]["switch.dev/pool"] == "agents"

    _crashed_bind(kube, stop)
    assert _isolation(kube) == pooled
    BoxOperator(PoolCore(), kube, cfg()).bind(bind_action())
    assert _isolation(kube) == pooled


@pytest.mark.parametrize("stop", STEPS)
def test_the_pool_map_is_never_touched_by_a_bind(stop: str) -> None:
    kube = _pooled()
    _crashed_bind(kube, stop)
    BoxOperator(PoolCore(), kube, cfg()).bind(bind_action())
    assert kube.lists["pool-map"] == {POOL_ID: POOL_NS}
    assert kube.list_writes.count("pool-map") == 1  # only when it was pooled


@pytest.mark.parametrize("stop", ("owner_writing", "B2", "B3"))
def test_a_claim_that_closes_after_owner_writing_never_goes_live(stop: str) -> None:
    """Core recorded `owner_writing` (repeats answer yes), then failed the
    claim before the retry reached B4: the re-check before B4 is the only
    thing between the box and the box map, and it holds."""
    kube = _pooled()
    _crashed_bind(kube, stop)

    core = PoolCore(step_ok=True, open_=False)
    BoxOperator(core, kube, cfg()).bind(bind_action())

    assert result(core)[2:] == ("failed", POOL_NS, "bind_closed")
    assert "recheck" in core.steps
    assert kube.boxes == {}
    assert kube.lists["box-owners"] == {POOL_NS: USER}  # the person's, never reaped


class _Retiring:
    """Core's side of the reaper: it lists the pool box as retiring, as Core
    does once a claim failed before its owner was written."""

    def __init__(self) -> None:
        self.gone_calls: list[str] = []

    def retiring(self) -> list[dict[str, str]]:
        return [{"pool_box_id": POOL_ID, "namespace": POOL_NS}]

    def gone(self, pool_box_id: str) -> bool:
        self.gone_calls.append(pool_box_id)
        return True


class _ReaperView:
    """The reaper's narrow view of the same fake cluster the bind wrote to."""

    def __init__(self, kube: PoolKube) -> None:
        self.kube = kube
        self.deleted: list[str] = []

    def read_list(self, name: str) -> dict[str, str]:
        data, _ = self.kube.read_list(name)
        return data

    def namespace_exists(self, name: str) -> bool:
        return name not in self.deleted and self.kube.get_namespace(name) is not None

    def delete_namespace(self, name: str) -> None:
        self.deleted.append(name)

    def volumes_left(self, namespace: str) -> int:
        return 0


def test_a_bind_crashed_before_its_owner_is_reaped_and_reported_gone() -> None:
    kube = _pooled()
    _crashed_bind(kube, "B1")
    view, core = _ReaperView(kube), _Retiring()

    assert reap_once(core, view)["deleted"] == 1
    assert view.deleted == [POOL_NS]
    assert reap_once(core, view)["gone"] == 1 and core.gone_calls == [POOL_ID]


@pytest.mark.parametrize("stop", ("B2", "B3", "B4"))
def test_a_bind_that_reached_its_owner_is_never_reaped(stop: str) -> None:
    """Even if Core wrongly listed it as retiring, the reaper's own check of
    `box-owners` and the box map refuses it."""
    kube = _pooled()
    _crashed_bind(kube, stop)
    view, core = _ReaperView(kube), _Retiring()

    counts = reap_once(core, view)

    assert counts["refused"] == 1 and counts["deleted"] == 0
    assert view.deleted == [] and core.gone_calls == []


def test_a_reaper_crash_after_the_delete_reports_gone_on_the_next_pass() -> None:
    """A real crash (not an exception the pass catches): nothing was reported,
    and the next reaper reports it gone without deleting again."""
    kube = _pooled()
    view, core = _ReaperView(kube), _Retiring()

    with pytest.raises(Crash):
        reap_once(core, view, stop_after=_crash_after("deleted"))
    assert view.deleted == [POOL_NS] and core.gone_calls == []

    assert reap_once(core, view)["gone"] == 1
    assert view.deleted == [POOL_NS] and core.gone_calls == [POOL_ID]
