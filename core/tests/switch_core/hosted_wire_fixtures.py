"""The hosted-machine wire fixtures, shared with the controller, the supervisor and Switch Console.

Each response fixture is real Core output with its volatile values (ids Core
mints, capabilities, API tokens, timestamps) swapped for fixed placeholders,
and each request fixture is a body Core's route accepts. The Core tests fail
when a route's output drifts from its fixture; run them with
`SWITCH_UPDATE_FIXTURES=1` to rewrite the response fixtures from real output.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

FIXTURES = Path(__file__).parent / "fixtures" / "hosted_machines"
UPDATE_FIXTURES = os.environ.get("SWITCH_UPDATE_FIXTURES") == "1"

MACHINE_ID = "3f1c2b4a-0000-4000-8000-000000000001"
AGENT_ID = "3f1c2b4a-0000-4000-8000-0000000000a1"
LAUNCH_ID = "3f1c2b4a-0000-4000-8000-0000000000c1"
MACHINE_CAPABILITY = "mcap-test-00000000000000000000000000000000"
WORKER_CAPABILITY = "wcap-test-00000000000000000000000000000000"
API_TOKEN = "test-token-placeholder"
API_ENDPOINT = "https://switch.example.test/agent-api"
TIMESTAMP = "2026-01-01T00:00:00+00:00"

JsonPath = tuple[str, ...]


def read_fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text())


def _substitute(value: Any, replacements: dict[str, str]) -> Any:
    if isinstance(value, dict):
        return {key: _substitute(item, replacements) for key, item in value.items()}
    if isinstance(value, list):
        return [_substitute(item, replacements) for item in value]
    if isinstance(value, str):
        return replacements.get(value, value)
    return value


def request_fixture(name: str, placeholders: dict[str, str]) -> Any:
    """The request fixture with each placeholder id replaced by the real one."""
    return _substitute(read_fixture(name), placeholders)


def _replace_volatile(value: Any, path: JsonPath, placeholder: Any, where: str) -> Any:
    if not path:
        assert type(value) is type(placeholder), (
            f"{where}: expected a {type(placeholder).__name__}, got {value!r}"
        )
        return placeholder
    head, rest = path[0], path[1:]
    if head == "*":
        assert isinstance(value, list), f"{where}: expected a list, got {value!r}"
        return [
            _replace_volatile(item, rest, placeholder, f"{where}[{index}]")
            for index, item in enumerate(value)
        ]
    assert isinstance(value, dict) and head in value, (
        f"{where}: expected an object with {head!r}, got {value!r}"
    )
    return {
        key: _replace_volatile(item, rest, placeholder, f"{where}.{key}")
        if key == head
        else item
        for key, item in value.items()
    }


def assert_wire_fixture(
    name: str,
    actual: Any,
    *,
    placeholders: dict[str, str],
    volatile: dict[JsonPath, Any],
) -> None:
    """Compare a real response body with its fixture, exactly.

    `placeholders` maps each placeholder id to the real value the test saw;
    every string equal to a real value is written as its placeholder. Each
    `volatile` path (`*` matches every list item) must hold a value of the
    placeholder's type and is written as the placeholder.
    """
    real = {value: placeholder for placeholder, value in placeholders.items()}
    assert len(real) == len(placeholders), "two placeholders share one real value"
    normalised = _substitute(actual, real)
    for path, placeholder in volatile.items():
        normalised = _replace_volatile(normalised, path, placeholder, name)
    if UPDATE_FIXTURES:
        (FIXTURES / name).write_text(json.dumps(normalised, indent=2) + "\n")
        return
    expected = read_fixture(name)
    drifted = (
        f"{name} no longer matches Core's output; rerun with SWITCH_UPDATE_FIXTURES=1 "
        "to rewrite it, and update its consumers."
    )
    assert normalised == expected, drifted
    assert json.dumps(normalised, sort_keys=True) == json.dumps(
        expected, sort_keys=True
    ), drifted
