from __future__ import annotations

import argparse
import json
import logging
import os
import re
import signal
import sys
import threading
from dataclasses import asdict, replace
from pathlib import Path
from time import time
from typing import Any

import boto3

from .cloud import Ec2Cloud
from .config import ConfigError, ControllerConfig, validate_agent_id
from .gateway import Gateway, GatewayConfig
from .health import check_health
from .lock import ControllerAlreadyRunning, ControllerLock
from .model import Agent, DesiredState
from .reconciler import Reconciler
from .store import AgentStore, StoreError
from .verification import VerificationWorkers


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="switch-hosted-controller")
    result.add_argument("--config", required=True, type=Path)
    result.add_argument("--gateway-config", type=Path)
    subparsers = result.add_subparsers(dest="command", required=True)

    create = subparsers.add_parser("create", help="reserve and request one configured agent")
    create.add_argument("agent_id")
    create.add_argument("--instance-type", required=True)

    for command in ("start", "stop", "status"):
        child = subparsers.add_parser(command)
        child.add_argument("agent_id")

    delete = subparsers.add_parser("delete")
    delete.add_argument("agent_id")
    delete.add_argument("--confirm-agent-id", required=True)
    cleanup = delete.add_mutually_exclusive_group(required=True)
    cleanup.add_argument("--retain-volume", action="store_true")
    cleanup.add_argument("--delete-volume", action="store_true")

    upgrade = subparsers.add_parser(
        "upgrade", help="use the configured image after the old worker is stopped and terminated"
    )
    upgrade.add_argument("agent_id")
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
    store = AgentStore(
        config.state_db_path,
        config.fingerprint(),
        legacy_fingerprint=config.fingerprint(legacy=True),
    )
    try:
        if args.command == "create":
            agent_id = validate_agent_id(args.agent_id)
            if args.instance_type not in config.allowed_instance_types:
                raise ConfigError("instance type is not in allowed_instance_types")
            assignment = config.assignment(agent_id)
            agent = store.reserve_create(
                agent_id=agent_id,
                instance_type=args.instance_type,
                image_id=config.image_id,
                assignment_secret_arn=assignment.assignment_secret_arn,
                instance_profile_arn=assignment.instance_profile_arn,
                max_agents=config.max_agents,
            )
            _print_agent(agent)
            return 0
        if args.command == "start":
            agent = store.set_desired(validate_agent_id(args.agent_id), DesiredState.RUNNING)
            _print_agent(agent)
            return 0
        if args.command == "stop":
            agent = store.set_desired(validate_agent_id(args.agent_id), DesiredState.STOPPED)
            _print_agent(agent)
            return 0
        if args.command == "delete":
            agent_id = validate_agent_id(args.agent_id)
            if args.confirm_agent_id != agent_id:
                raise StoreError("--confirm-agent-id must exactly match agent_id")
            agent = store.set_desired(
                agent_id, DesiredState.DELETED, delete_volume=args.delete_volume
            )
            _print_agent(agent)
            return 0
        if args.command == "upgrade":
            agent = store.get(validate_agent_id(args.agent_id))
            if (
                agent.desired_state is not DesiredState.STOPPED
                or agent.instance_id != args.confirm_instance_id
            ):
                raise StoreError(
                    "stop the assignment and confirm its recorded instance before upgrading"
                )
            if not re.fullmatch(r"[0-9a-f]{64}", args.previous_runtime_fingerprint):
                raise ConfigError(
                    "previous runtime fingerprint must be a SHA256 digest from the trusted disk marker"
                )
            cloud = Ec2Cloud(boto3.client("ec2", region_name=config.region), config)
            instance = cloud.get_instance(agent)
            volume = cloud.get_volume(agent)
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
            cloud.validate_image(replace(agent, image_id=config.image_id))
            claim = store.mark_instance_terminal_observed(agent.agent_id, agent.instance_id)
            _print_agent(
                store.upgrade_terminated(claim, config.image_id, args.previous_runtime_fingerprint)
            )
            return 0
        if args.command == "status":
            _print_agent(store.get(validate_agent_id(args.agent_id)))
            return 0
        if args.command == "list":
            print(json.dumps([_agent_output(agent) for agent in store.list()], sort_keys=True))
            return 0
        raise AssertionError(f"unhandled command {args.command}")
    finally:
        store.close()


def _reconcile_command(config: ControllerConfig, command: str, gateway_path: Path | None) -> int:
    with ControllerLock(config.lock_path):
        store = AgentStore(
            config.state_db_path,
            config.fingerprint(),
            legacy_fingerprint=config.fingerprint(legacy=True),
        )
        try:
            ec2 = boto3.client("ec2", region_name=config.region)
            reconciler = Reconciler(store, Ec2Cloud(ec2, config))
            gateway = (
                Gateway(
                    GatewayConfig.load(gateway_path),
                    config,
                    store,
                    boto3.client("secretsmanager", region_name=config.region),
                )
                if gateway_path
                else None
            )
            verification = VerificationWorkers(ec2, config, gateway) if gateway else None
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
                if verification:
                    try:
                        verification.reconcile()
                    except Exception as error:
                        logging.error(
                            "Provider verification reconciliation failed: %s", type(error).__name__
                        )
                if gateway:
                    try:
                        gateway.accept_launches()
                    except Exception as error:
                        logging.error("Cloud launch polling failed: %s", type(error).__name__)
                try:
                    reconciler.reconcile_all()
                except Exception as error:
                    logging.error("Cloud worker reconciliation failed: %s", type(error).__name__)
                if gateway:
                    try:
                        gateway.report_observations()
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


def _print_agent(agent: Agent) -> None:
    print(json.dumps(_agent_output(agent), sort_keys=True))


def _agent_output(agent: Agent) -> dict[str, Any]:
    raw = asdict(agent)
    return {
        "agent_id": raw["agent_id"],
        "generation": raw["generation"],
        "desired_state": agent.desired_state.value,
        "desired_revision": raw["desired_revision"],
        "observed_state": agent.observed_state.value,
        "instance_id": raw["instance_id"],
        "volume_id": raw["volume_id"],
        "last_error": raw["last_error"],
        "delete_volume": raw["delete_volume"],
    }


if __name__ == "__main__":
    raise SystemExit(main())
