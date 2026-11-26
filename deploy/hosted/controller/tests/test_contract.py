"""The cluster contract (`deploy/hosted/contract/`): written from the services' own clients, the same on every run,
committed up to date, and placeholders only, since it is public."""

import json
import re
from pathlib import Path

import pytest

from switch_hosted_controller import contract

HOSTED = Path(__file__).resolve().parents[2]
FOLDER = HOSTED / "contract"
SRC = Path(contract.__file__).parent


@pytest.fixture(scope="module")
def files() -> dict[str, bytes]:
    return contract.rendered()


def test_the_committed_contract_is_a_fresh_run(files):
    problems = contract.differences(FOLDER)
    assert problems == [], (
        "deploy/hosted/contract is out of date; write it again:\n"
        "  uv run python -m switch_hosted_controller.contract --out ../contract\n"
        + "\n".join(problems)
    )


def test_a_run_is_the_same_every_time(files):
    assert contract.rendered() == files


def test_the_index_names_every_file_with_its_hash(files):
    index = json.loads(files["index.json"])
    assert index["format"] == contract.FORMAT
    assert {f["path"] for f in index["files"]} == set(files) - {"index.json"}
    assert index["tiers"] == ["base", "plus", "max"]


def test_the_contract_is_placeholders_only(files):
    assert contract.placeholder_problems(files) == []


@pytest.mark.parametrize(
    ("planted", "why"),
    [
        ('{"account": "123456789012"}', "12-digit"),
        ('{"host": "https://ip-10-0-1-2.eu-west-3.compute.internal"}', "internal"),
        ('{"host": "https://box.tail1234.ts.net"}', "tailnet"),
        ('{"cidr": "10.0.32.0/20"}', "outside the documentation ranges"),
        ('{"user": "k1-3f9a0c27b81e44d5"}', "made-up"),
        ('{"key": "-----BEGIN PRIVATE KEY-----"}', "private key"),
        ('{"image": "123.dkr.ecr.example.com/box@sha256:00"}', "host name"),
        ('{"url": "https://core.prod.example.com/api"}', "host name"),
    ],
)
def test_the_placeholders_check_catches_a_slip(planted, why):
    problems = contract.placeholder_problems({"x.json": planted.encode()})
    assert any(why in p for p in problems), problems


def test_every_box_tier_has_its_good_requests(files):
    good = {
        name: json.loads(data) for name, data in files.items() if name.startswith("admission/good/")
    }
    for tier in contract.TIERS:
        made = {
            (d["request"]["method"], d["resource"])
            for d in good.values()
            if d["what"] == f"provisioner: a {tier} box, box-keyed"
        }
        assert ("POST", "statefulsets") in made and ("POST", "namespaces") in made, tier
        assert ("PUT", "secrets") in made  # its box-map entry
    whats = {d["what"] for d in good.values()}
    for expected in (
        "provisioner: a base box, person-keyed",
        "provisioner: a warm pool box",
        "provisioner: the pool box bound to its person",
        "provisioner: a box named for removal, listed",
        "remover: a listed box's namespace deleted",
        "reaper: an unclaimed pool box's namespace deleted",
        "scaler: a box started",
        "scaler: a box stopped",
    ):
        assert expected in whats
    assert all(d["expect"] == "allow" for d in good.values())


def test_every_recorded_call_is_a_services(files):
    """No call is recorded outside a service's account, where no grant could cover it."""
    calls = json.loads(files["rbac.json"])["calls"]
    assert "" not in calls
    assert all(account.startswith("system:serviceaccount:") for account in calls)


# Every list the policies keep add-only: each has a sample that removes an entry, and one that changes one.
ADD_ONLY_LISTS = {"box-map", "pool-map", "box-owners", "box-removals"}


def test_each_entry_removed_sample_drops_an_entry_the_list_already_held(files):
    """An add-only list written back without an entry it had before: the body lacks a key the setup's copy of the
    list holds, and it isn't merely the good write without its own new entry."""
    removed = {
        n: json.loads(d)
        for n, d in files.items()
        if n.startswith("admission/bad/") and "entry-removed" in n
    }
    assert {s["name"] for s in removed.values()} == ADD_ONLY_LISTS
    for name, sample in removed.items():
        path = sample["request"]["path"]
        (old,) = [o["object"] for o in sample["setup"] if o["path"] == path]
        dropped = set(old["data"]) - set(sample["request"]["body"]["data"])
        assert dropped, name


def test_each_value_changed_sample_rewrites_an_entry_the_list_already_held(files):
    """An add-only list written back with an entry it had before now holding another value."""
    changed = {
        n: json.loads(d)
        for n, d in files.items()
        if n.startswith("admission/bad/") and "entry-value-changed" in n
    }
    assert {s["name"] for s in changed.values()} == ADD_ONLY_LISTS
    for name, sample in changed.items():
        path = sample["request"]["path"]
        (old,) = [o["object"] for o in sample["setup"] if o["path"] == path]
        new = sample["request"]["body"]["data"]
        assert any(key in new and new[key] != value for key, value in old["data"].items()), name


def test_each_good_request_is_one_its_account_made(files):
    rbac = json.loads(files["rbac.json"])["calls"]
    for name, data in files.items():
        if not name.startswith("admission/good/"):
            continue
        d = json.loads(data)
        verb = contract._VERB[d["request"]["method"]]
        target = contract.parse_path(d["request"]["path"])
        call = contract._general(
            (verb, target.group, target.resource, target.subresource, target.namespace, target.name)
        )
        listed = {
            tuple(c[k] for k in ("verb", "group", "resource", "subresource", "namespace", "name"))
            for c in rbac[d["as"]]
        }
        assert call in listed, name


def test_a_box_requests_setup_holds_its_namespace_and_the_lists(files):
    d = json.loads(
        files["admission/good/provisioner-a-base-box-box-keyed-post-statefulset-box.json"]
    )
    paths = [s["path"] for s in d["setup"]]
    assert paths[0].startswith("/api/v1/namespaces/")
    assert f"/api/v1/namespaces/{d['namespace']}" in paths
    for name in ("box-map", "pool-map", "box-owners", "box-removals"):
        assert f"/api/v1/namespaces/switch-hosted/secrets/{name}" in paths
    assert all("resourceVersion" not in s["object"]["metadata"] for s in d["setup"])


def test_the_alert_lines_are_still_logged():
    assert contract.log_lines_problems(SRC) == []


def test_each_alert_lines_service_is_a_pods_datadog_service_tag():
    """A monitor filters on the pod's Datadog service tag, so each line names one a pod really carries."""
    tags = set()
    for path in (HOSTED / "k8s").glob("*.yaml"):
        tags |= set(re.findall(r"tags\.datadoghq\.com/service: ([a-z0-9-]+)", path.read_text()))
    # The node gate isn't deployed yet (its manifest is only proposed): its pod takes the tag when it is.
    services = {line["service"] for line in contract.LOG_LINES} - {"switch-node-gate"}
    assert services <= tags, services - tags


def test_the_tiers_are_the_operators_and_the_policys():
    """The tiers here, the operator's configuration and admission policy P4 agree. (Until the manifests move to
    the deployment repository, which then checks its own configuration against `tiers.json`.)"""
    config = (HOSTED / "k8s" / "40-switch-hosted.yaml").read_text()
    raw = json.loads(
        re.search(r"  config\.json: \|\n(.*?)\n(?=\S|  \S)", config, re.S).group(1)  # type: ignore[union-attr]
    )
    for tier, size in contract.TIERS.items():
        assert raw["sizes"][tier] == size
    policies = (HOSTED / "k8s" / "30-admission-policies.yaml").read_text()
    for size in contract.TIERS.values():
        assert (
            f"[{{'cpu': '{size['cpu_request']}', 'memory': '{size['memory_request']}'}}, "
            f"{{'cpu': '{size['cpu_limit']}', 'memory': '{size['memory_limit']}'}}]" in policies
        )


def test_the_fills_cover_the_manifests_tokens():
    """Every token in the files a deployment applies (as `fill-placeholders.py` reads them)."""
    applied = [
        *(HOSTED / "k8s").glob("*.yaml"),
        HOSTED / "box" / "priorityclass-switch-box.yaml",
        HOSTED / "egress" / "egress-proxy-networkpolicy.yaml",
    ]
    tokens = set()
    for path in applied:
        tokens |= set(re.findall(r"__[A-Z0-9_]+__", path.read_text()))
    assert tokens <= set(contract.fills()), sorted(tokens - set(contract.fills()))


def test_check_mode_reports_a_stale_folder(tmp_path):
    contract.write(tmp_path)
    assert contract.main(["--check", str(tmp_path)]) == 0
    (tmp_path / "tiers.json").write_text("{}\n")
    (tmp_path / "extra.json").write_text("{}\n")
    assert contract.differences(tmp_path) == ["changed: tiers.json", "extra: extra.json"]
    assert contract.main(["--check", str(tmp_path)]) == 1


def test_an_alert_line_left_out_of_the_catalogue_is_caught(monkeypatch):
    monkeypatch.setattr(
        contract,
        "LOG_LINES",
        [line for line in contract.LOG_LINES if line["words"] != "Reaper ALERT"],
    )
    assert any("Reaper ALERT" in p for p in contract.log_lines_problems(SRC))


# Policy rules no service request here can reach, and why.
NOT_REACHED: dict[str, str] = {}


def _policy_messages() -> dict[str, list[str]]:
    text = (HOSTED / "k8s" / "30-admission-policies.yaml").read_text()
    out: dict[str, list[str]] = {}
    for doc in text.split("\n---\n"):
        if "\nkind: ValidatingAdmissionPolicy\n" not in "\n" + doc + "\n":
            continue
        name = re.search(r"\nmetadata:\n  name: (\S+)", "\n" + doc).group(1)  # type: ignore[union-attr]
        out[name] = [
            m.strip().strip("'\"").replace("''", "'")
            for m in re.findall(r"\n\s+message: ([^\n]+)", doc)
        ]
    return out


def test_every_policy_rule_has_a_bad_sample(files):
    """One bad sample per validation of every policy: admission refuses it by that rule's message, or RBAC
    refuses it first (marked so)."""
    bad = [json.loads(d) for n, d in files.items() if n.startswith("admission/bad/")]
    messages = _policy_messages()
    for sample in bad:
        assert sample["expect"] == "refuse"
        assert (sample["refused_by"] == "rbac") == (not sample["policies"])
        for policy in sample["policies"]:
            assert policy in messages, policy
        if sample["policies"]:
            assert any(m.startswith(sample["message"]) for m in messages[sample["policies"][0]]), (
                sample["what"]
            )
    covered = {(s["policies"][0], s["message"]) for s in bad if s["policies"]}
    for policy, rules in messages.items():
        if policy in NOT_REACHED:
            continue
        for rule in rules:
            reached = any(p == policy and rule.startswith(m) for p, m in covered)
            by_rbac = any(
                s["refused_by"] == "rbac" and s["from_good"] for s in bad
            )  # a verb or name the account isn't granted: RBAC refuses before the rule
            assert reached or (by_rbac and _rbac_only(policy, rule)), (policy, rule)


def _rbac_only(policy: str, rule: str) -> bool:
    """The rules about a verb or object the account has no grant for: their bad samples stop at RBAC."""
    return rule.startswith(
        (
            "the provisioner may only create namespaces",
            "the provisioner only creates; it never updates or deletes",
            "the provisioner may only update the box map",
            "the provisioner may only update the pool-map",
            "the provisioner may only update the box-owners",
            "the reaper may only delete namespaces",
            "the remover may only delete namespaces",
            "the provisioner may only create the RoleBinding",
            "the operator may not change a node's status",
            "the operator may only create placeholder pods",
        )
    )


def test_each_bad_sample_has_its_own_name():
    """Two bad samples of one name would write one file, and the earlier would silently go."""
    slugs = [bad.slug for bad in contract.BAD]
    assert len(slugs) == len(set(slugs)), sorted({s for s in slugs if slugs.count(s) > 1})
