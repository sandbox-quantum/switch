"""The credential broker against a reference model of who may hold what,
against `broker_machine.py`."""

from __future__ import annotations

import ast
from pathlib import Path

import pytest
from hypothesis import settings
from hypothesis.stateful import run_state_machine_as_test

import switch_core
from tests.switch_core.properties.broker_machine import (
    COVERAGE,
    SHOULD_REACH,
    machine_on,
)


@pytest.mark.property("connector.token-only-to-granted")
def test_a_token_goes_only_where_it_was_granted(postgres_schema: str) -> None:
    COVERAGE.clear()
    # A withdrawal is only seen between an issue and an upkeep after it, so a
    # run needs room for all three, and more runs than most machines to find
    # the rarer withdrawals on a pull request.
    current = settings()
    run_state_machine_as_test(
        machine_on(postgres_schema),
        settings=settings(
            current,
            max_examples=max(100, current.max_examples),
            stateful_step_count=max(60, current.stateful_step_count),
        ),
    )
    print(f"reached {dict(COVERAGE)}")
    assert COVERAGE["refused"], f"no ask was refused: {dict(COVERAGE)}"
    if settings.get_current_profile_name() == "nightly":
        unreached = [what for what in SHOULD_REACH if COVERAGE[what] == 0]
        assert not unreached, (
            f"the run never reached {unreached}; it reached {dict(COVERAGE)}"
        )


# The code that may read a connection's secret or an issued token in the clear,
# and why. Anything else that does is a second broker.
MAY_DECRYPT = {
    "connections/broker.py": "the broker",
    "connections/oauth_clients.py": "its own registered client's secret, not a connection's",
    "db/key_rotation.py": "re-encrypts each value in place under the new key",
    "connections/github_move.py": "reads the account id and login from a legacy GitHub row",
}
CIPHERTEXT = {"encrypted_secret", "encrypted_token", "encrypted_credential"}


def _decrypts_ciphertext(tree: ast.AST) -> bool:
    """Whether a module both calls a `decrypt` and reads, or names, one of
    `CIPHERTEXT`."""
    calls = reads = False
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and (
            isinstance(node.func, ast.Attribute) and node.func.attr == "decrypt"
        ):
            calls = True
        if isinstance(node, ast.Attribute) and node.attr in CIPHERTEXT:
            reads = True
        if isinstance(node, ast.Constant) and node.value in CIPHERTEXT:
            # A column named by string: `getattr`, or a table of columns.
            reads = True
    return calls and reads


@pytest.mark.property("connector.token-only-to-granted")
def test_nothing_but_the_broker_decrypts_a_connection() -> None:
    root = Path(switch_core.__file__).parent
    found = {
        path.relative_to(root).as_posix()
        for path in root.rglob("*.py")
        if "migrations" not in path.parts
        and _decrypts_ciphertext(ast.parse(path.read_text()))
    }
    assert found <= MAY_DECRYPT.keys(), (
        f"{sorted(found - MAY_DECRYPT.keys())} decrypt a connection's secret or "
        "an issued token; only the broker should"
    )
    assert found == MAY_DECRYPT.keys(), (
        f"{sorted(MAY_DECRYPT.keys() - found)} no longer decrypt anything; take "
        "them off the list"
    )
