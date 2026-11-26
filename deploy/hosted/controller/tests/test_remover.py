"""The remover (`remover.py`): deletes a retired box's namespace only when the cluster and Core both back it."""

from __future__ import annotations

import base64
import io
import json
import logging
import re
from pathlib import Path
from typing import Any
from urllib.error import HTTPError

import pytest

from switch_hosted_controller.remover import remove_once

M1 = "11111111-1111-4111-8111-111111111111"
M2 = "22222222-2222-4222-8222-222222222222"
NS1 = "agents-box-k1-00000000000000a1"
NS2 = "agents-user-k1-00000000000000b2"
K8S = Path(__file__).resolve().parents[2] / "k8s"


def _ns(machine: str, terminating: bool = False) -> dict[str, Any]:
    meta: dict[str, Any] = {"annotations": {"switch.dev/machine-id": machine}}
    if terminating:
        meta["deletionTimestamp"] = "2026-11-25T00:00:00Z"
    return {"metadata": meta, "status": {"phase": "Terminating" if terminating else "Active"}}


class Core:
    def __init__(self, removable: bool | Exception = True, listed_error: Exception | None = None):
        self._removable, self._listed_error = removable, listed_error
        self.asked: list[tuple[str, str]] = []
        self.reports: list[list[dict[str, str]]] = []

    def removable(self, machine_id: str, namespace: str) -> bool:
        self.asked.append((machine_id, namespace))
        if isinstance(self._removable, Exception):
            raise self._removable
        return self._removable

    def listed(self, entries: list[dict[str, str]]) -> None:
        self.reports.append(entries)
        if self._listed_error:
            raise self._listed_error


class Kube:
    def __init__(self, removals: Any, namespaces: dict[str, dict[str, Any]]):
        self._removals, self.namespaces = removals, namespaces
        self.deleted: list[str] = []

    def removals(self) -> dict[str, str]:
        if isinstance(self._removals, Exception):
            raise self._removals
        return self._removals

    def get_namespace(self, name: str) -> dict[str, Any] | None:
        return self.namespaces.get(name)

    def delete_namespace(self, name: str) -> None:
        self.deleted.append(name)


def test_a_listed_box_backed_by_the_cluster_and_core_is_deleted():
    kube, core = Kube({NS1: M1}, {NS1: _ns(M1)}), Core()
    assert remove_once(core, kube)["deleted"] == 1
    assert kube.deleted == [NS1] and core.asked == [(M1, NS1)]
    assert core.reports == [[{"namespace": NS1, "machine_id": M1}]]


def test_a_namespace_of_another_machine_is_never_deleted_and_core_is_not_asked(caplog):
    kube, core = Kube({NS1: M1}, {NS1: _ns(M2)}), Core()
    with caplog.at_level(logging.ERROR):
        counts = remove_once(core, kube)
    assert counts["refused"] == 1 and kube.deleted == [] and core.asked == []
    assert "belongs to another machine" in caplog.text


def test_core_not_backing_a_removal_means_no_delete(caplog):
    kube, core = Kube({NS1: M1}, {NS1: _ns(M1)}), Core(removable=False)
    with caplog.at_level(logging.ERROR):
        assert remove_once(core, kube)["refused"] == 1
    assert kube.deleted == [] and "does not back" in caplog.text


def test_a_box_already_gone_or_going_is_left_alone_without_asking_core():
    kube = Kube({NS1: M1, NS2: M2}, {NS2: _ns(M2, terminating=True)})
    core = Core()
    counts = remove_once(core, kube)
    assert counts["gone"] == 1 and counts["waiting"] == 1
    assert kube.deleted == [] and core.asked == []


@pytest.mark.parametrize(
    "entry", [{"kube-system": M1}, {NS1: "not-a-machine"}, {"agents-box-k1-zz": M1}]
)
def test_an_entry_out_of_form_is_never_deleted(entry, caplog):
    kube, core = Kube(entry, {name: _ns(M1) for name in entry}), Core()
    with caplog.at_level(logging.ERROR):
        assert remove_once(core, kube)["refused"] == 1
    assert kube.deleted == [] and core.asked == []


def test_a_list_that_cant_be_read_deletes_nothing():
    kube, core = Kube(OSError(), {NS1: _ns(M1)}), Core()
    with pytest.raises(OSError):
        remove_once(core, kube)
    assert kube.deleted == [] and core.asked == []


def test_a_failed_report_or_one_failing_box_doesnt_stop_the_others():
    class FlakyCore(Core):
        def removable(self, machine_id: str, namespace: str) -> bool:
            if namespace == NS1:
                raise TimeoutError()
            return super().removable(machine_id, namespace)

    kube = Kube({NS1: M1, NS2: M2}, {NS1: _ns(M1), NS2: _ns(M2)})
    counts = remove_once(FlakyCore(listed_error=HTTPError("u", 500, "x", None, None)), kube)  # type: ignore[arg-type]
    assert counts["failed"] == 1 and counts["deleted"] == 1 and kube.deleted == [NS2]


# ---- the clients ----


def test_the_core_client_asks_by_machine_and_namespace_and_reports_the_list(tmp_path):
    from switch_hosted_controller import remover_main

    token = tmp_path / "token"
    token.write_text("r" * 40)
    api = remover_main.RemoverCoreApi("https://core.example.invalid", token)
    calls: list[tuple[str, str, Any]] = []
    api._call = lambda method, path, body=None: (
        calls.append((method, path, body)),
        {"removable": True},
    )[1]  # type: ignore[method-assign]
    assert api.removable(M1, NS1) is True
    api.listed([{"namespace": NS1, "machine_id": M1}])
    assert calls[0][:2] == ("GET", f"/removals/{M1}?namespace={NS1}")
    assert calls[1] == (
        "POST",
        "/removals/listed",
        {"entries": [{"namespace": NS1, "machine_id": M1}]},
    )
    with pytest.raises(ValueError):
        api.removable(M1, "kube-system")


def test_the_kube_client_touches_only_box_namespaces_and_reads_the_list_by_name():
    from switch_hosted_controller import remover_main

    api = object.__new__(remover_main.RemoverKubeApi)
    calls: list[tuple[str, str]] = []
    answers: list[Any] = [
        {"data": {NS1: base64.b64encode(M1.encode()).decode()}},
        HTTPError("u", 404, "x", None, io.BytesIO(b"{}")),  # type: ignore[arg-type]
    ]

    def call(method: str, path: str) -> Any:
        calls.append((method, path))
        answer = answers.pop(0) if answers else {}
        if isinstance(answer, Exception):
            raise answer
        return answer

    api._call = call  # type: ignore[method-assign]
    assert dict(api.removals()) == {NS1: M1}
    assert dict(api.removals()) == {}  # not made yet
    api.delete_namespace(NS1)
    assert calls == [
        ("GET", "/api/v1/namespaces/switch-hosted/secrets/box-removals"),
        ("GET", "/api/v1/namespaces/switch-hosted/secrets/box-removals"),
        ("DELETE", f"/api/v1/namespaces/{NS1}"),
    ]
    for bad in ("kube-system", "switch-hosted", "agents-user-ada"):
        with pytest.raises(ValueError):
            api.delete_namespace(bad)


# ---- its account and the cluster's rule ----


def _docs(text: str) -> list[str]:
    return [d for d in ("\n" + text).split("\n---\n") if "\nkind: " in "\n" + d]


def _doc(text: str, kind: str, name: str) -> str:
    (found,) = [
        d
        for d in _docs(text)
        if f"\nkind: {kind}\n" in "\n" + d + "\n" and f"\n  name: {name}\n" in d + "\n"
    ]
    return found


def test_the_remover_has_its_own_account_and_only_its_rights():
    text = (K8S / "46-switch-hosted-remover.yaml").read_text()
    dep = _doc(text, "Deployment", "switch-hosted-remover")
    assert "serviceAccountName: switch-hosted-remover" in dep
    assert "secretName: switch-hosted-remover-core" in dep and "reaper" not in text.lower()
    role = _doc(text, "Role", "switch-hosted-remover-removals")
    assert role.rstrip().endswith(
        "rules:\n- apiGroups:\n  - ''\n  resourceNames:\n  - box-removals\n  resources:\n  - secrets\n  verbs:\n  - get"
    )
    cluster_role = _doc(text, "ClusterRole", "switch-hosted-remover")
    assert cluster_role.rstrip().endswith(
        "rules:\n- apiGroups:\n  - ''\n  resources:\n  - namespaces\n  verbs:\n  - get\n  - delete"
    )


def test_the_cluster_lets_the_remover_delete_only_a_listed_box_namespace():
    policies = (K8S / "30-admission-policies.yaml").read_text()
    p = _doc(policies, "ValidatingAdmissionPolicy", "switch-remover-deletes-listed-boxes")
    b = _doc(policies, "ValidatingAdmissionPolicyBinding", "switch-remover-deletes-listed-boxes")
    assert "system:serviceaccount:switch-hosted:switch-hosted-remover" in p
    assert "failurePolicy: Fail" in p
    # The params policy matches namespace deletions alone, so a missing `box-removals` can't refuse every write in
    # the cluster (params are looked up before the match condition); the rest of the remover's writes are refused by
    # a policy that takes no params.
    assert "operations:\n      - DELETE\n      resources:\n      - namespaces" in p
    assert "request.?name.orValue('') in params.?data.orValue({})" in p
    other = _doc(policies, "ValidatingAdmissionPolicy", "switch-remover-does-nothing-else")
    other_binding = _doc(
        policies, "ValidatingAdmissionPolicyBinding", "switch-remover-does-nothing-else"
    )
    assert "system:serviceaccount:switch-hosted:switch-hosted-remover" in other
    assert "failurePolicy: Fail" in other and "request.operation == 'DELETE'" in other
    assert "request.resource.resource == 'namespaces'" in other
    assert "paramKind" not in other and "paramRef" not in other_binding
    (box_re,) = re.findall(r"\.matches\('([^']*)'\)", p)

    def allows(name: str, listed: dict[str, str]) -> bool:
        return re.fullmatch(box_re, name) is not None and name in listed

    listed = {NS1: M1}
    assert allows(NS1, listed)
    assert not allows(NS2, listed)  # a box, but not listed
    assert not allows("kube-system", {"kube-system": M1})  # listed, but not a box
    assert (
        "name: box-removals\n    namespace: switch-hosted\n    parameterNotFoundAction: Deny" in b
    )
    assert json.dumps(b).count("Deny") == 2


@pytest.mark.parametrize("status", [403, 500])
def test_the_kube_client_raises_on_a_removals_read_it_cant_trust(status):
    """Only a list not made yet (404) reads as empty. Any other error raises, so the pass fails loudly (logged as a
    failed pass) and nothing is deleted, rather than quietly working from an empty list."""
    from switch_hosted_controller import remover_main

    api = object.__new__(remover_main.RemoverKubeApi)

    def call(method: str, path: str) -> Any:
        raise HTTPError("u", status, "x", None, io.BytesIO(b"{}"))  # type: ignore[arg-type]

    api._call = call  # type: ignore[method-assign]
    with pytest.raises(HTTPError):
        api.removals()
