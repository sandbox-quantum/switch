from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import threading
from dataclasses import asdict
from pathlib import Path
from time import time
from typing import Any

import boto3

from .cloud import Ec2Cloud
from .config import ConfigError, ControllerConfig, validate_agent_id
from .lock import ControllerAlreadyRunning, ControllerLock
from .model import Agent, DesiredState
from .reconciler import Reconciler
from .store import AgentStore, StoreError


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="switch-hosted-controller")
    result.add_argument("--config", required=True, type=Path)
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
            return _reconcile_command(config, args.command)
        if args.command == "health":
            return _health(args.max_age)
        return _state_command(config, args)
    except (ConfigError, StoreError, ControllerAlreadyRunning) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 2


def _state_command(config: ControllerConfig, args: argparse.Namespace) -> int:
    store = AgentStore(config.state_db_path, config.fingerprint())
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
        if args.command == "status":
            _print_agent(store.get(validate_agent_id(args.agent_id)))
            return 0
        if args.command == "list":
            print(json.dumps([_agent_output(agent) for agent in store.list()], sort_keys=True))
            return 0
        raise AssertionError(f"unhandled command {args.command}")
    finally:
        store.close()


def _reconcile_command(config: ControllerConfig, command: str) -> int:
    with ControllerLock(config.lock_path):
        store = AgentStore(config.state_db_path, config.fingerprint())
        try:
            ec2 = boto3.client("ec2", region_name=config.region)
            reconciler = Reconciler(store, Ec2Cloud(ec2, config))
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
                try:
                    reconciler.reconcile_all()
                finally:
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
    if not 0 < max_age <= 3600:
        raise ConfigError("--max-age must be greater than zero and at most 3600 seconds")
    try:
        updated = float(_HEALTH_PATH.read_text().strip())
    except (OSError, ValueError):
        return 1
    return 0 if time() - updated <= max_age else 1


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
