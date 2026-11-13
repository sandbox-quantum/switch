"""The placer's admission policy must cover every StatefulSet and pod field the cluster knows.

Kubernetes CEL can't loop over a typed object's fields, so the policy lists them. This walks the cluster's own field
lists (tests/fixtures/k8s-fields.json, from its OpenAPI schema) and fails on any field that is neither compared with
the old object, required absent, nor on the short allowed list below. After a Kubernetes upgrade, refresh the fixture
from the cluster: a new field then fails here until the policy covers it.
"""

import json
import re
from pathlib import Path

import pytest

HERE = Path(__file__).parent
FIELDS = json.loads((HERE / "fixtures" / "k8s-fields.json").read_text())
MANIFEST = (HERE.parents[1] / "placer" / "placer-guard.PROPOSED.yaml").read_text()


def expressions(manifest: str) -> str:
    """Only the policy's CEL expressions: the `validations` block of the policy document, less comment and
    message lines, so wording in a comment or a message can never count as a check."""
    policy = next(
        doc for doc in manifest.split("\n---\n") if "kind: ValidatingAdmissionPolicy\n" in doc
    )
    block = policy.split("\n  validations:\n", 1)[1]
    kept = [line for line in block.splitlines() if not line.lstrip().startswith(("#", "message:"))]
    return "\n".join(kept)


POLICY = expressions(MANIFEST)

# What the placer may change, or the server manages. Everything else must be compared or absent.
ALLOWED = {
    "metadata": {
        "creationTimestamp",
        "deletionGracePeriodSeconds",
        "deletionTimestamp",
        "generation",
        "managedFields",
        "resourceVersion",
        "selfLink",
        "uid",  # set by the API server
        "name",
        "namespace",  # can't change on update; and checked: box in agents-user-*
    },
    "spec": {"replicas", "template"},  # replicas: the scaler's job; template: walked below
    "spec.template": {"spec"},  # walked below
    "spec.template.spec": {"affinity"},  # walked below
    "spec.template.spec.affinity": {"nodeAffinity"},  # walked below
    "spec.template.spec.affinity.nodeAffinity": {
        "preferredDuringSchedulingIgnoredDuringExecution"
    },  # the placer's
}
MUST_BE_ABSENT = {"spec.template.spec": {"nodeName", "hostNetwork", "hostPID", "hostIPC"}}

WALK = [
    ("metadata", "ObjectMeta"),
    ("spec", "StatefulSetSpec"),
    ("spec.template", "PodTemplateSpec"),
    ("spec.template.spec", "PodSpec"),
    ("spec.template.spec.affinity", "Affinity"),
    ("spec.template.spec.affinity.nodeAffinity", "NodeAffinity"),
]


def compared(path: str) -> bool:
    return f"object.{path} == oldObject.{path}" in POLICY


def absent(path: str) -> bool:
    return re.search(rf"!has\(object\.{re.escape(path)}\)(?! \|\|)", POLICY) is not None


def cases():
    for prefix, kind in WALK:
        for field in FIELDS[kind]:
            yield prefix, field


@pytest.mark.parametrize(("prefix", "field"), list(cases()), ids=lambda v: v)
def test_every_field_is_compared_absent_or_allowed(prefix, field):
    path = f"{prefix}.{field}"
    if field in ALLOWED.get(prefix, set()):
        assert not compared(path), f"{path} is allowed, so it must not be pinned"
        return
    if field in MUST_BE_ABSENT.get(prefix, set()):
        assert absent(path), f"{path} must be required absent in the policy"
        return
    assert compared(path), f"{path} is neither compared, absent nor allowed: add it to the policy"


def test_the_fields_security_named_are_covered():
    for path in [
        "spec.persistentVolumeClaimRetentionPolicy",  # whenScaled: Delete would delete the user's disk
        "spec.podManagementPolicy",
        "metadata.ownerReferences",
        "metadata.finalizers",
        "spec.template.spec.schedulerName",
        "spec.template.spec.hostAliases",
        "spec.template.spec.imagePullSecrets",
        "spec.template.spec.dnsPolicy",
        "spec.template.spec.dnsConfig",
        "spec.template.spec.hostUsers",
        "spec.template.spec.topologySpreadConstraints",
        "spec.template.spec.overhead",
        "spec.template.spec.terminationGracePeriodSeconds",
        "spec.template.spec.readinessGates",
        "spec.template.spec.resourceClaims",
        "spec.template.spec.os",
        "spec.template.spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution",
    ]:
        assert compared(path), path
    assert absent("spec.template.spec.nodeName")  # it would skip the scheduler and its taints


def test_the_fixture_is_the_clusters_and_covers_the_kinds_walked():
    assert FIELDS["source"].startswith("cluster OpenAPI v3, v1.")
    for _, kind in WALK:
        assert FIELDS[kind], kind
    assert "persistentVolumeClaimRetentionPolicy" in FIELDS["StatefulSetSpec"]
    assert "nodeName" in FIELDS["PodSpec"]


def test_a_missing_field_would_fail_this_test():
    # The check itself: a field the policy doesn't mention is reported.
    assert not compared("spec.template.spec.aFieldFromTheFuture")
    assert not absent("spec.template.spec.aFieldFromTheFuture")


def test_wording_in_a_comment_or_message_does_not_count():
    fake = MANIFEST.replace(
        "  validations:\n",
        "  validations:\n    # object.spec.template.spec.zzz == oldObject.spec.template.spec.zzz\n"
        '    - expression: "true"\n      message: "!has(object.spec.template.spec.yyy)"\n',
        1,
    )
    policy = expressions(fake)
    assert "spec.zzz" not in policy and "spec.yyy" not in policy
