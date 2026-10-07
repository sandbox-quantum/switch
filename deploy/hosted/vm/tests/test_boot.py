from __future__ import annotations

import contextlib
import fcntl
import importlib.util
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).parent
MODULE_PATH = HERE.parent / "switch_machine_boot.py"
SPEC = importlib.util.spec_from_file_location("switch_machine_boot", MODULE_PATH)
assert SPEC and SPEC.loader
boot = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = boot
SPEC.loader.exec_module(boot)

TESTDATA = HERE / "testdata"
INSTANCE = "i-0123456789abcdef0"
OTHER_INSTANCE = "i-0fedcba9876543210"
BOOT_1 = "00000000-0000-4000-8000-00000000b001"
BOOT_2 = "00000000-0000-4000-8000-00000000b002"
FS_UUID = "00000000-0000-4000-8000-00000000f001"
FINGERPRINT = "sha256:" + "1" * 64
AGENT_1 = "3f1c2b4a-0000-4000-8000-0000000000a1"
AGENT_2 = "managed_agent-2"
ACCOUNTS = boot.Accounts(
    controller_uid=990, controller_gid=990, agent_uid=991, agent_gid=991
)
ZERO = "0" * 64


def text(name: str) -> str:
    return (TESTDATA / name).read_text()


def fixture(name: str):
    return json.loads(text(name))


def mode(path: Path) -> int:
    return stat.S_IMODE(path.lstat().st_mode)


def machine_config(root: Path) -> boot.MachineConfig:
    (root / "etc").mkdir(exist_ok=True)
    assignment = root / "etc/assignment.json"
    runtime = root / "etc/runtime.json"
    assignment.write_text(text("assignment.json"))
    runtime.write_text(text("runtime.json"))
    return boot.load_machine_config(assignment, runtime)


class FakeCommands:
    """Answers lsblk, wipefs and findmnt, and records every command it runs."""

    def __init__(
        self,
        devices: list[dict],
        *,
        mounted: str | None = None,
        runtime_fs: str = "tmpfs",
    ) -> None:
        self.devices = devices
        self.mounted = mounted
        self.runtime_fs = runtime_fs
        self.calls: list[list[str]] = []

    def result(
        self, arguments: list[str], *, capture: bool = True
    ) -> subprocess.CompletedProcess[str]:
        self.calls.append(arguments)
        program = arguments[0]
        if program == "/usr/bin/lsblk":
            return subprocess.CompletedProcess(
                arguments, 0, json.dumps({"blockdevices": self.devices}), ""
            )
        if program == "/usr/sbin/wipefs":
            return subprocess.CompletedProcess(
                arguments, 0, json.dumps({"signatures": []}), ""
            )
        if program == "/usr/bin/findmnt" and "--mountpoint" in arguments:
            if self.mounted is None:
                return subprocess.CompletedProcess(arguments, 1, "", "")
            return subprocess.CompletedProcess(arguments, 0, self.mounted + "\n", "")
        if program == "/usr/bin/findmnt":
            return subprocess.CompletedProcess(arguments, 0, self.runtime_fs + "\n", "")
        if program == "/usr/sbin/mkfs.ext4":
            for device in self.devices:
                device["fstype"] = "ext4"
                device["uuid"] = FS_UUID
        return subprocess.CompletedProcess(arguments, 0, "", "")

    def run(self, arguments: list[str], *, capture: bool = True) -> str:
        completed = self.result(arguments, capture=capture)
        if completed.returncode != 0:
            raise boot.BootError(f"Required host operation failed: {arguments[0]}.")
        return completed.stdout

    def programs(self) -> list[str]:
        return [call[0] for call in self.calls]


def disk(*, fstype: str | None = "ext4", uuid: str | None = FS_UUID) -> dict:
    return {
        "path": "/dev/nvme1n1",
        "type": "disk",
        "fstype": fstype,
        "uuid": uuid,
        "serial": "vol0123456789abcdef0",
        "mountpoints": [None],
    }


class TemporaryRoot(unittest.TestCase):
    """A temp directory standing in for the host, with ownership changes recorded.

    The tests run unprivileged, so chown/fchown are recorded rather than applied,
    and files the current user owns count as root-owned.
    """

    def setUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._directory.cleanup)
        self.root = Path(self._directory.name)
        self.chowns: list[tuple[str, int, int]] = []
        patches = [
            mock.patch.object(boot, "ROOT_UID", os.getuid()),
            mock.patch.object(boot.os, "chown", side_effect=self._chown),
            mock.patch.object(boot.os, "fchown", side_effect=self._fchown),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def _chown(self, path, uid, gid) -> None:
        self.chowns.append((str(path), uid, gid))

    def _fchown(self, descriptor, uid, gid) -> None:
        self.chowns.append((self._fd_path(descriptor), uid, gid))

    @staticmethod
    def _fd_path(descriptor: int) -> str:
        if sys.platform == "darwin":
            return (
                fcntl.fcntl(descriptor, fcntl.F_GETPATH, bytes(1024))
                .rstrip(b"\x00")
                .decode()
            )
        return os.readlink(f"/proc/self/fd/{descriptor}")

    def owner_of(self, path: Path) -> tuple[int, int] | None:
        wanted = os.path.realpath(path)
        owner = None
        for recorded, uid, gid in self.chowns:
            if os.path.realpath(recorded) == wanted:
                owner = (uid, gid)
        return owner


class BundleTests(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.config = machine_config(Path(directory.name))

    def bundle(self, **changes) -> str:
        value = fixture("bundle-v3.json")
        for key, entry in changes.items():
            value[key] = entry
        return json.dumps(value)

    def test_parses_a_v3_bundle(self) -> None:
        bundle = boot.parse_bundle(text("bundle-v3.json"), self.config)
        self.assertEqual(bundle.controller_id, "ctl-test-0001")
        self.assertEqual(bundle.api_endpoint, "https://switch.example.test/agent-api")
        self.assertEqual(bundle.kms.grant_tokens, ("grant-token-test",))
        self.assertNotIn("swcc_", repr(bundle))

    def test_a_v2_bundle_is_obsolete(self) -> None:
        with self.assertRaises(boot.ObsoleteBundle):
            boot.parse_bundle(text("bundle-v2.json"), self.config)

    def test_other_versions_are_errors_not_obsolete(self) -> None:
        with self.assertRaises(boot.BootError) as raised:
            boot.parse_bundle(self.bundle(version=4), self.config)
        self.assertNotIsInstance(raised.exception, boot.ObsoleteBundle)

    def test_rejects_a_bundle_for_another_assignment(self) -> None:
        assignment = dict(fixture("bundle-v3.json")["assignment"], generation=2)
        with self.assertRaisesRegex(boot.BootError, "does not match"):
            boot.parse_bundle(self.bundle(assignment=assignment), self.config)

    def test_rejects_a_machine_capability(self) -> None:
        with self.assertRaises(boot.BootError):
            boot.parse_bundle(
                self.bundle(machineCapability="mcap-" + "0" * 32), self.config
            )

    def test_rejects_a_credential_that_is_not_a_controller_credential(self) -> None:
        with self.assertRaisesRegex(boot.BootError, "credential"):
            boot.parse_bundle(
                self.bundle(
                    controller={"id": "ctl-test-0001", "credential": "swct_" + "0" * 32}
                ),
                self.config,
            )

    def test_rejects_a_kms_context_for_another_controller(self) -> None:
        kms = fixture("bundle-v3.json")["kms"]
        kms["context"]["switch:controller_id"] = "ctl-other"
        with self.assertRaisesRegex(boot.BootError, "another controller"):
            boot.parse_bundle(self.bundle(kms=kms), self.config)

    def test_rejects_a_kms_region_that_differs_from_the_key(self) -> None:
        kms = dict(fixture("bundle-v3.json")["kms"], region="eu-west-1")
        with self.assertRaisesRegex(boot.BootError, "KMS"):
            boot.parse_bundle(self.bundle(kms=kms), self.config)

    def test_rejects_extra_kms_context_keys(self) -> None:
        kms = fixture("bundle-v3.json")["kms"]
        kms["context"]["switch:provider"] = "codex"
        with self.assertRaises(boot.BootError):
            boot.parse_bundle(self.bundle(kms=kms), self.config)


class RuntimeConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "runtime.json"

    def load(self, value: dict) -> boot.RuntimeConfig:
        self.path.write_text(json.dumps(value))
        return boot.load_runtime_config(self.path)

    def test_loads_the_v2_runtime(self) -> None:
        runtime = self.load(fixture("runtime.json"))
        self.assertEqual(
            set(runtime.artifact_sha256),
            {"node", "sharedHostDaemon", "bootstrap", "controller", "boot", "provider"},
        )
        self.assertEqual(set(runtime.providers), {"codex", "antigravity"})

    def test_refuses_the_worker_runtime(self) -> None:
        with self.assertRaisesRegex(boot.BootError, "worker runtime"):
            self.load({"version": 1})

    def test_refuses_paths_the_units_do_not_run(self) -> None:
        with self.assertRaisesRegex(boot.BootError, "units"):
            self.load(
                dict(
                    fixture("runtime.json"),
                    controllerPath="/opt/elsewhere/controller.mjs",
                )
            )

    def test_refuses_a_missing_artifact_digest(self) -> None:
        value = fixture("runtime.json")
        del value["artifactSha256"]["boot"]
        with self.assertRaises(boot.BootError):
            self.load(value)


class VerifyRuntimeTests(TemporaryRoot):
    def runtime(self, hashes: dict[str, str]) -> boot.RuntimeConfig:
        paths = {}
        for name in (
            "node",
            "daemon",
            "bootstrap",
            "controller",
            "boot",
            "claude",
            "codex",
        ):
            path = self.root / name
            path.write_bytes(name.encode())
            path.chmod(0o755)
            paths[name] = str(path)
        return boot.RuntimeConfig(
            node_path=paths["node"],
            controller_path=paths["controller"],
            shared_host_daemon_path=paths["daemon"],
            bootstrap_path=paths["bootstrap"],
            boot_path=paths["boot"],
            provider_binary_path=paths["claude"],
            controller_user="switch-controller",
            agent_user="switch-agent",
            agent_group="switch-agent",
            path="/usr/bin:/bin",
            allow_initial_format=True,
            artifact_sha256=hashes,
            providers={
                "codex": {
                    "path": paths["codex"],
                    "sha256": boot._sha256_file(paths["codex"]),
                }
            },
        )

    def correct_hashes(self) -> dict[str, str]:
        names = {
            "node": "node",
            "sharedHostDaemon": "daemon",
            "bootstrap": "bootstrap",
            "controller": "controller",
            "boot": "boot",
            "provider": "claude",
        }
        hashes = {}
        for key, name in names.items():
            (self.root / name).write_bytes(name.encode())
            hashes[key] = boot._sha256_file(str(self.root / name))
        return hashes

    def node_version(self, version: str):
        return mock.patch.object(
            boot.subprocess, "run", return_value=SimpleNamespace(stdout=version + "\n")
        )

    def test_fingerprints_matching_artifacts(self) -> None:
        runtime = self.runtime(self.correct_hashes())
        with self.node_version("v24.3.0"):
            fingerprint = boot.verify_pinned_runtime(runtime)
        self.assertRegex(fingerprint, r"^sha256:[0-9a-f]{64}$")
        self.assertTrue(boot.FINGERPRINT_RE.fullmatch(fingerprint))

    def test_refuses_a_controller_that_does_not_match_its_pin(self) -> None:
        hashes = self.correct_hashes()
        hashes["controller"] = ZERO
        runtime = self.runtime(hashes)
        with (
            self.node_version("v24.3.0"),
            self.assertRaisesRegex(boot.BootError, "controller"),
        ):
            boot.verify_pinned_runtime(runtime)

    def test_refuses_another_node_major(self) -> None:
        runtime = self.runtime(self.correct_hashes())
        with (
            self.node_version("v22.1.0"),
            self.assertRaisesRegex(boot.BootError, "Node.js 24"),
        ):
            boot.verify_pinned_runtime(runtime)


class StorageTests(TemporaryRoot):
    def setUp(self) -> None:
        super().setUp()
        self.config = machine_config(self.root)
        self.data = self.root / "data"

    def test_mounts_an_existing_filesystem(self) -> None:
        commands = FakeCommands([disk()])
        observation, formatted = boot.prepare_storage(commands, self.config, self.data)
        self.assertFalse(formatted)
        self.assertEqual(observation.filesystem_uuid, FS_UUID)
        self.assertIn(boot.SYSTEMD_MOUNT, commands.programs())
        self.assertNotIn("/usr/sbin/mkfs.ext4", commands.programs())

    def test_formats_only_a_blank_disk(self) -> None:
        commands = FakeCommands([disk(fstype=None, uuid=None)])
        _observation, formatted = boot.prepare_storage(commands, self.config, self.data)
        self.assertTrue(formatted)
        self.assertIn("/usr/sbin/mkfs.ext4", commands.programs())

    def test_refuses_to_format_a_disk_with_signatures(self) -> None:
        commands = FakeCommands([disk(fstype=None, uuid=None)])
        original = commands.result

        def with_signature(arguments, *, capture=True):
            if arguments[0] == "/usr/sbin/wipefs":
                commands.calls.append(arguments)
                return subprocess.CompletedProcess(
                    arguments, 0, json.dumps({"signatures": [{"type": "xfs"}]}), ""
                )
            return original(arguments, capture=capture)

        commands.result = with_signature
        with self.assertRaisesRegex(boot.BootError, "blank disk"):
            boot.prepare_storage(commands, self.config, self.data)
        self.assertNotIn("/usr/sbin/mkfs.ext4", commands.programs())

    def test_refuses_a_mountpoint_held_by_another_device(self) -> None:
        commands = FakeCommands([disk()], mounted="/dev/nvme9n1")
        with self.assertRaisesRegex(boot.BootError, "another device"):
            boot.prepare_storage(commands, self.config, self.data)


class MarkerTests(TemporaryRoot):
    def setUp(self) -> None:
        super().setUp()
        self.config = machine_config(self.root)
        self.data = self.root / "data"
        self.data.mkdir()
        self.paths = boot.Paths(self.data, self.root / "run/switch-machine")
        self.identity = boot.MachineIdentity(INSTANCE, BOOT_1)

    def marker(self) -> dict:
        return json.loads(self.paths.marker.read_text())

    def test_a_blank_volume_gets_a_worker_compatible_marker(self) -> None:
        boot.reconcile_marker(
            self.identity, self.config, FS_UUID, FINGERPRINT, self.paths
        )
        self.assertEqual(
            self.marker(),
            {
                "version": 2,
                "installationId": "inst-test",
                "slotId": "slot-a",
                "generation": 1,
                "instanceId": INSTANCE,
                "bootId": BOOT_1,
                "filesystemUuid": FS_UUID,
                "runtimeFingerprint": FINGERPRINT,
                "layout": "per-user-v1",
            },
        )
        self.assertEqual(mode(self.paths.marker), 0o600)
        self.assertEqual(mode(self.paths.marker_directory), 0o700)

    def test_a_replacement_instance_rewrites_identity_and_keeps_layout(self) -> None:
        boot.reconcile_marker(
            self.identity, self.config, FS_UUID, "sha256:0000", self.paths
        )
        (self.data / "agents").mkdir()
        boot.reconcile_marker(
            boot.MachineIdentity(OTHER_INSTANCE, BOOT_2),
            self.config,
            FS_UUID,
            FINGERPRINT,
            self.paths,
        )
        marker = self.marker()
        self.assertEqual(
            (marker["instanceId"], marker["bootId"], marker["runtimeFingerprint"]),
            (OTHER_INSTANCE, BOOT_2, FINGERPRINT),
        )
        self.assertEqual(marker["layout"], "per-user-v1")

    def test_refuses_a_volume_from_another_slot(self) -> None:
        boot.reconcile_marker(
            self.identity, self.config, FS_UUID, FINGERPRINT, self.paths
        )
        value = self.marker()
        value["slotId"] = "slot-b"
        self.paths.marker.write_text(json.dumps(value))
        with self.assertRaisesRegex(boot.BootError, "another installation or slot"):
            boot.reconcile_marker(
                self.identity, self.config, FS_UUID, FINGERPRINT, self.paths
            )

    def test_refuses_a_changed_filesystem(self) -> None:
        boot.reconcile_marker(
            self.identity, self.config, FS_UUID, FINGERPRINT, self.paths
        )
        with self.assertRaisesRegex(boot.BootError, "filesystem identity"):
            boot.reconcile_marker(
                self.identity,
                self.config,
                "00000000-0000-4000-8000-00000000f002",
                FINGERPRINT,
                self.paths,
            )

    def test_refuses_unmarked_legacy_state(self) -> None:
        (self.data / "agents").mkdir()
        with self.assertRaisesRegex(boot.BootError, "no trusted machine marker"):
            boot.reconcile_marker(
                self.identity, self.config, FS_UUID, FINGERPRINT, self.paths
            )

    def test_refuses_the_one_agent_layout(self) -> None:
        self.paths.marker_directory.mkdir(mode=0o700)
        self.paths.marker.write_text(json.dumps({"version": 1}))
        self.paths.marker.chmod(0o600)
        with self.assertRaisesRegex(boot.BootError, "one-agent layout"):
            boot.reconcile_marker(
                self.identity, self.config, FS_UUID, FINGERPRINT, self.paths
            )


class LayoutTests(TemporaryRoot):
    """A per-user-v1 worker volume moved onto the controller layout."""

    def setUp(self) -> None:
        super().setUp()
        self.data = self.root / "data"
        self.paths = boot.Paths(self.data, self.root / "run/switch-machine")
        self.data.mkdir()
        self.paths.marker_directory.mkdir(mode=0o700)
        for top in ("agents", "worktrees"):
            (self.data / top).mkdir(mode=0o755)
        (self.data / "repos").mkdir(mode=0o700)
        (self.data / "repos/octo").mkdir()
        for agent in (AGENT_1, AGENT_2):
            root = self.data / "agents" / agent
            for leaf in ("home", "tmp", "provider-home", "watcher/supervisor"):
                (root / leaf).mkdir(parents=True, mode=0o700)
            os.chmod(root, 0o700)
            os.chmod(root / "watcher", 0o700)
            secret = root / "provider-home/auth.json"
            secret.write_text("{}")
            secret.chmod(0o600)
            worktree = self.data / "worktrees" / agent / "workspace"
            worktree.mkdir(parents=True, mode=0o700)
            os.chmod(self.data / "worktrees" / agent, 0o700)

    def test_moves_a_worker_volume_onto_the_controller_layout(self) -> None:
        migrated = boot.prepare_controller_layout(self.paths, ACCOUNTS)
        self.assertEqual(sorted(migrated), sorted([AGENT_1, AGENT_2]))
        controller = (ACCOUNTS.controller_uid, ACCOUNTS.controller_gid)
        shared = (ACCOUNTS.controller_uid, ACCOUNTS.agent_gid)
        self.assertEqual(mode(self.data / "agents"), 0o750)
        self.assertEqual(self.owner_of(self.data / "agents"), controller)
        self.assertEqual(mode(self.data / "worktrees"), 0o750)
        self.assertEqual(self.owner_of(self.data / "worktrees"), controller)
        self.assertEqual(mode(self.data / ".switch-controller"), 0o700)
        self.assertEqual(self.owner_of(self.data / ".switch-controller"), controller)
        for agent in (AGENT_1, AGENT_2):
            for directory in (
                self.data / "agents" / agent,
                self.data / "agents" / agent / "watcher",
                self.data / "worktrees" / agent,
            ):
                self.assertEqual(mode(directory), 0o3770, directory)
                self.assertEqual(self.owner_of(directory), shared, directory)
            for untouched in ("home", "tmp", "provider-home", "watcher/supervisor"):
                self.assertEqual(mode(self.data / "agents" / agent / untouched), 0o700)
                self.assertIsNone(
                    self.owner_of(self.data / "agents" / agent / untouched)
                )
            self.assertEqual(
                mode(self.data / "agents" / agent / "provider-home/auth.json"), 0o600
            )
            self.assertEqual(mode(self.data / "worktrees" / agent / "workspace"), 0o700)
        self.assertEqual(mode(self.data / "repos"), 0o700)
        self.assertIsNone(self.owner_of(self.data / "repos"))
        marker = json.loads(self.paths.controller_marker.read_text())
        self.assertEqual((marker["version"], marker["layout"]), (1, "controller-v1"))
        self.assertEqual(sorted(marker["agents"]), sorted([AGENT_1, AGENT_2]))
        self.assertEqual(mode(self.paths.controller_marker), 0o600)
        self.assertTrue(self.paths.marker_directory.joinpath("controller-v1").is_file())

    def test_runs_the_agent_pass_once(self) -> None:
        boot.prepare_controller_layout(self.paths, ACCOUNTS)
        os.chmod(self.data / "agents" / AGENT_1, 0o2750)
        self.chowns.clear()
        self.assertEqual(boot.prepare_controller_layout(self.paths, ACCOUNTS), [])
        self.assertEqual(mode(self.data / "agents" / AGENT_1), 0o2750)
        self.assertIsNone(self.owner_of(self.data / "agents" / AGENT_1))

    def test_repairs_top_level_directories_on_every_boot(self) -> None:
        boot.prepare_controller_layout(self.paths, ACCOUNTS)
        os.chmod(self.data / "agents", 0o755)
        boot.prepare_controller_layout(self.paths, ACCOUNTS)
        self.assertEqual(mode(self.data / "agents"), 0o750)

    def test_an_interrupted_pass_repeats_to_the_same_result(self) -> None:
        boot.prepare_controller_layout(self.paths, ACCOUNTS)
        self.paths.controller_marker.unlink()
        boot.prepare_controller_layout(self.paths, ACCOUNTS)
        self.assertEqual(mode(self.data / "agents" / AGENT_1), 0o3770)
        self.assertEqual(mode(self.data / "agents" / AGENT_1 / "home"), 0o700)

    def test_a_blank_volume_gets_the_controller_layout(self) -> None:
        for top in ("agents", "worktrees", "repos"):
            for path in sorted((self.data / top).rglob("*"), reverse=True):
                path.unlink() if path.is_file() else path.rmdir()
            (self.data / top).rmdir()
        self.assertEqual(boot.prepare_controller_layout(self.paths, ACCOUNTS), [])
        self.assertEqual(mode(self.data / "agents"), 0o750)
        self.assertEqual(mode(self.data / "repos"), 0o700)
        self.assertEqual(
            self.owner_of(self.data / "repos"), (ACCOUNTS.agent_uid, ACCOUNTS.agent_gid)
        )

    def test_ignores_entries_that_are_not_agent_ids(self) -> None:
        (self.data / "agents" / "not.an.id").mkdir(mode=0o700)
        boot.prepare_controller_layout(self.paths, ACCOUNTS)
        self.assertEqual(mode(self.data / "agents" / "not.an.id"), 0o700)

    def test_does_not_follow_a_watcher_symlink(self) -> None:
        target = self.root / "elsewhere"
        target.mkdir(mode=0o700)
        watcher = self.data / "agents" / AGENT_1 / "watcher"
        for path in sorted(watcher.rglob("*"), reverse=True):
            path.rmdir()
        watcher.rmdir()
        watcher.symlink_to(target)
        with self.assertLogs("switch-machine-boot", "ERROR"):
            boot.prepare_controller_layout(self.paths, ACCOUNTS)
        self.assertEqual(mode(target), 0o700)
        self.assertIsNone(self.owner_of(target))

    def test_refuses_an_agent_root_that_is_a_symlink(self) -> None:
        target = self.root / "elsewhere"
        target.mkdir(mode=0o700)
        (self.data / "agents" / "symlinked").symlink_to(target)
        with self.assertRaisesRegex(boot.BootError, "not a real directory"):
            boot.prepare_controller_layout(self.paths, ACCOUNTS)
        self.assertEqual(mode(target), 0o700)
        self.assertFalse(self.paths.controller_marker.exists())


class ControllerFilesTests(TemporaryRoot):
    def setUp(self) -> None:
        super().setUp()
        self.config = machine_config(self.root)
        self.bundle = boot.parse_bundle(text("bundle-v3.json"), self.config)
        self.identity = boot.MachineIdentity(INSTANCE, BOOT_1)
        self.paths = boot.Paths(self.root / "data", self.root / "run/switch-machine")
        (self.root / "run").mkdir()

    def test_controller_config_content(self) -> None:
        self.assertEqual(
            boot.controller_config(self.bundle, self.identity, self.config.runtime),
            {
                "controllerId": "ctl-test-0001",
                "server": "https://switch.example.test/agent-api",
                "relayPort": 47100,
                "instanceId": INSTANCE,
                "bootId": BOOT_1,
                "kms": {
                    "keyArn": "arn:aws:kms:us-east-1:000000000000:key/00000000-0000-4000-8000-00000000c0de",
                    "region": "us-east-1",
                    "grantTokens": ["grant-token-test"],
                    "context": {
                        "switch:tenant": "tenant-test",
                        "switch:owner_id": "owner-test",
                        "switch:controller_id": "ctl-test-0001",
                    },
                },
                "sharedHostBundle": "/opt/switch/agent-providers/shared-host-daemon.mjs",
                "nodePath": "/opt/switch/node/bin/node",
                "providers": {
                    "claude": "/opt/switch/claude/bin/claude",
                    "codex": "/opt/switch/providers/codex",
                    "antigravity": "/opt/switch/providers/antigravity-acp",
                },
            },
        )

    def test_writes_config_and_credential_with_their_modes(self) -> None:
        commands = FakeCommands([])
        boot.prepare_machine_runtime(commands, self.paths, ACCOUNTS)
        boot.write_controller_files(
            self.paths, self.bundle, self.identity, self.config.runtime, ACCOUNTS
        )
        self.assertEqual(mode(self.paths.machine_runtime), 0o750)
        self.assertEqual(
            self.owner_of(self.paths.machine_runtime),
            (os.getuid(), ACCOUNTS.controller_gid),
        )
        config = self.paths.controller_config
        credential = self.paths.controller_credential
        self.assertEqual(mode(config), 0o640)
        self.assertEqual(mode(credential), 0o600)
        self.assertEqual(
            credential.read_text(), "swcc_test-00000000000000000000000000000000"
        )
        self.assertNotIn("swcc_", config.read_text())
        self.assertEqual(
            json.loads(config.read_text())["controllerId"], "ctl-test-0001"
        )
        gids = {gid for path, _uid, gid in self.chowns if ".controller.json." in path}
        self.assertEqual(gids, {ACCOUNTS.controller_gid})
        gids = {
            gid for path, _uid, gid in self.chowns if ".controller-credential." in path
        }
        self.assertEqual(gids, {os.getuid()})
        self.assertEqual(
            sorted(path.name for path in self.paths.machine_runtime.iterdir()),
            ["controller-credential", "controller.json"],
        )

    def test_refuses_a_runtime_directory_off_tmpfs(self) -> None:
        with self.assertRaisesRegex(boot.BootError, "tmpfs"):
            boot.prepare_machine_runtime(
                FakeCommands([], runtime_fs="ext4"), self.paths, ACCOUNTS
            )


class MainTests(TemporaryRoot):
    def setUp(self) -> None:
        super().setUp()
        machine_config(self.root)
        self.bundle_file = self.root / "bundle.json"

    def run_main(self, bundle: str) -> tuple[int, mock.MagicMock]:
        self.bundle_file.write_text(bundle)
        storage = mock.MagicMock(
            side_effect=AssertionError("the volume must not be touched")
        )
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.dict(os.environ, {boot.TEST_HOOKS_ENV: "1"}))
            stack.enter_context(
                mock.patch.object(boot.os, "geteuid", return_value=os.getuid())
            )
            stack.enter_context(
                mock.patch.object(boot, "LOCK_PATH", self.root / "lock/boot.lock")
            )
            stack.enter_context(
                mock.patch.object(
                    boot, "verify_pinned_runtime", return_value=FINGERPRINT
                )
            )
            stack.enter_context(
                mock.patch.object(boot, "resolve_accounts", return_value=ACCOUNTS)
            )
            stack.enter_context(
                mock.patch.object(boot.ImdsV2, "instance_id", return_value=INSTANCE)
            )
            stack.enter_context(
                mock.patch.object(boot, "_read_boot_id", return_value=BOOT_1)
            )
            stack.enter_context(mock.patch.object(boot, "prepare_storage", storage))
            stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            code = boot.main(
                [
                    "--config",
                    str(self.root / "etc/assignment.json"),
                    "--runtime-config",
                    str(self.root / "etc/runtime.json"),
                    "--bundle-file",
                    str(self.bundle_file),
                ]
            )
        return code, storage

    def test_a_v2_bundle_exits_75_before_touching_the_volume(self) -> None:
        code, storage = self.run_main(text("bundle-v2.json"))
        self.assertEqual(code, 75)
        storage.assert_not_called()

    def test_an_invalid_bundle_is_an_error(self) -> None:
        with self.assertRaises(boot.BootError):
            self.run_main(json.dumps({"version": 3}))

    def test_the_bundle_file_hook_needs_the_test_environment(self) -> None:
        with (
            mock.patch.dict(os.environ, {}, clear=False),
            contextlib.redirect_stderr(io.StringIO()),
        ):
            os.environ.pop(boot.TEST_HOOKS_ENV, None)
            with self.assertRaises(SystemExit) as raised:
                boot.parse_arguments(["--bundle-file", str(self.bundle_file)])
        self.assertEqual(raised.exception.code, 2)

    def test_the_bundle_file_hook_rejects_other_values(self) -> None:
        with (
            mock.patch.dict(os.environ, {boot.TEST_HOOKS_ENV: "yes"}),
            contextlib.redirect_stderr(io.StringIO()),
        ):
            with self.assertRaises(SystemExit):
                boot.parse_arguments(["--bundle-file", str(self.bundle_file)])


class RetryTests(unittest.TestCase):
    def test_retries_then_succeeds(self) -> None:
        outcomes = [boot.BootError("not yet"), boot.BootError("not yet"), "value"]
        sleeps: list[float] = []

        def operation():
            outcome = outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

        with self.assertLogs("switch-machine-boot", "WARNING"):
            self.assertEqual(
                boot.with_retries("probe", operation, attempts=3, sleep=sleeps.append),
                "value",
            )
        self.assertEqual(sleeps, [2, 4])

    def test_raises_the_last_error(self) -> None:
        def operation():
            raise boot.BootError("still down")

        with (
            self.assertLogs("switch-machine-boot", "WARNING"),
            self.assertRaisesRegex(boot.BootError, "still down"),
        ):
            boot.with_retries(
                "probe", operation, attempts=2, sleep=lambda _seconds: None
            )


class UnitFileTests(unittest.TestCase):
    """The unit files and the boot step agree on paths and accounts."""

    def unit(self, name: str) -> str:
        return (HERE.parent / name).read_text()

    def test_controller_unit_runs_the_pinned_controller_with_a_loaded_credential(
        self,
    ) -> None:
        unit = self.unit("switch-controller.service")
        self.assertIn(
            f"ExecStart={boot.NODE_PATH} {boot.CONTROLLER_PATH} run --ec2 --config /run/switch-machine/controller.json --credential-file ${{CREDENTIALS_DIRECTORY}}/controller --data-dir /data/.switch-controller",
            unit,
        )
        self.assertIn(
            "LoadCredential=controller:/run/switch-machine/controller-credential", unit
        )
        self.assertIn("User=switch-controller", unit)
        self.assertIn("NoNewPrivileges=yes", unit)
        self.assertNotIn("StandardInput=socket", unit)

    def test_agent_unit_runs_the_pinned_daemon_and_never_the_hosted_worker(
        self,
    ) -> None:
        unit = self.unit("switch-agent@.service")
        sandbox = (
            "!/usr/bin/unshare --pid --fork --mount-proc --kill-child -- "
            "/usr/bin/setpriv --reuid=switch-agent --regid=switch-agent --init-groups "
            "--inh-caps=-all --bounding-set=-all --no-new-privs -- "
            "/usr/bin/python3 -I -S /usr/local/libexec/switch-agent-init"
        )
        self.assertIn(
            f"ExecStartPre={sandbox} {boot.NODE_PATH} {boot.SHARED_HOST_DAEMON_PATH} --prepare /data/agents/%i\n",
            unit,
        )
        self.assertIn(
            f"ExecStart={sandbox} {boot.NODE_PATH} {boot.SHARED_HOST_DAEMON_PATH} --unit /data/agents/%i/watcher\n",
            unit,
        )
        self.assertIn("User=switch-agent\n", unit)
        self.assertNotIn("SWITCH_HOSTED_BOOTSTRAP", unit)
        self.assertNotIn("--watch-supervise", unit)
        self.assertIn("IPAddressDeny=169.254.169.254/32 fd00:ec2::254/128", unit)

    def test_agent_unit_mounts_the_shared_repository_mirror_read_only(self) -> None:
        unit = self.unit("switch-agent@.service")
        self.assertIn("BindPaths=/data/agents/%i /data/worktrees/%i\n", unit)
        self.assertIn("BindReadOnlyPaths=/data/repos\n", unit)

    def test_polkit_rule_admits_only_agent_units(self) -> None:
        rule = self.unit("50-switch-controller.rules")
        self.assertIn('subject.user !== "switch-controller"', rule)
        self.assertIn(r"/^switch-agent@[A-Za-z0-9_-]{1,64}\.service$/", rule)

    def test_no_unit_orders_after_cloud_final(self) -> None:
        for unit_file in (HERE.parent).glob("*.service"):
            with self.subTest(unit_file=unit_file.name):
                content = unit_file.read_text()
                self.assertNotIn("cloud-final.service", content)


if __name__ == "__main__":
    unittest.main()
