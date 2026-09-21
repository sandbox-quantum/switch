from __future__ import annotations

import importlib.util
import io
import json
import os
import signal
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).with_name("switch_hosted_worker.py")
SPEC = importlib.util.spec_from_file_location("switch_hosted_worker", MODULE_PATH)
assert SPEC and SPEC.loader
worker = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = worker
SPEC.loader.exec_module(worker)

INSTANCE = "i-0123456789abcdef0"
VOLUME = "vol-0123456789abcdef0"
BOOT_1 = "11111111-1111-4111-8111-111111111111"
BOOT_2 = "22222222-2222-4222-8222-222222222222"
FS_UUID = "33333333-3333-4333-8333-333333333333"
RUNTIME_FP = "a" * 64
GITHUB_CREDENTIAL = "synthetic-github-credential"


def config() -> worker.WorkerConfig:
    return worker.WorkerConfig(
        installation_id="installation-1",
        secret_id="arn:aws:secretsmanager:eu-west-1:000000000000:secret:assignment-1",
        secret_region="eu-west-1",
        agent_id="agent-1",
        generation=7,
        volume_id=VOLUME,
        device_path="/dev/sdf",
        runtime=worker.RuntimeConfig(
            node_path="/opt/switch/node/bin/node",
            bootstrap_path="/opt/switch/agent-providers/hosted-bootstrap.mjs",
            shared_host_daemon_path="/opt/switch/agent-providers/shared-host-daemon.mjs",
            provider_binary_path="/opt/switch/claude/bin/claude",
            agent_user="switch-agent",
            agent_group="switch-agent",
            path="/opt/switch/node/bin:/usr/bin:/bin",
            mcp_runtime="@sandboxaq/switch-agent-runtime@0.4.2",
            allow_initial_format=True,
            artifact_sha256={
                "node": "1" * 64,
                "bootstrap": "2" * 64,
                "sharedHostDaemon": "3" * 64,
                "provider": "4" * 64,
            },
        ),
    )


def deployment() -> dict:
    return {
        "version": 1,
        "session": {"sessionId": "session-1", "agentId": "agent-1"},
        "provider": {
            "kind": "claude",
            "credential": {
                "kind": "api-key",
                "path": "/run/switch-hosted/secrets/provider",
            },
            "binaryPath": "/opt/switch/claude/bin/claude",
            "context": "test",
        },
        "workspacePath": "/data/workspace",
        "room": {"roomId": "room-1", "startCursor": 0},
        "runtimeMode": "approval-required",
        "switchCredentialsPath": "/run/switch-hosted/secrets/switch.json",
        "mcpRuntime": "@sandboxaq/switch-agent-runtime@0.4.2",
    }


def secret(provider: str = "provider-value", switch_token: str = "switch-value") -> str:
    return json.dumps(
        {
            "version": 1,
            "assignment": {
                "installationId": "installation-1",
                "agentId": "agent-1",
                "generation": 7,
                "dataVolumeId": VOLUME,
            },
            "deployment": deployment(),
            "providerCredential": provider,
            "switchCredentials": {
                "env": {
                    "SWITCH_API_ENDPOINT": "https://switch.invalid/api/agent",
                    "SWITCH_API_TOKEN": switch_token,
                    "SWITCH_AGENT_ID": "agent-1",
                }
            },
        }
    )


def github_secret(credential: object = GITHUB_CREDENTIAL) -> str:
    value = json.loads(secret())
    value["githubCredential"] = credential
    value["deployment"]["github"] = {
        "credentialPath": "/run/switch-hosted/secrets/github"
    }
    return json.dumps(value)


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class WorkerTests(unittest.TestCase):
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
        self.assertEqual(
            requests[0][0].get_header("X-aws-ec2-metadata-token-ttl-seconds"), "60"
        )
        self.assertEqual(len(requests), 2)

    def test_secret_boundary_is_strict_and_launch_has_no_secret_values(self):
        parsed = worker.parse_secret_document(secret(), config())
        identity = worker.MachineIdentity(INSTANCE, BOOT_1, 7)
        arguments, environment = worker.build_launch(
            config(),
            identity,
            Path("/run/switch-hosted/secrets/deployment.json"),
            123,
            456,
        )
        serialized = json.dumps({"arguments": arguments, "environment": environment})
        self.assertNotIn(parsed.provider_credential, serialized)
        self.assertNotIn("switch-value", serialized)
        self.assertEqual(environment["SWITCH_HOST_BOOT_ID"], BOOT_1)
        altered = json.loads(secret())
        altered["assignment"]["generation"] = 8
        with self.assertRaisesRegex(worker.WorkerError, "does not match"):
            worker.parse_secret_document(json.dumps(altered), config())
        insecure = json.loads(secret())
        insecure["switchCredentials"]["env"]["SWITCH_API_ENDPOINT"] = "http://switch.invalid/api"
        with self.assertRaisesRegex(worker.WorkerError, "endpoint is invalid"):
            worker.parse_secret_document(json.dumps(insecure), config())

    def test_optional_github_contract_is_strict_and_never_enters_launch(self):
        legacy = worker.parse_secret_document(secret(), config())
        self.assertIsNone(legacy.github_credential)

        parsed = worker.parse_secret_document(github_secret(), config())
        self.assertEqual(parsed.github_credential, GITHUB_CREDENTIAL)
        identity = worker.MachineIdentity(INSTANCE, BOOT_1, 7)
        arguments, environment = worker.build_launch(
            config(),
            identity,
            Path("/run/switch-hosted/secrets/deployment.json"),
            123,
            456,
        )
        serialized = json.dumps({"arguments": arguments, "environment": environment})
        self.assertNotIn(GITHUB_CREDENTIAL, serialized)
        self.assertNotIn("githubCredential", json.dumps(parsed.deployment))

        missing_credential = json.loads(github_secret())
        del missing_credential["githubCredential"]
        missing_deployment = json.loads(github_secret())
        del missing_deployment["deployment"]["github"]
        for invalid in (missing_credential, missing_deployment):
            with self.subTest(invalid=invalid):
                with self.assertRaisesRegex(worker.WorkerError, "provided together"):
                    worker.parse_secret_document(json.dumps(invalid), config())

        wrong_path = json.loads(github_secret())
        wrong_path["deployment"]["github"]["credentialPath"] = "/tmp/github"
        with self.assertRaisesRegex(worker.WorkerError, "path is not fixed"):
            worker.parse_secret_document(json.dumps(wrong_path), config())

        unexpected = json.loads(github_secret())
        unexpected["deployment"]["github"]["extra"] = True
        with self.assertRaisesRegex(worker.WorkerError, "missing or unexpected"):
            worker.parse_secret_document(json.dumps(unexpected), config())

    def test_github_credential_requires_bounded_printable_ascii_without_whitespace(self):
        invalid_credentials = [
            "",
            "two words",
            "line\nbreak",
            "control\x1fvalue",
            "non-ascii-\N{SNOWMAN}",
            "x" * (16 * 1024 + 1),
        ]
        for credential in invalid_credentials:
            with self.subTest(credential_length=len(credential)):
                with self.assertRaisesRegex(worker.WorkerError, "GitHub credential is invalid"):
                    worker.parse_secret_document(github_secret(credential), config())

    def test_secret_arn_supplies_region_without_ambient_aws_configuration(self):
        boto3 = mock.Mock()
        boto3.client.return_value = mock.Mock()
        with (
            mock.patch.dict(sys.modules, {"boto3": boto3}),
            mock.patch.dict(os.environ, {}, clear=True),
        ):
            worker.SecretsManager("eu-west-1")
        boto3.client.assert_called_once_with("secretsmanager", region_name="eu-west-1")

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

    def test_secret_store_calls_only_get_for_configured_secret(self):
        class Client:
            def __init__(self):
                self.calls = []

            def get_secret_value(self, **kwargs):
                self.calls.append(kwargs)
                return {"SecretString": secret()}

        client = Client()
        self.assertEqual(worker.SecretsManager("eu-west-1", client).read("secret-id"), secret())
        self.assertEqual(client.calls, [{"SecretId": "secret-id"}])

    def test_storage_resolves_nitro_device_by_ebs_serial(self):
        class FakeCommands:
            def __init__(self):
                self.calls = []

            def run(self, arguments, capture=True):
                self.calls.append(arguments)
                if arguments[0].endswith("lsblk"):
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
                raise AssertionError(arguments)

        commands = FakeCommands()
        observed = worker.inspect_storage(commands, "/dev/sdf", VOLUME)
        self.assertEqual(observed.device_path, "/dev/nvme0n1")
        self.assertNotIn("/dev/sdf", commands.calls[0])

    def test_unexpected_signature_never_formats(self):
        class FakeCommands:
            def __init__(self):
                self.calls = []

            def run(self, arguments, capture=True):
                self.calls.append(arguments)
                if arguments[0].endswith("lsblk"):
                    return json.dumps(
                        {
                            "blockdevices": [
                                {
                                    "path": "/dev/nvme1n1",
                                    "type": "disk",
                                    "fstype": None,
                                    "uuid": None,
                                    "serial": VOLUME.replace("-", ""),
                                    "mountpoints": [None],
                                }
                            ]
                        }
                    )
                if arguments[0].endswith("wipefs"):
                    return json.dumps({"signatures": [{"type": "xfs"}]})
                raise AssertionError(arguments)

            def result(self, arguments, capture=True):
                raise AssertionError(arguments)

        commands = FakeCommands()
        with self.assertRaisesRegex(worker.WorkerError, "not a safely initializable"):
            worker.prepare_storage(commands, config())
        self.assertFalse(any(call[0].endswith("mkfs.ext4") for call in commands.calls))

    def test_findmnt_exit_one_mounts_exact_resolved_device(self):
        observation = worker.StorageObservation(
            "/dev/nvme1n1", VOLUME, "ext4", FS_UUID, False, ()
        )

        class FakeCommands:
            def __init__(self):
                self.calls = []

            def result(self, arguments, capture=True):
                self.calls.append(arguments)
                return subprocess.CompletedProcess(arguments, 1, "", "")

            def run(self, arguments, capture=True):
                self.calls.append(arguments)
                return ""

        with tempfile.TemporaryDirectory() as temporary:
            mount = Path(temporary) / "data"
            with (
                mock.patch.object(worker, "DATA_MOUNT", mount),
                mock.patch.object(worker, "inspect_storage", return_value=observation),
                mock.patch.object(worker, "ROOT_UID", os.getuid()),
            ):
                commands = FakeCommands()
                worker.prepare_storage(commands, config())
        find = next(call for call in commands.calls if call[0].endswith("findmnt"))
        self.assertIn("--mountpoint", find)
        mounted = next(call for call in commands.calls if call[0].endswith("mount"))
        self.assertEqual(mounted[-2], "/dev/nvme1n1")

    def test_same_instance_new_boot_quarantines_only_proven_owners(self):
        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary) / "data"
            state = data / "state"
            marker_directory = data / ".switch-hosted"
            marker = marker_directory / "machine.json"
            supervisor = state / "supervisor"
            ownership = supervisor / "ownership"
            ownership.mkdir(parents=True, mode=0o700)
            journal = state / "shared-state.jsonl"
            journal.write_text('{"journal":"preserve"}\n')
            previous = worker.MachineIdentity(INSTANCE, BOOT_1, 7)
            owner_value = {
                "pid": os.getpid(),
                "token": "old",
                "machine": previous.json(),
            }
            (supervisor / "owner.json").write_text(json.dumps(owner_value))
            (ownership / f"{os.getpid()}-ticket.json").write_text(
                json.dumps({"choosing": False, "ticket": 1, "machine": previous.json()})
            )
            with (
                mock.patch.object(worker, "ROOT_UID", os.getuid()),
                mock.patch.object(worker.os, "chown"),
            ):
                worker._write_root_json(
                    marker,
                    {
                        "version": 1,
                        "installationId": "installation-1",
                        "agentId": "agent-1",
                        **previous.json(),
                        "filesystemUuid": FS_UUID,
                        "runtimeFingerprint": RUNTIME_FP,
                    },
                )
                worker.reconcile_boot_identity(
                    worker.MachineIdentity(INSTANCE, BOOT_2, 7),
                    "installation-1",
                    "agent-1",
                    FS_UUID,
                    RUNTIME_FP,
                    marker_directory=marker_directory,
                    marker_path=marker,
                    state_path=state,
                    data_mount=data,
                )
            self.assertEqual(journal.read_text(), '{"journal":"preserve"}\n')
            self.assertFalse((supervisor / "owner.json").exists())
            quarantined = list((marker_directory / "quarantine").rglob("owner.json"))
            self.assertEqual(len(quarantined), 1)
            with mock.patch.object(worker, "ROOT_UID", os.getuid()):
                self.assertEqual(worker._read_root_marker(marker)["bootId"], BOOT_2)

    def test_agent_account_cannot_resolve_to_root(self):
        account = mock.Mock(pw_uid=0, pw_gid=0)
        group = mock.Mock(gr_gid=0)
        with (
            mock.patch.object(worker.pwd, "getpwnam", return_value=account),
            mock.patch.object(worker.grp, "getgrnam", return_value=group),
        ):
            with self.assertRaisesRegex(worker.WorkerError, "non-root primary group"):
                worker.prepare_agent_directories("switch-agent", "switch-agent")

    def test_changed_instance_fails_without_moving_owner(self):
        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary) / "data"
            state = data / "state"
            marker_directory = data / ".switch-hosted"
            marker = marker_directory / "machine.json"
            state.mkdir(parents=True, mode=0o700)
            owner = state / "shared-owner.lock"
            previous = worker.MachineIdentity(INSTANCE, BOOT_1, 7)
            owner.write_text(json.dumps({"pid": 123, "machine": previous.json()}))
            with (
                mock.patch.object(worker, "ROOT_UID", os.getuid()),
                mock.patch.object(worker.os, "chown"),
            ):
                worker._write_root_json(
                    marker,
                    {
                        "version": 1,
                        "installationId": "installation-1",
                        "agentId": "agent-1",
                        **previous.json(),
                        "filesystemUuid": FS_UUID,
                        "runtimeFingerprint": RUNTIME_FP,
                    },
                )
                with self.assertRaisesRegex(worker.WorkerError, "another EC2 instance"):
                    worker.reconcile_boot_identity(
                        worker.MachineIdentity("i-11111111111111111", BOOT_2, 7),
                        "installation-1",
                        "agent-1",
                        FS_UUID,
                        RUNTIME_FP,
                        marker_directory=marker_directory,
                        marker_path=marker,
                        state_path=state,
                        data_mount=data,
                    )
            self.assertTrue(owner.exists())

    def test_legacy_owner_and_symlinked_supervisor_fail_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary) / "data"
            state = data / "state"
            marker_directory = data / ".switch-hosted"
            marker = marker_directory / "machine.json"
            state.mkdir(parents=True, mode=0o700)
            previous = worker.MachineIdentity(INSTANCE, BOOT_1, 7)
            (state / "shared-owner.lock").write_text(json.dumps({"pid": os.getpid()}))
            with (
                mock.patch.object(worker, "ROOT_UID", os.getuid()),
                mock.patch.object(worker.os, "chown"),
            ):
                worker._write_root_json(
                    marker,
                    {
                        "version": 1,
                        "installationId": "installation-1",
                        "agentId": "agent-1",
                        **previous.json(),
                        "filesystemUuid": FS_UUID,
                        "runtimeFingerprint": RUNTIME_FP,
                    },
                )
                with self.assertRaisesRegex(worker.WorkerError, "must be an object"):
                    worker.reconcile_boot_identity(
                        worker.MachineIdentity(INSTANCE, BOOT_2, 7),
                        "installation-1",
                        "agent-1",
                        FS_UUID,
                        RUNTIME_FP,
                        marker_directory=marker_directory,
                        marker_path=marker,
                        state_path=state,
                        data_mount=data,
                    )
            (state / "shared-owner.lock").unlink()
            target = data / "attacker"
            target.mkdir()
            (state / "supervisor").symlink_to(target, target_is_directory=True)
            with self.assertRaisesRegex(worker.WorkerError, "directory is invalid"):
                worker._ownership_paths(state)

    def test_partial_quarantine_is_resumed_after_launcher_crash(self):
        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary) / "data"
            state = data / "state"
            marker_directory = data / ".switch-hosted"
            marker = marker_directory / "machine.json"
            supervisor = state / "supervisor"
            supervisor.mkdir(parents=True, mode=0o700)
            previous = worker.MachineIdentity(INSTANCE, BOOT_1, 7)
            machine = previous.json()
            (supervisor / "owner.json").write_text(
                json.dumps({"pid": 42, "token": "supervisor", "machine": machine})
            )
            quarantine = (
                marker_directory / "quarantine" / f"{BOOT_1}--{BOOT_2}"
            )
            quarantine.mkdir(parents=True, mode=0o700)
            (quarantine / "shared-owner.lock").write_text(
                json.dumps({"pid": 43, "token": "worker", "machine": machine})
            )
            with (
                mock.patch.object(worker, "ROOT_UID", os.getuid()),
                mock.patch.object(worker.os, "chown"),
            ):
                worker._write_root_json(
                    marker,
                    {
                        "version": 1,
                        "installationId": "installation-1",
                        "agentId": "agent-1",
                        **machine,
                        "filesystemUuid": FS_UUID,
                        "runtimeFingerprint": RUNTIME_FP,
                    },
                )
                worker.reconcile_boot_identity(
                    worker.MachineIdentity(INSTANCE, BOOT_2, 7),
                    "installation-1",
                    "agent-1",
                    FS_UUID,
                    RUNTIME_FP,
                    marker_directory=marker_directory,
                    marker_path=marker,
                    state_path=state,
                    data_mount=data,
                )
            self.assertFalse((supervisor / "owner.json").exists())
            self.assertTrue((quarantine / "supervisor/owner.json").exists())
            self.assertTrue((quarantine / "shared-owner.lock").exists())

    def test_stale_secret_orphans_are_removed_before_new_materialization(self):
        parsed = worker.parse_secret_document(secret(), config())

        class TmpfsCommands:
            def run(self, arguments, capture=True):
                return "tmpfs\n"

        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary)
            orphan = runtime / ".secrets-old-crash"
            orphan.mkdir(mode=0o750)
            (orphan / "provider").write_text("old-provider")
            os.chmod(orphan / "provider", 0o440)
            with (
                mock.patch.object(worker, "Commands", TmpfsCommands),
                mock.patch.object(worker, "ROOT_UID", os.getuid()),
                mock.patch.object(worker.os, "chown"),
                mock.patch.object(worker.os, "fchown"),
            ):
                deployment_path, cleanup = worker.materialize_secrets(
                    parsed, 12345, os.getgid(), runtime
                )
                self.assertFalse(orphan.exists())
                self.assertEqual(
                    (deployment_path.parent / "provider").read_text(), "provider-value\n"
                )
                cleanup()

    def test_secret_directory_is_root_owned_group_read_only_and_cleaned(self):
        parsed = worker.parse_secret_document(github_secret(), config())

        class TmpfsCommands:
            def run(self, arguments, capture=True):
                return "tmpfs\n"

        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary)
            with (
                mock.patch.object(worker, "Commands", TmpfsCommands),
                mock.patch.object(worker, "ROOT_UID", os.getuid()),
                mock.patch.object(worker.os, "chown"),
                mock.patch.object(worker.os, "fchown"),
            ):
                deployment_path, cleanup = worker.materialize_secrets(
                    parsed, 12345, os.getgid(), runtime
                )
                directory = deployment_path.parent
                self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o750)
                self.assertEqual(directory.stat().st_uid, os.getuid())
                for path in directory.iterdir():
                    self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o440)
                    self.assertEqual(path.stat().st_uid, os.getuid())
                self.assertEqual((directory / "github").read_text(), GITHUB_CREDENTIAL + "\n")
                self.assertNotIn(GITHUB_CREDENTIAL, (directory / "deployment.json").read_text())
                cleanup()
                self.assertFalse(directory.exists())

    def test_signal_is_forwarded_to_the_child_process_group(self):
        handlers = {}

        class Child:
            pid = 4321

            def wait(self):
                handlers[signal.SIGTERM](signal.SIGTERM, None)
                return -signal.SIGTERM

        def install_handler(signum, handler):
            previous = handlers.get(signum, signal.SIG_DFL)
            if callable(handler):
                handlers[signum] = handler
            return previous

        with (
            mock.patch.object(worker.subprocess, "Popen", return_value=Child()),
            mock.patch.object(worker.signal, "signal", side_effect=install_handler),
            mock.patch.object(worker.os, "killpg") as killpg,
        ):
            self.assertEqual(worker.run_child(["safe"], {"PATH": "/usr/bin"}), 0)
        killpg.assert_called_once_with(4321, signal.SIGTERM)


if __name__ == "__main__":
    unittest.main()
