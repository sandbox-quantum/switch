from __future__ import annotations

import configparser
import contextlib
import fcntl
import hashlib
import http.server
import importlib.util
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).parent
MODULE_PATH = HERE / "switch_hosted_worker.py"
SPEC = importlib.util.spec_from_file_location("switch_hosted_worker", MODULE_PATH)
assert SPEC and SPEC.loader
worker = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = worker
SPEC.loader.exec_module(worker)

TESTDATA = HERE / "testdata"
CORE_FIXTURES = HERE.parents[2] / "core/tests/switch_core/fixtures/hosted_machines"
INSTANCE = "i-0123456789abcdef0"
OTHER_INSTANCE = "i-0fedcba9876543210"
VOLUME = "vol-0123456789abcdef0"
MACHINE = "3f1c2b4a-0000-4000-8000-000000000001"
AGENT = "3f1c2b4a-0000-4000-8000-0000000000a1"
AGENT_2 = "3f1c2b4a-0000-4000-8000-0000000000a2"
BOOT_1 = "00000000-0000-4000-8000-00000000b001"
BOOT_2 = "00000000-0000-4000-8000-00000000b002"
FS_UUID = "00000000-0000-4000-8000-00000000f001"
FINGERPRINT = "sha256:0000"
SECRET_ARN = "arn:aws:secretsmanager:eu-west-1:000000000000:secret:switch-hosted/inst-test/slot-a"
CAPABILITY = "wcap-test-0000000000000000"
MACHINE_CAPABILITY = "mcap-test-00000000000000000000000000000000"
GENERATION = 1
ONE_AGENT_MESSAGE = "data volume uses the one-agent layout; see 'Moving to one machine per user' in deploy/hosted/README.md"
INACTIVE = {
    "ActiveState": "inactive",
    "SubState": "dead",
    "Result": "success",
    "NRestarts": "0",
    "ExecMainStatus": "0",
    "ExecMainCode": "0",
    "ExecMainExitTimestampMonotonic": "0",
}


def fixture(name: str):
    return json.loads((TESTDATA / name).read_text())


def core_fixture(name: str):
    return json.loads((CORE_FIXTURES / name).read_text())


def core_agent(**overrides) -> dict:
    agent = core_fixture("agents_response.json")["agents"][0]
    agent.update(overrides)
    return agent


def structure(value):
    if isinstance(value, dict):
        return {key: structure(field) for key, field in value.items()}
    if isinstance(value, list):
        return [structure(item) for item in value]
    return type(value).__name__


def runtime_config() -> worker.RuntimeConfig:
    return worker.RuntimeConfig(
        node_path="/opt/switch/node/bin/node",
        bootstrap_path="/opt/switch/agent-providers/hosted-bootstrap.mjs",
        shared_host_daemon_path="/opt/switch/agent-providers/shared-host-daemon.mjs",
        provider_binary_path="/opt/switch/claude/bin/claude",
        agent_user="switch-agent",
        agent_group="switch-agent",
        path="/opt/switch/node/bin:/usr/bin:/bin",
        allow_initial_format=True,
        artifact_sha256={
            "node": "1" * 64,
            "bootstrap": "2" * 64,
            "sharedHostDaemon": "3" * 64,
            "provider": "4" * 64,
        },
        providers={
            "codex": {"path": "/opt/switch/providers/codex", "sha256": "5" * 64}
        },
    )


def worker_config(runtime: worker.RuntimeConfig | None = None) -> worker.WorkerConfig:
    return worker.WorkerConfig(
        installation_id="inst-test",
        slot_id="slot-a",
        generation=GENERATION,
        secret_id=SECRET_ARN,
        secret_region="eu-west-1",
        volume_id=VOLUME,
        device_path="/dev/sdf",
        runtime=runtime or runtime_config(),
    )


def valid_agent(**overrides) -> dict:
    agent = core_agent()
    agent["worker_capability"] = CAPABILITY
    agent["skills"] = []
    agent["spec"] = {
        "name": "reviewer",
        "instructions": "Review pull requests.",
        "provider": "claude",
        "definition": "You review code.",
        "definition_attributes": {"model": "claude-test-model"},
        "auto_session": True,
        "auto_approve": False,
        "session_limit": 8,
    }
    agent.update(overrides)
    return agent


def second_agent(**overrides) -> dict:
    agent = valid_agent(
        agent_id=AGENT_2,
        launch_id="req-0000000000000002",
        repository=None,
        switch_credentials={
            "env": {
                "SWITCH_API_ENDPOINT": "https://switch.example.test/agent-api",
                "SWITCH_API_TOKEN": "test-token-placeholder",
                "SWITCH_AGENT_ID": AGENT_2,
            }
        },
    )
    agent.update(overrides)
    return agent


def listing(*agents: dict, version: int = 3) -> dict:
    value = core_fixture("agents_response.json")
    value["agents"] = list(agents)
    value["agents_version"] = version
    return value


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


def http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(
        "https://switch.example.test", code, "error", {}, io.BytesIO(b"{}")
    )


def core_client(requests: list, agents_status: int | None = None) -> worker.CoreClient:
    def opener(request, timeout):
        requests.append(request)
        if request.full_url.endswith("/agents"):
            if agents_status is not None:
                raise http_error(agents_status)
            return Response((CORE_FIXTURES / "agents_response.json").read_bytes())
        return Response((CORE_FIXTURES / "heartbeat_response.json").read_bytes())

    return worker.CoreClient(
        worker.MachineBundle(
            MACHINE,
            "https://switch.example.test/agent-api",
            MACHINE_CAPABILITY,
        ),
        worker.MachineIdentity(INSTANCE, BOOT_1, GENERATION),
        opener,
    )


class FakeSystemctl:
    def __init__(self):
        self.calls: list[list[str]] = []
        self.units: dict[str, dict[str, str]] = {}

    def run(self, arguments, capture=True):
        self.calls.append(arguments)
        if arguments[1] == "show":
            agent = arguments[-1].removeprefix("switch-agent@").removesuffix(".service")
            properties = {**INACTIVE, **self.units.get(agent, {})}
            return "".join(f"{name}={value}\n" for name, value in properties.items())
        return ""

    def result(self, arguments, capture=True):
        self.calls.append(arguments)
        return subprocess.CompletedProcess(arguments, 1, "", "")

    def actions(self) -> list[list[str]]:
        return [call[1:] for call in self.calls if call[1] != "show"]

    def clear(self) -> None:
        self.calls.clear()


class FakeClient:
    def __init__(self):
        self.listings: list = []
        self.heartbeats: list = []
        self.bodies: list[dict] = []
        self.list_calls = 0

    def agents(self):
        self.list_calls += 1
        value = self.listings.pop(0)
        if isinstance(value, BaseException):
            raise value
        return value

    def heartbeat(self, body):
        self.bodies.append(body)
        value = (
            self.heartbeats.pop(0)
            if self.heartbeats
            else core_fixture("heartbeat_response.json")
        )
        if isinstance(value, BaseException):
            raise value
        return value


class FakeGit:
    def __init__(self):
        self.calls: list[tuple[Path, list[str]]] = []

    def run(self, mirror, arguments):
        self.calls.append((mirror, arguments))


class Harness:
    def __init__(self, root: Path, git=None):
        root.mkdir(exist_ok=True)
        self.paths = worker.Paths(root / "data", root / "run")
        self.paths.data.mkdir(mode=0o755)
        self.paths.marker_directory.mkdir(mode=0o700)
        self.paths.runtime.mkdir(mode=0o750)
        self.paths.agents_runtime.mkdir(mode=0o750)
        worker.prepare_layout(self.paths, os.getuid(), os.getgid())
        self.meminfo = root / "meminfo"
        self.meminfo.write_text(
            "MemTotal:       16777216 kB\n"
            "MemFree:            1000 kB\n"
            "MemAvailable:   12582912 kB\n"
        )
        self.commands = FakeSystemctl()
        self.client = FakeClient()
        self.git = git or FakeGit()
        self.ownership_blocked: set[str] = set()
        self.now = 0.0
        self.clock_value = datetime(2026, 1, 1, tzinfo=UTC)
        self.supervisor = self.build()

    def build(self) -> worker.Supervisor:
        return worker.Supervisor(
            runtime=runtime_config(),
            identity=worker.MachineIdentity(INSTANCE, BOOT_1, GENERATION),
            machine_id=MACHINE,
            runtime_fingerprint=FINGERPRINT,
            paths=self.paths,
            uid=os.getuid(),
            gid=os.getgid(),
            client=self.client,
            systemd=worker.Systemd(self.commands),
            git=self.git,
            clock=lambda: self.clock_value,
            monotonic=lambda: self.now,
            sleep=lambda _seconds: None,
            statvfs=lambda _path: SimpleNamespace(
                f_frsize=4096, f_blocks=52428800, f_bfree=49807360, f_bavail=49807360
            ),
            meminfo=self.meminfo,
            ownership_blocked=self.ownership_blocked,
        )


class RootPatched(unittest.TestCase):
    def setUp(self):
        for patcher in (
            mock.patch.object(worker, "ROOT_UID", os.getuid()),
            mock.patch.object(worker.os, "chown"),
            mock.patch.object(worker.os, "fchown"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.temporary = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.temporary, True)


class ConfigTests(unittest.TestCase):
    def write(self, value) -> Path:
        directory = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, directory, True)
        path = directory / "assignment.json"
        path.write_text(json.dumps(value))
        return path

    def test_assignment_v2_fixture_with_secret_arn(self):
        value = fixture("assignment.json")
        value["assignmentSecretId"] = SECRET_ARN
        value["previousInstanceId"] = INSTANCE
        value["previousRuntimeFingerprint"] = "sha256:ffff"
        config = worker.load_worker_config(self.write(value), HERE / "runtime.json")
        self.assertEqual(
            (config.installation_id, config.slot_id, config.generation),
            ("inst-test", "slot-a", GENERATION),
        )
        self.assertEqual(config.volume_id, VOLUME)
        self.assertEqual(config.device_path, "/dev/sdf")
        self.assertEqual(config.secret_region, "eu-west-1")

    def test_verbatim_assignment_fixture_parses(self):
        config = worker.load_worker_config(
            self.write(fixture("assignment.json")), HERE / "runtime.json"
        )
        self.assertEqual(
            config.secret_id,
            "arn:aws:secretsmanager:us-east-1:000000000000:secret:switch-hosted/inst-test/slot-a",
        )
        self.assertEqual(config.secret_region, "us-east-1")
        self.assertEqual(
            (config.installation_id, config.slot_id, config.generation),
            ("inst-test", "slot-a", GENERATION),
        )
        self.assertEqual(config.volume_id, VOLUME)
        self.assertEqual(config.device_path, "/dev/sdf")

    def test_assignment_with_a_plain_secret_name_is_rejected(self):
        value = fixture("assignment.json")
        value["assignmentSecretId"] = "switch-hosted/inst-test/slot-a"
        with self.assertRaisesRegex(worker.WorkerError, "full Secrets Manager ARN"):
            worker.load_worker_config(self.write(value), HERE / "runtime.json")

    def test_assignment_rejects_v1_unknown_fields_and_other_mounts(self):
        base = fixture("assignment.json")
        base["assignmentSecretId"] = SECRET_ARN
        for change in (
            {"version": 1},
            {"agentId": "agent-1"},
            {"mountPath": "/mnt"},
            {"generation": 0},
        ):
            with self.subTest(change=change):
                with self.assertRaises(worker.WorkerError):
                    worker.load_worker_config(
                        self.write({**base, **change}), HERE / "runtime.json"
                    )

    def test_secret_arn_rejects_malformed_and_partition_mismatched_regions(self):
        with self.assertRaisesRegex(worker.WorkerError, "full Secrets Manager ARN"):
            worker._secret_arn_region("secret-id")
        with self.assertRaisesRegex(worker.WorkerError, "partition and region"):
            worker._secret_arn_region(
                "arn:aws-cn:secretsmanager:eu-west-1:000000000000:secret:assignment"
            )
        self.assertEqual(
            worker._secret_arn_region(
                "arn:aws-us-gov:secretsmanager:us-gov-west-1:000000000000:secret:assignment"
            ),
            "us-gov-west-1",
        )


class BundleTests(unittest.TestCase):
    def raw(self, **changes) -> str:
        return json.dumps({**fixture("bundle.json"), **changes})

    def test_fixture_bundle_parses(self):
        bundle = worker.parse_bundle(self.raw(), worker_config())
        self.assertEqual(bundle.machine_id, MACHINE)
        self.assertEqual(bundle.api_endpoint, "https://switch.example.test/agent-api")
        self.assertEqual(bundle.machine_capability, MACHINE_CAPABILITY)
        self.assertNotIn("mcap-test", repr(bundle))

    def test_other_version_is_obsolete(self):
        for version in (1, 3, "2"):
            with self.subTest(version=version):
                with self.assertRaises(worker.ObsoleteBundle):
                    worker.parse_bundle(self.raw(version=version), worker_config())

    def test_bundle_must_match_the_assignment(self):
        for key, value in (
            ("installationId", "inst-other"),
            ("slotId", "slot-b"),
            ("generation", 3),
            ("dataVolumeId", "vol-0fedcba9876543210"),
        ):
            assignment = {**fixture("bundle.json")["assignment"], key: value}
            with self.subTest(key=key):
                with self.assertRaisesRegex(worker.WorkerError, "does not match"):
                    worker.parse_bundle(
                        self.raw(assignment=assignment), worker_config()
                    )

    def test_bundle_rejects_unsafe_endpoints_capabilities_and_extra_keys(self):
        for change in (
            {"apiEndpoint": "http://switch.example.test/agent-api"},
            {"apiEndpoint": "https://user:pass@switch.example.test/agent-api"},
            {"apiEndpoint": "https://switch.example.test/agent-api?x=1"},
            {"apiEndpoint": "https://switch.example.test/agent-api#x"},
            {"machineCapability": "short"},
            {"machineCapability": "has a space in it 0000"},
            {"machineCapability": "x" * 4097},
            {"agentId": AGENT},
        ):
            with self.subTest(change=change):
                with self.assertRaises(worker.WorkerError) as raised:
                    worker.parse_bundle(self.raw(**change), worker_config())
                self.assertNotIsInstance(raised.exception, worker.ObsoleteBundle)

    def test_main_exits_75_on_an_obsolete_bundle_before_touching_the_host(self):
        secrets = mock.Mock()
        secrets.read.return_value = self.raw(version=1)
        imds = mock.Mock()
        imds.return_value.instance_id.return_value = INSTANCE
        stderr = io.StringIO()
        with (
            mock.patch.object(worker.os, "geteuid", return_value=0),
            mock.patch.object(worker, "acquire_root_lock"),
            mock.patch.object(
                worker, "load_worker_config", return_value=worker_config()
            ),
            mock.patch.object(worker, "verify_pinned_runtime", return_value="0" * 64),
            mock.patch.object(
                worker, "resolve_agent_account", return_value=(1000, 1000)
            ),
            mock.patch.object(worker, "ImdsV2", imds),
            mock.patch.object(worker, "_read_boot_id", return_value=BOOT_1),
            mock.patch.object(worker, "SecretsManager", return_value=secrets),
            mock.patch.object(worker, "prepare_runtime_directory") as runtime,
            mock.patch.object(worker, "prepare_storage") as storage,
            contextlib.redirect_stderr(stderr),
        ):
            self.assertEqual(worker.main([]), 75)
        self.assertEqual(stderr.getvalue(), "obsolete bundle\n")
        secrets.read.assert_called_once_with(SECRET_ARN)
        runtime.assert_not_called()
        storage.assert_not_called()


class BundleFileTests(RootPatched):
    def test_bundle_file_is_private_and_holds_only_machine_fields(self):
        paths = worker.Paths(self.temporary / "data", self.temporary / "run")
        paths.runtime.mkdir()
        worker.write_bundle(
            paths,
            worker.parse_bundle(json.dumps(fixture("bundle.json")), worker_config()),
        )
        self.assertEqual(paths.bundle, self.temporary / "run/machine/bundle.json")
        self.assertEqual(stat.S_IMODE(paths.bundle.stat().st_mode), 0o600)
        self.assertEqual(
            json.loads(paths.bundle.read_text()),
            {
                "version": 2,
                "machineId": MACHINE,
                "machineCapability": MACHINE_CAPABILITY,
                "apiEndpoint": "https://switch.example.test/agent-api",
            },
        )

    def test_runtime_directory_must_be_tmpfs(self):
        class Commands:
            def __init__(self, filesystem):
                self.filesystem = filesystem

            def run(self, arguments, capture=True):
                return self.filesystem + "\n"

        paths = worker.Paths(self.temporary / "data", self.temporary / "run")
        paths.runtime.mkdir(mode=0o750)
        with self.assertRaisesRegex(worker.WorkerError, "tmpfs"):
            worker.prepare_runtime_directory(Commands("ext4"), paths, os.getgid())
        worker.prepare_runtime_directory(Commands("tmpfs"), paths, os.getgid())
        self.assertEqual(stat.S_IMODE(paths.bundle.parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(paths.agents_runtime.stat().st_mode), 0o750)


class MarkerTests(RootPatched):
    def setUp(self):
        super().setUp()
        self.paths = worker.Paths(self.temporary / "data", self.temporary / "run")
        self.paths.data.mkdir(mode=0o755)
        self.identity = worker.MachineIdentity(INSTANCE, BOOT_1, GENERATION)

    def reconcile(self, identity=None, fingerprint=FINGERPRINT):
        return worker.reconcile_marker(
            identity or self.identity,
            worker_config(),
            FS_UUID,
            fingerprint,
            self.paths,
        )

    def marker(self) -> dict:
        return json.loads(self.paths.marker.read_text())

    def test_blank_disk_gets_a_v2_marker(self):
        (self.paths.data / "lost+found").mkdir()
        self.reconcile()
        self.assertEqual(self.marker(), fixture("machine.json"))
        self.assertEqual(stat.S_IMODE(self.paths.marker.stat().st_mode), 0o600)

    def test_unmarked_disk_with_data_is_refused(self):
        (self.paths.data / "state").mkdir()
        with self.assertRaisesRegex(worker.WorkerError, "no trusted machine marker"):
            self.reconcile()

    def test_fixture_marker_is_accepted_unchanged(self):
        worker._write_root_json(self.paths.marker, fixture("machine.json"))
        before = self.paths.marker.stat().st_ino
        self.reconcile()
        self.assertEqual(self.paths.marker.stat().st_ino, before)

    def test_v1_marker_is_refused_with_the_migration_message(self):
        worker._write_root_json(
            self.paths.marker,
            {
                "version": 1,
                "installationId": "inst-test",
                "agentId": "agent-1",
                "generation": 2,
                "instanceId": INSTANCE,
                "bootId": BOOT_1,
                "filesystemUuid": FS_UUID,
                "runtimeFingerprint": "a" * 64,
            },
        )
        with self.assertRaises(worker.WorkerError) as raised:
            self.reconcile()
        self.assertEqual(str(raised.exception), ONE_AGENT_MESSAGE)

    def test_identity_mismatches_are_refused(self):
        for key, value in (
            ("installationId", "inst-other"),
            ("slotId", "slot-b"),
            ("generation", 3),
            ("filesystemUuid", "00000000-0000-4000-8000-00000000f002"),
        ):
            with self.subTest(key=key):
                worker._write_root_json(
                    self.paths.marker, {**fixture("machine.json"), key: value}
                )
                with self.assertRaises(worker.WorkerError):
                    self.reconcile()

    def test_malformed_marker_is_refused(self):
        for change in (
            {"layout": "one-agent"},
            {"runtimeFingerprint": "0000"},
            {"extra": 1},
        ):
            with self.subTest(change=change):
                worker._write_root_json(
                    self.paths.marker, {**fixture("machine.json"), **change}
                )
                with self.assertRaisesRegex(worker.WorkerError, "marker is invalid"):
                    self.reconcile()

    def test_new_instance_and_fingerprint_are_rewritten_without_pinning(self):
        worker._write_root_json(self.paths.marker, fixture("machine.json"))
        self.reconcile(
            worker.MachineIdentity(OTHER_INSTANCE, BOOT_2, GENERATION),
            fingerprint="sha256:" + "b" * 64,
        )
        marker = self.marker()
        self.assertEqual(marker["instanceId"], OTHER_INSTANCE)
        self.assertEqual(marker["bootId"], BOOT_2)
        self.assertEqual(marker["runtimeFingerprint"], "sha256:" + "b" * 64)
        self.assertEqual(marker["layout"], "per-user-v1")

    def owner_files(self, agent_id: str) -> Path:
        state = self.paths.agents / agent_id
        for relative, record in fixture("owner-records.json").items():
            path = state / relative
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            path.write_text(json.dumps(record, separators=(",", ":")))
        self.paths.agents.chmod(0o755)
        (state / "shared-state.jsonl").write_text('{"journal":"preserve"}\n')
        return state

    def test_new_boot_quarantines_ownership_per_agent(self):
        worker._write_root_json(self.paths.marker, fixture("machine.json"))
        first = self.owner_files(AGENT)
        second = self.owner_files(AGENT_2)
        (self.paths.agents / "not-a-uuid").mkdir()
        with self.assertLogs(worker.logger, "WARNING"):
            self.reconcile(worker.MachineIdentity(INSTANCE, BOOT_2, GENERATION))
        for agent_id, state in ((AGENT, first), (AGENT_2, second)):
            quarantine = self.paths.quarantine / agent_id / f"{BOOT_1}--{BOOT_2}"
            for relative, record in fixture("owner-records.json").items():
                self.assertFalse((state / relative).exists())
                self.assertEqual(
                    json.loads((quarantine / relative).read_text()), record
                )
            self.assertEqual(
                (state / "shared-state.jsonl").read_text(), '{"journal":"preserve"}\n'
            )
        self.assertEqual(self.marker()["bootId"], BOOT_2)

    def test_torn_ticket_write_is_quarantined(self):
        worker._write_root_json(self.paths.marker, fixture("machine.json"))
        state = self.owner_files(AGENT)
        torn = (
            "ownership/4108-00000000-0000-4000-8000-0000000000c8.json."
            "00000000-0000-4000-8000-0000000000c9.tmp"
        )
        (state / torn).write_text("")
        self.reconcile(worker.MachineIdentity(INSTANCE, BOOT_2, GENERATION))
        self.assertFalse((state / torn).exists())
        self.assertTrue(
            (self.paths.quarantine / AGENT / f"{BOOT_1}--{BOOT_2}" / torn).exists()
        )
        self.assertEqual(self.marker()["bootId"], BOOT_2)

    def test_same_boot_does_not_quarantine(self):
        worker._write_root_json(self.paths.marker, fixture("machine.json"))
        state = self.owner_files(AGENT)
        self.reconcile(self.identity, fingerprint="sha256:" + "c" * 64)
        self.assertTrue((state / "supervisor/owner.json").exists())
        self.assertFalse(self.paths.quarantine.exists())
        self.assertEqual(self.marker()["runtimeFingerprint"], "sha256:" + "c" * 64)

    def test_corrupt_owner_record_fails_closed(self):
        ticket = "ownership/4103-00000000-0000-4000-8000-0000000000c3.json"
        for relative, content in (
            ("supervisor/owner.json", "{"),
            ("supervisor/owner.json", '{"pid":1,"token":"t"}'),
            ("shared-owner.lock", '{"pid":0,"token":"t"}'),
            ("shared-owner.lock", '{"pid":1,"token":"t","group":true}'),
            (ticket, '{"choosing":1,"ticket":1}'),
            (ticket, '{"choosing":false,"ticket":-1}'),
            ("ownership/unexpected.json", '{"choosing":false,"ticket":1}'),
        ):
            with self.subTest(relative=relative, content=content):
                shutil.rmtree(self.paths.data)
                self.paths.data.mkdir(mode=0o755)
                worker._write_root_json(self.paths.marker, fixture("machine.json"))
                state = self.owner_files(AGENT)
                (state / relative).write_text(content)
                with self.assertLogs(worker.logger, "ERROR") as logs:
                    blocked = self.reconcile(
                        worker.MachineIdentity(INSTANCE, BOOT_2, GENERATION)
                    )
                self.assertEqual(blocked, {AGENT})
                self.assertIn("ownership record is invalid", logs.output[0])
                self.assertTrue((state / relative).exists())
                self.assertTrue((state / "shared-owner.lock").exists())
                self.assertEqual(self.marker()["bootId"], BOOT_2)

    def test_corrupt_owner_record_blocks_only_its_agent(self):
        worker._write_root_json(self.paths.marker, fixture("machine.json"))
        first = self.owner_files(AGENT)
        second = self.owner_files(AGENT_2)
        (first / "supervisor/owner.json").write_text("{")
        boot_2 = worker.MachineIdentity(INSTANCE, BOOT_2, GENERATION)
        with self.assertLogs(worker.logger, "ERROR"):
            self.assertEqual(self.reconcile(boot_2), {AGENT})
        self.assertFalse((second / "supervisor/owner.json").exists())
        self.assertTrue(
            (
                self.paths.quarantine
                / AGENT_2
                / f"{BOOT_1}--{BOOT_2}"
                / "supervisor/owner.json"
            ).exists()
        )
        self.assertEqual(
            json.loads(self.paths.ownership_blocked.read_text()),
            {
                "version": 1,
                "bootId": BOOT_2,
                "previousBootId": BOOT_1,
                "agents": [AGENT],
            },
        )
        with self.assertLogs(worker.logger, "ERROR"):
            self.assertEqual(self.reconcile(boot_2), {AGENT})
        (first / "supervisor/owner.json").unlink()
        self.assertEqual(self.reconcile(boot_2), set())
        self.assertFalse(self.paths.ownership_blocked.exists())
        self.assertFalse((first / "shared-owner.lock").exists())
        self.assertTrue(
            (
                self.paths.quarantine
                / AGENT
                / f"{BOOT_1}--{BOOT_2}"
                / "shared-owner.lock"
            ).exists()
        )

    def test_partial_quarantine_is_resumed(self):
        worker._write_root_json(self.paths.marker, fixture("machine.json"))
        state = self.owner_files(AGENT)
        quarantine = self.paths.quarantine / AGENT / f"{BOOT_1}--{BOOT_2}"
        quarantine.mkdir(parents=True, mode=0o700)
        self.paths.quarantine.chmod(0o700)
        (self.paths.quarantine / AGENT).chmod(0o700)
        os.replace(state / "shared-owner.lock", quarantine / "shared-owner.lock")
        self.reconcile(worker.MachineIdentity(INSTANCE, BOOT_2, GENERATION))
        self.assertFalse((state / "supervisor/owner.json").exists())
        self.assertTrue((quarantine / "supervisor/owner.json").exists())
        self.assertTrue((quarantine / "shared-owner.lock").exists())


class StorageTests(unittest.TestCase):
    def test_storage_resolves_nitro_device_by_ebs_serial(self):
        class FakeCommands:
            def __init__(self):
                self.calls = []

            def run(self, arguments, capture=True):
                self.calls.append(arguments)
                return json.dumps(
                    {
                        "blockdevices": [
                            {
                                "path": "/dev/nvme0n1",
                                "type": "disk",
                                "fstype": "ext4",
                                "uuid": FS_UUID,
                                "serial": VOLUME.replace("-", ""),
                                "mountpoints": [None],
                            }
                        ]
                    }
                )

        commands = FakeCommands()
        observed = worker.inspect_storage(commands, "/dev/sdf", VOLUME)
        self.assertEqual(observed.device_path, "/dev/nvme0n1")
        self.assertNotIn("/dev/sdf", commands.calls[0])

    def test_unexpected_signature_never_formats(self):
        blank = worker.StorageObservation(
            "/dev/nvme1n1", VOLUME, None, None, False, ("xfs",)
        )
        commands = mock.Mock()
        with mock.patch.object(worker, "inspect_storage", return_value=blank):
            with self.assertRaisesRegex(
                worker.WorkerError, "not a safely initializable"
            ):
                worker.prepare_storage(commands, worker_config())
        commands.run.assert_not_called()

    def test_unmounted_data_is_mounted_with_systemd_mount(self):
        observation = worker.StorageObservation(
            "/dev/nvme1n1", VOLUME, "ext4", FS_UUID, False, ()
        )
        commands = mock.Mock()
        commands.result.return_value = subprocess.CompletedProcess([], 1, "", "")
        with tempfile.TemporaryDirectory() as temporary:
            mount = Path(temporary) / "data"
            with (
                mock.patch.object(worker, "DATA_MOUNT", mount),
                mock.patch.object(worker, "inspect_storage", return_value=observation),
                mock.patch.object(worker, "ROOT_UID", os.getuid()),
            ):
                worker.prepare_storage(commands, worker_config())
        commands.run.assert_called_once_with(
            [
                "/usr/bin/systemd-mount",
                "--type=ext4",
                "--options=nodev,nosuid",
                "/dev/nvme1n1",
                str(mount),
            ],
            capture=False,
        )

    def test_mountpoint_held_by_another_device_is_refused(self):
        observation = worker.StorageObservation(
            "/dev/nvme1n1", VOLUME, "ext4", FS_UUID, False, ()
        )
        commands = mock.Mock()
        commands.result.return_value = subprocess.CompletedProcess(
            [], 0, "/dev/nvme9n1\n", ""
        )
        with tempfile.TemporaryDirectory() as temporary:
            with (
                mock.patch.object(worker, "DATA_MOUNT", Path(temporary) / "data"),
                mock.patch.object(worker, "inspect_storage", return_value=observation),
                mock.patch.object(worker, "ROOT_UID", os.getuid()),
            ):
                with self.assertRaisesRegex(worker.WorkerError, "occupied"):
                    worker.prepare_storage(commands, worker_config())

    def test_new_filesystem_waits_for_device_metadata_before_mount(self):
        blank = worker.StorageObservation("/dev/nvme1n1", VOLUME, None, None, False, ())
        formatted = worker.StorageObservation(
            "/dev/nvme1n1", VOLUME, "ext4", FS_UUID, False, ()
        )
        settled = False
        calls = []

        def run(arguments, capture=True):
            nonlocal settled
            calls.append(arguments)
            if arguments[:2] == ["/usr/bin/udevadm", "settle"]:
                settled = True
            return ""

        commands = mock.Mock()
        commands.run.side_effect = run
        commands.result.return_value = subprocess.CompletedProcess([], 1, "", "")
        with tempfile.TemporaryDirectory() as temporary:
            with (
                mock.patch.object(worker, "DATA_MOUNT", Path(temporary) / "data"),
                mock.patch.object(worker, "ROOT_UID", os.getuid()),
                mock.patch.object(
                    worker,
                    "inspect_storage",
                    side_effect=lambda *_: formatted if settled else blank,
                ),
            ):
                observation, did_format = worker.prepare_storage(
                    commands, worker_config()
                )
        self.assertTrue(did_format)
        self.assertEqual(observation.filesystem_uuid, FS_UUID)
        self.assertEqual(sum(call[0].endswith("mkfs.ext4") for call in calls), 1)
        self.assertEqual(calls[-1][0], "/usr/bin/systemd-mount")


class HostTests(unittest.TestCase):
    def test_imdsv2_requires_token_and_does_not_guess_identity(self):
        requests = []

        def opener(request, timeout):
            requests.append((request, timeout))
            if request.full_url.endswith("/api/token"):
                return Response(b"token")
            self.assertEqual(request.get_header("X-aws-ec2-metadata-token"), "token")
            return Response(INSTANCE.encode())

        self.assertEqual(worker.ImdsV2(opener).instance_id(), INSTANCE)
        self.assertEqual(requests[0][0].method, "PUT")
        self.assertEqual(len(requests), 2)

    def test_secret_store_calls_only_get_for_configured_secret(self):
        client = mock.Mock()
        client.get_secret_value.return_value = {"SecretString": "{}", "VersionId": "v"}
        self.assertEqual(
            worker.SecretsManager("eu-west-1", client).read(SECRET_ARN), "{}"
        )
        client.get_secret_value.assert_called_once_with(
            SecretId=SECRET_ARN, VersionStage="AWSCURRENT"
        )

    def test_secret_region_is_explicit(self):
        boto3 = mock.Mock()
        with (
            mock.patch.dict(sys.modules, {"boto3": boto3}),
            mock.patch.dict(os.environ, {}, clear=True),
        ):
            worker.SecretsManager("eu-west-1")
        boto3.client.assert_called_once_with("secretsmanager", region_name="eu-west-1")

    def test_agent_account_cannot_resolve_to_root(self):
        with (
            mock.patch.object(
                worker.pwd,
                "getpwnam",
                return_value=SimpleNamespace(pw_uid=0, pw_gid=0),
            ),
            mock.patch.object(
                worker.grp, "getgrnam", return_value=SimpleNamespace(gr_gid=0)
            ),
        ):
            with self.assertRaisesRegex(worker.WorkerError, "non-root"):
                worker.resolve_agent_account("switch-agent", "switch-agent")

    def test_tampered_baked_runtime_fails_checksum_verification(self):
        with tempfile.TemporaryDirectory() as temporary:
            paths = {}
            hashes = {}
            for name in ("node", "bootstrap", "sharedHostDaemon", "provider"):
                path = Path(temporary) / name
                path.write_bytes(f"trusted-{name}".encode())
                path.chmod(0o444)
                paths[name] = str(path)
                hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
            runtime = worker.RuntimeConfig(
                node_path=paths["node"],
                bootstrap_path=paths["bootstrap"],
                shared_host_daemon_path=paths["sharedHostDaemon"],
                provider_binary_path=paths["provider"],
                agent_user="switch-agent",
                agent_group="switch-agent",
                path="/usr/bin:/bin",
                allow_initial_format=True,
                artifact_sha256=hashes,
            )
            completed = subprocess.CompletedProcess([], 0, "v24.1.0\n", "")
            with (
                mock.patch.object(worker, "ROOT_UID", os.getuid()),
                mock.patch.object(worker.subprocess, "run", return_value=completed),
            ):
                self.assertRegex(
                    worker.verify_pinned_runtime(worker_config(runtime)),
                    r"^[0-9a-f]{64}$",
                )
                Path(paths["bootstrap"]).chmod(0o644)
                Path(paths["bootstrap"]).write_text("tampered")
                Path(paths["bootstrap"]).chmod(0o444)
                with self.assertRaisesRegex(worker.WorkerError, "checksum"):
                    worker.verify_pinned_runtime(worker_config(runtime))

    def test_meminfo_is_read_in_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "meminfo"
            path.write_text("MemTotal: 2048 kB\nMemAvailable: 1024 kB\n")
            self.assertEqual(worker.read_meminfo(path), (2097152, 1048576))
            path.write_text("MemTotal: 2048 kB\n")
            with self.assertRaisesRegex(worker.WorkerError, "Memory"):
                worker.read_meminfo(path)


class DeploymentTests(unittest.TestCase):
    paths = worker.Paths(Path("/data"), Path("/run/switch-hosted"))

    def plan(self, agent: dict) -> worker.AgentPlan:
        return worker.build_agent_plan(agent, runtime_config(), self.paths)

    def test_core_agent_without_a_credential_kind_is_a_per_agent_config_error(self):
        with self.assertRaisesRegex(worker.WorkerError, "credential kind None"):
            self.plan(core_agent(provider_credential_kind=None))

    def test_fixture_agent_builds_deployment_v2(self):
        plan = self.plan(valid_agent())
        run = f"/run/switch-hosted/agents/{AGENT}"
        self.assertEqual(
            plan.deployment,
            {
                "version": 2,
                "revision": 1,
                "session": {"sessionId": "watcher-" + AGENT, "agentId": AGENT},
                "provider": {
                    "kind": "claude",
                    "credential": {
                        "kind": "setup-token",
                        "path": f"{run}/provider",
                        "refresh": True,
                    },
                    "binaryPath": "/opt/switch/claude/bin/claude",
                    "context": "Use the Switch tools to read room context and post replies to the room.\nReview pull requests.",
                    "definition": {"name": "reviewer", "content": "You review code."},
                    "model": {"id": "claude-test-model"},
                },
                "github": {
                    "credentialPath": f"{run}/github",
                    "repository": "example-org/example-repo",
                    "refresh": True,
                    "mirrorPath": "/data/repos/example-org/example-repo.git",
                },
                "workspacePath": f"/data/worktrees/{AGENT}/example-org/example-repo",
                "watch": True,
                "runtimeMode": "approval-required",
                "switchCredentialsPath": f"{run}/switch.json",
                "workerCapabilityPath": f"{run}/worker-capability",
            },
        )
        self.assertEqual(plan.worker_capability, CAPABILITY)
        self.assertNotIn(CAPABILITY, json.dumps(plan.deployment))
        self.assertNotIn("test-token-placeholder", json.dumps(plan.deployment))

    def test_repository_paths_are_lowercase_and_optional(self):
        plan = self.plan(valid_agent(repository="Example-Org/Example.Repo"))
        self.assertEqual(
            plan.deployment["github"]["repository"], "Example-Org/Example.Repo"
        )
        self.assertEqual(
            plan.deployment["github"]["mirrorPath"],
            "/data/repos/example-org/example.repo.git",
        )
        self.assertEqual(
            plan.worktree_owner, Path(f"/data/worktrees/{AGENT}/example-org")
        )
        plan = self.plan(valid_agent(repository=None))
        self.assertNotIn("github", plan.deployment)
        self.assertEqual(
            plan.deployment["workspacePath"], f"/data/worktrees/{AGENT}/workspace"
        )
        self.assertIsNone(plan.worktree_owner)

    def test_codex_uses_its_pinned_binary_and_has_no_definition(self):
        spec = {
            **valid_agent()["spec"],
            "definition_attributes": {},
            "auto_approve": True,
        }
        plan = self.plan(
            valid_agent(
                provider="codex", provider_credential_kind="auth-json", spec=spec
            )
        )
        provider = plan.deployment["provider"]
        self.assertEqual(provider["binaryPath"], "/opt/switch/providers/codex")
        self.assertNotIn("definition", provider)
        self.assertNotIn("model", provider)
        self.assertEqual(plan.deployment["runtimeMode"], "full-access")

    def test_skills_are_validated_and_included(self):
        skills = [{"slug": "review", "files": {"SKILL.md": "# Review\n"}}]
        self.assertEqual(
            self.plan(valid_agent(skills=skills)).deployment["skills"], skills
        )
        for bad in (
            [{"slug": "../x", "files": {"SKILL.md": "x"}}],
            [{"slug": "review", "files": {"notes.md": "x"}}],
            [{"slug": "review", "files": {"../SKILL.md": "x", "SKILL.md": "x"}}],
        ):
            with self.subTest(skills=bad):
                with self.assertRaises(worker.WorkerError):
                    self.plan(valid_agent(skills=bad))

    def test_invalid_agent_fields_are_rejected(self):
        wrong_agent = {
            "env": {
                "SWITCH_API_ENDPOINT": "https://switch.example.test",
                "SWITCH_API_TOKEN": "x",
                "SWITCH_AGENT_ID": AGENT_2,
            }
        }
        for change in (
            {"agent_id": "agent-1"},
            {"agent_id": AGENT.upper()},
            {"provider": "opencode"},
            {"provider_credential_kind": "oauth"},
            {"worker_capability": "wcap-test-0000"},
            {"repository": "example-org/.."},
            {"repository": "-bad/repo"},
            {"desired_state": "deleted"},
            {"revision": 0},
            {"spec": {"session_limit": 8}},
            {"switch_credentials": wrong_agent},
        ):
            with self.subTest(change=change):
                with self.assertRaises(worker.WorkerError):
                    self.plan(valid_agent(**change))
        without = valid_agent()
        del without["skills"]
        with self.assertRaisesRegex(worker.WorkerError, "missing skills"):
            self.plan(without)

    def test_environment_file_follows_the_contract(self):
        text = worker.agent_environment(
            runtime_config(),
            worker.MachineIdentity(INSTANCE, BOOT_1, GENERATION),
            MACHINE,
            self.paths,
            AGENT,
        )
        self.assertEqual(
            text,
            "PATH=/opt/switch/node/bin:/usr/bin:/bin\n"
            "USER=switch-agent\n"
            "LOGNAME=switch-agent\n"
            "SHELL=/bin/bash\n"
            "LANG=C.UTF-8\n"
            f"HOME=/data/agents/{AGENT}/home\n"
            f"TMPDIR=/data/agents/{AGENT}/tmp\n"
            f"SWITCH_HOST_INSTANCE_ID={INSTANCE}\n"
            f"SWITCH_HOST_BOOT_ID={BOOT_1}\n"
            f"SWITCH_HOST_ASSIGNMENT_GENERATION={GENERATION}\n"
            f"SWITCH_HOST_MACHINE_ID={MACHINE}\n",
        )

    def test_environment_values_with_newlines_are_refused(self):
        runtime = runtime_config()
        for path in ("/usr/bin\nEVIL=1", "/usr/bin\r", '/usr/bin"'):
            with self.subTest(path=path):
                with self.assertRaisesRegex(worker.WorkerError, "PATH"):
                    worker.agent_environment(
                        worker.RuntimeConfig(**{**runtime.__dict__, "path": path}),
                        worker.MachineIdentity(INSTANCE, BOOT_1, GENERATION),
                        MACHINE,
                        self.paths,
                        AGENT,
                    )


class CoreClientTests(unittest.TestCase):
    def client(self, opener, endpoint="https://switch.example.test/agent-api/"):
        bundle = worker.MachineBundle(MACHINE, endpoint, MACHINE_CAPABILITY)
        return worker.CoreClient(
            bundle, worker.MachineIdentity(INSTANCE, BOOT_1, GENERATION), opener
        )

    def test_requests_carry_capability_and_host_identity(self):
        requests = []

        def opener(request, timeout):
            requests.append((request, timeout))
            if request.full_url.endswith("/agents"):
                value = {**core_fixture("agents_response.json"), "future": 1}
            else:
                value = {**core_fixture("heartbeat_response.json"), "future": 1}
            return Response(json.dumps(value).encode())

        client = self.client(opener)
        self.assertEqual(client.agents()["agents_version"], 3)
        body = core_fixture("heartbeat_request.json")
        self.assertEqual(client.heartbeat(body)["heartbeat_every_s"], 15)
        listed, beat = requests
        self.assertEqual(
            listed[0].full_url,
            f"https://switch.example.test/agent-api/hosted/machines/{MACHINE}/agents",
        )
        self.assertEqual(listed[0].get_method(), "GET")
        self.assertIsNone(listed[0].data)
        self.assertEqual(
            beat[0].full_url,
            f"https://switch.example.test/agent-api/hosted/machines/{MACHINE}/heartbeat",
        )
        self.assertEqual(beat[0].get_method(), "POST")
        self.assertEqual(json.loads(beat[0].data), body)
        for request, timeout in requests:
            self.assertEqual(timeout, worker.HTTP_TIMEOUT_SECONDS)
            self.assertEqual(
                request.get_header("Authorization"),
                "Bearer " + MACHINE_CAPABILITY,
            )
            self.assertEqual(request.get_header("X-switch-host-boot-id"), BOOT_1)
            self.assertEqual(request.get_header("X-switch-host-instance-id"), INSTANCE)

    def test_status_codes_map_to_restart_retire_and_retry(self):
        for code, expected in (
            (401, worker.WorkerError),
            (410, worker.MachineRetired),
            (500, worker.CoreUnavailable),
            (404, worker.CoreUnavailable),
        ):

            def opener(request, timeout, code=code):
                raise http_error(code)

            with self.subTest(code=code):
                with self.assertRaises(expected):
                    self.client(opener).heartbeat({})

    def test_network_errors_and_invalid_bodies_are_retryable(self):
        def unreachable(request, timeout):
            raise urllib.error.URLError("down")

        with self.assertRaises(worker.CoreUnavailable):
            self.client(unreachable).agents()
        for raw in (
            b"not json",
            b"[]",
            b'{"agents_version": true, "agents": []}',
            b'{"agents_version": 1}',
        ):
            with self.subTest(raw=raw):
                with self.assertRaises(worker.CoreUnavailable):
                    self.client(
                        lambda request, timeout, raw=raw: Response(raw)
                    ).agents()

    def test_redirects_are_not_followed(self):
        hits = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.path)
                if self.path.endswith("/agents"):
                    self.send_response(302)
                    self.send_header("Location", "/elsewhere")
                    self.end_headers()
                else:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b'{"agents_version":1,"agents":[]}')

            def log_message(self, *_args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        endpoint = f"http://127.0.0.1:{server.server_address[1]}/agent-api"
        with mock.patch.dict(os.environ, {"no_proxy": "*", "NO_PROXY": "*"}):
            with self.assertRaisesRegex(worker.CoreUnavailable, "302"):
                self.client(worker.default_opener(), endpoint).agents()
        self.assertEqual(hits, [f"/agent-api/hosted/machines/{MACHINE}/agents"])


class SystemdTests(unittest.TestCase):
    def test_systemctl_argv(self):
        commands = FakeSystemctl()
        systemd = worker.Systemd(commands)
        systemd.start(AGENT)
        systemd.restart(AGENT)
        systemd.stop(AGENT, wait=False)
        systemd.stop(AGENT, wait=True)
        systemd.reset_failed(AGENT)
        systemd.stop_all()
        systemd.limit_slice(15 * 1024**3)
        unit = f"switch-agent@{AGENT}.service"
        self.assertEqual(
            commands.calls,
            [
                ["/usr/bin/systemctl", "--no-block", "start", unit],
                ["/usr/bin/systemctl", "--no-block", "restart", unit],
                ["/usr/bin/systemctl", "--no-block", "stop", unit],
                ["/usr/bin/systemctl", "stop", unit],
                ["/usr/bin/systemctl", "reset-failed", unit],
                ["/usr/bin/systemctl", "stop", "switch-agent@*.service"],
                [
                    "/usr/bin/systemctl",
                    "set-property",
                    "--runtime",
                    "switch-agents.slice",
                    "MemoryMax=16106127360",
                ],
            ],
        )
        with self.assertRaises(worker.WorkerError):
            systemd.start("../../etc")

    def test_show_reads_the_contract_properties(self):
        commands = FakeSystemctl()
        self.assertEqual(worker.Systemd(commands).show(AGENT), INACTIVE)
        self.assertEqual(
            commands.calls[0],
            [
                "/usr/bin/systemctl",
                "show",
                "-p",
                "ActiveState,SubState,Result,NRestarts,ExecMainStatus,ExecMainCode,ExecMainExitTimestampMonotonic",
                f"switch-agent@{AGENT}.service",
            ],
        )


class SupervisorTests(RootPatched):
    def setUp(self):
        super().setUp()
        self.harness = Harness(self.temporary / "machine")
        self.supervisor = self.harness.supervisor
        self.paths = self.harness.paths
        self.commands = self.harness.commands

    def state(self, agent_id=AGENT) -> dict:
        body = self.supervisor.heartbeat_body()
        return next(agent for agent in body["agents"] if agent["agent_id"] == agent_id)

    def test_new_running_agent_gets_files_directories_and_a_restart(self):
        self.supervisor.reconcile([valid_agent()])
        unit = f"switch-agent@{AGENT}.service"
        self.assertEqual(
            self.commands.actions(),
            [["reset-failed", unit], ["--no-block", "restart", unit]],
        )
        directory = self.paths.agents_runtime / AGENT
        self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o750)
        self.assertEqual(
            sorted(path.name for path in directory.iterdir()),
            ["deployment.json", "env", "switch.json", "worker-capability"],
        )
        for path in directory.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o440)
        self.assertEqual((directory / "worker-capability").read_text(), CAPABILITY)
        self.assertEqual(
            json.loads((directory / "switch.json").read_text()),
            valid_agent()["switch_credentials"],
        )
        deployment = json.loads((directory / "deployment.json").read_text())
        self.assertEqual(deployment["version"], 2)
        self.assertEqual(
            deployment["workspacePath"],
            str(self.paths.worktrees / AGENT / "example-org/example-repo"),
        )
        self.assertIn(
            f"SWITCH_HOST_MACHINE_ID={MACHINE}\n", (directory / "env").read_text()
        )
        for path in (
            self.paths.agents / AGENT,
            self.paths.agents / AGENT / "home",
            self.paths.agents / AGENT / "tmp",
            self.paths.worktrees / AGENT,
            self.paths.worktrees / AGENT / "example-org",
            self.paths.worktrees / AGENT / "example-org/example-repo",
            self.paths.repos,
        ):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700, path)
        self.assertEqual(stat.S_IMODE(self.paths.agents.stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE(self.paths.worktrees.stat().st_mode), 0o755)
        self.assertEqual(list(self.paths.agents_runtime.glob(".*")), [])

    def test_new_stopped_agent_is_stopped(self):
        self.supervisor.reconcile([valid_agent(desired_state="stopped")])
        unit = f"switch-agent@{AGENT}.service"
        self.assertEqual(
            self.commands.actions(),
            [["--no-block", "stop", unit], ["reset-failed", unit]],
        )
        self.supervisor._observe()
        self.assertEqual(self.state()["process_state"], "stopped")

    def test_same_revision_only_corrects_the_running_state(self):
        unit = f"switch-agent@{AGENT}.service"
        self.supervisor.reconcile([valid_agent()])
        deployment = self.paths.agents_runtime / AGENT / "deployment.json"
        inode = deployment.stat().st_ino
        self.commands.clear()
        self.supervisor.reconcile([valid_agent()])
        self.assertEqual(self.commands.actions(), [["--no-block", "start", unit]])
        self.commands.clear()
        self.commands.units[AGENT] = {"ActiveState": "active", "SubState": "running"}
        self.supervisor.reconcile([valid_agent()])
        self.assertEqual(self.commands.actions(), [])
        self.supervisor.reconcile([valid_agent(desired_state="stopped")])
        self.assertEqual(
            self.commands.actions(),
            [["--no-block", "stop", unit], ["reset-failed", unit]],
        )
        self.commands.clear()
        self.commands.units[AGENT] = {
            "ActiveState": "failed",
            "Result": "start-limit-hit",
        }
        self.supervisor.reconcile([valid_agent()])
        self.assertEqual(self.commands.actions(), [])
        self.assertEqual(deployment.stat().st_ino, inode)

    def test_stopping_a_crashed_agent_resets_the_failed_unit(self):
        unit = f"switch-agent@{AGENT}.service"
        self.supervisor.reconcile([valid_agent()])
        self.commands.clear()
        self.commands.units[AGENT] = {
            "ActiveState": "failed",
            "Result": "start-limit-hit",
        }
        self.supervisor.reconcile([valid_agent(desired_state="stopped")])
        self.assertEqual(
            self.commands.actions(),
            [["--no-block", "stop", unit], ["reset-failed", unit]],
        )

    def test_failed_restart_is_retried_on_the_next_reconcile(self):
        unit = f"switch-agent@{AGENT}.service"
        failing = [True]
        original = self.commands.run

        def run(arguments, capture=True):
            if "restart" in arguments and failing and failing.pop():
                original(arguments, capture)
                raise worker.WorkerError("Required host operation failed: systemctl.")
            return original(arguments, capture)

        self.commands.run = run
        with (
            self.assertLogs(worker.logger, "ERROR"),
            self.assertRaises(worker.ReconcileIncomplete),
        ):
            self.supervisor.reconcile([valid_agent()])
        self.commands.clear()
        self.supervisor.reconcile([valid_agent()])
        self.assertEqual(
            self.commands.actions(),
            [["reset-failed", unit], ["--no-block", "restart", unit]],
        )
        self.commands.clear()
        self.supervisor.reconcile([valid_agent()])
        self.assertEqual(self.commands.actions(), [["--no-block", "start", unit]])

    def test_revision_change_rewrites_files_and_resets_a_crashed_unit(self):
        unit = f"switch-agent@{AGENT}.service"
        self.supervisor.reconcile([valid_agent()])
        self.commands.clear()
        self.commands.units[AGENT] = {
            "ActiveState": "failed",
            "Result": "start-limit-hit",
        }
        self.supervisor.reconcile(
            [valid_agent(revision=4, worker_capability="wcap-test-1111111111111111")]
        )
        self.assertEqual(
            self.commands.actions(),
            [["reset-failed", unit], ["--no-block", "restart", unit]],
        )
        directory = self.paths.agents_runtime / AGENT
        self.assertEqual(
            json.loads((directory / "deployment.json").read_text())["revision"], 4
        )
        self.assertEqual(
            (directory / "worker-capability").read_text(),
            "wcap-test-1111111111111111",
        )

    def test_core_agent_list_configures_the_agent(self):
        requests: list = []
        self.harness.client = core_client(requests)
        supervisor = self.harness.build()
        supervisor.tick()
        unit = f"switch-agent@{AGENT}.service"
        self.assertEqual(
            self.commands.actions(),
            [["reset-failed", unit], ["--no-block", "restart", unit]],
        )
        self.assertEqual(
            [request.full_url.rsplit("/", 1)[-1] for request in requests],
            ["agents", "heartbeat"],
        )
        written = (self.paths.agents_runtime / AGENT / "deployment.json").read_text()
        written = written.replace(str(self.paths.data), "/data").replace(
            str(self.paths.runtime), "/run/switch-hosted"
        )
        self.assertEqual(json.loads(written), fixture("deployment.json"))
        body = json.loads(requests[1].data)
        agent = core_agent()
        self.assertEqual(
            [
                (state["launch_id"], state["revision"], state["exit"])
                for state in body["agents"]
            ],
            [(agent["launch_id"], agent["revision"], None)],
        )
        self.harness.now = 14
        supervisor.tick()
        self.assertEqual(len(requests), 2)
        self.harness.now = 15
        supervisor.tick()
        self.assertEqual(
            [request.full_url.rsplit("/", 1)[-1] for request in requests],
            ["agents", "heartbeat", "heartbeat"],
        )

    def test_core_agent_without_a_credential_kind_is_stopped_and_kept(self):
        self.supervisor.reconcile(core_fixture("agents_response.json")["agents"])
        self.commands.clear()
        with self.assertLogs(worker.logger, "ERROR"):
            self.supervisor.reconcile([core_agent(provider_credential_kind=None)])
        unit = f"switch-agent@{AGENT}.service"
        self.assertEqual(
            self.commands.actions(),
            [["--no-block", "stop", unit], ["reset-failed", unit]],
        )
        self.assertFalse((self.paths.agents_runtime / AGENT).exists())
        self.assertTrue((self.paths.agents / AGENT / "home").is_dir())
        self.assertTrue(
            (self.paths.worktrees / AGENT / "example-org/example-repo").is_dir()
        )
        self.supervisor._observe()
        self.assertEqual(
            self.state(),
            {
                "launch_id": core_agent()["launch_id"],
                "agent_id": AGENT,
                "revision": 1,
                "process_state": "failed",
                "restarts": 0,
                "oom_kills": 0,
                "exit": {"code": None, "signal": None, "result": "invalid-config"},
                "since": "2026-01-01T00:00:00Z",
            },
        )

    def test_unavailable_agent_is_stopped_and_kept(self):
        unit = f"switch-agent@{AGENT}.service"
        self.supervisor.reconcile([valid_agent()])
        self.commands.clear()
        entry = core_fixture("agents_response_unavailable.json")["agents"][0]
        self.assertNotIn("worker_capability", entry)
        self.assertNotIn("switch_credentials", entry)
        with self.assertLogs(worker.logger, "WARNING"):
            self.supervisor.reconcile([entry])
        self.assertEqual(
            self.commands.actions(),
            [["--no-block", "stop", unit], ["reset-failed", unit]],
        )
        self.assertFalse((self.paths.agents_runtime / AGENT).exists())
        self.assertTrue((self.paths.agents / AGENT / "home").is_dir())
        self.assertTrue(
            (self.paths.worktrees / AGENT / "example-org/example-repo").is_dir()
        )
        self.supervisor._observe()
        self.assertEqual(
            self.state(),
            {
                "launch_id": entry["launch_id"],
                "agent_id": AGENT,
                "revision": 1,
                "process_state": "stopped",
                "restarts": 0,
                "oom_kills": 0,
                "exit": {"code": None, "signal": None, "result": "invalid-config"},
                "since": "2026-01-01T00:00:00Z",
            },
        )
        self.commands.clear()
        self.supervisor.reconcile([valid_agent()])
        self.assertEqual(
            self.commands.actions(),
            [["reset-failed", unit], ["--no-block", "restart", unit]],
        )

    def test_agent_with_a_missing_identity_is_stopped_and_kept(self):
        self.supervisor.reconcile([valid_agent()])
        entry = core_fixture("agents_response_unavailable.json")["agents"][0]
        entry["unavailable"] = "agent_identity_missing"
        with self.assertLogs(worker.logger, "WARNING"):
            self.supervisor.reconcile([entry])
        self.assertTrue((self.paths.agents / AGENT / "home").is_dir())
        self.supervisor._observe()
        self.assertEqual(self.state()["process_state"], "stopped")

    def test_malformed_unavailable_code_is_an_invalid_config(self):
        entry = core_fixture("agents_response_unavailable.json")["agents"][0]
        entry["unavailable"] = ""
        with self.assertLogs(worker.logger, "ERROR"):
            self.supervisor.reconcile([entry])
        self.supervisor._observe()
        self.assertEqual(self.state()["process_state"], "failed")
        self.assertEqual(self.state()["exit"]["result"], "invalid-config")

    def test_invalid_revision_stops_a_running_agent_but_keeps_its_data(self):
        self.supervisor.reconcile([valid_agent()])
        self.commands.clear()
        with self.assertLogs(worker.logger, "ERROR"):
            self.supervisor.reconcile(
                [valid_agent(revision=4, provider_credential_kind="oauth")]
            )
        unit = f"switch-agent@{AGENT}.service"
        self.assertEqual(
            self.commands.actions(),
            [["--no-block", "stop", unit], ["reset-failed", unit]],
        )
        self.assertFalse((self.paths.agents_runtime / AGENT).exists())
        self.assertTrue((self.paths.agents / AGENT).exists())

    def test_duplicate_agents_are_all_invalid(self):
        with self.assertLogs(worker.logger, "ERROR"):
            self.supervisor.reconcile(
                [valid_agent(), valid_agent(launch_id="req-0000000000000009")]
            )
        self.supervisor._observe()
        states = self.supervisor.heartbeat_body()["agents"]
        self.assertEqual(
            [agent["exit"]["result"] for agent in states], ["invalid-config"] * 2
        )
        self.assertFalse((self.paths.agents_runtime / AGENT).exists())

    def test_entries_without_identity_are_left_out(self):
        with self.assertLogs(worker.logger, "ERROR"):
            self.supervisor.reconcile([{"agent_id": AGENT}, "junk"])
        self.supervisor._observe()
        self.assertEqual(self.supervisor.heartbeat_body()["agents"], [])
        self.assertEqual(self.commands.actions(), [])

    def test_setup_failure_is_reported(self):
        (self.paths.worktrees / AGENT).write_text("not a directory")
        with (
            self.assertLogs(worker.logger, "ERROR"),
            self.assertRaises(worker.ReconcileIncomplete),
        ):
            self.supervisor.reconcile([valid_agent()])
        self.supervisor._observe()
        self.assertEqual(self.state()["process_state"], "failed")
        self.assertEqual(self.state()["exit"]["result"], "setup-failed")
        self.assertEqual(self.commands.actions(), [])

    def test_directory_swapped_for_a_symlink_is_not_followed(self):
        victim = self.temporary / "victim"
        victim.mkdir(mode=0o755)
        real_mkdir = os.mkdir

        def racing_mkdir(path, mode=0o777, *, dir_fd=None):
            real_mkdir(path, mode, dir_fd=dir_fd)
            if os.path.basename(os.fspath(path)) == "home":
                os.rmdir(path, dir_fd=dir_fd)
                os.symlink(victim, path, dir_fd=dir_fd)

        with (
            mock.patch.object(worker.os, "mkdir", racing_mkdir),
            self.assertLogs(worker.logger, "ERROR"),
            self.assertRaises(worker.ReconcileIncomplete),
        ):
            self.supervisor.reconcile([valid_agent()])
        self.assertEqual(stat.S_IMODE(victim.stat().st_mode), 0o755)
        for call in worker.os.chown.call_args_list + worker.os.fchown.call_args_list:
            self.assertNotIn(str(victim), str(call))
        self.supervisor._observe()
        self.assertEqual(self.state()["exit"]["result"], "setup-failed")
        self.assertEqual(self.commands.actions(), [])

    def test_loosened_directory_modes_are_repaired(self):
        self.supervisor.reconcile([valid_agent()])
        loosened = (
            self.paths.agents / AGENT / "home",
            self.paths.worktrees / AGENT / "example-org/example-repo",
            self.paths.repos,
        )
        for path in loosened:
            path.chmod(0o755)
        worker.prepare_layout(self.paths, os.getuid(), os.getgid())
        self.supervisor.reconcile([valid_agent()])
        self.supervisor._observe()
        self.assertIsNone(self.state()["exit"])
        for path in loosened:
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700, path)

    def test_absent_agent_is_removed_and_mirrors_are_kept(self):
        self.supervisor.reconcile([valid_agent(), second_agent()])
        mirror = self.paths.repos / "example-org/example-repo.git"
        mirror.mkdir(parents=True)
        (self.paths.agents / AGENT / "home/notes").write_text("x")
        (self.paths.agents / "not-a-uuid").mkdir()
        self.commands.clear()
        with self.assertLogs(worker.logger, "WARNING") as logs:
            self.supervisor.reconcile([second_agent()])
        actions = self.commands.actions()
        self.assertIn(["stop", f"switch-agent@{AGENT}.service"], actions)
        self.assertNotIn(["stop", f"switch-agent@{AGENT_2}.service"], actions)
        self.assertFalse((self.paths.agents_runtime / AGENT).exists())
        self.assertFalse((self.paths.agents / AGENT).exists())
        self.assertFalse((self.paths.worktrees / AGENT).exists())
        self.assertTrue((self.paths.agents / AGENT_2).exists())
        self.assertTrue((self.paths.agents / "not-a-uuid").exists())
        self.assertTrue(mirror.exists())
        worktree = self.paths.worktrees / AGENT / "example-org/example-repo"
        self.assertEqual(
            self.harness.git.calls,
            [
                (mirror, ["worktree", "remove", "--force", str(worktree)]),
                (mirror, ["worktree", "prune"]),
            ],
        )
        self.assertTrue(any("not-a-uuid" in line for line in logs.output))

    def test_failed_prune_is_retried(self):
        class FlakyPruneGit(FakeGit):
            def __init__(self):
                super().__init__()
                self.fail_prune = True

            def run(self, mirror, arguments):
                super().run(mirror, arguments)
                if arguments == ["worktree", "prune"] and self.fail_prune:
                    self.fail_prune = False
                    raise worker.WorkerError("git worktree prune failed.")

        harness = Harness(self.temporary / "prune", git=FlakyPruneGit())
        harness.supervisor.reconcile([valid_agent()])
        mirror = harness.paths.repos / "example-org/example-repo.git"
        mirror.mkdir(parents=True)
        with (
            self.assertLogs(worker.logger, "WARNING"),
            self.assertRaises(worker.ReconcileIncomplete),
        ):
            harness.supervisor.reconcile([])
        self.assertFalse((harness.paths.worktrees / AGENT).exists())
        harness.supervisor.reconcile([])
        self.assertEqual(
            [arguments for _mirror, arguments in harness.git.calls][-2:],
            [["worktree", "prune"], ["worktree", "prune"]],
        )
        harness.git.calls.clear()
        harness.supervisor.reconcile([])
        self.assertEqual(harness.git.calls, [])

    def test_owner_named_workspace_is_cleaned_up(self):
        self.supervisor.reconcile([valid_agent(repository="workspace/example-repo")])
        mirror = self.paths.repos / "workspace/example-repo.git"
        mirror.mkdir(parents=True)
        with self.assertLogs(worker.logger, "WARNING"):
            self.supervisor.reconcile([])
        worktree = self.paths.worktrees / AGENT / "workspace/example-repo"
        self.assertEqual(
            self.harness.git.calls,
            [
                (mirror, ["worktree", "remove", "--force", str(worktree)]),
                (mirror, ["worktree", "prune"]),
            ],
        )

    def test_agent_with_blocked_ownership_is_not_started(self):
        self.harness.ownership_blocked.add(AGENT)
        supervisor = self.harness.build()
        with self.assertLogs(worker.logger, "ERROR"):
            supervisor.reconcile([valid_agent(), second_agent()])
        self.assertEqual(
            self.commands.actions(),
            [
                ["--no-block", "stop", f"switch-agent@{AGENT}.service"],
                ["reset-failed", f"switch-agent@{AGENT}.service"],
                ["reset-failed", f"switch-agent@{AGENT_2}.service"],
                ["--no-block", "restart", f"switch-agent@{AGENT_2}.service"],
            ],
        )
        self.assertFalse((self.paths.agents_runtime / AGENT).exists())
        supervisor._observe()
        body = supervisor.heartbeat_body()
        states = {agent["agent_id"]: agent for agent in body["agents"]}
        self.assertEqual(states[AGENT]["process_state"], "failed")
        self.assertEqual(
            states[AGENT]["exit"],
            {"code": None, "signal": None, "result": "ownership-invalid"},
        )
        self.assertNotEqual(states[AGENT_2]["process_state"], "failed")

    def test_worktree_without_mirror_skips_git(self):
        self.supervisor.reconcile([valid_agent()])
        with self.assertLogs(worker.logger, "WARNING"):
            self.supervisor.reconcile([])
        self.assertEqual(self.harness.git.calls, [])
        self.assertFalse((self.paths.worktrees / AGENT).exists())

    def test_failed_removal_is_logged_and_retried(self):
        self.supervisor.reconcile([valid_agent()])
        failing = [True]
        original = self.commands.run

        def run(arguments, capture=True):
            if arguments[1] == "stop" and failing and failing.pop():
                raise worker.WorkerError("Required host operation failed: systemctl.")
            return original(arguments, capture)

        self.commands.run = run
        with (
            self.assertLogs(worker.logger, "ERROR"),
            self.assertRaises(worker.ReconcileIncomplete),
        ):
            self.supervisor.reconcile([])
        self.assertTrue((self.paths.agents / AGENT).exists())
        with self.assertLogs(worker.logger, "WARNING"):
            self.supervisor.reconcile([])
        self.assertFalse((self.paths.agents / AGENT).exists())

    def test_removal_stops_when_git_outlives_its_kill(self):
        class AbandoningGit(FakeGit):
            def run(self, mirror, arguments):
                super().run(mirror, arguments)
                raise worker.GitAbandoned("git worktree remove did not exit.")

        harness = Harness(self.temporary / "abandoned", git=AbandoningGit())
        harness.supervisor.reconcile([valid_agent()])
        (harness.paths.repos / "example-org/example-repo.git").mkdir(parents=True)
        with (
            self.assertLogs(worker.logger, "ERROR"),
            self.assertRaises(worker.ReconcileIncomplete),
        ):
            harness.supervisor.reconcile([])
        self.assertTrue(
            (harness.paths.worktrees / AGENT / "example-org/example-repo").is_dir()
        )
        self.assertTrue((harness.paths.agents / AGENT).is_dir())
        self.assertEqual([call[1][1] for call in harness.git.calls], ["remove"])

    def test_stale_temporary_runtime_directories_are_cleaned(self):
        stale = self.paths.agents_runtime / ".tmp-crashed"
        stale.mkdir(mode=0o750)
        (stale / "switch.json").write_text("{}")
        self.supervisor.reconcile([])
        self.assertFalse(stale.exists())

    def test_slice_memory_is_total_minus_one_gibibyte(self):
        self.supervisor.limit_slice()
        self.assertEqual(
            self.commands.actions(),
            [
                [
                    "set-property",
                    "--runtime",
                    "switch-agents.slice",
                    f"MemoryMax={16 * 1024**3 - 1024**3}",
                ]
            ],
        )


class ProcessStateTests(RootPatched):
    def setUp(self):
        super().setUp()
        self.harness = Harness(self.temporary / "machine")
        self.supervisor = self.harness.supervisor
        self.commands = self.harness.commands

    def observe(self, desired="running", touched=False, **properties):
        held = worker.HeldAgent("req-1", AGENT, 3, desired, None)
        self.commands.units[AGENT] = properties
        if touched:
            self.supervisor._touched.add(AGENT)
        else:
            self.supervisor._touched.discard(AGENT)
        return self.supervisor._unit_state(held)

    def test_systemd_states_map_to_process_states(self):
        cases = [
            ({"ActiveState": "activating", "SubState": "start"}, "starting"),
            ({"ActiveState": "active", "SubState": "running"}, "running"),
            ({"ActiveState": "reloading", "SubState": "reload"}, "running"),
            ({"ActiveState": "activating", "SubState": "auto-restart"}, "restarting"),
            (
                {"ActiveState": "activating", "SubState": "auto-restart-queued"},
                "restarting",
            ),
            ({"ActiveState": "deactivating", "SubState": "stop-sigterm"}, "stopping"),
            ({"ActiveState": "failed", "Result": "start-limit-hit"}, "crashed"),
            ({"ActiveState": "failed", "Result": "exit-code"}, "failed"),
            ({"ActiveState": "failed", "Result": "oom-kill"}, "failed"),
            ({"ActiveState": "inactive"}, "pending"),
        ]
        for properties, expected in cases:
            with self.subTest(properties=properties):
                self.assertEqual(self.observe(**properties)[0], expected)
        self.assertEqual(self.observe(touched=True)[0], "stopped")
        self.assertEqual(self.observe(desired="stopped")[0], "stopped")
        self.assertEqual(self.observe(ExecMainExitTimestampMonotonic="5")[0], "stopped")
        with self.assertRaisesRegex(worker.WorkerError, "unknown unit state"):
            self.observe(ActiveState="maintenance")

    def test_restarts_and_exit_shape(self):
        state, restarts, exit_value = self.observe(
            ActiveState="failed",
            Result="start-limit-hit",
            NRestarts="5",
            ExecMainCode="2",
            ExecMainStatus="9",
            ExecMainExitTimestampMonotonic="100",
        )
        self.assertEqual((state, restarts), ("crashed", 5))
        self.assertEqual(
            exit_value, {"code": None, "signal": 9, "result": "start-limit-hit"}
        )
        _, _, exit_value = self.observe(
            ActiveState="activating",
            SubState="auto-restart",
            Result="exit-code",
            ExecMainCode="1",
            ExecMainStatus="3",
            ExecMainExitTimestampMonotonic="100",
        )
        self.assertEqual(exit_value, {"code": 3, "signal": None, "result": "exit-code"})
        _, _, exit_value = self.observe(
            ActiveState="active",
            SubState="running",
            ExecMainCode="1",
            ExecMainStatus="3",
        )
        self.assertIsNone(exit_value)
        self.assertIsNone(self.observe()[2])

    def test_oom_kills_are_counted_once_per_exit_and_persisted(self):
        self.supervisor.reconcile([valid_agent()])
        oom = {
            "ActiveState": "activating",
            "SubState": "auto-restart",
            "Result": "oom-kill",
            "ExecMainCode": "2",
            "ExecMainStatus": "9",
        }
        units = self.commands.units
        units[AGENT] = {**oom, "ExecMainExitTimestampMonotonic": "100"}
        self.supervisor._observe()
        self.supervisor._observe()
        units[AGENT] = {
            "ActiveState": "active",
            "SubState": "running",
            "ExecMainExitTimestampMonotonic": "100",
        }
        self.supervisor._observe()
        units[AGENT] = {**oom, "ExecMainExitTimestampMonotonic": "200"}
        self.supervisor._observe()
        records = self.harness.paths.agent_records
        self.assertEqual(stat.S_IMODE(records.stat().st_mode), 0o600)
        self.assertEqual(
            json.loads(records.read_text()),
            {
                "version": 1,
                "agents": {
                    AGENT: {
                        "oomKills": 2,
                        "lastOomExit": f"{BOOT_1}:200",
                        "revision": 1,
                    }
                },
            },
        )
        restarted = self.harness.build()
        restarted.reconcile([valid_agent()])
        restarted._observe()
        self.assertEqual(restarted.heartbeat_body()["agents"][0]["oom_kills"], 2)
        with self.assertLogs(worker.logger, "WARNING"):
            restarted.reconcile([])
        self.assertEqual(json.loads(records.read_text()), {"version": 1, "agents": {}})

    def test_new_revision_resets_the_oom_count(self):
        self.supervisor.reconcile([valid_agent()])
        self.commands.units[AGENT] = {
            "ActiveState": "activating",
            "SubState": "auto-restart",
            "Result": "oom-kill",
            "ExecMainCode": "2",
            "ExecMainStatus": "9",
            "ExecMainExitTimestampMonotonic": "100",
        }
        self.supervisor._observe()
        self.assertEqual(self.supervisor.heartbeat_body()["agents"][0]["oom_kills"], 1)
        self.supervisor.reconcile([valid_agent(revision=2)])
        self.supervisor._observe()
        self.assertEqual(self.supervisor.heartbeat_body()["agents"][0]["oom_kills"], 0)
        self.assertEqual(
            json.loads(self.harness.paths.agent_records.read_text())["agents"][AGENT],
            {"oomKills": 0, "lastOomExit": f"{BOOT_1}:100", "revision": 2},
        )
        restarted = self.harness.build()
        restarted.reconcile([valid_agent(revision=2)])
        restarted._observe()
        self.assertEqual(restarted.heartbeat_body()["agents"][0]["oom_kills"], 0)

    def test_invalid_records_file_fails_loud(self):
        worker._write_root_json(self.harness.paths.agent_records, {"version": 9})
        with self.assertRaisesRegex(worker.WorkerError, "records"):
            self.harness.build()

    def test_since_changes_only_with_the_process_state(self):
        self.supervisor.reconcile([valid_agent()])
        self.commands.units[AGENT] = {"ActiveState": "active", "SubState": "running"}
        self.assertTrue(self.supervisor._observe())
        self.harness.clock_value = datetime(2026, 1, 1, 0, 5, tzinfo=UTC)
        self.assertFalse(self.supervisor._observe())
        self.assertEqual(
            self.supervisor.heartbeat_body()["agents"][0]["since"],
            "2026-01-01T00:00:00Z",
        )
        self.commands.units[AGENT] = {"ActiveState": "deactivating"}
        self.assertTrue(self.supervisor._observe())
        self.assertEqual(
            self.supervisor.heartbeat_body()["agents"][0]["since"],
            "2026-01-01T00:05:00Z",
        )

    def test_heartbeat_body_matches_the_contract_fixture(self):
        worker._write_root_json(
            self.harness.paths.agent_records,
            {
                "version": 1,
                "agents": {
                    AGENT: {
                        "oomKills": 1,
                        "lastOomExit": f"{BOOT_1}:50",
                        "revision": 1,
                    }
                },
            },
        )
        supervisor = self.harness.build()
        supervisor.reconcile(core_fixture("agents_response.json")["agents"])
        self.commands.units[AGENT] = {
            "ActiveState": "failed",
            "SubState": "failed",
            "Result": "start-limit-hit",
            "NRestarts": "5",
            "ExecMainCode": "2",
            "ExecMainStatus": "9",
            "ExecMainExitTimestampMonotonic": "100",
        }
        supervisor._observe()
        body = supervisor.heartbeat_body()
        expected = core_fixture("heartbeat_request.json")
        self.assertEqual(structure(body), structure(expected))
        self.assertEqual(expected["disk"]["path"], "/data")
        expected["disk"]["path"] = str(self.harness.paths.data)
        self.assertEqual(body, expected)


class LoopTests(RootPatched):
    def setUp(self):
        super().setUp()
        self.harness = Harness(self.temporary / "machine")
        self.supervisor = self.harness.supervisor
        self.client = self.harness.client
        self.commands = self.harness.commands

    def test_boot_fetches_reconciles_and_heartbeats(self):
        self.client.listings.append(listing(valid_agent()))
        self.supervisor.tick()
        self.assertEqual(self.client.list_calls, 1)
        self.assertEqual(len(self.client.bodies), 1)
        self.assertEqual(self.client.bodies[0]["agents"][0]["process_state"], "stopped")
        self.harness.now = 3
        self.supervisor.tick()
        self.assertEqual(len(self.client.bodies), 1)
        self.commands.units[AGENT] = {"ActiveState": "active", "SubState": "running"}
        self.harness.now = 6
        self.supervisor.tick()
        self.assertEqual(len(self.client.bodies), 2)
        self.assertEqual(self.client.bodies[1]["agents"][0]["process_state"], "running")
        self.harness.now = 6 + 15
        self.supervisor.tick()
        self.assertEqual(len(self.client.bodies), 3)
        self.assertEqual(self.client.list_calls, 1)

    def test_heartbeat_interval_comes_from_the_response(self):
        self.client.listings.append(listing())
        self.client.heartbeats.append(
            {
                "agents_version": 3,
                "machine_desired_state": "stopped",
                "heartbeat_every_s": 30,
            }
        )
        self.supervisor.tick()
        self.harness.now = 20
        self.supervisor.tick()
        self.assertEqual(len(self.client.bodies), 1)
        self.assertEqual(self.commands.actions(), [])
        self.harness.now = 30
        self.supervisor.tick()
        self.assertEqual(len(self.client.bodies), 2)

    def test_changed_agents_version_refetches(self):
        self.client.listings += [listing(), listing(valid_agent(), version=8)]
        self.client.heartbeats.append(
            {
                "agents_version": 8,
                "machine_desired_state": "running",
                "heartbeat_every_s": 15,
            }
        )
        self.supervisor.tick()
        self.assertEqual(self.client.list_calls, 2)
        self.assertEqual(
            self.commands.actions()[-1],
            ["--no-block", "restart", f"switch-agent@{AGENT}.service"],
        )

    def test_exit_75_refetches_the_list(self):
        self.client.listings += [listing(valid_agent()), listing(valid_agent())]
        self.supervisor.tick()
        self.commands.units[AGENT] = {
            "ActiveState": "failed",
            "Result": "exit-code",
            "ExecMainCode": "1",
            "ExecMainStatus": "75",
            "ExecMainExitTimestampMonotonic": "100",
        }
        self.harness.now = 3
        with self.assertLogs(worker.logger, "WARNING"):
            self.supervisor.tick()
        self.assertEqual(self.client.list_calls, 2)
        self.harness.now = 6
        self.supervisor.tick()
        self.assertEqual(self.client.list_calls, 2)

    def test_failed_fetch_is_retried(self):
        self.client.listings += [worker.CoreUnavailable("down"), listing()]
        with self.assertLogs(worker.logger, "WARNING"):
            self.supervisor.tick()
        self.harness.now = 3
        self.supervisor.tick()
        self.assertEqual(self.client.list_calls, 1)
        self.harness.now = 15
        self.supervisor.tick()
        self.assertEqual(self.client.list_calls, 2)

    def test_failed_reconcile_is_retried_with_backoff(self):
        blocker = self.harness.paths.worktrees / AGENT
        blocker.write_text("not a directory")
        self.client.listings += [listing(valid_agent()) for _ in range(3)]
        with self.assertLogs(worker.logger, "ERROR"):
            self.supervisor.tick()
        self.assertEqual(self.client.list_calls, 1)
        self.assertIsNone(self.supervisor._agents_version)
        self.harness.now = 14
        self.supervisor.tick()
        self.assertEqual(self.client.list_calls, 1)
        self.harness.now = 15
        with self.assertLogs(worker.logger, "ERROR"):
            self.supervisor.tick()
        self.assertEqual(self.client.list_calls, 2)
        self.harness.now = 44
        self.supervisor.tick()
        self.assertEqual(self.client.list_calls, 2)
        blocker.unlink()
        self.harness.now = 45
        self.supervisor.tick()
        self.assertEqual(self.client.list_calls, 3)
        self.assertEqual(self.supervisor._agents_version, 3)
        self.assertEqual(
            self.commands.actions()[-1],
            ["--no-block", "restart", f"switch-agent@{AGENT}.service"],
        )
        self.harness.now = 200
        self.supervisor.tick()
        self.assertEqual(self.client.list_calls, 3)

    def test_failed_heartbeat_is_retried_next_interval(self):
        self.client.listings.append(listing())
        self.client.heartbeats.append(worker.CoreUnavailable("down"))
        with self.assertLogs(worker.logger, "WARNING"):
            self.supervisor.tick()
        self.harness.now = 15
        self.supervisor.tick()
        self.assertEqual(len(self.client.bodies), 2)

    def test_rejected_agent_list_leaves_agents_and_their_data_alone(self):
        for status, retired in (
            (400, False),
            (409, False),
            (500, False),
            (503, False),
            (410, True),
        ):
            with self.subTest(status=status):
                harness = Harness(self.temporary / f"machine-{status}")
                for directory in (
                    harness.paths.agents / AGENT / "home",
                    harness.paths.worktrees / AGENT / "workspace",
                ):
                    directory.mkdir(parents=True)
                    (directory / "notes").write_text("kept")
                requests: list = []
                harness.client = core_client(requests, status)
                supervisor = harness.build()
                with self.assertLogs(worker.logger, "WARNING"):
                    supervisor.tick()
                self.assertEqual(
                    harness.commands.actions(),
                    [["stop", "switch-agent@*.service"]] if retired else [],
                )
                self.assertEqual(supervisor.heartbeat_body()["agents"], [])
                self.assertEqual(
                    (harness.paths.agents / AGENT / "home/notes").read_text(), "kept"
                )
                self.assertEqual(
                    (harness.paths.worktrees / AGENT / "workspace/notes").read_text(),
                    "kept",
                )
                self.assertEqual(requests[0].full_url.rsplit("/", 1)[-1], "agents")

    def test_401_stops_the_supervisor(self):
        self.client.listings.append(worker.WorkerError("rejected"))
        with self.assertRaises(worker.WorkerError):
            self.supervisor.tick()

    def test_410_stops_all_agents_idles_and_resumes(self):
        stop_all = ["stop", "switch-agent@*.service"]
        self.client.listings += [listing(valid_agent()), listing(valid_agent())]
        self.client.heartbeats += [
            worker.MachineRetired(),
            worker.MachineRetired(),
            core_fixture("heartbeat_response.json"),
        ]
        with self.assertLogs(worker.logger, "WARNING"):
            self.supervisor.tick()
        self.assertEqual(self.commands.actions()[-1], stop_all)
        self.assertEqual(len(self.client.bodies), 1)
        self.harness.now = 59
        self.supervisor.tick()
        self.assertEqual(len(self.client.bodies), 1)
        self.harness.now = 60
        self.supervisor.tick()
        self.assertEqual(len(self.client.bodies), 2)
        self.assertEqual(self.commands.actions().count(stop_all), 1)
        self.assertEqual(self.client.bodies[1]["agents"][0]["process_state"], "stopped")
        self.harness.now = 120
        with self.assertLogs(worker.logger, "WARNING"):
            self.supervisor.tick()
        self.assertEqual(len(self.client.bodies), 3)
        self.assertEqual(self.client.list_calls, 1)
        self.harness.now = 123
        self.supervisor.tick()
        self.assertEqual(self.client.list_calls, 2)
        self.assertEqual(
            self.commands.actions()[-1],
            ["--no-block", "start", f"switch-agent@{AGENT}.service"],
        )

    def test_410_on_the_list_retires_and_401_while_retired_exits(self):
        self.client.listings.append(worker.MachineRetired())
        self.client.heartbeats.append(worker.WorkerError("rejected"))
        with self.assertLogs(worker.logger, "WARNING"):
            self.supervisor.tick()
        self.assertEqual(self.commands.actions(), [["stop", "switch-agent@*.service"]])
        self.assertEqual(self.client.bodies, [])
        self.harness.now = 60
        with self.assertRaises(worker.WorkerError):
            self.supervisor.tick()


class GitTests(RootPatched):
    def setUp(self):
        super().setUp()
        real_git = shutil.which("git")
        if real_git is None:
            self.skipTest("git is not installed")
        self.real_git = real_git
        tools = self.temporary / "tools"
        tools.mkdir()
        self.flock = tools / "flock"
        self.flock.write_text(
            f"#!{sys.executable}\n"
            "import fcntl, os, sys\n"
            "if sys.argv[1] != '--no-fork':\n"
            "    sys.exit('flock must not fork')\n"
            "fd = os.open(sys.argv[2], os.O_RDWR | os.O_CREAT, 0o600)\n"
            "fcntl.flock(fd, fcntl.LOCK_EX)\n"
            "os.set_inheritable(fd, True)\n"
            "os.execv(sys.argv[3], sys.argv[3:])\n"
        )
        self.record = tools / "record"
        self.git = tools / "git"
        self.git.write_text(
            f"#!{sys.executable}\n"
            "import fcntl, os, sys\n"
            "arguments = sys.argv[1:]\n"
            "mirror = arguments[arguments.index('-C') + 1]\n"
            "fd = os.open(mirror + '.lock', os.O_RDWR)\n"
            "try:\n"
            "    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)\n"
            "    held = 'free'\n"
            "except BlockingIOError:\n"
            "    held = 'held'\n"
            "os.close(fd)\n"
            f"with open({str(self.record)!r}, 'a') as handle:\n"
            "    handle.write(held + ' ' + ' '.join(arguments[2:4]) + '\\n')\n"
            f"os.execv({real_git!r}, [{real_git!r}] + arguments)\n"
        )
        for path in (self.flock, self.git):
            path.chmod(0o755)
        self.runner = worker.GitRunner([], str(self.flock), str(self.git))

    def git_setup(self, *arguments):
        subprocess.run(
            [self.real_git, *arguments],
            check=True,
            capture_output=True,
            env={
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                "HOME": str(self.temporary),
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": "/dev/null",
            },
        )

    def git_output(self, *arguments) -> str:
        return subprocess.run(
            [self.real_git, *arguments], check=True, capture_output=True, text=True
        ).stdout

    def test_removal_runs_real_git_under_the_mirror_lock(self):
        harness = Harness(self.temporary / "machine", git=self.runner)
        harness.supervisor.reconcile([valid_agent()])
        source = self.temporary / "source"
        self.git_setup("init", "-q", str(source))
        self.git_setup(
            "-C",
            str(source),
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.test",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "init",
        )
        mirror = harness.paths.repos / "example-org/example-repo.git"
        mirror.parent.mkdir(mode=0o700)
        self.git_setup("clone", "-q", "--bare", str(source), str(mirror))
        worktree = harness.paths.worktrees / AGENT / "example-org/example-repo"
        self.git_setup(
            "-C",
            str(mirror),
            "worktree",
            "add",
            "-q",
            "-b",
            f"switch/{AGENT}",
            str(worktree),
        )
        (worktree / "work.txt").write_text("uncommitted")
        self.assertIn(
            str(worktree), self.git_output("-C", str(mirror), "worktree", "list")
        )
        harness.commands.clear()
        with self.assertLogs(worker.logger, "WARNING"):
            harness.supervisor.reconcile([])
        unit = f"switch-agent@{AGENT}.service"
        self.assertEqual(
            harness.commands.actions(), [["stop", unit], ["reset-failed", unit]]
        )
        self.assertFalse(worktree.exists())
        self.assertFalse((harness.paths.worktrees / AGENT).exists())
        self.assertFalse((harness.paths.agents / AGENT).exists())
        self.assertTrue(mirror.exists())
        self.assertEqual(
            self.record.read_text().splitlines(),
            ["held worktree remove", "held worktree prune"],
        )
        self.assertNotIn(
            str(worktree), self.git_output("-C", str(mirror), "worktree", "list")
        )
        self.assertIn(
            f"switch/{AGENT}",
            self.git_output("-C", str(mirror), "branch", "--list", f"switch/{AGENT}"),
        )

    def test_git_waits_for_a_concurrent_lock_holder(self):
        mirror = self.temporary / "mirror.git"
        self.git_setup("init", "-q", "--bare", str(mirror))
        descriptor = os.open(f"{mirror}.lock", os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        done = threading.Event()
        errors: list[BaseException] = []

        def run():
            try:
                self.runner.run(mirror, ["worktree", "prune"])
            except BaseException as error:
                errors.append(error)
            done.set()

        thread = threading.Thread(target=run)
        thread.start()
        try:
            self.assertFalse(done.wait(0.5))
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)
        self.assertTrue(done.wait(30))
        thread.join()
        self.assertEqual(errors, [])

    def script(self, name: str, body: str) -> Path:
        path = self.temporary / "tools" / name
        path.write_text(f"#!{sys.executable}\n" + body)
        path.chmod(0o755)
        return path

    def test_git_failure_reports_the_exit_status_but_not_stderr(self):
        secret = "ghs_placeholder-secret-from-repo-config"
        git = self.script(
            "noisy-git", f"import sys\nsys.stderr.write({secret!r})\nsys.exit(3)\n"
        )
        runner = worker.GitRunner([], str(self.flock), str(git))
        mirror = self.temporary / "mirror.git"
        with self.assertRaises(worker.WorkerError) as raised:
            runner.run(mirror, ["worktree", "prune"])
        self.assertEqual(
            str(raised.exception),
            f"git worktree prune on {mirror} failed with exit status 3.",
        )
        self.assertNotIn(secret, str(raised.exception))

    def test_timeout_kills_every_process_holding_the_lock(self):
        child_record = self.temporary / "child-pid"
        git = self.script(
            "hanging-git",
            "import os, time\n"
            "pid = os.fork()\n"
            "if pid == 0:\n"
            "    time.sleep(60)\n"
            "    os._exit(0)\n"
            f"with open({str(child_record)!r}, 'w') as handle:\n"
            "    handle.write(str(pid))\n"
            "time.sleep(60)\n",
        )
        runner = worker.GitRunner([], str(self.flock), str(git))
        mirror = self.temporary / "mirror.git"
        with mock.patch.object(worker, "GIT_TIMEOUT_SECONDS", 1):
            with self.assertRaises(worker.WorkerError) as raised:
                runner.run(mirror, ["worktree", "prune"])
        child = int(child_record.read_text())
        self.addCleanup(self.kill_quietly, child)
        with self.assertRaises(ProcessLookupError):
            os.kill(child, 0)
        descriptor = os.open(f"{mirror}.lock", os.O_RDWR)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            os.close(descriptor)
        self.assertIn("timed out", str(raised.exception))

    @staticmethod
    def kill_quietly(pid: int) -> None:
        with contextlib.suppress(ProcessLookupError):
            os.kill(pid, 9)

    def test_setpriv_prefix_drops_everything(self):
        self.assertEqual(
            worker.setpriv_prefix(1001, 1002),
            [
                "/usr/bin/setpriv",
                "--reuid=1001",
                "--regid=1002",
                "--clear-groups",
                "--no-new-privs",
                "--inh-caps=-all",
                "--ambient-caps=-all",
                "--bounding-set=-all",
            ],
        )


def unit_file(name: str) -> configparser.ConfigParser:
    parser = configparser.ConfigParser(interpolation=None, strict=False)
    parser.optionxform = str  # type: ignore[assignment,method-assign]
    parser.read_string((HERE / name).read_text())
    return parser


class UnitFileTests(unittest.TestCase):
    def test_agent_unit(self):
        unit = unit_file("switch-agent@.service")
        self.assertEqual(unit.sections(), ["Unit", "Service"])
        self.assertEqual(
            dict(unit["Unit"]),
            {
                "Description": "Switch agent %i",
                "StartLimitIntervalSec": "600",
                "StartLimitBurst": "5",
                "AssertPathIsMountPoint": "/data",
            },
        )
        service = unit["Service"]
        expected = {
            "Type": "simple",
            "User": "switch-agent",
            "Group": "switch-agent",
            "Slice": "switch-agents.slice",
            "EnvironmentFile": "/run/switch-hosted/agents/%i/env",
            "ExecStart": f"{worker.UNIT_NODE_PATH} {worker.UNIT_BOOTSTRAP_PATH} /data/agents/%i /run/switch-hosted/agents/%i/deployment.json",
            "WorkingDirectory": "/data/agents/%i",
            "Restart": "on-failure",
            "RestartSec": "10s",
            "RestartPreventExitStatus": "75",
            "MemoryMax": "75%",
            "OOMPolicy": "stop",
            "NoNewPrivileges": "yes",
            "CapabilityBoundingSet": "",
            "AmbientCapabilities": "",
            "UMask": "0077",
        }
        for key, value in expected.items():
            self.assertEqual(service[key], value, key)
        self.assertNotIn("PartOf", service)

    def test_slice_and_supervisor_units(self):
        slice_unit = unit_file("switch-agents.slice")
        self.assertEqual(slice_unit["Slice"]["MemoryAccounting"], "yes")
        self.assertNotIn("MemoryMax", slice_unit["Slice"])
        supervisor = unit_file("switch-hosted-worker.service")["Service"]
        self.assertEqual(supervisor["User"], "root")
        self.assertEqual(supervisor["Restart"], "always")
        self.assertEqual(supervisor["RuntimeDirectory"], "switch-hosted")
        self.assertEqual(supervisor["RuntimeDirectoryPreserve"], "yes")
        self.assertIn("CAP_SETUID", supervisor["CapabilityBoundingSet"].split())
        self.assertIn("CAP_SETGID", supervisor["CapabilityBoundingSet"].split())

    def test_install_ships_units_and_runtime_matches_the_unit(self):
        install = (HERE / "install.sh").read_text()
        for name in (
            "switch-agent@.service",
            "switch-agents.slice",
            "switch-hosted-worker.service",
        ):
            self.assertIn(f'"$source_dir/{name}" /etc/systemd/system/{name}', install)
        for command in ("flock", "systemctl", "systemd-mount"):
            self.assertRegex(install, rf"for command in [^\n]* {command}[ ;]")
        self.assertIn("systemctl daemon-reload", install)
        runtime = json.loads((HERE / "runtime.json").read_text())
        self.assertEqual(runtime["nodePath"], worker.UNIT_NODE_PATH)
        self.assertEqual(runtime["bootstrapPath"], worker.UNIT_BOOTSTRAP_PATH)


if __name__ == "__main__":
    unittest.main()
