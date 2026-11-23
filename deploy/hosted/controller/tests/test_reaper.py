"""The reaper: deletes only unclaimed pool boxes Core lists, and tells Core only once they're gone."""

from __future__ import annotations

import logging
from typing import Any

import pytest

from switch_hosted_controller.reaper import reap_once, reapable

P1, P2 = "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"
NS1, NS2 = "agents-box-k1-00000000000000b1", "agents-box-k1-00000000000000b2"
USER_NS = "agents-user-k1-0123456789abcdef"


class Core:
    def __init__(self, retiring: list[dict[str, Any]], refuse: bool = False) -> None:
        self.listed, self.refuse, self.gone_calls = retiring, refuse, []

    def retiring(self) -> list[dict[str, Any]]:
        return self.listed

    def gone(self, pool_box_id: str) -> bool:
        self.gone_calls.append(pool_box_id)
        return not self.refuse


class Kube:
    def __init__(self, pool_map, box_map=None, owners=None, namespaces=(), volumes=None):  # type: ignore[no-untyped-def]
        self.lists = {"pool-map": pool_map, "box-map": box_map or {}, "box-owners": owners or {}}
        self.namespaces, self.volumes = set(namespaces), dict(volumes or {})
        self.deleted: list[str] = []

    def read_list(self, name):  # type: ignore[no-untyped-def]
        return self.lists[name]

    def namespace_exists(self, name):  # type: ignore[no-untyped-def]
        return name in self.namespaces

    def delete_namespace(self, name):  # type: ignore[no-untyped-def]
        self.deleted.append(name)
        self.namespaces.discard(name)

    def volumes_left(self, namespace):  # type: ignore[no-untyped-def]
        return self.volumes.get(namespace, 0)


def test_an_unclaimed_pool_box_is_deleted_then_reported_gone_once_its_disks_are():
    core = Core([{"pool_box_id": P1, "namespace": NS1}])
    kube = Kube({P1: NS1}, namespaces={NS1}, volumes={NS1: 2})
    assert reap_once(core, kube)["deleted"] == 1 and kube.deleted == [NS1] and core.gone_calls == []
    assert (
        reap_once(core, kube)["waiting"] == 1 and core.gone_calls == []
    )  # its disks are still going
    kube.volumes[NS1] = 0
    assert reap_once(core, kube)["gone"] == 1 and core.gone_calls == [P1]


@pytest.mark.parametrize(
    ("namespace", "pool_map", "box_map", "owners", "why"),
    [
        (USER_NS, {P1: USER_NS}, {}, {}, "not a box-keyed name"),
        ("switch-hosted", {P1: "switch-hosted"}, {}, {}, "not a box-keyed name"),
        ("kube-system", {}, {}, {}, "not a box-keyed name"),
        (NS1, {}, {}, {}, "not this pool box's"),
        (NS1, {P2: NS1}, {}, {}, "not this pool box's"),
        (NS1, {P1: NS1}, {"m": NS1}, {}, "in the box map"),
        (NS1, {P1: NS1}, {}, {NS1: "k1-0123456789abcdef"}, "has an owner"),
    ],
)
def test_nothing_of_a_persons_and_nothing_outside_the_pool_is_ever_deleted(
    namespace, pool_map, box_map, owners, why, caplog
):  # type: ignore[no-untyped-def]
    assert reapable(namespace, P1, pool_map, box_map, owners) == why
    core = Core([{"pool_box_id": P1, "namespace": namespace}])
    kube = Kube(pool_map, box_map, owners, namespaces={namespace})
    with caplog.at_level(logging.ERROR):
        counts = reap_once(core, kube)
    assert counts["refused"] == 1 and kube.deleted == [] and core.gone_calls == []
    assert "Reaper ALERT" in caplog.text and "k1-0123456789abcdef" not in caplog.text


def test_core_refusing_gone_is_an_alert(caplog):  # type: ignore[no-untyped-def]
    core = Core([{"pool_box_id": P1, "namespace": NS1}], refuse=True)
    with caplog.at_level(logging.ERROR):
        assert reap_once(core, Kube({P1: NS1}))["refused"] == 1
    assert "Core refused pool box" in caplog.text


def test_an_empty_list_reads_nothing():
    class NoKube(Kube):
        def read_list(self, name):  # type: ignore[no-untyped-def]
            raise AssertionError("not read")

    assert reap_once(Core([]), NoKube({})) == {"deleted": 0, "gone": 0, "waiting": 0, "refused": 0}


def test_an_error_after_the_delete_carries_on_and_reports_gone_on_the_next_pass():
    """An error raised after the delete is caught per box, so the pass carries on; the next pass reports the box
    gone without deleting again. (A real crash, which nothing catches, is in `test_pool_bind_crash.py`.)"""
    core = Core([{"pool_box_id": P1, "namespace": NS1}])
    kube = Kube({P1: NS1}, namespaces={NS1})

    def crash(step):  # type: ignore[no-untyped-def]
        raise RuntimeError(step)

    reap_once(core, kube, stop_after=crash)  # this box stops right after its delete; the pass carries on
    assert core.gone_calls == []
    assert reap_once(core, kube)["gone"] == 1 and core.gone_calls == [P1]


def test_one_box_failing_doesnt_stop_the_others():
    class Flaky(Kube):
        def namespace_exists(self, name):  # type: ignore[no-untyped-def]
            if name == NS1:
                raise OSError("down")
            return super().namespace_exists(name)

    core = Core([{"pool_box_id": P1, "namespace": NS1}, {"pool_box_id": P2, "namespace": NS2}])
    kube = Flaky({P1: NS1, P2: NS2}, namespaces={NS2})
    assert reap_once(core, kube)["deleted"] == 1 and kube.deleted == [NS2]


def test_the_kube_client_touches_only_box_keyed_namespaces(tmp_path, monkeypatch):  # type: ignore[no-untyped-def]
    from switch_hosted_controller import reaper_main

    monkeypatch.setattr(reaper_main.ssl, "create_default_context", lambda cafile=None: None)
    token = tmp_path / "t"
    token.write_text("sa")
    api = reaper_main.ReaperKubeApi("https://10.0.0.1", token, "ca")
    calls = []
    monkeypatch.setattr(
        api, "_call", lambda method, path: calls.append((method, path)) or {"items": []}
    )
    for bad in (USER_NS, "switch-hosted", "kube-system", "agents-box-ada"):
        with pytest.raises(ValueError):
            api.delete_namespace(bad)
        with pytest.raises(ValueError):
            api.namespace_exists(bad)
    with pytest.raises(ValueError):
        api.read_list("some-secret")
    api.delete_namespace(NS1)
    assert calls == [("DELETE", f"/api/v1/namespaces/{NS1}")]


def test_the_core_client_reports_gone_by_uuid_only(tmp_path, monkeypatch):  # type: ignore[no-untyped-def]
    from switch_hosted_controller import reaper_main

    token = tmp_path / "t"
    token.write_text("reaper-token")
    api = reaper_main.ReaperCoreApi("https://core.example.invalid", token)
    calls = []
    monkeypatch.setattr(api, "_call", lambda method, path: calls.append((method, path)))
    assert api.gone(P1) is True
    assert calls == [("POST", f"/pool/{P1}/gone")]
    with pytest.raises(ValueError):
        api.gone("../../machines")


def test_main_refuses_to_start_without_its_settings(tmp_path):  # type: ignore[no-untyped-def]
    from switch_hosted_controller import reaper_main

    assert reaper_main.main({}, sa_dir=tmp_path) == 2
    token = tmp_path / "rt"
    token.write_text("")
    env = {
        "SWITCH_REAPER_CORE_URL": "https://core.example.invalid",
        "SWITCH_REAPER_TOKEN_FILE": str(token),
    }
    assert reaper_main.main(env, sa_dir=tmp_path) == 2
