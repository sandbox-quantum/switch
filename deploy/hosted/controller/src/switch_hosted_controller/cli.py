from __future__ import annotations

import argparse
import json
import logging
import os
import re
import signal
import sys
import threading
import uuid
from pathlib import Path
from time import time
from typing import Any

import boto3

from .cloud import Ec2Cloud
from .config import ConfigError, ControllerConfig, validate_slot_id
from .gateway import Gateway, GatewayConfig
from .health import check_health
from .kms_grants import KmsGrants
from .lock import ControllerAlreadyRunning, ControllerLock
from .model import DesiredState, Machine
from .reconciler import Reconciler
from .store import MachineStore, StoreError


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="switch-hosted-controller")
    result.add_argument("--config", required=True, type=Path)
    result.add_argument("--gateway-config", type=Path)
    subparsers = result.add_subparsers(dest="command", required=True)

    create = subparsers.add_parser("create", help="create a machine in one configured slot")
    create.add_argument("slot_id")
    create.add_argument("--instance-type", required=True)

    for command in ("start", "stop", "status"):
        child = subparsers.add_parser(command)
        child.add_argument("slot_id")

    delete = subparsers.add_parser("delete")
    delete.add_argument("slot_id")
    delete.add_argument("--confirm-slot-id", required=True)
    cleanup = delete.add_mutually_exclusive_group(required=True)
    cleanup.add_argument("--retain-volume", action="store_true")
    cleanup.add_argument("--delete-volume", action="store_true")

    upgrade = subparsers.add_parser(
        "upgrade", help="use the configured image after the old instance is stopped and terminated"
    )
    upgrade.add_argument("slot_id")
    upgrade.add_argument("--confirm-instance-id", required=True)
    upgrade.add_argument("--previous-runtime-fingerprint", required=True)

    subparsers.add_parser("list")
    health = subparsers.add_parser("health")
    health.add_argument("--max-age", required=True, type=float)
    subparsers.add_parser("reconcile-once")
    subparsers.add_parser("serve")
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        config = ControllerConfig.load(args.config)
        if args.command in {"serve", "reconcile-once"}:
            return _reconcile_command(config, args.command, args.gateway_config)
        if args.command == "health":
            return _health(args.max_age)
        return _state_command(config, args)
    except (ConfigError, StoreError, ControllerAlreadyRunning) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 2


def _state_command(config: ControllerConfig, args: argparse.Namespace) -> int:
    store = MachineStore(config.state_db_path, config.fingerprint())
    try:
        if args.command == "create":
            slot_id = validate_slot_id(args.slot_id)
            if args.instance_type not in config.allowed_instance_types:
                raise ConfigError("instance type is not in allowed_instance_types")
            slot = config.slot(slot_id)
            machine = store.insert(
                machine_id=str(uuid.uuid4()),
                slot_id=slot_id,
                generation=store.next_generation(slot_id),
                core_revision=0,
                instance_type=args.instance_type,
                image_id=config.image_id,
                assignment_secret_arn=slot.assignment_secret_arn,
                instance_profile_arn=slot.instance_profile_arn,
                max_machines=config.max_machines,
            )
            _print_machine(machine)
            return 0
        if args.command == "list":
            print(
                json.dumps([_machine_output(machine) for machine in store.list()], sort_keys=True)
            )
            return 0
        slot_id = validate_slot_id(args.slot_id)
        machine = store.latest(slot_id)
        if args.command == "status":
            _print_machine(machine)
            return 0
        if args.command == "start":
            _print_machine(store.set_desired(machine.machine_id, DesiredState.RUNNING, None))
            return 0
        if args.command == "stop":
            _print_machine(store.set_desired(machine.machine_id, DesiredState.STOPPED, None))
            return 0
        if args.command == "delete":
            if args.confirm_slot_id != slot_id:
                raise StoreError("--confirm-slot-id must exactly match slot_id")
            desired = DesiredState.DELETED if args.delete_volume else DesiredState.RETAINED
            _print_machine(store.set_desired(machine.machine_id, desired, None))
            return 0
        if args.command == "upgrade":
            if (
                machine.desired_state is not DesiredState.STOPPED
                or machine.instance_id is None
                or machine.instance_id != args.confirm_instance_id
            ):
                raise StoreError(
                    "stop the machine and confirm its recorded instance before upgrading"
                )
            if not re.fullmatch(r"sha256:[0-9a-f]{64}", args.previous_runtime_fingerprint):
                raise ConfigError(
                    "previous runtime fingerprint must be the sha256:<64 hex> runtimeFingerprint from the trusted disk marker"
                )
            cloud = Ec2Cloud(boto3.client("ec2", region_name=config.region), config)
            instance = cloud.get_instance(machine)
            volume = cloud.get_volume(machine)
            if (
                instance is None
                or instance["State"]["Name"] != "terminated"
                or volume is None
                or volume["State"] != "available"
                or volume.get("Attachments")
            ):
                raise StoreError(
                    "the old instance must be confirmed terminated and its retained disk detached"
                )
            cloud.validate_image(config.image_id)
            claim = store.mark_instance_terminal_observed(machine.machine_id, machine.instance_id)
            _print_machine(
                store.upgrade_terminated(claim, config.image_id, args.previous_runtime_fingerprint)
            )
            return 0
        raise AssertionError(f"unhandled command {args.command}")
    finally:
        store.close()


def _reconcile_command(config: ControllerConfig, command: str, gateway_path: Path | None) -> int:
    with ControllerLock(config.lock_path):
        store = MachineStore(config.state_db_path, config.fingerprint())
        try:
            cloud = Ec2Cloud(boto3.client("ec2", region_name=config.region), config)
            reconciler = Reconciler(store, cloud)
            grants = KmsGrants(
                boto3.client("kms", region_name=config.region),
                config.login_kms_key_arn,
                store,
            )
            gateway = (
                Gateway(
                    GatewayConfig.load(gateway_path),
                    config,
                    store,
                    boto3.client("secretsmanager", region_name=config.region),
                    cloud,
                    grants,
                )
                if gateway_path
                else None
            )
            _touch_health()
            if command == "reconcile-once":
                try:
                    reconciler.reconcile_all()
                finally:
                    _touch_health()
                return 0
            stop = threading.Event()

            def request_stop(_signum: int, _frame: Any) -> None:
                stop.set()

            signal.signal(signal.SIGTERM, request_stop)
            signal.signal(signal.SIGINT, request_stop)
            while not stop.is_set():
                listed = None
                if gateway:
                    try:
                        listed = gateway.machines()
                        gateway.sync_machines(listed)
                    except Exception as error:
                        logging.error("Cloud machine polling failed: %s", type(error).__name__)
                try:
                    reconciler.reconcile_all()
                except Exception as error:
                    logging.error("Cloud machine reconciliation failed: %s", type(error).__name__)
                if gateway and listed is not None:
                    try:
                        gateway.report_observations(listed)
                    except Exception as error:
                        logging.error(
                            "Cloud observation reporting failed: %s", type(error).__name__
                        )
                _touch_health()
                stop.wait(config.poll_interval_seconds)
            return 0
        finally:
            store.close()


_HEALTH_PATH = Path("/tmp/switch-hosted-controller-health")


def _touch_health() -> None:
    temporary = _HEALTH_PATH.with_name(f"{_HEALTH_PATH.name}.{os.getpid()}")
    temporary.write_text(f"{time()}\n")
    temporary.replace(_HEALTH_PATH)


def _health(max_age: float) -> int:
    try:
        return check_health(_HEALTH_PATH, max_age)
    except ValueError as error:
        raise ConfigError(str(error)) from error


def _print_machine(machine: Machine) -> None:
    print(json.dumps(_machine_output(machine), sort_keys=True))


def _machine_output(machine: Machine) -> dict[str, Any]:
    return {
        "machine_id": machine.machine_id,
        "slot_id": machine.slot_id,
        "generation": machine.generation,
        "instance_type": machine.instance_type,
        "desired_state": machine.desired_state.value,
        "desired_revision": machine.desired_revision,
        "observed_state": machine.observed_state.value,
        "instance_id": machine.instance_id,
        "instance_seq": machine.instance_seq,
        "data_volume_id": machine.data_volume_id,
        "retain_until": machine.retain_until.isoformat() if machine.retain_until else None,
        "error": machine.error,
    }


if __name__ == "__main__":
    raise SystemExit(main())
