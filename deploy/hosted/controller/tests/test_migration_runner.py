"""`switch-hosted-migration-runner copy`: every check before anything is made, the copy's objects and Job, the
report, and the box's namespace put back exactly as it was, whatever happens."""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path

import pytest

from switch_hosted_controller import migration_runner as mr
from switch_hosted_controller.migration_runner import (
    BOX_CLAIM,
    BOX_EGRESS,
    DEFAULT_DENY,
    JOB,
    MANIFEST_CONFIGMAP,
    PSS_ENFORCE,
    SNAPSHOT,
    SOURCE_CLAIM,
    CopyRunner,
    Refused,
    check_inputs,
    content_name,
    copy_job,
    load_manifest,
    load_record,
)

MACHINE = "11111111-2222-4333-8444-555555555555"
OTHER_MACHINE = "99999999-2222-4333-8444-555555555555"
PERSON = "k1-0123456789abcdef"
NS = f"agents-user-{PERSON}"
SNAP = "snap-0123456789abcdef0"
V1_DISK = "vol-0aaaaaaaaaaaaaaa1"
RESTORED = "vol-0bbbbbbbbbbbbbbb2"
INSTALLATION = "test-install"
IMAGE = "registry.example.com/switch/copier@sha256:" + "a" * 64
ZONE = "zone-a"


def record(**changes) -> dict:
    base = {
        "machine_id": MACHINE,
        "owner_keyed_id": PERSON,
        "step": "held",
        "v1_instance_id": "i-0123456789abcdef0",
        "v1_data_volume_id": V1_DISK,
        "snapshot_id": SNAP,
        "done_at": None,
    }
    return {**base, **changes}


def manifest(**changes) -> dict:
    base = {
        "machine_id": MACHINE,
        "person": PERSON,
        "namespace": NS,
        "snapshot_id": SNAP,
        "workspaces": [
            {"tenant_id": "t-1", "seat_key": "s-1", "v1_controller_id": "c-1", "agents": []},
            {"tenant_id": "t-2", "seat_key": "s-2", "v1_controller_id": "c-2", "agents": []},
        ],
    }
    return {**base, **changes}


def good_report(**changes) -> dict:
    base = {
        "machine_id": MACHINE,
        "workspaces": ["t-1", "t-2"],
        "files": 12,
        "bytes": 3456,
        "symlinks_skipped": 1,
        "refused": 0,
        "checksum_mismatches": 0,
        "source_volume_id": None,
        "seconds": 7,
    }
    return {**base, **changes}


class FakeEc2:
    def __init__(self) -> None:
        self.snapshot = {
            "SnapshotId": SNAP,
            "State": "completed",
            "Encrypted": True,
            "VolumeId": V1_DISK,
            "VolumeSize": 200,
            "Tags": [
                {"Key": "switch:installation-id", "Value": INSTALLATION},
                {"Key": "switch:machine-id", "Value": MACHINE},
                {"Key": "switch:owner-keyed-id", "Value": PERSON},
                {"Key": "switch:source-volume-id", "Value": V1_DISK},
                {"Key": "switch:purpose", "Value": "migration-copy"},
            ],
        }
        self.shared: list[dict] = []

    def describe_snapshots(self, **kwargs):
        assert kwargs == {"SnapshotIds": [SNAP], "OwnerIds": ["self"]}
        return {"Snapshots": [self.snapshot]}

    def describe_snapshot_attribute(self, **kwargs):
        return {"CreateVolumePermissions": self.shared}


EGRESS = {
    "apiVersion": "networking.k8s.io/v1",
    "kind": "NetworkPolicy",
    "metadata": {"name": BOX_EGRESS, "namespace": NS},
    "spec": {"podSelector": {}, "policyTypes": ["Egress"], "egress": [{"ports": [{"port": 443}]}]},
}


class FakeKube:
    """The parts of a box cluster the runner touches, with the controllers' answers: a snapshot import becomes
    ready, a Job runs to its end, a claim binds to a volume."""

    def __init__(self) -> None:
        self.objects: dict[tuple[str, str | None, str], dict] = {}
        self.log: list[tuple[str, ...]] = []
        self.report: dict | None = good_report()
        self.exit_code = 0
        self.message: str | None = None
        self.reader_exit = 0
        self.reader_note: str = json.dumps(
            {"read": "done", "skipped_agents": [], "skipped_total": 0}
        )
        self.egress_during_job: bool | None = None
        self.pss_during_job: str | None = None
        self.fail_create: str | None = None
        self.put(
            "namespace",
            None,
            NS,
            {
                "metadata": {
                    "name": NS,
                    "labels": {PSS_ENFORCE: "restricted"},
                    "annotations": {"switch.dev/machine-id": MACHINE},
                }
            },
        )
        self.put("statefulset", NS, "box", {"spec": {"replicas": 0}, "status": {"replicas": 0}})
        self.put(
            "persistentvolumeclaim",
            NS,
            BOX_CLAIM,
            {
                "spec": {"storageClassName": "box-disk", "volumeName": "pv-box"},
                "status": {"phase": "Bound"},
            },
        )
        self.put("persistentvolume", None, "pv-box", self.pv("vol-0ccccccccccccccc3"))
        self.put(
            "storageclass",
            None,
            "box-disk",
            {
                "parameters": {
                    "type": "gp3",
                    "encrypted": "true",
                    "kmsKeyId": "cluster-key-placeholder",
                }
            },
        )
        self.put("networkpolicy", NS, BOX_EGRESS, copy.deepcopy(EGRESS))
        self.put("networkpolicy", NS, DEFAULT_DENY, {"spec": {"podSelector": {}}})

    @staticmethod
    def pv(handle: str) -> dict:
        return {
            "spec": {
                "csi": {"volumeHandle": handle},
                "nodeAffinity": {
                    "required": {
                        "nodeSelectorTerms": [
                            {
                                "matchExpressions": [
                                    {
                                        "key": "topology.kubernetes.io/zone",
                                        "operator": "In",
                                        "values": [ZONE],
                                    }
                                ]
                            }
                        ]
                    }
                },
            }
        }

    def put(self, kind: str, ns: str | None, name: str, obj: dict) -> None:
        self.objects[(kind, ns, name)] = obj

    def get(self, kind, name, namespace):
        self.log.append(("get", kind, name or ""))
        obj = self.objects.get((kind, namespace, name))
        return copy.deepcopy(obj) if obj is not None else None

    def list(self, kind, namespace, selector):
        key, _, value = selector.partition("=")
        return [
            copy.deepcopy(o)
            for (k, ns, _), o in self.objects.items()
            if k == kind
            and ns == namespace
            and (o.get("metadata", {}).get("labels") or {}).get(key) == value
        ]

    def create(self, obj):
        kind = obj["kind"].lower()
        meta = obj["metadata"]
        self.log.append(("create", kind, meta["name"]))
        if self.fail_create == kind:
            raise Refused(
                "kubectl_failed", f"kubectl create {obj['kind']} failed: refused by policy"
            )
        ns = meta.get("namespace")
        stored = copy.deepcopy(obj)
        self.put(kind, ns, meta["name"], stored)
        if kind == "volumesnapshot":
            stored["status"] = {"readyToUse": True}
        if kind == "job":
            ns_labels = self.objects[("namespace", None, NS)]["metadata"]["labels"]
            self.pss_during_job = ns_labels.get(PSS_ENFORCE)
            self.egress_during_job = ("networkpolicy", NS, BOX_EGRESS) in self.objects
            self.objects[("persistentvolumeclaim", NS, SOURCE_CLAIM)]["spec"]["volumeName"] = (
                "pv-restored"
            )
            self.put("persistentvolume", None, "pv-restored", self.pv(RESTORED))
            message = self.message if self.message is not None else json.dumps(self.report)
            self.put(
                "pod",
                NS,
                "migration-copy-abcde",
                {
                    "metadata": {"name": "migration-copy-abcde", "labels": dict(mr.JOB_LABEL)},
                    "status": {
                        "containerStatuses": [
                            {
                                "name": "read",
                                "state": {
                                    "terminated": {
                                        "exitCode": self.reader_exit,
                                        "message": self.reader_note,
                                    }
                                },
                            },
                            {
                                "name": "write",
                                "state": {
                                    "terminated": {"exitCode": self.exit_code, "message": message}
                                },
                            },
                        ]
                    },
                },
            )
            ok = self.exit_code == 0 and self.reader_exit == 0
            stored["status"] = {"succeeded": 1} if ok else {"failed": 1}

    def delete(self, kind, name, namespace):
        self.log.append(("delete", kind, name))
        self.objects.pop((kind, namespace, name), None)
        if kind == "persistentvolumeclaim" and name == SOURCE_CLAIM:
            self.objects.pop(("persistentvolume", None, "pv-restored"), None)

    def label(self, kind, name, key, value):
        self.log.append(("label", kind, f"{key}={value}"))
        self.objects[(kind, None, name)]["metadata"]["labels"][key] = value


class Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.t += seconds


@pytest.fixture
def kube() -> FakeKube:
    return FakeKube()


@pytest.fixture
def ec2() -> FakeEc2:
    return FakeEc2()


def run(kube, ec2, tmp_path: Path, rec=None, man=None):
    said: list[str] = []
    runner = CopyRunner(kube, ec2, Clock(), said.append)
    report = runner.run(
        load_record(json.dumps(rec or record())),
        load_manifest(json.dumps(man or manifest())),
        installation_id=INSTALLATION,
        image=IMAGE,
        saved_egress=tmp_path / "egress.json",
    )
    return report, said


def assert_box_as_before(kube: FakeKube, tmp_path: Path) -> None:
    """The namespace is a box's again: egress exactly as it was, restricted, and nothing of the copy left."""
    assert kube.objects[("networkpolicy", NS, BOX_EGRESS)]["spec"] == EGRESS["spec"]
    assert kube.objects[("namespace", None, NS)]["metadata"]["labels"][PSS_ENFORCE] == "restricted"
    own = {
        ("job", NS, JOB),
        ("persistentvolumeclaim", NS, SOURCE_CLAIM),
        ("volumesnapshot", NS, SNAPSHOT),
        ("volumesnapshotcontent", None, content_name(MACHINE)),
        ("configmap", NS, MANIFEST_CONFIGMAP),
        ("persistentvolume", None, "pv-restored"),
    }
    assert not own & set(kube.objects)
    assert not [k for k in kube.objects if k[0] == "pod"]
    assert not (tmp_path / "egress.json").exists()


# ── the happy path ───────────────────────────────────────────────────────


def test_a_copy_reports_the_restored_volume_and_leaves_the_box_as_it_was(kube, ec2, tmp_path):
    report, said = run(kube, ec2, tmp_path)
    assert report == good_report(source_volume_id=RESTORED)
    assert list(report) == list(mr.REPORT_KEYS)
    # While the Job ran: no egress rule, baseline.
    assert kube.egress_during_job is False
    assert kube.pss_during_job == "baseline"
    assert_box_as_before(kube, tmp_path)
    assert not any(SNAP in line or "t-1" in line for line in said)


def test_baseline_brackets_the_egress_change_both_ways(kube, ec2, tmp_path):
    """The cluster reads `baseline` as "a copy is on": it's set before the egress rule goes, and only taken off
    once the rule is back."""
    run(kube, ec2, tmp_path)
    steps = [
        e
        for e in kube.log
        if e[0] in ("label", "delete", "create") and e[1] in ("namespace", "networkpolicy")
    ]
    assert steps == [
        ("label", "namespace", f"{PSS_ENFORCE}=baseline"),
        ("delete", "networkpolicy", BOX_EGRESS),
        ("create", "networkpolicy", BOX_EGRESS),
        ("label", "namespace", f"{PSS_ENFORCE}=restricted"),
    ]


def test_the_snapshot_import_keeps_the_snapshot_and_points_only_into_the_box(kube, ec2, tmp_path):
    made: dict[str, dict] = {}
    create = kube.create

    def keep(obj):
        made[obj["kind"]] = copy.deepcopy(obj)
        create(obj)

    kube.create = keep
    run(kube, ec2, tmp_path)
    content = made["VolumeSnapshotContent"]
    assert content["spec"]["deletionPolicy"] == "Retain"
    assert content["spec"]["source"] == {"snapshotHandle": SNAP}
    assert content["spec"]["volumeSnapshotRef"] == {"name": SNAPSHOT, "namespace": NS}
    claim = made["PersistentVolumeClaim"]
    assert claim["metadata"]["namespace"] == NS
    assert claim["spec"]["dataSource"]["name"] == SNAPSHOT
    assert claim["spec"]["resources"]["requests"]["storage"] == "200Gi"
    assert made["ConfigMap"]["data"]["manifest.json"] == json.dumps(manifest())


def test_the_job_is_exactly_the_sandboxed_shape():
    box = mr.Box(zone=ZONE, storage_class="box-disk")
    job = copy_job(load_manifest(json.dumps(manifest())), box, IMAGE, "held")
    spec = job["spec"]
    pod = spec["template"]["spec"]
    read, write = pod["containers"]
    assert (read["name"], write["name"]) == ("read", "write")
    assert spec["backoffLimit"] == 0
    assert pod["automountServiceAccountToken"] is False
    assert pod["runtimeClassName"] == "gvisor"
    assert pod["securityContext"] == {"seccompProfile": {"type": "RuntimeDefault"}}
    assert pod["nodeSelector"]["topology.kubernetes.io/zone"] == ZONE
    assert "hostNetwork" not in pod and "hostPID" not in pod and "hostIPC" not in pod
    for container in (read, write):
        assert container["image"] == IMAGE
        sc = container["securityContext"]
        assert sc["allowPrivilegeEscalation"] is False and sc["readOnlyRootFilesystem"] is True
        assert container["resources"]["limits"]
    # The reader: root with DAC_OVERRIDE only, and nothing writable but the pipe's folder.
    assert read["securityContext"]["runAsUser"] == 0
    assert read["securityContext"]["capabilities"] == {"drop": ["ALL"], "add": ["DAC_OVERRIDE"]}
    reads = {m["name"]: m.get("readOnly", False) for m in read["volumeMounts"]}
    assert reads == {"source": True, "manifest": True, "stream": False}
    # The writer: the agents user, no capability, the box claim and the pipe.
    assert write["securityContext"]["runAsUser"] == 2000
    assert write["securityContext"]["runAsNonRoot"] is True
    assert write["securityContext"]["capabilities"] == {"drop": ["ALL"]}
    writes = {m["name"]: m.get("readOnly", False) for m in write["volumeMounts"]}
    assert writes == {"target": False, "manifest": True, "stream": False}
    volumes = {v["name"]: v for v in pod["volumes"]}
    assert volumes["source"]["persistentVolumeClaim"] == {
        "claimName": SOURCE_CLAIM,
        "readOnly": True,
    }
    assert volumes["target"]["persistentVolumeClaim"] == {"claimName": BOX_CLAIM}
    assert volumes["stream"]["emptyDir"] == {"medium": "Memory", "sizeLimit": "1Mi"}
    assert set(volumes) == {"source", "target", "manifest", "stream"}
    assert write["args"][-2:] == ["--step", "held"]


def test_an_image_not_pinned_by_digest_is_refused():
    box = mr.Box(zone=ZONE, storage_class="box-disk")
    with pytest.raises(Refused) as refused:
        copy_job(
            load_manifest(json.dumps(manifest())), box, "registry.example.com/copier:latest", "held"
        )
    assert refused.value.code == "bad_image"


# ── refused before anything is made ──────────────────────────────────────


def made_nothing(kube: FakeKube) -> bool:
    return not [entry for entry in kube.log if entry[0] in ("create", "delete", "label")]


@pytest.mark.parametrize(
    ("changes", "code"),
    [
        ({"step": "released"}, "not_held"),
        ({"step": "frozen"}, "not_held"),
        ({"snapshot_id": "not-a-snapshot"}, "bad_record"),
        ({"extra": 1}, "bad_record"),
    ],
)
def test_a_record_not_at_the_copy_step_is_refused(changes, code):
    with pytest.raises(Refused) as refused:
        load_record(json.dumps(record(**changes)))
    assert refused.value.code == code


@pytest.mark.parametrize(
    ("changes", "code"),
    [
        ({"namespace": "agents-user-k1-ffffffffffffffff"}, "bad_manifest"),
        ({"namespace": "kube-system"}, "bad_manifest"),
        ({"workspaces": []}, "bad_manifest"),
        ({"workspaces": [{"tenant_id": "t-1"}, {"tenant_id": "t-1"}]}, "bad_manifest"),
        ({"snapshot_id": None}, "bad_manifest"),
    ],
)
def test_a_manifest_that_doesnt_hold_together_is_refused(changes, code):
    with pytest.raises(Refused) as refused:
        load_manifest(json.dumps(manifest(**changes)))
    assert refused.value.code == code


@pytest.mark.parametrize(
    ("rec", "man", "code"),
    [
        (record(machine_id=OTHER_MACHINE), manifest(), "target_mismatch"),
        (record(owner_keyed_id="k1-ffffffffffffffff"), manifest(), "target_mismatch"),
        (record(snapshot_id="snap-0ffffffffffffffff"), manifest(), "snapshot_mismatch"),
    ],
)
def test_a_manifest_for_another_move_is_refused(rec, man, code):
    with pytest.raises(Refused) as refused:
        check_inputs(load_record(json.dumps(rec)), load_manifest(json.dumps(man)))
    assert refused.value.code == code


@pytest.mark.parametrize(
    ("change", "code"),
    [
        (lambda s: s.update(State="pending"), "snapshot_not_ready"),
        (lambda s: s.update(Encrypted=False), "snapshot_unencrypted"),
        (lambda s: s.update(VolumeId="vol-0fffffffffffffff9"), "snapshot_mismatch"),
        (lambda s: s["Tags"].pop(0), "snapshot_untagged"),
        (lambda s: s["Tags"].pop(4), "snapshot_untagged"),
        (lambda s: s["Tags"][1].update(Value=OTHER_MACHINE), "snapshot_mismatch"),
        (lambda s: s["Tags"][0].update(Value="other-install"), "snapshot_mismatch"),
        (lambda s: s["Tags"][4].update(Value="backup"), "snapshot_mismatch"),
    ],
)
def test_a_snapshot_that_isnt_this_moves_copy_is_never_restored(kube, ec2, tmp_path, change, code):
    change(ec2.snapshot)
    with pytest.raises(Refused) as refused:
        run(kube, ec2, tmp_path)
    assert refused.value.code == code
    assert made_nothing(kube)


def test_a_shared_snapshot_is_never_restored(kube, ec2, tmp_path):
    ec2.shared = [{"Group": "all"}]
    with pytest.raises(Refused) as refused:
        run(kube, ec2, tmp_path)
    assert refused.value.code == "snapshot_shared"
    assert made_nothing(kube)


@pytest.mark.parametrize(
    ("break_box", "code"),
    [
        (lambda k: k.objects.pop(("namespace", None, NS)), "box_missing"),
        (
            lambda k: k.objects[("namespace", None, NS)]["metadata"]["annotations"].update(
                {"switch.dev/machine-id": OTHER_MACHINE}
            ),
            "target_mismatch",
        ),
        (lambda k: k.objects[("statefulset", NS, "box")]["spec"].update(replicas=1), "not_held"),
        (lambda k: k.objects[("statefulset", NS, "box")]["status"].update(replicas=1), "not_held"),
        (
            lambda k: k.put(
                "pod", NS, "box-0", {"metadata": {"name": "box-0", "labels": {"app": "switch-box"}}}
            ),
            "not_held",
        ),
        (
            lambda k: k.objects[("persistentvolumeclaim", NS, BOX_CLAIM)]["status"].update(
                phase="Pending"
            ),
            "box_missing",
        ),
        (lambda k: k.objects.pop(("networkpolicy", NS, DEFAULT_DENY)), "box_missing"),
        (
            lambda k: k.objects[("storageclass", None, "box-disk")]["parameters"].pop("kmsKeyId"),
            "box_missing",
        ),
        (
            lambda k: k.objects[("storageclass", None, "box-disk")]["parameters"].update(
                encrypted="false"
            ),
            "box_missing",
        ),
        (lambda k: k.objects.pop(("networkpolicy", NS, BOX_EGRESS)), "box_missing"),
    ],
)
def test_a_box_that_isnt_this_machines_held_box_is_refused(kube, ec2, tmp_path, break_box, code):
    break_box(kube)
    with pytest.raises(Refused) as refused:
        run(kube, ec2, tmp_path)
    assert refused.value.code == code
    assert not [entry for entry in kube.log if entry[0] in ("create", "label")]


# ── a copy that fails, or a report that can't be trusted ─────────────────


@pytest.mark.parametrize(
    ("setup", "code"),
    [
        (
            lambda k: (
                setattr(k, "exit_code", 3) or setattr(k, "message", '{"refused": "full_target"}')
            ),
            "copy_failed",
        ),
        (
            lambda k: setattr(k, "exit_code", 3) or setattr(k, "message", "Traceback /source/x"),
            "copy_failed",
        ),
        (lambda k: setattr(k, "report", good_report(machine_id=OTHER_MACHINE)), "target_mismatch"),
        (lambda k: setattr(k, "report", good_report(workspaces=["t-1"])), "target_mismatch"),
        (lambda k: setattr(k, "report", good_report(source_volume_id=V1_DISK)), "bad_report"),
        (lambda k: setattr(k, "report", {**good_report(), "file_names": ["a"]}), "bad_report"),
        (lambda k: setattr(k, "message", "not json"), "bad_report"),
        (
            lambda k: (
                setattr(k, "reader_exit", 4)
                or setattr(k, "reader_note", '{"refused": "seat_mismatch"}')
            ),
            "copy_failed",
        ),
        (
            lambda k: setattr(
                k,
                "reader_note",
                '{"read": "done", "skipped_agents": ["a/../b"], "skipped_total": 1}',
            ),
            "bad_report",
        ),
        (
            lambda k: setattr(
                k,
                "reader_note",
                '{"read": "done", "skipped_agents": [], "skipped_total": 0, "files": ["/x"]}',
            ),
            "bad_report",
        ),
        (lambda k: setattr(k, "reader_note", "not json"), "bad_report"),
        (lambda k: setattr(k, "reader_note", '{"read": "done"}'), "bad_report"),
        (
            lambda k: setattr(
                k,
                "reader_note",
                '{"read": "done", "skipped_agents": ["a", "b"], "skipped_total": 1}',
            ),
            "bad_report",
        ),
    ],
)
def test_a_failed_copy_or_an_untrustworthy_report_still_puts_the_box_back(
    kube, ec2, tmp_path, setup, code
):
    setup(kube)
    with pytest.raises(Refused) as refused:
        run(kube, ec2, tmp_path)
    assert refused.value.code == code
    assert "/source" not in str(refused.value)
    assert_box_as_before(kube, tmp_path)


def test_a_failure_part_way_still_puts_the_box_back(kube, ec2, tmp_path):
    kube.fail_create = "job"
    with pytest.raises(Refused) as refused:
        run(kube, ec2, tmp_path)
    assert refused.value.code == "kubectl_failed"
    assert_box_as_before(kube, tmp_path)


def test_a_run_that_stopped_part_way_is_put_right_first(kube, ec2, tmp_path):
    # As a run killed after setting the egress aside and lowering the level left it.
    (tmp_path / "egress.json").write_text(json.dumps(EGRESS))
    kube.objects.pop(("networkpolicy", NS, BOX_EGRESS))
    kube.objects[("namespace", None, NS)]["metadata"]["labels"][PSS_ENFORCE] = "baseline"
    kube.put("job", NS, JOB, {"metadata": {"name": JOB}})
    report, said = run(kube, ec2, tmp_path)
    assert report["source_volume_id"] == RESTORED
    assert said[0] == "The box's egress rule is back as it was."
    assert_box_as_before(kube, tmp_path)


def test_a_saved_egress_rule_for_another_namespace_is_refused(kube, ec2, tmp_path):
    (tmp_path / "egress.json").write_text(
        json.dumps(
            {
                **EGRESS,
                "metadata": {"name": BOX_EGRESS, "namespace": "agents-user-k1-ffffffffffffffff"},
            }
        )
    )
    with pytest.raises(Refused) as refused:
        run(kube, ec2, tmp_path)
    assert refused.value.code == "bad_saved_egress"


def test_an_egress_rule_that_doesnt_come_back_as_it_was_is_said_loudly(kube, ec2, tmp_path):
    create = kube.create

    def tamper(obj):
        if obj["kind"] == "NetworkPolicy":
            obj = {**obj, "spec": {"podSelector": {}, "policyTypes": ["Egress"], "egress": [{}]}}
        create(obj)

    kube.create = tamper
    with pytest.raises(Refused) as refused:
        run(kube, ec2, tmp_path)
    assert refused.value.code == "restore_failed"
    # Kept, so a later run (or a person) can still put the exact rule back.
    assert (tmp_path / "egress.json").exists()


def test_agents_with_no_slot_are_said_to_the_operator_never_put_in_the_report(kube, ec2, tmp_path):
    kube.reader_note = json.dumps(
        {"read": "done", "skipped_agents": ["agent-7", "agent-9"], "skipped_total": 5}
    )
    report, said = run(kube, ec2, tmp_path)
    assert any("5 agent(s)" in line and "agent-7, agent-9 (and 3 more)" in line for line in said)
    assert "agent-7" not in json.dumps(report)


def test_a_failed_reader_is_named_by_its_side_and_code_only(kube, ec2, tmp_path):
    kube.reader_exit = 4
    kube.reader_note = '{"refused": "seat_mismatch"}'
    with pytest.raises(Refused) as refused:
        run(kube, ec2, tmp_path)
    assert str(refused.value) == "The copy failed on its read side (seat_mismatch)."


# ── verify, before release ───────────────────────────────────────────────


def egress_hash() -> str:
    return mr.egress_sha256(EGRESS)


def test_verify_passes_once_the_box_is_back(kube, ec2, tmp_path):
    for key in mr.PSS_LABELS:
        kube.objects[("namespace", None, NS)]["metadata"]["labels"][key] = "restricted"
    run(kube, ec2, tmp_path)
    mr.verify(kube, load_manifest(json.dumps(manifest())), egress_hash())


@pytest.mark.parametrize(
    "unrestore",
    [
        lambda k: k.objects[("namespace", None, NS)]["metadata"]["labels"].update(
            {PSS_ENFORCE: "baseline"}
        ),
        lambda k: k.objects[("namespace", None, NS)]["metadata"]["labels"].update(
            {"pod-security.kubernetes.io/warn": "baseline"}
        ),
        lambda k: k.objects[("namespace", None, NS)]["metadata"]["labels"].update(
            {"pod-security.kubernetes.io/audit": "privileged"}
        ),
        lambda k: k.objects[("namespace", None, NS)]["metadata"]["labels"].pop(
            "pod-security.kubernetes.io/warn"
        ),
        lambda k: k.objects.pop(("networkpolicy", NS, BOX_EGRESS)),
        lambda k: k.objects[("networkpolicy", NS, BOX_EGRESS)]["spec"].update({"egress": [{}]}),
        lambda k: k.put("job", NS, JOB, {"metadata": {"name": JOB}}),
        lambda k: k.put("volumesnapshotcontent", None, content_name(MACHINE), {}),
        lambda k: k.objects[("statefulset", NS, "box")]["spec"].update(replicas=1),
    ],
)
def test_verify_refuses_until_both_changes_are_undone_and_nothing_is_left(kube, unrestore):
    for key in mr.PSS_LABELS:
        kube.objects[("namespace", None, NS)]["metadata"]["labels"][key] = "restricted"
    mr.verify(kube, load_manifest(json.dumps(manifest())), egress_hash())
    unrestore(kube)
    with pytest.raises(Refused):
        mr.verify(kube, load_manifest(json.dumps(manifest())), egress_hash())


def test_the_copy_prints_the_fingerprint_verify_checks(kube, ec2, tmp_path):
    runner = CopyRunner(kube, ec2, Clock(), lambda line: None)
    runner.run(
        load_record(json.dumps(record())),
        load_manifest(json.dumps(manifest())),
        installation_id=INSTALLATION,
        image=IMAGE,
        saved_egress=tmp_path / "egress.json",
    )
    assert runner.egress_sha256 == egress_hash()


# ── the API client ───────────────────────────────────────────────────────


class Recorder:
    def __init__(self, answers: dict | None = None, fail: int | None = None) -> None:
        self.calls: list[tuple] = []
        self.answers = answers or {}
        self.fail = fail

    def __call__(self, method, path, body=None, content_type=None):
        self.calls.append((method, path, body, content_type))
        if self.fail is not None:
            raise mr.ApiError(self.fail, "denied by policy p-m6")
        return self.answers.get((method, path.split("?")[0]))


def test_the_client_sends_plain_creates_deletes_and_one_label_patch():
    rec = Recorder()
    kube = mr.KubeHttp(rec)
    kube.create({"kind": "Job", "metadata": {"name": JOB, "namespace": NS}})
    kube.create({"kind": "VolumeSnapshotContent", "metadata": {"name": content_name(MACHINE)}})
    kube.delete("networkpolicy", BOX_EGRESS, NS)
    kube.label("namespace", NS, PSS_ENFORCE, "baseline")
    assert [(m, p) for m, p, _b, _c in rec.calls] == [
        ("POST", f"/apis/batch/v1/namespaces/{NS}/jobs?fieldManager=switch-migration-runner"),
        (
            "POST",
            "/apis/snapshot.storage.k8s.io/v1/volumesnapshotcontents?fieldManager=switch-migration-runner",
        ),
        ("DELETE", f"/apis/networking.k8s.io/v1/namespaces/{NS}/networkpolicies/{BOX_EGRESS}"),
        ("PATCH", f"/api/v1/namespaces/{NS}?fieldManager=switch-migration-runner"),
    ]
    assert rec.calls[2][2]["propagationPolicy"] == "Background"
    assert rec.calls[3][2:] == (
        {"metadata": {"labels": {PSS_ENFORCE: "baseline"}}},
        "application/merge-patch+json",
    )


def test_a_missing_object_is_none_and_a_missing_delete_is_nothing():
    kube = mr.KubeHttp(Recorder(fail=404))
    assert kube.get("job", JOB, NS) is None
    kube.delete("job", JOB, NS)


def test_an_api_refusal_is_a_refusal_with_the_apis_reason():
    with pytest.raises(Refused) as refused:
        mr.KubeHttp(Recorder(fail=403)).create(
            {"kind": "Job", "metadata": {"name": JOB, "namespace": NS}}
        )
    assert refused.value.code == "api_refused"
    assert "403" in str(refused.value) and "p-m6" in str(refused.value)


def test_a_list_keeps_only_what_its_selector_names():
    path = f"/api/v1/namespaces/{NS}/pods"
    rec = Recorder(
        {
            ("GET", path): {
                "items": [
                    {"metadata": {"name": "box-0", "labels": {"app": "switch-box"}}},
                    {"metadata": {"name": "copy", "labels": dict(mr.JOB_LABEL)}},
                ]
            }
        }
    )
    found = mr.KubeHttp(rec).list("pod", NS, "app=switch-box")
    assert [p["metadata"]["name"] for p in found] == ["box-0"]
    assert rec.calls[0][1] == f"{path}?labelSelector=app%3Dswitch-box"


def test_paths_are_built_from_the_table_and_checked_names_only():
    with pytest.raises(Refused):
        mr.resource_path("job", NS, "../../secrets/x")
    with pytest.raises(ValueError):
        mr.resource_path("namespace", NS, "x")


def test_a_context_that_isnt_a_plain_name_is_refused():
    with pytest.raises(Refused):
        mr.KubectlProxy("ctx; rm -rf /")


def _proxy_accepts(path: str) -> bool:
    # As kubectl reads the flag: a comma-separated list of patterns.
    return any(re.fullmatch(p, path) for p in mr.PROXY_ACCEPT_PATHS.split(","))


def test_the_proxy_patterns_hold_no_comma_of_their_own():
    assert len(mr.PROXY_ACCEPT_PATHS.split(",")) == len(mr._RESOURCES)


def test_the_proxy_forwards_every_path_the_runner_builds_and_nothing_else():
    for kind, (_prefix, _plural, namespaced) in mr._RESOURCES.items():
        ns = NS if namespaced else None
        if kind != "namespace":  # namespaces are only ever read by name, never listed
            assert _proxy_accepts(mr.resource_path(kind, ns)), kind
        assert _proxy_accepts(mr.resource_path(kind, ns, "some-name")), kind
    assert not _proxy_accepts("/api/v1/namespaces")
    for path in (
        f"/api/v1/namespaces/{NS}/secrets/switch-proxy-login",
        f"/api/v1/namespaces/{NS}/pods/box-0/exec",
        f"/api/v1/namespaces/{NS}/pods/box-0/attach",
        f"/api/v1/namespaces/{NS}/pods/box-0/portforward",
        f"/api/v1/namespaces/{NS}/pods/box-0/log",
        "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings",
        "/api/v1/nodes/n1",
        f"/api/v1/namespaces/{NS}/serviceaccounts/box/token",
        "/api/v1/namespaces/a/b/c",
    ):
        assert not _proxy_accepts(path), path


# ── the command ──────────────────────────────────────────────────────────


def test_the_command_refuses_two_inputs_on_standard_input(capsys):
    code = mr.main(
        [
            "copy",
            "--record",
            "-",
            "--manifest",
            "-",
            "--report",
            "r.json",
            "--context",
            "ctx",
            "--installation-id",
            INSTALLATION,
            "--image",
            IMAGE,
            "--region",
            "us-east-1",
        ]
    )
    assert code == 2
    assert json.loads(capsys.readouterr().err.splitlines()[0])["refused"] == "bad_input"
