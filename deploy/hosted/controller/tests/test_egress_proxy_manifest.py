"""`k8s/50-egress-proxy.yaml` and its runbook step: squid starts with no box yet, and an empty cluster lets
nothing through.

squid treats an `include` whose glob matches no file as a fatal configuration error, so with an empty
`squid-boxes` it would never start. A fixed `_none.conf` from `squid-boxes-base`, projected beside the
per-box files, means the glob always finds a file. The three objects egress-lists may only patch or read are
created empty, if missing, by the runbook (DEPLOY.md, step 3), never by egress-lists itself."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

HOSTED = Path(__file__).resolve().parents[2]
MANIFEST = HOSTED / "k8s" / "50-egress-proxy.yaml"
DEPLOY = HOSTED / "DEPLOY.md"


# The cluster files are plain block YAML, read here as text (this package has no YAML library): each `---`
# separates one object, and its kind and name are on fixed lines.
def _docs() -> list[str]:
    return [d for d in MANIFEST.read_text().split("\n---\n") if d.strip()]


def _one(kind: str, name: str) -> str:
    (doc,) = [
        d
        for d in _docs()
        if re.search(rf"^kind: {kind}$", d, re.M)
        and re.search(rf"^  name: {re.escape(name)}$", d, re.M)
    ]
    return doc


def _block(doc: str, key: str, indent: int) -> str:
    """The literal block `key: |` at `indent` spaces, de-indented."""
    lines = doc.splitlines()
    start = lines.index(" " * indent + f"{key}: |") + 1
    body = []
    for line in lines[start:]:
        if line.strip() and not line.startswith(" " * (indent + 2)):
            break
        body.append(line[indent + 2 :])
    return "\n".join(body).rstrip("\n") + "\n"


def _squid_conf() -> str:
    return _block(_one("ConfigMap", "squid-conf"), "squid.conf", 2)


def test_the_box_files_are_a_projection_of_the_fixed_base_and_the_generated_files() -> None:
    pod = _one("Deployment", "squid")
    assert (
        "      - name: boxes\n"
        "        projected:\n"
        "          defaultMode: 420\n"
        "          sources:\n"
        "          - configMap:\n"
        "              name: squid-boxes-base\n"
        "          - configMap:\n"
        "              name: squid-boxes\n"
        "              optional: true\n"
    ) in pod
    # The only volume named boxes, mounted where squid's include looks, read-only.
    assert pod.count("name: boxes\n") == 2
    assert (
        '        - mountPath: "/etc/squid/boxes"\n          name: boxes\n          readOnly: true\n'
    ) in pod
    # Mounted whole, never with a subPath: a subPath mount is a copy taken at start that never updates, so
    # egress-lists' later patches to squid-boxes would stop reaching squid without anything failing.
    mount = pod.split('        - mountPath: "/etc/squid/boxes"\n', 1)[1].split("\n        - ", 1)[0]
    mount = mount.split("\n      - ", 1)[0]
    assert mount.splitlines() == ["          name: boxes", "          readOnly: true"]
    assert "subPath" not in pod
    # No plain configMap volume of squid-boxes is left.
    assert "          name: squid-boxes\n        name: boxes" not in pod


def test_the_base_holds_one_box_file_that_allows_nothing_and_no_box_can_be_named() -> None:
    base = _one("ConfigMap", "squid-boxes-base")
    assert re.search(r"^  namespace: egress-proxy$", base, re.M)
    assert "binaryData" not in base
    data = base.split("data:\n", 1)[1].split("\nkind:", 1)[0]
    keys = re.findall(r"^  ([^\s#][^:]*):", data, re.M)
    assert keys == ["_none.conf"]
    # Comments only: no directive at all.
    lines = [line.strip() for line in _block(base, "_none.conf", 2).splitlines()]
    assert lines and all(not line or line.startswith("#") for line in lines)
    # squid's include still picks it up, and the per-box files beside it.
    assert re.search(r"^include /etc/squid/boxes/\*\.conf$", _squid_conf(), re.M)
    # A box's files start with its id, which never starts with an underscore; the gate's is `_gate`.
    from switch_hosted_controller.egress_lists import GATE_ID, BoxEgress, box_files

    box = BoxEgress("agents-user-k1-0123456789abcdef", ("github",))
    assert "_none.conf" not in box_files(box)
    assert GATE_ID != "_none"


def test_with_no_box_file_squid_allows_nothing() -> None:
    """Every allow lives in a box's include file; after the include, everything else is denied."""
    lines = [line.split("#", 1)[0].strip() for line in _squid_conf().splitlines()]
    lines = [line for line in lines if line]
    assert not [line for line in lines if line.startswith("http_access allow")]
    include = lines.index("include /etc/squid/boxes/*.conf")
    assert lines[include + 1] == "http_access deny all"


def test_egress_lists_still_cannot_create_what_it_fills() -> None:
    role = _one("Role", "switch-egress-lists")
    rules = role.split("rules:\n", 1)[1]
    # Each rule as (its object, its resource, its verbs): get and patch on the two named objects only.
    parsed = []
    for rule in rules.split("\n- "):
        names = rule.split("resourceNames:\n", 1)[1].split("\n  resources:", 1)[0]
        resources = rule.split("resources:\n", 1)[1].split("\n  verbs:", 1)[0]
        verbs = rule.split("verbs:\n", 1)[1]
        parsed.append(
            (
                re.findall(r"- ([\w-]+)", names),
                re.findall(r"- ([\w-]+)", resources),
                re.findall(r"- ([\w-]+)", verbs),
            )
        )
    assert parsed == [
        (["squid-boxes"], ["configmaps"], ["get", "patch"]),
        (["squid-passwd"], ["secrets"], ["get", "patch"]),
    ]
    assert "create" not in rules
    assert "squid-boxes-base" not in role


def test_the_runbook_creates_the_three_objects_only_if_missing_and_empty() -> None:
    step = DEPLOY.read_text().split("### 3. Apply them", 1)[1].split("### 4.", 1)[0]
    block = step.split("```sh", 1)[1].split("```", 1)[0]
    commands = [
        " ".join(line.split()) for line in block.replace("\\\n", " ").splitlines() if line.strip()
    ]
    assert commands[0] == "kubectl apply -f <folder>/10-namespaces.yaml"
    assert commands[1:] == [
        "kubectl -n egress-proxy get configmap squid-boxes >/dev/null 2>&1"
        " || kubectl -n egress-proxy create configmap squid-boxes",
        "kubectl -n egress-proxy get secret squid-passwd >/dev/null 2>&1"
        " || kubectl -n egress-proxy create secret generic squid-passwd --from-literal=passwd=",
        "kubectl -n egress-lists get secret egress-settings >/dev/null 2>&1"
        " || kubectl -n egress-lists create secret generic egress-settings --from-literal=egress.json='{}'",
    ]
    # `create` never overwrites; nothing here applies, replaces or patches an existing object.
    assert not re.search(r"\b(apply|replace|patch)\b", " ".join(commands[1:]))
    # And it comes before the folder's own apply.
    assert step.index("```sh") < step.index("kubectl apply -f <folder>/`")


def test_an_empty_settings_secret_is_what_egress_lists_accepts() -> None:
    from switch_hosted_controller.egress_lists import parse_egress

    assert parse_egress("{}", {}, ()) == []


SQUID = os.environ.get("SQUID_BIN") or shutil.which("squid")


@pytest.mark.skipif(SQUID is None, reason="needs a squid binary (SQUID_BIN or on PATH)")
@pytest.mark.parametrize("with_base", [False, True])
def test_squid_parses_the_config_with_no_box_only_with_the_base_file(
    tmp_path: Path, with_base: bool
) -> None:
    """The slot-10 failure, reproduced: no box file is a fatal include; with `_none.conf` it parses."""
    boxes, passwd = tmp_path / "boxes", tmp_path / "passwd"
    boxes.mkdir()
    passwd.mkdir()
    (passwd / "passwd").write_text("")
    if with_base:
        (boxes / "_none.conf").write_text(
            _block(_one("ConfigMap", "squid-boxes-base"), "_none.conf", 2)
        )
    conf = (
        _squid_conf()
        .replace("/etc/squid/boxes", str(boxes))
        .replace("/etc/squid/passwd/passwd", str(passwd / "passwd"))
        .replace("__AGENTS_SUBNET__", "10.1.32.0/20")
        .replace("/var/log/squid", str(tmp_path))
        .replace("coredump_dir /tmp", f"coredump_dir {tmp_path}")
    )
    (tmp_path / "squid.conf").write_text(conf)
    parsed = subprocess.run(
        [SQUID, "-k", "parse", "-f", str(tmp_path / "squid.conf")],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if with_base:
        assert parsed.returncode == 0, parsed.stderr[-2000:]
    else:
        assert parsed.returncode != 0
        assert "Unable to find configuration file" in parsed.stderr
