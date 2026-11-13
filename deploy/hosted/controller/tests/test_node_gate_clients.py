import json
import re
from urllib.error import HTTPError
from urllib.parse import unquote

import pytest

from switch_hosted_controller.node_gate import GateNode, check_namespaces, proxy_ok
from switch_hosted_controller.node_gate_jobs import (
    CHECK_CLUSTER_ROLE,
    GATE1_TAINT,
    GateConfigError,
    check_jobs,
    gate_config_from,
    namespace_objects,
)
from switch_hosted_controller.node_gate_main import (
    GateEc2Api,
    GateKubeApi,
    gate_nodes_from_list,
    stuck_machines,
    untaint_patch,
)

DIGEST = "sha256:" + "a" * 64
RAW = {
    "python_image": f"123.dkr.ecr.eu-west-3.amazonaws.com/check-python:3.12@{DIGEST}",
    "alpine_image": f"123.dkr.ecr.eu-west-3.amazonaws.com/check-alpine@{DIGEST}",
    "server_ip": "10.0.0.10",
    "proxy_host": "squid.egress-proxy.svc",
    "proxy_namespace": "egress-proxy",
    "proxy_port": 3128,
    "responder_url": "http://gate-responder.switch-node-gate.svc:8080/",
    "gate_namespace": "switch-node-gate",
    "proxy_entries": [
        {"verdict": "ALLOW", "label": "pypi", "url": "https://pypi.org/simple/", "via_proxy": True},
        {
            "verdict": "DENY",
            "label": "example.net",
            "url": "https://example.net/",
            "via_proxy": True,
        },
    ],
}
NODE = "ip-10-0-2-86.eu-west-3.compute.internal"


def cfg(**changes):
    return gate_config_from({**RAW, **changes})


# ---- configuration ----


@pytest.mark.parametrize(
    "changes",
    [
        {"python_image": "python:3.12"},  # a tag, not a digest
        {"alpine_image": "alpine@sha256:" + "a" * 63},  # every pin is 64 characters
        {"server_ip": "10.0.0.10; rm"},
        {"proxy_port": 0},
        {"proxy_port": "3128"},
        {"proxy_namespace": "Egress_Proxy"},
        {"responder_url": "file:///etc/passwd"},
        {"max_parallel": 17},
        {"extra_l3_subnets": ["sg-123"]},
        {
            "proxy_entries": [
                {"verdict": "MAYBE", "label": "x", "url": "https://x/", "via_proxy": True}
            ]
        },
        {
            "proxy_entries": [
                {
                    "verdict": "DENY",
                    "label": "x'; import os",
                    "url": "https://x/",
                    "via_proxy": True,
                }
            ]
        },
        {
            "proxy_entries": [
                {"verdict": "DENY", "label": "x", "url": "https://x/", "via_proxy": "yes"}
            ]
        },
    ],
)
def test_a_bad_config_is_refused_whole(changes):
    with pytest.raises(GateConfigError):
        cfg(**changes)


def test_the_fixed_proxy_entries_are_always_added_and_the_expected_count_follows():
    config = cfg()
    entries = config.all_proxy_entries()
    assert len(entries) == 6 + 2
    labels = " ".join(e.label for e in entries)
    for must in (
        "server direct",
        "public direct",
        "direct the responder",
        "via proxy the responder",
        "10250",
        "metadata",
    ):
        assert must in labels
    good = "\n".join(
        f"{e.verdict} {e.label} {'reached (HTTP 200)' if e.verdict == 'ALLOW' else 'BLOCKED: t'}"
        for e in entries
    )
    assert proxy_ok(good, expected=len(entries)) is None
    assert proxy_ok(good, expected=len(entries) + 1)  # a missing line fails


# ---- what gets created ----


def test_every_job_is_pinned_locked_down_and_tolerates_only_gate_and_l3():
    config = cfg()
    ns = check_namespaces(NODE)[0]
    jobs = [j for c in ("gate1", "proxy", "runsc") for j in check_jobs(c, ns, NODE, config)]
    assert [j["metadata"]["name"] for j in jobs] == [
        "first-second-check",
        "kubelet-check",
        "imds-hop-check",
        "proxy-check",
        "runsc-check",
    ]
    for job in jobs:
        assert job["metadata"]["namespace"] == ns and job["spec"]["backoffLimit"] == 0
        pod = job["spec"]["template"]["spec"]
        assert pod["nodeName"] == NODE and pod["runtimeClassName"] == "gvisor"
        assert pod["automountServiceAccountToken"] is False
        assert {t["key"] for t in pod["tolerations"]} == {GATE1_TAINT, "switch.dev/level"}
        assert all(t["operator"] == "Equal" for t in pod["tolerations"])
        assert not any(
            k in pod for k in ("hostNetwork", "hostPID", "hostIPC", "volumes", "serviceAccountName")
        )
        (container,) = pod["containers"]
        assert re.search(r"@sha256:[0-9a-f]{64}$", container["image"])
        sc = container["securityContext"]
        assert sc["allowPrivilegeEscalation"] is False and sc["capabilities"]["drop"] == ["ALL"]
        assert pod["securityContext"]["runAsNonRoot"] is True
    assert jobs[-1]["spec"]["template"]["spec"]["containers"][0]["command"][0] == "sh"
    plan = json.loads(
        next(
            e["value"]
            for e in jobs[3]["spec"]["template"]["spec"]["containers"][0]["env"]
            if e["name"] == "PLAN"
        )
    )
    assert len(plan) == len(config.all_proxy_entries())
    with pytest.raises(ValueError):
        check_jobs("anything", ns, NODE, config)


def test_the_namespace_binds_only_the_fixed_role_and_walls_egress():
    config = cfg()
    ns = check_namespaces(NODE)[1]
    objs = {o["kind"] + "/" + o["metadata"]["name"]: o for o in namespace_objects(ns, NODE, config)}
    namespace = objs[f"Namespace/{ns}"]
    assert namespace["metadata"]["labels"]["app.kubernetes.io/managed-by"] == "switch-node-gate"
    assert namespace["metadata"]["labels"]["pod-security.kubernetes.io/enforce"] == "restricted"
    binding = objs["RoleBinding/switch-node-gate"]
    assert binding["roleRef"] == {
        "apiGroup": "rbac.authorization.k8s.io",
        "kind": "ClusterRole",
        "name": CHECK_CLUSTER_ROLE,
    }
    assert binding["subjects"] == [
        {"kind": "ServiceAccount", "name": "switch-node-gate", "namespace": "switch-node-gate"}
    ]
    egress = objs["NetworkPolicy/agent-egress"]["spec"]["egress"]
    assert egress[1]["to"] == [{"ipBlock": {"cidr": "10.0.0.10/32"}}]
    assert egress[2]["to"][0]["namespaceSelector"]["matchLabels"] == {
        "kubernetes.io/metadata.name": "egress-proxy"
    }
    assert all(o["metadata"].get("namespace", ns) == ns for o in objs.values())


# ---- the Kubernetes client ----


class FakeApi(GateKubeApi):
    def __init__(self, config, responses):
        self._config = config
        self._sleep = lambda s: None
        self.responses = responses  # list of (method, path regex, response or exception)
        self.calls = []
        self.accepts = []

    def _call(
        self, method, path, body=None, content_type="application/json", accept="application/json"
    ):
        self.calls.append((method, unquote(path), body, content_type))
        self.accepts.append(accept)
        for i, (m, pattern, response) in enumerate(self.responses):
            if m == method and re.search(pattern, unquote(path)):
                if isinstance(response, list) and response and response[0] == "seq":
                    value = response.pop(1) if len(response) > 2 else response[1]
                else:
                    value = response
                if isinstance(value, Exception):
                    raise value
                return value
        raise AssertionError(f"unexpected call {method} {path}")


def http_error(code):
    return HTTPError("u", code, "x", {}, None)


def test_nodes_are_read_by_label_with_ready_time_and_taint():
    items = [
        {
            "metadata": {"name": NODE},
            "spec": {
                "taints": [
                    {"key": "switch.dev/level", "value": "l3"},
                    {"key": GATE1_TAINT, "value": "pending"},
                ]
            },
            "status": {
                "conditions": [
                    {
                        "type": "Ready",
                        "status": "True",
                        "lastTransitionTime": "2026-10-28T10:00:00Z",
                    }
                ],
                "addresses": [
                    {"type": "Hostname", "address": "h"},
                    {"type": "InternalIP", "address": "10.0.2.86"},
                ],
            },
        }
    ]
    (node,) = gate_nodes_from_list(items)
    assert node.ready and node.tainted and node.internal_ip == "10.0.2.86"
    assert node.ready_since == 1793181600.0
    api = FakeApi(
        cfg(), [("GET", r"^/api/v1/nodes\?labelSelector=switch.dev/level=l3$", {"items": items})]
    )
    assert api.gate_nodes()[0].name == NODE


def test_untaint_removes_only_the_gate_taint_and_tests_it_first():
    node = {
        "spec": {"taints": [{"key": "switch.dev/level"}, {"key": GATE1_TAINT}, {"key": "other"}]}
    }
    assert untaint_patch(node) == [
        {"op": "test", "path": "/spec/taints/1/key", "value": GATE1_TAINT},
        {"op": "remove", "path": "/spec/taints/1"},
    ]
    assert untaint_patch({"spec": {"taints": [{"key": "switch.dev/level"}]}}) is None
    api = FakeApi(
        cfg(), [("GET", f"/api/v1/nodes/{NODE}$", node), ("PATCH", f"/api/v1/nodes/{NODE}$", {})]
    )
    api.untaint(NODE)
    method, _, body, content_type = api.calls[-1]
    assert (
        method == "PATCH"
        and content_type == "application/json-patch+json"
        and body[0]["op"] == "test"
    )
    api = FakeApi(cfg(), [("GET", f"/api/v1/nodes/{NODE}$", {"spec": {}})])
    api.untaint(NODE)  # already untainted: no patch
    assert [c[0] for c in api.calls] == ["GET"]


@pytest.mark.parametrize(
    "name",
    ["kube-system", "agents-user-b", "agents-check", "agents-check-x-zz", "agents-check-x-g1/../a"],
)
def test_the_client_refuses_any_namespace_that_is_not_a_check_one(name):
    api = FakeApi(cfg(), [])
    with pytest.raises(ValueError):
        api.delete_namespace(name)
    with pytest.raises(ValueError):
        api.namespace_exists(name)
    with pytest.raises(ValueError):
        api.run_check(GateNode(NODE, True, True, "10.0.2.86"), name, "runsc")
    assert api.calls == []


def test_delete_and_exists_treat_404_as_gone():
    ns = check_namespaces(NODE)[2]
    api = FakeApi(
        cfg(),
        [
            ("DELETE", f"/api/v1/namespaces/{ns}$", http_error(404)),
            ("GET", f"/api/v1/namespaces/{ns}$", http_error(404)),
        ],
    )
    api.delete_namespace(ns)
    assert api.namespace_exists(ns) is False
    api = FakeApi(cfg(), [("DELETE", f"/api/v1/namespaces/{ns}$", http_error(403))])
    with pytest.raises(HTTPError):
        api.delete_namespace(ns)


def test_run_check_creates_the_walls_then_the_job_and_reads_where_it_ran():
    ns = check_namespaces(NODE)[2]
    pod = {
        "metadata": {"name": "runsc-check-abc"},
        "spec": {"nodeName": NODE, "runtimeClassName": "gvisor"},
    }
    api = FakeApi(
        cfg(),
        [
            ("POST", r".", {}),
            ("GET", "/jobs/runsc-check$", ["seq", {"status": {}}, {"status": {"succeeded": 1}}]),
            ("GET", r"/pods\?labelSelector=job-name=runsc-check$", {"items": [pod]}),
            ("GET", r"/pods/runsc-check-abc/log\?limitBytes=65536$", "Linux 4.19.0-gvisor\n"),
        ],
    )
    (run,) = api.run_check(GateNode(NODE, True, True, "10.0.2.86"), ns, "runsc")
    assert run.ran_on == NODE and run.runtime == "gvisor" and run.completed and "gvisor" in run.logs
    posts = [(c[1], c[2]["kind"]) for c in api.calls if c[0] == "POST"]
    assert [k for _, k in posts] == [
        "Namespace",
        "RoleBinding",
        "ResourceQuota",
        "NetworkPolicy",
        "NetworkPolicy",
        "Job",
    ]
    assert all(path == "/api/v1/namespaces" or f"/namespaces/{ns}/" in path for path, _ in posts)


def test_a_failed_job_is_read_as_not_completed():
    ns = check_namespaces(NODE)[2]
    api = FakeApi(
        cfg(),
        [
            ("POST", r".", {}),
            ("GET", r"/jobs/runsc-check$", {"status": {"failed": 1}}),
            ("GET", r"/pods\?labelSelector=", {"items": []}),
        ],
    )
    (run,) = api.run_check(GateNode(NODE, True, True, "10.0.2.86"), ns, "runsc")
    assert run.completed is False and run.ran_on == ""


def test_pods_on_lists_by_node_name_only_and_keeps_namespace_and_owner_kind():
    listed = {
        "items": [
            {
                "metadata": {
                    "namespace": "kube-system",
                    "ownerReferences": [{"kind": "DaemonSet"}],
                },
                "spec": {"secret": "no"},
            },
            {"metadata": {"namespace": "agents-x"}},
        ]
    }
    api = FakeApi(
        cfg(),
        [("GET", r"^/api/v1/pods\?fieldSelector=spec.nodeName=" + re.escape(NODE) + ",", listed)],
    )
    assert api.pods_on(NODE) == [("kube-system", "DaemonSet"), ("agents-x", "")]
    assert api.accepts == [
        "application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1"
    ]  # metadata only


# ---- EC2 and the alert ----


class FakeEc2Client:
    def __init__(self, count=1):
        self.calls = []
        self.count = count

    def describe_instances(self, **kw):
        self.calls.append(("describe_instances", kw))
        inst = {
            "MetadataOptions": {"HttpTokens": "required", "HttpPutResponseHopLimit": 1},
            "SubnetId": "subnet-0abc",
            "Tags": [{"Key": "switch:level", "Value": "l3"}],
        }
        return {"Reservations": [{"Instances": [inst]} for _ in range(self.count)]}

    def describe_subnets(self, **kw):
        self.calls.append(("describe_subnets", kw))
        return {"Subnets": [{"SubnetId": "subnet-0abc"}]}


def test_ec2_reads_the_instance_and_l3_subnets_with_two_read_calls_only():
    client = FakeEc2Client()
    ec2 = GateEc2Api(client, ("subnet-0def",))
    inst = ec2.instance_by_ip("10.0.2.86")
    assert (inst.http_tokens, inst.hop_limit, inst.public_ip, inst.subnet_id, inst.level_tag) == (
        "required",
        1,
        None,
        "subnet-0abc",
        "l3",
    )
    assert ec2.l3_subnets() == {"subnet-0abc", "subnet-0def"}
    assert {c[0] for c in client.calls} == {"describe_instances", "describe_subnets"}
    filters = client.calls[0][1]["Filters"]
    assert {"Name": "instance-state-name", "Values": ["running"]} in filters


@pytest.mark.parametrize("count", [0, 2])
def test_no_instance_or_more_than_one_reads_as_none_which_fails_the_machine(count):
    assert GateEc2Api(FakeEc2Client(count)).instance_by_ip("10.0.2.86") is None


def test_the_failure_marker_is_a_labelled_check_namespace_with_the_result():
    ns = check_namespaces(NODE)[0]
    api = FakeApi(cfg(), [("POST", r"^/api/v1/namespaces$", {})])
    api.mark_failed(GateNode(NODE, True, True, "10.0.2.86"), ns)
    ((method, path, body, _),) = api.calls
    assert body["kind"] == "Namespace" and body["metadata"]["name"] == ns
    assert body["metadata"]["labels"]["app.kubernetes.io/managed-by"] == "switch-node-gate"
    assert body["metadata"]["annotations"]["switch.dev/check-node"] == NODE
    assert body["metadata"]["annotations"]["switch.dev/gate-result"].startswith("failed")
    with pytest.raises(ValueError):
        api.mark_failed(GateNode(NODE, True, True, "10.0.2.86"), "agents-user-x")


def test_only_ready_machines_tainted_for_over_ten_minutes_are_stuck():
    now = 10_000.0
    nodes = [
        GateNode("old", True, True, "", now - 601),
        GateNode("new", True, True, "", now - 30),
        GateNode("done", True, False, "", now - 9000),
        GateNode("notready", False, True, "", now - 9000),
        GateNode("unknown", True, True, "", None),
    ]
    assert stuck_machines(nodes, now) == ["old"]


def test_the_gates_proxy_login_goes_only_to_the_proxy_job_and_that_job_expires_quickly():
    from dataclasses import replace

    config = cfg()
    ns = check_namespaces(NODE)[1]
    (plain,) = check_jobs("proxy", ns, NODE, config)
    assert not any(
        e["name"] == "PROXY_URL" for e in plain["spec"]["template"]["spec"]["containers"][0]["env"]
    )
    assert plain["spec"]["ttlSecondsAfterFinished"] == 600
    login = "http://gate-check:" + "a" * 43 + "@squid.egress-proxy.svc:3128"
    (job,) = check_jobs("proxy", ns, NODE, replace(config, proxy_login=login))
    env = {
        e["name"]: e.get("value") for e in job["spec"]["template"]["spec"]["containers"][0]["env"]
    }
    assert env["PROXY_URL"] == login and job["spec"]["ttlSecondsAfterFinished"] == 60
    for other in ("gate1", "runsc"):
        for j in check_jobs(other, ns, NODE, replace(config, proxy_login=login)):
            assert login not in json.dumps(j)  # never in any other check
    assert login not in repr(replace(config, proxy_login=login))  # never printed with the config


def test_the_gates_login_file_must_hold_a_gate_login_url():
    from switch_hosted_controller.node_gate_main import PROXY_LOGIN_RE

    assert PROXY_LOGIN_RE.fullmatch(
        "http://gate-check:" + "a" * 43 + "@squid.egress-proxy.svc:3128"
    )
    for bad in (
        "http://box-ada:" + "a" * 43 + "@s:3128",
        "http://gate-check:short@s:3128",
        "gate-check",
    ):
        assert not PROXY_LOGIN_RE.fullmatch(bad)


def test_check_namespaces_carry_their_own_label_for_squid_never_the_users():
    """squid admits check namespaces by `switch.dev/check` (the NetworkPolicy), so the proxy check's ALLOW
    lines can be reached; a check namespace never carries `switch.dev/user`, so nothing takes it for a box."""
    for ns in check_namespaces(NODE):
        (namespace,) = [o for o in namespace_objects(ns, NODE, cfg()) if o["kind"] == "Namespace"]
        labels = namespace["metadata"]["labels"]
        assert labels["switch.dev/check"] == ns.removeprefix("agents-")
        assert re.fullmatch(r"[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?", labels["switch.dev/check"])
        assert "switch.dev/user" not in labels
