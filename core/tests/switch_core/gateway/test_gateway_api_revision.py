"""The `gateway-api` revision rises when a strict request body changes.

A gateway body that forbids extra fields refuses one it does not know, so a
Switch Console that sends a field a server lacks fails with a 422 naming an
internal schema path. The revision is how Console tells that server apart
before it sends anything, and it is only right if someone raises it. This test
holds the fields every strict body takes, recorded against the revision that
introduced them, and fails when they change and the revision did not.

Field names only: a field added or removed is the change that breaks a peer
most often, and names stay stable across Python and pydantic upgrades where
the text of a type annotation does not.

To record a change: raise `gateway-api` `speaks` for switch-core and Switch
Console in artifacts.yaml, run `just artifacts`, then run this test with
`UPDATE_GATEWAY_API_BODIES=1`.
"""

from __future__ import annotations

import importlib
import inspect
import json
import os
import pkgutil
from pathlib import Path

import pytest
from pydantic import BaseModel

import switch_core.gateway
import switch_core.management
from switch_core.artifacts import contract_range

RECORD = Path(__file__).with_name("gateway_api_strict_bodies.json")
UPDATE_ENV = "UPDATE_GATEWAY_API_BODIES"

# Served to the hosted controller, which is not a first-party UI client and is
# not a party to `gateway-api`.
NOT_GATEWAY_API = frozenset({"switch_core.gateway.hosted_controller"})


def strict_bodies() -> dict[str, list[str]]:
    bodies: dict[str, list[str]] = {}
    for package in (switch_core.gateway, switch_core.management):
        for info in pkgutil.walk_packages(package.__path__, f"{package.__name__}."):
            if info.name in NOT_GATEWAY_API:
                continue
            module = importlib.import_module(info.name)
            for _, cls in inspect.getmembers(module, inspect.isclass):
                if (
                    issubclass(cls, BaseModel)
                    and cls.__module__ == info.name
                    and cls.model_config.get("extra") == "forbid"
                    and cls.model_fields
                ):
                    bodies[f"{cls.__module__}.{cls.__qualname__}"] = sorted(
                        cls.model_fields
                    )
    return dict(sorted(bodies.items()))


def _changes(recorded: dict[str, list[str]], current: dict[str, list[str]]) -> str:
    lines = []
    for name in sorted(recorded.keys() | current.keys()):
        before, after = set(recorded.get(name, [])), set(current.get(name, []))
        if name not in recorded:
            lines.append(f"  + {name}")
        elif name not in current:
            lines.append(f"  - {name}")
        elif before != after:
            added = ", ".join(sorted(after - before)) or "nothing"
            removed = ", ".join(sorted(before - after)) or "nothing"
            lines.append(f"  ~ {name}: added {added}; removed {removed}")
    return "\n".join(lines)


def test_strict_gateway_bodies_are_recorded_against_the_current_revision() -> None:
    speaks = contract_range("gateway-api", "switch-core").speaks
    console_speaks = contract_range("gateway-api", "switch-console").speaks
    recorded = json.loads(RECORD.read_text())
    current = strict_bodies()

    if os.environ.get(UPDATE_ENV):
        if current != recorded["bodies"] and speaks <= recorded["revision"]:
            pytest.fail(
                f"The strict gateway bodies changed, but gateway-api still speaks "
                f"{speaks}. Raise it in artifacts.yaml and run `just artifacts` "
                f"before recording.\n{_changes(recorded['bodies'], current)}"
            )
        RECORD.write_text(
            json.dumps({"revision": speaks, "bodies": current}, indent=2) + "\n"
        )
        return

    assert speaks == console_speaks, (
        f"switch-core speaks gateway-api {speaks} but Switch Console speaks "
        f"{console_speaks}. They live in one repository and ship the same "
        "gateway, so raise them together in artifacts.yaml."
    )
    assert current == recorded["bodies"], (
        "A strict gateway request body changed. A Switch Console that sends the "
        "new shape is refused with a 422 by every server without it, so raise "
        "gateway-api `speaks` in artifacts.yaml, run `just artifacts`, and "
        f"record it with {UPDATE_ENV}=1:\n{_changes(recorded['bodies'], current)}"
    )
    assert recorded["revision"] == speaks, (
        f"{RECORD.name} was recorded at gateway-api revision "
        f"{recorded['revision']}, but artifacts.yaml says {speaks}. Record it "
        f"again with {UPDATE_ENV}=1."
    )
