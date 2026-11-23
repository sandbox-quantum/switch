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
    assert re.search(r"^include /run/squid-live/boxes\.conf$", _squid_conf(), re.M)
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
    include = lines.index("include /run/squid-live/boxes.conf")
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
    """The slot-10 failure, reproduced: no box file is a fatal include; with `_none.conf` (which the wrapper
    always puts in the live file, alone when no box is allowed) it parses."""
    boxes, passwd = tmp_path / "boxes.conf", tmp_path / "passwd"
    passwd.mkdir()
    (passwd / "passwd").write_text("")
    if with_base:
        boxes.write_text(_block(_one("ConfigMap", "squid-boxes-base"), "_none.conf", 2))
    conf = (
        _squid_conf()
        .replace("/run/squid-live/boxes.conf", str(boxes))
        .replace("/run/squid-live/passwd", str(passwd / "passwd"))
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


# ---- the reload wrapper: logins at once, box files only after a clean parse ----

import time  # noqa: E402

FAKE_SQUID = """#!/bin/sh
# A stand-in for squid: `-k parse -f conf` fails if an included file is missing or holds BAD;
# `-N -f conf` runs until TERM and notes each HUP.
if [ "$1" = "-k" ]; then
  for pattern in $(sed -n 's/^include //p' "$4"); do
    for f in $pattern; do [ -f "$f" ] || exit 1; ! grep -q BAD "$f" || exit 1; done
  done
  exit 0
fi
trap 'echo hup >> "$FAKE_SQUID_LOG"' HUP
trap 'exit 0' TERM
while :; do sleep 0.05; done
"""
HASH_ADA = "ada:$apr1$HASH-CANARY-ada"
HASH_BOB = "bob:$apr1$HASH-CANARY-bob"


def _run_sh() -> str:
    return _block(_one("ConfigMap", "squid-reload"), "run.sh", 2)


# With SQUID_TEST_IMAGE set (CI), the wrapper runs inside squid's own image, so it is tested on that image's
# shell and tools (`mv`, `sed`, `find`, ...), not only on the test machine's.
IMAGE = os.environ.get("SQUID_TEST_IMAGE", "")
TIMEOUT_S = 30.0 if IMAGE else 5.0


class Wrapper:
    """run.sh as the pod runs it, on folders under tmp_path, with the fake squid and a 0.1 s check."""

    def __init__(
        self, tmp_path: Path, boxes: dict[str, str], passwd: str | None, warn_every: int = 60
    ):
        self.src_boxes, self.src_passwd, self.live = (
            tmp_path / "boxes",
            tmp_path / "passwd",
            tmp_path / "live",
        )
        self.src_boxes.mkdir()
        self.src_passwd.mkdir()
        (self.src_boxes / "_none.conf").write_text("# No box yet: nothing is allowed.\n")
        self.set_boxes(boxes)
        if passwd is not None:
            self.set_passwd(passwd)
        squid = tmp_path / "squid"
        squid.write_text(FAKE_SQUID)
        squid.chmod(0o755)
        conf = tmp_path / "squid.conf"
        conf.write_text(_squid_conf().replace("/run/squid-live", str(self.live)))
        script = tmp_path / "run.sh"
        script.write_text(_run_sh())
        self.hups = tmp_path / "hups"
        self.out = tmp_path / "out"
        env = {
            "SQUID_CONF": str(conf),
            "SQUID_SRC_BOXES": str(self.src_boxes),
            "SQUID_SRC_PASSWD": str(self.src_passwd),
            "SQUID_LIVE": str(self.live),
            "SQUID_BIN": str(squid),
            "SQUID_POLL_S": "0.1",
            "SQUID_WARN_EVERY_S": str(warn_every),
            "FAKE_SQUID_LOG": str(self.hups),
        }
        self.name = f"squid-wrapper-test-{os.getpid()}-{tmp_path.parent.name}-{tmp_path.name}"
        if IMAGE:
            command = ["docker", "run", "--rm", "--name", self.name, "--network", "none"]
            command += ["--user", f"{os.getuid()}:{os.getgid()}", "-v", f"{tmp_path}:{tmp_path}"]
            for key, value in env.items():
                command += ["-e", f"{key}={value}"]
            command += ["--entrypoint", "sh", IMAGE, str(script)]
            env = dict(os.environ)
        else:
            command = ["sh", str(script)]
            env["PATH"] = os.environ.get("PATH", "/usr/bin:/bin")
        self.proc = subprocess.Popen(
            command, env=env, stdout=self.out.open("w"), stderr=subprocess.STDOUT
        )
        self.until(lambda: "squid started" in self.output())

    def set_boxes(self, boxes: dict[str, str]) -> None:
        """New files first, each written whole and renamed in, then the old ones removed, so the
        wrapper never sees a half-written file or a moment with neither."""
        for name, text in boxes.items():
            staged = self.src_boxes.parent / f".{name}.tmp"
            staged.write_text(text)
            os.replace(staged, self.src_boxes / name)
        for old in self.src_boxes.iterdir():
            if old.name != "_none.conf" and old.name not in boxes:
                old.unlink()

    def set_passwd(self, text: str) -> None:
        staged = self.src_passwd.parent / ".passwd.tmp"
        staged.write_text(text)
        os.replace(staged, self.src_passwd / "passwd")

    def output(self) -> str:
        return self.out.read_text()

    def live_boxes(self) -> set[str]:
        """Which boxes' files are in squid's one live file, told by their lines: each test box file is
        `http_access allow <name>`, and the base is `_none.conf`'s comment."""
        text = (self.live / "boxes.conf").read_text()
        names = {f"{m}.conf" for m in re.findall(r"^http_access allow (\w+)$", text, re.M)}
        return names | ({"_none.conf"} if "# No box yet" in text else set())

    def live_passwd(self) -> str:
        return (self.live / "passwd").read_text()

    def hup_count(self) -> int:
        return len(self.hups.read_text().splitlines()) if self.hups.exists() else 0

    @staticmethod
    def until(check, timeout: float = TIMEOUT_S) -> None:  # type: ignore[no-untyped-def]
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if check():
                return
            time.sleep(0.05)
        raise AssertionError("not within the time allowed")

    def stop(self) -> None:
        self.proc.terminate()
        try:
            self.proc.wait(timeout=TIMEOUT_S)
        finally:
            if IMAGE:
                subprocess.run(["docker", "rm", "-f", self.name], capture_output=True, timeout=60)


GOOD = {"ada.conf": "http_access allow ada\n", "bob.conf": "http_access allow bob\n"}


@pytest.fixture
def wrapper(tmp_path: Path):  # type: ignore[no-untyped-def]
    started: list[Wrapper] = []

    def start(*args, **kwargs) -> Wrapper:  # type: ignore[no-untyped-def]
        folder = tmp_path / str(len(started))
        folder.mkdir()
        w = Wrapper(folder, *args, **kwargs)
        started.append(w)
        return w

    yield start
    for w in started:
        w.stop()


def test_a_bad_box_file_plus_a_removal_still_revokes_the_login(wrapper) -> None:  # type: ignore[no-untyped-def]
    """Security's condition 1: bob is removed while another box's new file is bad. bob's login goes at
    once, apart from the parse; the bad file never goes live, and bob's old file lingering allows
    nothing without a login."""
    w = wrapper(GOOD, f"{HASH_ADA}\n{HASH_BOB}\n")
    assert w.live_boxes() == {"_none.conf", "ada.conf", "bob.conf"}
    assert HASH_BOB in w.live_passwd()
    w.set_boxes({"ada.conf": GOOD["ada.conf"], "carl.conf": "BAD directive\n"})
    w.set_passwd(f"{HASH_ADA}\n")
    w.until(lambda: HASH_BOB not in w.live_passwd())
    w.until(lambda: "WARN box files failed squid -k parse" in w.output())
    assert w.live_passwd() == f"{HASH_ADA}\n"
    assert w.live_boxes() == {
        "_none.conf",
        "ada.conf",
        "bob.conf",
    }  # the last good set, never carl's
    w.until(lambda: w.hup_count() >= 1)  # reloaded for the logins, on its last good config
    assert "logins changed, applied and reloaded" in w.output()
    # Names and counts only: no file's content, no hash.
    out = w.output()
    assert "HASH-CANARY" not in out and "BAD" not in out and "allow" not in out
    assert re.search(
        r"WARN box files failed squid -k parse; kept the last good config \(files=3 failing_for=\d+s\)",
        out,
    )


def test_a_new_box_goes_live_within_seconds_and_a_removal_as_fast(wrapper) -> None:  # type: ignore[no-untyped-def]
    w = wrapper({"ada.conf": GOOD["ada.conf"]}, f"{HASH_ADA}\n")
    hups = w.hup_count()
    w.set_boxes(GOOD)
    w.set_passwd(f"{HASH_ADA}\n{HASH_BOB}\n")
    w.until(lambda: "bob.conf" in w.live_boxes() and HASH_BOB in w.live_passwd())
    w.until(lambda: w.hup_count() > hups)
    w.set_boxes({"ada.conf": GOOD["ada.conf"]})
    w.set_passwd(f"{HASH_ADA}\n")
    w.until(lambda: "bob.conf" not in w.live_boxes() and HASH_BOB not in w.live_passwd())
    w.until(lambda: "box files changed, parse ok, reloaded (files=2)" in w.output())


def test_a_bad_file_at_start_allows_no_box_and_says_so(wrapper) -> None:  # type: ignore[no-untyped-def]
    w = wrapper({"carl.conf": "BAD\n"}, f"{HASH_ADA}\n")
    w.until(lambda: "WARN box files failed squid -k parse" in w.output())
    assert w.live_boxes() == {"_none.conf"}  # empty means deny
    w.set_boxes({"carl.conf": "http_access allow carl\n"})  # fixed: it goes live
    w.until(lambda: "carl.conf" in w.live_boxes())


def test_a_lasting_parse_failure_is_repeated_with_how_long(wrapper) -> None:  # type: ignore[no-untyped-def]
    w = wrapper(GOOD, f"{HASH_ADA}\n", warn_every=1)
    w.set_boxes({"carl.conf": "BAD\n"})
    w.until(lambda: w.output().count("WARN box files failed") >= 3, timeout=TIMEOUT_S + 3)
    assert re.search(r"failing_for=[1-9]\d*s", w.output())


def test_no_logins_file_means_no_login_works(wrapper) -> None:  # type: ignore[no-untyped-def]
    w = wrapper(GOOD, None)
    assert w.live_passwd() == ""
    assert oct((w.live / "passwd").stat().st_mode & 0o777) == "0o400"


def test_squid_reads_only_the_live_folder_never_the_mounts() -> None:
    conf = _squid_conf()
    assert "/etc/squid/boxes" not in conf and "/etc/squid/passwd" not in conf
    assert "auth_param basic program /usr/lib/squid/basic_ncsa_auth /run/squid-live/passwd" in conf
    assert re.search(r"^auth_param basic credentialsttl 10 seconds$", conf, re.M)
    pod = _one("Deployment", "squid")
    assert '        - mountPath: "/run"\n          name: run\n' in pod  # a writable emptyDir
    assert "automountServiceAccountToken: false" in pod  # option A: no token in this pod
    run_sh = _run_sh()
    assert "sleep 30" not in run_sh and "poll=${SQUID_POLL_S:-2}" in run_sh
    # Portable: no GNU-only flags. The live file is switched by a plain rename, atomic everywhere.
    assert "mv -T" not in run_sh and "-Tf" not in run_sh
    assert 'mv -f "$live/boxes.conf.new" "$live/boxes.conf"' in run_sh
